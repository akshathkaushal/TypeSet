import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitProxyUrl,
  systemGitEnvironment,
} from "../electron/services/gitProxy";

const execute = promisify(execFile);
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "typeset-proxy-test-"));
  env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  await execute("git", ["init"], { cwd: root, env });
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("system proxy for GitHub", () => {
  it.each([
    [
      "PROXY proxy.example:8080; PROXY backup.example:8080; DIRECT",
      "http://proxy.example:8080",
    ],
    ["HTTPS proxy.example:443", "https://proxy.example:443"],
    ["SOCKS5 [::1]:1080", "socks5h://[::1]:1080"],
    ["SOCKS proxy.example:1080", "socks4a://proxy.example:1080"],
    ["DIRECT; PROXY proxy.example:8080", undefined],
    ["PROXY user:password@proxy.example:80", undefined],
    ["PROXY proxy.example:65536", undefined],
    ["PROXY proxy.example:80/extra", undefined],
  ])("respects the first system route: %s", (routes, expected) => {
    expect(gitProxyUrl(routes)).toBe(expected);
  });

  it("scopes the proxy to GitHub, preserves inherited config, and never writes Git settings", async () => {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "color.ui";
    env.GIT_CONFIG_VALUE_0 = "never";
    const before = await readFile(path.join(root, ".git/config"), "utf8");
    const resolveProxy = vi.fn(async () => "PROXY proxy.example:8080; DIRECT");
    const prepared = await systemGitEnvironment(root, env, resolveProxy);
    expect(resolveProxy).toHaveBeenCalledWith("https://github.com/");
    const config = async (args: string[]) =>
      (
        await execute("git", ["config", ...args], { cwd: root, env: prepared })
      ).stdout.trim();
    expect(
      await config([
        "--get-urlmatch",
        "http.proxy",
        "https://github.com/owner/paper.git",
      ]),
    ).toBe("http://proxy.example:8080");
    await expect(
      config(["--get-urlmatch", "http.proxy", "https://example.org/paper.git"]),
    ).rejects.toMatchObject({ code: 1 });
    expect(await config(["--get", "color.ui"])).toBe("never");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(before);
  });

  it.each(["http://custom.example:3128", ""])(
    "preserves explicit Git proxy setting %j",
    async (value) => {
      await execute("git", ["config", "http.proxy", value], { cwd: root, env });
      const resolveProxy = vi.fn(async () => "PROXY proxy.example:8080");
      expect(await systemGitEnvironment(root, env, resolveProxy)).toEqual(env);
      expect(resolveProxy).not.toHaveBeenCalled();
    },
  );

  it("preserves explicit per-repository URL overrides over the automatic host setting", async () => {
    await execute(
      "git",
      [
        "config",
        "http.https://github.com/owner/paper.git.proxy",
        "http://custom.example:3128",
      ],
      { cwd: root, env },
    );
    const prepared = await systemGitEnvironment(
      root,
      env,
      async () => "PROXY proxy.example:8080",
    );
    const result = await execute(
      "git",
      [
        "config",
        "--get-urlmatch",
        "http.proxy",
        "https://github.com/owner/paper.git",
      ],
      { cwd: root, env: prepared },
    );
    expect(result.stdout.trim()).toBe("http://custom.example:3128");
  });

  it.each(["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"])(
    "preserves the user's %s environment",
    async (key) => {
      env[key] = "http://custom.example:3128";
      const resolveProxy = vi.fn(async () => "PROXY proxy.example:8080");
      expect(await systemGitEnvironment(root, env, resolveProxy)).toEqual(env);
      expect(resolveProxy).not.toHaveBeenCalled();
    },
  );

  it("keeps the terminal usable when proxy resolution fails", async () => {
    expect(
      await systemGitEnvironment(root, env, async () => {
        throw new Error("Network offline");
      }),
    ).toEqual(env);
    expect(await systemGitEnvironment(root, env, async () => "DIRECT")).toEqual(
      env,
    );
  });

  it("bounds the wait for a stalled PAC resolver", async () => {
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.useFakeTimers();
    const prepared = systemGitEnvironment(root, env, () => {
      entered();
      return new Promise<string>(() => {});
    });
    await called;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await prepared).toEqual(env);
  });
});
