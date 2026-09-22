import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DriveSnapshot, DriveStatus } from "../../shared/types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const APP_MARKER = "typeset-desktop";
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

export interface DriveOptions {
  storageDir: string;
  getCredentials: () => { clientId: string; clientSecret: string };
  encrypt: (text: string) => Buffer;
  decrypt: (data: Buffer) => string;
  openExternal: (url: string) => Promise<void>;
}

interface Tokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}
interface DriveFile extends DriveSnapshot {
  mimeType?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

function queryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function snapshotId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new Error("Invalid Google Drive snapshot.");
  return value;
}
function projectKey(value: string): string {
  if (!value.trim() || Buffer.byteLength(value) > 100)
    throw new Error(
      "This project needs a valid identifier before saving to Google Drive.",
    );
  return value;
}

/** Desktop OAuth, encrypted local tokens, and immutable project ZIP snapshots. */
export class DriveService {
  private tokens?: Tokens;
  private connecting?: Promise<DriveStatus>;
  private refreshing?: Promise<Tokens>;
  private writing: Promise<void> = Promise.resolve();
  private generation = 0;
  private cancelAuthorization?: () => void;
  private get tokenFile(): string {
    return path.join(this.options.storageDir, "google-drive-tokens.enc");
  }

  constructor(private readonly options: DriveOptions) {}

  private credentials(): { clientId: string; clientSecret: string } {
    const credentials = this.options.getCredentials();
    return {
      clientId: credentials.clientId.trim(),
      clientSecret: credentials.clientSecret.trim(),
    };
  }

  private async loadTokens(): Promise<Tokens | undefined> {
    const { clientId } = this.credentials();
    if (this.tokens?.clientId === clientId) return this.tokens;
    this.tokens = undefined;
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.tokenFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let tokens: Tokens;
    try {
      tokens = JSON.parse(this.options.decrypt(encrypted)) as Tokens;
    } catch {
      throw new Error(
        "Google Drive credentials could not be unlocked. Disconnect and reconnect Drive with your system keychain available.",
      );
    }
    if (tokens.clientId !== clientId) return undefined;
    if (
      !tokens.accessToken ||
      !tokens.refreshToken ||
      !Number.isFinite(tokens.expiresAt)
    )
      throw new Error(
        "Google Drive credentials are incomplete. Disconnect and reconnect Drive.",
      );
    this.tokens = tokens;
    return tokens;
  }

  private async saveTokens(
    tokens: Tokens,
    generation = this.generation,
  ): Promise<void> {
    // Encryption failure is fatal: credentials must never fall back to plaintext storage.
    const encrypted = this.options.encrypt(JSON.stringify(tokens));
    const write = this.writing
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.generation)
          throw new Error("Google Drive has been disconnected.");
        await mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
        const temporary = `${this.tokenFile}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
          if (generation !== this.generation)
            throw new Error("Google Drive has been disconnected.");
          await rename(temporary, this.tokenFile);
          this.tokens = tokens;
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.writing = write;
    await write;
  }

  async status(): Promise<DriveStatus> {
    const { clientId, clientSecret } = this.credentials();
    const configured = Boolean(clientId && clientSecret);
    return {
      configured,
      connected: configured && Boolean(await this.loadTokens()),
    };
  }

  async connect(): Promise<DriveStatus> {
    if (this.connecting) return this.connecting;
    const task = this.authorize();
    this.connecting = task;
    try {
      return await task;
    } finally {
      if (this.connecting === task) this.connecting = undefined;
    }
  }

  private async authorize(): Promise<DriveStatus> {
    const { clientId, clientSecret } = this.credentials();
    if (!clientId || !clientSecret)
      throw new Error(
        "Add a Google OAuth client ID and client secret for a Desktop app in Settings first. Enable the free Google Drive API for that project.",
      );
    this.options.encrypt("Typeset encryption availability check");
    const generation = this.generation;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    let redirectUri = "";
    let settleCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      settleCode = resolve;
      rejectCode = reject;
    });
    // Attach a handler immediately so opening a browser cannot leave an unhandled rejection.
    void codePromise.catch(() => undefined);
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found.");
        return;
      }
      const receivedState = Buffer.from(url.searchParams.get("state") || "");
      const expectedState = Buffer.from(state);
      if (
        receivedState.length !== expectedState.length ||
        !timingSafeEqual(receivedState, expectedState)
      ) {
        response
          .writeHead(400)
          .end(
            "This sign-in response is invalid. Return to Typeset and try again.",
          );
        return;
      }
      if (url.searchParams.has("error")) {
        response
          .writeHead(400)
          .end("Google Drive was not connected. You can return to Typeset.");
        rejectCode(new Error("Google Drive sign-in was cancelled or denied."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) {
        response.writeHead(400).end("Missing sign-in code.");
        return;
      }
      response
        .writeHead(200)
        .end(
          "Google sign-in received. You can close this tab and return to Typeset.",
        );
      settleCode(code);
    });
    const timer = setTimeout(
      () =>
        rejectCode(
          new Error("Google Drive sign-in timed out. Please connect again."),
        ),
      180_000,
    );
    timer.unref();
    const cancel = () =>
      rejectCode(new Error("Google Drive sign-in was cancelled."));
    this.cancelAuthorization = cancel;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", rejectCode);
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Could not start the local Google sign-in callback.");
      redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      const auth = new URL(AUTH_URL);
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: DRIVE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      await this.options.openExternal(auth.toString());
      const code = await codePromise;
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      const token = (await response.json()) as TokenResponse;
      if (!response.ok || !token.access_token || !token.refresh_token)
        throw new Error(
          "Google could not finish sign-in. Check the Desktop app credentials and reconnect, granting Drive access.",
        );
      if (generation !== this.generation)
        throw new Error("Google Drive sign-in was cancelled.");
      await this.saveTokens(
        {
          clientId,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt:
            Date.now() + Math.max(1, Number(token.expires_in) || 3600) * 1000,
        },
        generation,
      );
      return this.status();
    } finally {
      clearTimeout(timer);
      if (this.cancelAuthorization === cancel)
        this.cancelAuthorization = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      });
    }
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.cancelAuthorization?.();
    let tokens: Tokens | undefined;
    try {
      tokens = await this.loadTokens();
    } catch {
      /* Disconnect also clears inaccessible/corrupt credentials. */
    }
    await this.writing.catch(() => undefined);
    this.tokens = undefined;
    await rm(this.tokenFile, { force: true });
    if (tokens) {
      // Clearing the local connection always succeeds, including while offline.
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          body: new URLSearchParams({ token: tokens.refreshToken }),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
      } catch {
        /* The user can also revoke access in their Google account settings. */
      }
    }
  }

  private async refresh(tokens: Tokens): Promise<Tokens> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const operation = (async () => {
      const { clientId, clientSecret } = this.credentials();
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      const data = (await response.json()) as TokenResponse;
      if (!response.ok || !data.access_token) {
        if (data.error === "invalid_grant") {
          this.tokens = undefined;
          await rm(this.tokenFile, { force: true });
          throw new Error(
            "Google Drive access expired or was revoked. Connect Drive again in Settings.",
          );
        }
        throw new Error(
          "Google Drive could not refresh access. Check your connection and Google OAuth settings.",
        );
      }
      if (generation !== this.generation)
        throw new Error("Google Drive has been disconnected.");
      const updated = {
        clientId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || tokens.refreshToken,
        expiresAt:
          Date.now() + Math.max(1, Number(data.expires_in) || 3600) * 1000,
      };
      await this.saveTokens(updated, generation);
      return updated;
    })();
    this.refreshing = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshing === operation) this.refreshing = undefined;
    }
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let tokens = await this.loadTokens();
    if (!tokens) throw new Error("Connect Google Drive in Settings first.");
    if (tokens.expiresAt <= Date.now() + 60_000)
      tokens = await this.refresh(tokens);
    const run = (accessToken: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(90_000),
        redirect: "error",
      });
    };
    let response = await run(tokens.accessToken);
    if (response.status === 401) {
      tokens = await this.refresh(tokens);
      response = await run(tokens.accessToken);
    }
    if (!response.ok) {
      let reason = "";
      try {
        const body = (await response.json()) as {
          error?: { errors?: { reason?: string }[] };
        };
        reason = body.error?.errors?.map((item) => item.reason).join(",") || "";
      } catch {
        /* Do not display response bodies that might contain sensitive details. */
      }
      if (/storageQuotaExceeded/.test(reason))
        throw new Error(
          "Google Drive storage is full. Free space in your existing account before saving another snapshot. No paid upgrade is required by Typeset.",
        );
      if (
        response.status === 429 ||
        /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded/.test(
          reason,
        )
      )
        throw new Error(
          "Google Drive’s free API allowance is temporarily exhausted. Synchronization is paused; keep working locally and try again later.",
        );
      if (/accessNotConfigured|serviceDisabled/.test(reason))
        throw new Error(
          "Enable the Google Drive API in the Google Cloud project for your Desktop OAuth client.",
        );
      if (response.status === 404)
        throw new Error(
          "This Google Drive snapshot no longer exists or is unavailable to this app.",
        );
      if (response.status === 403)
        throw new Error(
          "Google Drive did not permit this action. Reconnect and grant Typeset access to the files it creates.",
        );
      if (response.status === 401)
        throw new Error(
          "Google Drive sign-in expired. Connect Drive again in Settings.",
        );
      throw new Error(
        `Google Drive is unavailable (HTTP ${response.status}). Your local project is safe; try again later.`,
      );
    }
    return response;
  }

  async listSnapshots(projectId: string): Promise<DriveSnapshot[]> {
    const id = projectKey(projectId);
    const snapshots: DriveSnapshot[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        q: `trashed = false and mimeType = 'application/zip' and appProperties has { key='typesetApp' and value='${APP_MARKER}' } and appProperties has { key='typesetProject' and value='${queryLiteral(id)}' }`,
        fields: "nextPageToken,files(id,name,createdTime,size)",
        orderBy: "createdTime desc",
        pageSize: "100",
        spaces: "drive",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request(`${API_URL}?${query}`);
      const page = (await response.json()) as {
        files?: DriveSnapshot[];
        nextPageToken?: string;
      };
      snapshots.push(...(page.files || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return snapshots;
  }

  async saveSnapshot(
    projectId: string,
    projectName: string,
    label: string,
    zip: Uint8Array,
  ): Promise<DriveSnapshot> {
    const id = projectKey(projectId);
    if (!label.trim() || label.length > 160)
      throw new Error("Name this snapshot using 1–160 characters.");
    if (zip.byteLength > MAX_SNAPSHOT_BYTES)
      throw new Error(
        "This snapshot exceeds the 100 MB limit. Remove large generated files before saving to Drive.",
      );
    const clean = (value: string) =>
      value.trim().replace(/[\x00-\x1f/\\]/g, "-");
    const name = `${clean(projectName).slice(0, 100) || "Project"} — ${clean(label)} — ${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    const metadata = {
      name,
      mimeType: "application/zip",
      appProperties: { typesetApp: APP_MARKER, typesetProject: id },
      description:
        "A project snapshot saved by Typeset. Download and extract this ZIP to open the project in any LaTeX editor.",
    };
    const boundary = `typeset_${randomBytes(24).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      Buffer.from(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return response.json() as Promise<DriveSnapshot>;
  }

  async downloadSnapshot(value: string): Promise<Uint8Array> {
    const id = snapshotId(value);
    const metadata = await this.request(
      `${API_URL}/${id}?fields=id,mimeType,trashed,size,appProperties`,
    );
    const file = (await metadata.json()) as DriveFile;
    if (
      file.trashed ||
      file.mimeType !== "application/zip" ||
      file.appProperties?.typesetApp !== APP_MARKER ||
      !file.appProperties.typesetProject
    ) {
      throw new Error(
        "Only project ZIP snapshots created by Typeset can be restored.",
      );
    }
    if (Number(file.size) > MAX_SNAPSHOT_BYTES)
      throw new Error("This Drive snapshot exceeds the 100 MB restore limit.");
    const response = await this.request(`${API_URL}/${id}?alt=media`);
    if (Number(response.headers.get("content-length")) > MAX_SNAPSHOT_BYTES)
      throw new Error("This Drive snapshot exceeds the 100 MB restore limit.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Google Drive returned an empty snapshot.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_SNAPSHOT_BYTES)
          throw new Error(
            "This Drive snapshot exceeds the 100 MB restore limit.",
          );
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  }
}
