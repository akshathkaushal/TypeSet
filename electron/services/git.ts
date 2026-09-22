import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitStatus, Version } from "../../shared/types";

const execute = promisify(execFile);
const EMPTY_STATUS: GitStatus = {
  initialized: false,
  branch: "",
  remote: "",
  changed: 0,
  changes: [],
};

/** Only GitHub HTTPS and SSH URLs are accepted; credentials belong in Git's helper/SSH agent. */
export function validateGitHubUrl(value: string): string {
  const url = value.trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      url,
    ) ||
    url
      .split(/[/:]/)
      .slice(-2)
      .some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      "Use a GitHub URL such as https://github.com/owner/project.git or git@github.com:owner/project.git.",
    );
  }
  return url;
}

function gitEnvironment(includeUserConfiguration = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A parent process must not redirect commands into another repository or add config.
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_CONFIG_NOSYSTEM = "1";
  if (!includeUserConfiguration) env.GIT_CONFIG_GLOBAL = devNull;
  return env;
}

/** Keep native ordering while rejecting every project/worktree/command helper definition. */
export function trustedCredentialArgumentsFromConfig(
  configuration: string,
  trustedAppleDefault?: string,
): string[] {
  const fields = configuration.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0)
    throw new Error("Git returned invalid credential helper configuration.");
  const args: string[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [scope, origin, record] = fields.slice(index, index + 3);
    // Apple Git labels its bundled defaults "unknown", rather than "system".
    // Trust only the exact installation file derived from this Git executable's exec path.
    const appleDefault =
      scope === "unknown" &&
      trustedAppleDefault &&
      origin === `file:${trustedAppleDefault}`;
    if (scope !== "system" && scope !== "global" && !appleDefault) continue;
    const separator = record.indexOf("\n");
    if (separator < 0)
      throw new Error(
        "A Git credential helper has no value. Check your system and global Git configuration.",
      );
    const key = record.slice(0, separator);
    if (!/^credential(?:\..*)?\.helper$/.test(key)) continue;
    args.push("-c", `${key}=${record.slice(separator + 1)}`);
  }
  return args;
}

/** Read helper definitions only; this never invokes a helper or reads stored credentials. */
export async function trustedCredentialHelperArguments(
  root: string,
  configurationFiles: { system?: string; global?: string } = {},
): Promise<string[]> {
  const env = gitEnvironment(true);
  delete env.GIT_CONFIG_NOSYSTEM;
  // Explicit paths support isolated configuration fixtures without changing the user's Git settings.
  if (configurationFiles.system)
    env.GIT_CONFIG_SYSTEM = configurationFiles.system;
  if (configurationFiles.global)
    env.GIT_CONFIG_GLOBAL = configurationFiles.global;
  let trustedAppleDefault: string | undefined;
  // Isolated fixture files deliberately exclude host defaults, so tests cannot invoke Keychain.
  if (
    process.platform === "darwin" &&
    !configurationFiles.system &&
    !configurationFiles.global
  ) {
    try {
      const { stdout } = await execute("git", ["--exec-path"], {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        timeout: 10_000,
      });
      const execPath = stdout.trim();
      if (path.isAbsolute(execPath))
        trustedAppleDefault = path.resolve(
          execPath,
          "../../share/git-core/gitconfig",
        );
    } catch {
      /* Standard protected scopes still work if the optional Apple defaults cannot be located. */
    }
  }
  let configuration: string;
  try {
    const result = await execute(
      "git",
      [
        "config",
        "--includes",
        "--show-scope",
        "--show-origin",
        "--null",
        "--get-regexp",
        "^credential(\\..*)?\\.helper$",
      ],
      {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    configuration = result.stdout;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw new Error(
      "Git credential helper settings could not be read. Check your Git configuration, then try again.",
    );
  }
  // Native config traversal includes Apple's defaults and preserves system/global includes and resets.
  return trustedCredentialArgumentsFromConfig(
    configuration,
    trustedAppleDefault,
  );
}

export function gitFailureMessage(
  detail: string,
  httpsNetwork: boolean,
): string {
  if (!httpsNetwork) return detail;
  const missing =
    /could not read (?:Username|Password).*github\.com.*(?:terminal prompts disabled|No such device or address)/is.test(
      detail,
    );
  const rejected =
    /authentication failed|invalid username or (?:password|token)|password authentication is not supported/i.test(
      detail,
    );
  if (!missing && !rejected) return detail;
  return `${missing ? "GitHub HTTPS sign-in is required." : "GitHub rejected the saved HTTPS credentials."} Sign in once using GitHub CLI in Terminal: gh auth login --hostname github.com --git-protocol https --web, then gh auth setup-git --hostname github.com. Retry in Typeset afterward. Existing credentials from your system or global Git helper are also supported. Your local versions are unchanged.`;
}

export function gitPullFailureMessage(detail: string): string {
  if (/refusing to merge unrelated histories/i.test(detail)) {
    return "This project and GitHub have separate histories, often because the GitHub repository was initialized with a README or license. This pull has not changed your files or checkpoints. Inspect the fetched GitHub files first. If they belong to this project, reconcile the histories once in Terminal from the project folder: git merge --allow-unrelated-histories FETCH_HEAD. Resolve any conflicts and finish the merge, then retry Push in Typeset.";
  }
  return `GitHub changes could not be applied without a merge. Your checkpoints are preserved. Resolve the branches with Git, then try again.\n${detail}`;
}

/** Git history stays on disk in the project's ordinary .git directory. */
export class GitService {
  private locks = new Map<string, Promise<unknown>>();

  private async serialize<T>(
    root: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = path.resolve(root);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  private baseArgs(): string[] {
    return [
      "--no-replace-objects",
      "-c",
      `core.hooksPath=${path.join(tmpdir(), `typeset-no-hooks-${randomUUID()}`)}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.sshCommand=ssh -oBatchMode=yes",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      "submodule.recurse=false",
      "-c",
      "credential.helper=",
    ];
  }

  private async raw(
    root: string,
    args: string[],
    extra: string[] = [],
    timeout = 120_000,
  ): Promise<string> {
    try {
      const result = await execute(
        "git",
        [...this.baseArgs(), ...extra, ...args],
        {
          cwd: root,
          env: gitEnvironment(),
          shell: false,
          windowsHide: true,
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return result.stdout;
    } catch (error) {
      const result = error as Error & {
        code?: number | string;
        stderr?: string;
        stdout?: string;
        killed?: boolean;
      };
      if (result.code === "ENOENT")
        throw new Error(
          "Git is not installed. Install the free Git command-line tools to use version history.",
        );
      // Never echo command arguments: a helper may have provided private credentials.
      const detail = (
        result.stderr ||
        result.stdout ||
        (result.killed
          ? "Git timed out. Check your connection and try again."
          : "The Git command failed.")
      )
        .trim()
        .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@");
      const httpsNetwork =
        ["clone", "fetch", "push"].includes(args[0]) &&
        args.some((argument) => argument.startsWith("https://github.com/"));
      throw new Error(
        gitFailureMessage(detail || "The Git command failed.", httpsNetwork),
      );
    }
  }

  private async optional(root: string, args: string[]): Promise<string> {
    try {
      return (await this.raw(root, args)).trim();
    } catch {
      return "";
    }
  }

  private async userConfig(key: "user.name" | "user.email"): Promise<string[]> {
    try {
      const result = await execute(
        "git",
        ["config", "--global", "--includes", "--null", "--get-all", key],
        {
          env: gitEnvironment(true),
          shell: false,
          windowsHide: true,
          timeout: 10_000,
        },
      );
      const values = result.stdout.split("\0");
      if (values.at(-1) === "") values.pop();
      return values;
    } catch {
      return [];
    }
  }

  private async safeArgs(root: string, network = false): Promise<string[]> {
    const result: string[] = [];
    // A project can contain .gitattributes; never run project-configured clean/smudge filters.
    const names = await this.optional(root, [
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ]);
    for (const name of new Set(names.split("\n").filter(Boolean)))
      result.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
    if (network) {
      const rewrites = await this.optional(root, [
        "config",
        "--name-only",
        "--get-regexp",
        "^url\\..*\\.(insteadof|pushinsteadof)$",
      ]);
      if (rewrites)
        throw new Error(
          "This repository uses Git URL rewriting. Remove its url.*.insteadOf/pushInsteadOf configuration before synchronizing in Typeset.",
        );
      // Replay only trusted system/global helper definitions, after the base args reset project helpers.
      result.push(...(await trustedCredentialHelperArguments(root)));
      result.push("-c", "http.followRedirects=false");
    }
    return result;
  }

  private async isRepository(root: string): Promise<boolean> {
    const top = await this.optional(root, ["rev-parse", "--show-toplevel"]);
    if (!top) return false;
    return (await realpath(root)) === (await realpath(top));
  }

  private async ensure(root: string): Promise<void> {
    if (!(await this.isRepository(root)))
      await this.raw(root, [
        "init",
        "--initial-branch=main",
        "--template=",
        ".",
      ]);
    await this.ensureDefaults(root);
  }

  private async ensureDefaults(root: string): Promise<void> {
    for (const [key, fallback] of [
      ["user.name", "Typeset User"],
      ["user.email", "typeset@localhost"],
    ] as const) {
      if (!(await this.optional(root, ["config", "--get", key]))) {
        const global = await this.userConfig(key);
        await this.raw(root, [
          "config",
          "--local",
          key,
          global.at(-1) || fallback,
        ]);
      }
    }
    const gitDir = path.resolve(
      root,
      (await this.raw(root, ["rev-parse", "--git-dir"])).trim(),
    );
    const exclude = path.join(gitDir, "info", "exclude");
    await mkdir(path.dirname(exclude), { recursive: true });
    let content = "";
    try {
      content = await readFile(exclude, "utf8");
    } catch {
      /* New repository. */
    }
    if (!content.split(/\r?\n/).includes("/.typeset/"))
      await appendFile(
        exclude,
        "\n# Typeset local compiler output and metadata\n/.typeset/\n",
      );
  }

  async status(root: string): Promise<GitStatus> {
    if (!(await this.isRepository(root)))
      return { ...EMPTY_STATUS, changes: [] };
    const output = await this.raw(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).typeset",
      ],
      await this.safeArgs(root),
    );
    const entries = output.split("\0").filter(Boolean);
    const changes: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      changes.push(
        `${entries[i].slice(0, 2).trim() || "M"}  ${entries[i].slice(3)}`,
      );
      if (/[RC]/.test(entries[i].slice(0, 2))) i++; // Porcelain -z adds a second path for renames/copies.
    }
    return {
      initialized: true,
      branch:
        (await this.optional(root, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])) || "detached",
      remote: await this.optional(root, [
        "config",
        "--get",
        "remote.origin.url",
      ]),
      changed: changes.length,
      changes,
    };
  }

  async versions(root: string): Promise<Version[]> {
    if (
      !(await this.isRepository(root)) ||
      !(await this.optional(root, ["rev-parse", "--verify", "HEAD"]))
    )
      return [];
    const log = await this.raw(root, [
      "log",
      "-100",
      "--format=%H%x00%s%x00%aI%x00%an%x00",
    ]);
    const fields = log.split("\0");
    const versions: Version[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4)
      versions.push({
        hash: fields[i].trim(),
        message: fields[i + 1],
        date: fields[i + 2],
        author: fields[i + 3],
      });
    return versions;
  }

  private async checkpointInternal(
    root: string,
    message: string,
  ): Promise<void> {
    const text = message.trim();
    if (!text || text.length > 1000)
      throw new Error(
        "Give this checkpoint a name between 1 and 1,000 characters.",
      );
    await this.ensure(root);
    const safe = await this.safeArgs(root);
    if ((await this.raw(root, ["ls-files", "--unmerged"])).trim())
      throw new Error(
        "Resolve the repository’s existing merge conflicts with Git before creating a checkpoint.",
      );
    // The reserved local directory must remain excluded even if an imported repository tracked it.
    await this.raw(
      root,
      ["rm", "-r", "--cached", "--ignore-unmatch", "--", ".typeset"],
      safe,
    );
    await this.raw(root, ["add", "-A", "--", "."], safe);
    const staged = await this.raw(
      root,
      ["diff", "--cached", "--name-only", "--no-ext-diff", "--no-textconv"],
      safe,
    );
    if (staged.trim())
      await this.raw(root, ["commit", "--no-verify", "-m", text], safe);
  }

  async checkpoint(root: string, message: string): Promise<Version[]> {
    return this.serialize(root, async () => {
      await this.checkpointInternal(root, message);
      return this.versions(root);
    });
  }

  private async commit(root: string, hash: string): Promise<string> {
    if (!/^[a-f0-9]{7,64}$/i.test(hash))
      throw new Error("Select a valid checkpoint from version history.");
    return (
      await this.raw(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${hash}^{commit}`,
      ])
    ).trim();
  }

  private async protectIgnoredFiles(
    root: string,
    target: string,
  ): Promise<void> {
    const ignored = (
      await this.raw(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(
        (name) => name && name !== ".typeset" && !name.startsWith(".typeset/"),
      );
    if (!ignored.length) return;
    const insensitive =
      (await this.optional(root, ["config", "--get", "core.ignorecase"])) ===
      "true";
    const normalize = (name: string) =>
      insensitive ? name.normalize("NFC").toLowerCase() : name;
    const targetFiles = (
      await this.raw(root, ["ls-tree", "-r", "--name-only", "-z", target])
    )
      .split("\0")
      .filter(Boolean)
      .map(normalize);
    const targetPaths = new Set(targetFiles);
    const targetDirectories = new Set(
      targetFiles.flatMap((name) =>
        name
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
    );
    for (const name of ignored) {
      const normalized = normalize(name);
      const ancestors = normalized
        .split("/")
        .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
      if (
        targetDirectories.has(normalized) ||
        ancestors.some((ancestor) => targetPaths.has(ancestor))
      ) {
        throw new Error(
          `The ignored local file “${name}” would be overwritten by this checkpoint. Move it out of the project before restoring; ignored files are not included in safety checkpoints.`,
        );
      }
    }
  }

  async diff(root: string, hash?: string): Promise<string> {
    if (!(await this.isRepository(root)))
      return "Create a checkpoint to start comparing changes.";
    const safe = await this.safeArgs(root);
    const args = ["--no-ext-diff", "--no-textconv", "--no-color"];
    if (hash)
      return this.raw(
        root,
        [
          "show",
          ...args,
          "--format=medium",
          await this.commit(root, hash),
          "--",
          ".",
          ":(exclude).typeset",
        ],
        safe,
      );
    const head = await this.optional(root, ["rev-parse", "--verify", "HEAD"]);
    let result = await this.raw(
      root,
      [
        "diff",
        ...args,
        ...(head ? ["HEAD"] : []),
        "--",
        ".",
        ":(exclude).typeset",
      ],
      safe,
    );
    const untracked = await this.raw(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ":(exclude).typeset",
    ]);
    if (untracked.trim())
      result += `\nNew files (included in the next checkpoint):\n${untracked}`;
    return result || "No changes since the last checkpoint.";
  }

  async restore(root: string, hash: string): Promise<void> {
    await this.serialize(root, async () => {
      if (!(await this.isRepository(root)))
        throw new Error("This project has no version history.");
      const target = await this.commit(root, hash);
      await this.raw(root, ["merge-base", "--is-ancestor", target, "HEAD"]);
      await this.protectIgnoredFiles(root, target);
      await this.checkpointInternal(
        root,
        `Safety checkpoint before restoring ${target.slice(0, 8)}`,
      );
      const safe = await this.safeArgs(root);
      await this.raw(
        root,
        [
          "restore",
          "--source",
          target,
          "--staged",
          "--worktree",
          "--",
          ".",
          ":(exclude).typeset",
        ],
        safe,
      );
      const staged = await this.raw(
        root,
        ["diff", "--cached", "--name-only", "--no-ext-diff", "--no-textconv"],
        safe,
      );
      if (staged.trim())
        await this.raw(
          root,
          [
            "commit",
            "--no-verify",
            "-m",
            `Restore checkpoint ${target.slice(0, 8)}`,
          ],
          safe,
        );
    });
  }

  async setRemote(root: string, value: string): Promise<GitStatus> {
    const url = validateGitHubUrl(value);
    return this.serialize(root, async () => {
      await this.ensure(root);
      if (await this.optional(root, ["config", "--get", "remote.origin.url"]))
        await this.raw(root, ["remote", "set-url", "origin", url]);
      else await this.raw(root, ["remote", "add", "origin", url]);
      return this.status(root);
    });
  }

  async clone(value: string, destination: string): Promise<void> {
    const url = validateGitHubUrl(value);
    await this.serialize(destination, async () => {
      const parent = path.dirname(destination);
      await mkdir(parent, { recursive: true });
      await this.raw(
        parent,
        [
          "clone",
          "--no-recurse-submodules",
          "--template=",
          "--",
          url,
          path.resolve(destination),
        ],
        await this.safeArgs(parent, true),
        300_000,
      );
      await this.ensureDefaults(destination);
    });
  }

  private async remoteAndBranch(
    root: string,
  ): Promise<{ url: string; branch: string }> {
    if (!(await this.isRepository(root)))
      throw new Error(
        "Create a checkpoint and connect a GitHub repository first.",
      );
    const remote = await this.optional(root, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    if (!remote) throw new Error("Connect a GitHub repository first.");
    const branch = await this.optional(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (!branch || branch.startsWith("-"))
      throw new Error(
        "Check out a branch before synchronizing this repository.",
      );
    return { url: validateGitHubUrl(remote), branch };
  }

  async push(root: string): Promise<string> {
    return this.serialize(root, async () => {
      const { url, branch } = await this.remoteAndBranch(root);
      if (!(await this.optional(root, ["rev-parse", "--verify", "HEAD"])))
        throw new Error("Create a checkpoint before pushing to GitHub.");
      const output = await this.raw(
        root,
        ["push", "--porcelain", "--", url, `HEAD:refs/heads/${branch}`],
        await this.safeArgs(root, true),
        300_000,
      );
      return output.trim() || "Checkpoints pushed to GitHub.";
    });
  }

  async pull(root: string): Promise<void> {
    await this.serialize(root, async () => {
      const { url, branch } = await this.remoteAndBranch(root);
      if ((await this.status(root)).changed)
        throw new Error(
          "Create a checkpoint of your local changes before pulling from GitHub.",
        );
      const safe = await this.safeArgs(root, true);
      await this.raw(
        root,
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          url,
          `refs/heads/${branch}`,
        ],
        safe,
        300_000,
      );
      try {
        await this.raw(
          root,
          [
            "merge",
            "--ff-only",
            "--no-edit",
            "--no-overwrite-ignore",
            "FETCH_HEAD",
          ],
          safe,
        );
      } catch (error) {
        throw new Error(gitPullFailureMessage((error as Error).message));
      }
    });
  }
}
