import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveService, type DriveOptions } from "../electron/services/drive";

const originalFetch = globalThis.fetch;
const key = randomBytes(32);
// Real encryption in this test adapter; production uses the operating system's safeStorage.
const encrypt = (plain: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]);
};
const decrypt = (sealed: Buffer) => {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([
    decipher.update(sealed.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let root: string;
let drive: DriveService;
let options: DriveOptions;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
const tokenFile = () => path.join(root, "google-drive-tokens.enc");
async function seedTokens(expiresAt = Date.now() + 3600_000): Promise<void> {
  await writeFile(
    tokenFile(),
    encrypt(
      JSON.stringify({
        clientId: "client-id",
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresAt,
      }),
    ),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "typeset-drive-test-"));
  options = {
    storageDir: root,
    getCredentials: () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
    encrypt,
    decrypt,
    openExternal: vi.fn(async () => {}),
  };
  drive = new DriveService(options);
  request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("Google Drive desktop authentication", () => {
  it("reports configuration separately from connection", async () => {
    expect(await drive.status()).toEqual({
      configured: true,
      connected: false,
    });
    await seedTokens();
    expect(await drive.status()).toEqual({ configured: true, connected: true });
    options.getCredentials = () => ({ clientId: "", clientSecret: "" });
    expect(await drive.status()).toEqual({
      configured: false,
      connected: false,
    });
  });

  it("never opens OAuth when secure credential storage is unavailable", async () => {
    options.encrypt = () => {
      throw new Error("System keychain unavailable");
    };
    await expect(drive.connect()).rejects.toThrow("keychain unavailable");
    expect(options.openExternal).not.toHaveBeenCalled();
    await expect(access(tokenFile())).rejects.toThrow();
  });

  it("uses state-checked loopback OAuth with PKCE and stores only encrypted tokens", async () => {
    let authorization!: URL;
    options.openExternal = async (value) => {
      authorization = new URL(value);
      const redirect = authorization.searchParams.get("redirect_uri")!;
      expect(new URL(redirect).hostname).toBe("127.0.0.1");
      expect(authorization.searchParams.get("scope")).toBe(
        "https://www.googleapis.com/auth/drive.file",
      );
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      // Invalid state cannot complete sign-in, including equal-character-length multibyte input.
      const badState = "é".repeat(
        authorization.searchParams.get("state")!.length,
      );
      expect(
        (
          await originalFetch(
            `${redirect}?state=${encodeURIComponent(badState)}&code=bad`,
          )
        ).status,
      ).toBe(400);
      const callback = new URL(redirect);
      callback.search = new URLSearchParams({
        state: authorization.searchParams.get("state")!,
        code: "valid-code",
      }).toString();
      expect((await originalFetch(callback)).status).toBe(200);
    };
    request.mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      const params = init!.body as URLSearchParams;
      expect(params.get("code")).toBe("valid-code");
      expect(
        createHash("sha256")
          .update(params.get("code_verifier")!)
          .digest("base64url"),
      ).toBe(authorization.searchParams.get("code_challenge"));
      expect(params.get("grant_type")).toBe("authorization_code");
      return json({
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        expires_in: 3600,
      });
    });
    expect(await drive.connect()).toEqual({
      configured: true,
      connected: true,
    });
    const bytes = await readFile(tokenFile());
    expect(bytes.toString()).not.toContain("secret");
    expect(JSON.parse(decrypt(bytes)).refreshToken).toBe("secret-refresh");
  });

  it("refreshes expired credentials before requesting snapshots", async () => {
    await seedTokens(1);
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        expect((init!.body as URLSearchParams).get("refresh_token")).toBe(
          "private-refresh-token",
        );
        return json({ access_token: "renewed-access", expires_in: 3600 });
      }
      expect(new Headers(init!.headers).get("Authorization")).toBe(
        "Bearer renewed-access",
      );
      return json({ files: [] });
    });
    expect(await drive.listSnapshots("project-id")).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(decrypt(await readFile(tokenFile()))).refreshToken).toBe(
      "private-refresh-token",
    );
  });

  it("shares one refresh for concurrent API requests", async () => {
    await seedTokens(1);
    request.mockImplementation(async (url) =>
      String(url).includes("oauth2.googleapis.com/token")
        ? json({ access_token: "renewed", expires_in: 3600 })
        : json({ files: [] }),
    );
    await Promise.all([
      drive.listSnapshots("project-a"),
      drive.listSnapshots("project-b"),
    ]);
    expect(
      request.mock.calls.filter(([url]) => String(url).includes("/token")),
    ).toHaveLength(1);
  });

  it("retries an expired access token once and clears revoked refresh credentials", async () => {
    await seedTokens();
    request
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    await expect(drive.listSnapshots("project")).rejects.toThrow(
      "expired or was revoked",
    );
    expect((await drive.status()).connected).toBe(false);
    await expect(access(tokenFile())).rejects.toThrow();
  });

  it("disconnects locally even when Google cannot be reached", async () => {
    await seedTokens();
    request.mockRejectedValue(new Error("Offline"));
    await drive.disconnect();
    expect((await drive.status()).connected).toBe(false);
    await expect(access(tokenFile())).rejects.toThrow();
  });

  it("cannot recreate credentials when disconnected during token refresh", async () => {
    await seedTokens(1);
    let finish!: (response: Response) => void;
    let started!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    request.mockImplementation(async (url) => {
      if (String(url).includes("/token")) {
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return json({});
    });
    const operation = drive.listSnapshots("project");
    const rejection = expect(operation).rejects.toThrow("disconnected");
    await refreshStarted;
    await drive.disconnect();
    finish(json({ access_token: "renewed", expires_in: 3600 }));
    await rejection;
    await expect(access(tokenFile())).rejects.toThrow();
  });
});

describe("Google Drive project snapshots", () => {
  it("lists all pages for this app and project", async () => {
    await seedTokens();
    request
      .mockResolvedValueOnce(
        json({
          files: [{ id: "one", name: "First", createdTime: "2026-01-01" }],
          nextPageToken: "next",
        }),
      )
      .mockResolvedValueOnce(
        json({
          files: [{ id: "two", name: "Second", createdTime: "2025-12-01" }],
        }),
      );
    expect(await drive.listSnapshots("project'one")).toHaveLength(2);
    const first = new URL(String(request.mock.calls[0][0]));
    expect(first.searchParams.get("q")).toContain(
      "typesetApp' and value='typeset-desktop",
    );
    expect(first.searchParams.get("q")).toContain("project\\'one");
    expect(
      new URL(String(request.mock.calls[1][0])).searchParams.get("pageToken"),
    ).toBe("next");
  });

  it("uploads an immutable ZIP with app-owned metadata and a readable name", async () => {
    await seedTokens();
    request.mockResolvedValue(
      json({ id: "snapshot", name: "snapshot.zip", createdTime: "2026-01-01" }),
    );
    expect(
      (
        await drive.saveSnapshot(
          "project-id",
          "Research",
          "Before review",
          new Uint8Array([80, 75, 1, 2]),
        )
      ).id,
    ).toBe("snapshot");
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toContain("uploadType=multipart");
    expect(init!.method).toBe("POST");
    const body = Buffer.from(init!.body as Uint8Array).toString();
    expect(body).toContain("Research — Before review");
    expect(body).toContain('"typesetProject":"project-id"');
    expect(body).toContain("Content-Type: application/zip");
    expect(new Headers(init!.headers).get("Content-Type")).toContain(
      "multipart/related; boundary=typeset_",
    );
  });

  it("validates snapshot labels before making a request", async () => {
    await expect(
      drive.saveSnapshot("project", "Research", " ", new Uint8Array()),
    ).rejects.toThrow("Name this snapshot");
    expect(request).not.toHaveBeenCalled();
  });

  it("downloads app-owned project ZIP data after checking metadata", async () => {
    await seedTokens();
    request
      .mockResolvedValueOnce(
        json({
          id: "snapshot",
          mimeType: "application/zip",
          size: "4",
          appProperties: {
            typesetApp: "typeset-desktop",
            typesetProject: "project",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 1, 2])));
    expect(await drive.downloadSnapshot("snapshot")).toEqual(
      new Uint8Array([80, 75, 1, 2]),
    );
    expect(request.mock.calls[1][0]).toBe(
      "https://www.googleapis.com/drive/v3/files/snapshot?alt=media",
    );
  });

  it("refuses files not created by the app and oversized snapshots", async () => {
    await seedTokens();
    request.mockResolvedValueOnce(
      json({ mimeType: "application/zip", appProperties: {} }),
    );
    await expect(drive.downloadSnapshot("foreign")).rejects.toThrow(
      "created by Typeset",
    );
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce(
      json({
        mimeType: "application/zip",
        size: String(101 * 1024 * 1024),
        appProperties: {
          typesetApp: "typeset-desktop",
          typesetProject: "project",
        },
      }),
    );
    await expect(drive.downloadSnapshot("large")).rejects.toThrow("100 MB");
    expect(request).toHaveBeenCalledTimes(2);
    await expect(drive.downloadSnapshot("../other")).rejects.toThrow("Invalid");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, "storageQuotaExceeded", "storage is full"],
    [429, "rateLimitExceeded", "free API allowance"],
    [403, "dailyLimitExceeded", "free API allowance"],
    [403, "accessNotConfigured", "Enable the Google Drive API"],
  ])(
    "surfaces HTTP %s %s without retrying or enabling billing",
    async (status, reason, message) => {
      await seedTokens();
      request.mockResolvedValue(
        json({ error: { errors: [{ reason }] } }, status as number),
      );
      await expect(drive.listSnapshots("project")).rejects.toThrow(
        message as string,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
