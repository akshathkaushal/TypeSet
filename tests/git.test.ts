import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitService,
  gitFailureMessage,
  gitPullFailureMessage,
  trustedCredentialArgumentsFromConfig,
  trustedCredentialHelperArguments,
  validateGitHubUrl,
} from "../electron/services/git";

const execute = promisify(execFile);
let root: string;
let git: GitService;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "typeset-git-test-"));
  git = new GitService();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local Git history", () => {
  it("creates portable checkpoints without generated compiler files", async () => {
    expect((await git.status(root)).initialized).toBe(false);
    await writeFile(path.join(root, "main.tex"), "First document\n");
    await mkdir(path.join(root, ".typeset"));
    await writeFile(path.join(root, ".typeset", "output.pdf"), "generated PDF");
    const versions = await git.checkpoint(root, "First version");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ message: "First version" });
    expect(versions[0].author).toBeTruthy();
    expect((await git.status(root)).changed).toBe(0);
    const tracked = await execute("git", ["ls-files"], { cwd: root });
    expect(tracked.stdout).toBe("main.tex\n");
    await writeFile(path.join(root, "main.tex"), "Second document\n");
    const state = await git.status(root);
    expect(state.changed).toBe(1);
    expect(state.changes[0]).toContain("main.tex");
    expect(await git.diff(root)).toContain("+Second document");
  });

  it("restores through new commits and keeps unsaved work in a safety checkpoint", async () => {
    await writeFile(path.join(root, "main.tex"), "First\n");
    const [first] = await git.checkpoint(root, "First");
    await writeFile(path.join(root, "main.tex"), "Second\n");
    await writeFile(path.join(root, "second.tex"), "New chapter");
    const [second] = await git.checkpoint(root, "Second");
    await writeFile(path.join(root, "main.tex"), "Unsaved changes\n");
    await writeFile(path.join(root, "notes.txt"), "Untracked notes");
    await git.restore(root, first.hash);
    expect(await readFile(path.join(root, "main.tex"), "utf8")).toBe("First\n");
    const history = await git.versions(root);
    expect(history).toHaveLength(4);
    expect(history[0].message).toContain("Restore checkpoint");
    expect(history[1].message).toContain("Safety checkpoint");
    expect(history.some((version) => version.hash === second.hash)).toBe(true);
    expect(await git.diff(root, history[1].hash)).toContain("Unsaved changes");
    expect((await git.status(root)).changed).toBe(0);
    await git.restore(root, history[1].hash);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe(
      "Untracked notes",
    );
  });

  it("does not create duplicate checkpoints when nothing changed", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await git.checkpoint(root, "First");
    expect(await git.checkpoint(root, "No changes")).toHaveLength(1);
  });

  it("protects ignored local files that an old checkpoint would overwrite", async () => {
    await writeFile(path.join(root, "main.tex"), "Original");
    await writeFile(path.join(root, "notes.txt"), "Original notes");
    const [first] = await git.checkpoint(root, "First");
    await rm(path.join(root, "notes.txt"));
    await writeFile(path.join(root, ".gitignore"), "notes.txt\n");
    await git.checkpoint(root, "Stop tracking private notes");
    await writeFile(path.join(root, "notes.txt"), "Private local notes");
    await expect(git.restore(root, first.hash)).rejects.toThrow(
      "ignored local file",
    );
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe(
      "Private local notes",
    );
    expect(await git.versions(root)).toHaveLength(2);
  });

  it("rejects option-like and unknown revision inputs", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await git.checkpoint(root, "First");
    await expect(git.restore(root, "--help")).rejects.toThrow(
      "valid checkpoint",
    );
    await expect(git.diff(root, "HEAD")).rejects.toThrow("valid checkpoint");
    await expect(git.restore(root, "deadbeef")).rejects.toThrow();
  });

  it("does not use a parent folder repository as project history", async () => {
    await writeFile(path.join(root, "parent.txt"), "Parent");
    await git.checkpoint(root, "Parent");
    const child = path.join(root, "child");
    await mkdir(child);
    await writeFile(path.join(child, "main.tex"), "Child");
    expect((await git.status(child)).initialized).toBe(false);
    expect(await git.versions(child)).toEqual([]);
    const versions = await git.checkpoint(child, "Child");
    expect(versions).toHaveLength(1);
    expect(versions[0].message).toBe("Child");
    expect((await git.versions(root))[0].message).toBe("Parent");
  });

  it("disables repository hooks and clean filters", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await git.checkpoint(root, "First");
    const marker = path.join(root, "executed-hook");
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o755);
    await execute(
      "git",
      [
        "config",
        "--local",
        "filter.typesetTest.clean",
        `sh -c "touch '${marker}'; cat"`,
      ],
      { cwd: root },
    );
    await execute(
      "git",
      ["config", "--local", "filter.typesetTest.required", "true"],
      { cwd: root },
    );
    await writeFile(
      path.join(root, ".gitattributes"),
      "*.tex filter=typesetTest\n",
    );
    await writeFile(path.join(root, "main.tex"), "Modified");
    await git.status(root);
    await git.checkpoint(root, "Second");
    await expect(access(marker)).rejects.toThrow();
    expect(await readFile(path.join(root, "main.tex"), "utf8")).toBe(
      "Modified",
    );
  });

  it("sets a GitHub remote but refuses pulling over local edits before networking", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await git.checkpoint(root, "First");
    const state = await git.setRemote(
      root,
      "https://github.com/example/paper.git",
    );
    expect(state.remote).toBe("https://github.com/example/paper.git");
    await writeFile(path.join(root, "main.tex"), "Local edits");
    await expect(git.pull(root)).rejects.toThrow(
      "checkpoint of your local changes",
    );
  });

  it("rejects repository URL rewrites before remote operations", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await git.checkpoint(root, "First");
    await git.setRemote(root, "https://github.com/example/paper.git");
    await execute(
      "git",
      ["config", "--local", "url.ext::unsafe.insteadOf", "https://github.com/"],
      { cwd: root },
    );
    await expect(git.push(root)).rejects.toThrow("URL rewriting");
  });

  it("serializes checkpoints so parallel requests keep a valid index", async () => {
    await writeFile(path.join(root, "main.tex"), "Document");
    await Promise.all([
      git.checkpoint(root, "First"),
      git.checkpoint(root, "Second"),
    ]);
    expect(await git.versions(root)).toHaveLength(1);
  });
});

describe("GitHub URL validation", () => {
  it.each([
    "https://github.com/owner/project.git",
    "git@github.com:owner/project.git",
    "https://github.com/owner/project",
  ])("accepts %s", (value) => {
    expect(validateGitHubUrl(value)).toBe(value);
  });
  it.each([
    "file:///tmp/repository",
    "ext::sh -c evil",
    "--upload-pack=sh",
    "https://github.com.evil.test/owner/project",
    "https://token@github.com/owner/project",
    "https://github.com/owner/project?token=secret",
    "git@evil.test:owner/project",
    "https://github.com/../project",
    "https://github.com/owner/..",
  ])("rejects %s", (value) => {
    expect(() => validateGitHubUrl(value)).toThrow();
  });
});

describe("trusted Git credential helper configuration", () => {
  it("accepts only Apple's exact installation defaults in the unknown scope and preserves a later global reset", () => {
    const appleConfig =
      "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig";
    const entry = (
      scope: string,
      filename: string,
      key: string,
      value: string,
    ) => `${scope}\0file:${filename}\0${key}\n${value}\0`;
    const configuration = [
      entry("unknown", appleConfig, "credential.helper", "osxkeychain"),
      entry(
        "unknown",
        "/project/.git/config",
        "credential.helper",
        "untrusted-unknown",
      ),
      entry("system", "/etc/gitconfig", "credential.helper", "system-fixture"),
      entry("global", "/user/.gitconfig", "credential.helper", ""),
      entry(
        "global",
        "/user/.gitconfig",
        "credential.https://github.com.helper",
        "global-fixture",
      ),
      entry("local", appleConfig, "credential.helper", "untrusted-local"),
      entry(
        "worktree",
        "/project/.git/config.worktree",
        "credential.helper",
        "untrusted-worktree",
      ),
      entry(
        "command",
        "command line",
        "credential.helper",
        "untrusted-command",
      ),
    ].join("");
    expect(
      trustedCredentialArgumentsFromConfig(configuration, appleConfig),
    ).toEqual([
      "-c",
      "credential.helper=osxkeychain",
      "-c",
      "credential.helper=system-fixture",
      "-c",
      "credential.helper=",
      "-c",
      "credential.https://github.com.helper=global-fixture",
    ]);
    expect(
      trustedCredentialArgumentsFromConfig(
        entry("unknown", appleConfig, "credential.helper", "osxkeychain"),
      ),
    ).toEqual([]);
  });

  async function configuration() {
    const system = path.join(root, "system.gitconfig");
    const global = path.join(root, "global.gitconfig");
    await Promise.all([writeFile(system, ""), writeFile(global, "")]);
    return { system, global };
  }

  async function append(filename: string, key: string, value: string) {
    await execute("git", ["config", "--file", filename, "--add", key, value]);
  }

  // These fixtures only append a marker. They return no username, password, or token.
  function markerHelper(label: string, marker: string) {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    return `!f() { printf '%s\\n' ${quote(label)} >> ${quote(marker)}; }; f`;
  }

  async function exerciseHelpers(
    args: string[],
    host = "github.com",
    projectPath = "owner/paper.git",
  ) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ASKPASS = "";
    // Entirely offline plumbing with synthetic configuration; no system helper can execute.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-c", "credential.helper=", ...args, "credential", "fill"],
        { cwd: root, env, shell: false, windowsHide: true, timeout: 10_000 },
        (error, stdout) => {
          if (stdout) {
            reject(
              new Error(
                "The marker-only fixture unexpectedly returned credentials.",
              ),
            );
            return;
          }
          if (!error) {
            reject(
              new Error("The marker-only fixture unexpectedly authenticated."),
            );
            return;
          }
          resolve();
        },
      );
      child.stdin!.end(`protocol=https\nhost=${host}\npath=${projectPath}\n\n`);
    });
  }

  it("uses a system helper when no global helper exists and never uses project helpers", async () => {
    const files = await configuration();
    const marker = path.join(root, "helper-markers");
    await execute("git", ["init", "--template=", "."], { cwd: root });
    await execute(
      "git",
      [
        "config",
        "--local",
        "credential.https://github.com.helper",
        markerHelper("untrusted-project", marker),
      ],
      { cwd: root },
    );
    await append(
      files.system,
      "credential.helper",
      markerHelper("trusted-system", marker),
    );
    const args = await trustedCredentialHelperArguments(root, files);
    await exerciseHelpers(args);
    expect(await readFile(marker, "utf8")).toBe("trusted-system\n");
  });

  it("preserves multiple helpers, global empty resets, and URL-scoped selection", async () => {
    const files = await configuration();
    const marker = path.join(root, "helper-markers");
    await append(
      files.system,
      "credential.helper",
      markerHelper("system", marker),
    );
    await append(files.global, "credential.https://github.com.helper", "");
    await append(
      files.global,
      "credential.https://github.com.helper",
      markerHelper("global-first", marker),
    );
    await append(
      files.global,
      "credential.https://github.com.helper",
      markerHelper("global-second", marker),
    );
    await append(
      files.global,
      "credential.https://example.com.helper",
      markerHelper("other-host", marker),
    );
    await append(
      files.global,
      "credential.https://github.com/special.helper",
      "",
    );
    await append(
      files.global,
      "credential.https://github.com/special.helper",
      markerHelper("specific-path", marker),
    );
    const args = await trustedCredentialHelperArguments(root, files);
    await exerciseHelpers(args);
    expect(await readFile(marker, "utf8")).toBe(
      "global-first\nglobal-second\n",
    );
    await writeFile(marker, "");
    await exerciseHelpers(args, "github.com", "special/paper.git");
    expect(await readFile(marker, "utf8")).toBe("specific-path\n");
  });

  it("honors explicit includes in trusted configuration without reading unrelated configuration values", async () => {
    const files = await configuration();
    const included = path.join(root, "included.gitconfig");
    await writeFile(included, "");
    await append(files.system, "credential.helper", "system-fixture");
    await append(files.global, "include.path", included);
    await append(included, "credential.helper", "");
    await append(
      included,
      "credential.https://github.com.helper",
      "global-fixture",
    );
    await append(included, "core.hooksPath", "/unrelated-hook");
    await append(
      included,
      "http.extraHeader",
      "Unrelated-Test-Header: fixture",
    );
    expect(await trustedCredentialHelperArguments(root, files)).toEqual([
      "-c",
      "credential.helper=system-fixture",
      "-c",
      "credential.helper=",
      "-c",
      "credential.https://github.com.helper=global-fixture",
    ]);
  });

  it("supports an empty helper configuration", async () => {
    expect(
      await trustedCredentialHelperArguments(root, await configuration()),
    ).toEqual([]);
  });
});

describe("GitHub authentication guidance", () => {
  it.each([
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: could not read Password for 'https://someone@github.com': No such device or address",
  ])("explains one-time sign-in for %s", (detail) => {
    const message = gitFailureMessage(detail, true);
    expect(message).toContain("HTTPS sign-in is required");
    expect(message).toContain(
      "gh auth login --hostname github.com --git-protocol https --web",
    );
    expect(message).toContain("gh auth setup-git --hostname github.com");
    expect(message).toContain("local versions are unchanged");
  });

  it("distinguishes rejected credentials and preserves unrelated Git errors", () => {
    expect(
      gitFailureMessage(
        "fatal: Authentication failed for 'https://github.com/owner/paper.git'",
        true,
      ),
    ).toContain("rejected the saved HTTPS credentials");
    expect(gitFailureMessage("fatal: repository not found", true)).toBe(
      "fatal: repository not found",
    );
    expect(gitFailureMessage("Permission denied (publickey).", false)).toBe(
      "Permission denied (publickey).",
    );
  });
});

describe("GitHub pull guidance", () => {
  it("explains separately initialized histories and a reviewed one-time reconciliation", () => {
    const message = gitPullFailureMessage(
      "fatal: refusing to merge unrelated histories",
    );
    expect(message).toContain("separate histories");
    expect(message).toContain("README or license");
    expect(message).toContain("not changed your files or checkpoints");
    expect(message).toContain("Inspect the fetched GitHub files first");
    expect(message).toContain(
      "git merge --allow-unrelated-histories FETCH_HEAD",
    );
    expect(message).toContain("retry Push");
    expect(message).not.toContain("--force");
  });

  it("keeps ordinary divergent-history errors separate from unrelated histories", () => {
    const detail = "fatal: Not possible to fast-forward, aborting.";
    const message = gitPullFailureMessage(detail);
    expect(message).toContain("checkpoints are preserved");
    expect(message).toContain(detail);
    expect(message).not.toContain("--allow-unrelated-histories");
  });
});
