import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TerminalService,
  terminalEnvironment,
  descendantProcesses,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalPty,
  type TerminalSpawner,
  type TerminalProcess,
} from "../electron/services/terminal";

const temporary: string[] = [];
const services: TerminalService[] = [];
async function fixture(name = "project") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "typeset-terminal-"));
  temporary.push(parent);
  const root = path.join(parent, name);
  await mkdir(root);
  return { parent, root: await realpath(root) };
}
class FakePty implements TerminalPty {
  pid: number;
  writes: string[] = [];
  sizes: number[][] = [];
  kills: (string | undefined)[] = [];
  paused = false;
  private data = new Set<(data: string) => void>();
  private exits = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  constructor(pid: number) {
    this.pid = pid;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  kill(signal?: string) {
    this.kills.push(signal);
    this.emitExit(0, signal === "SIGKILL" ? 9 : 1);
  }
  onData(callback: (data: string) => void) {
    this.data.add(callback);
    return {
      dispose: () => {
        this.data.delete(callback);
      },
    };
  }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exits.add(callback);
    return {
      dispose: () => {
        this.exits.delete(callback);
      },
    };
  }
  emitData(data: string) {
    for (const callback of this.data) callback(data);
  }
  emitExit(exitCode: number, signal?: number) {
    for (const callback of [...this.exits]) callback({ exitCode, signal });
  }
}
function service(
  overrides: Partial<ConstructorParameters<typeof TerminalService>[0]> = {},
) {
  const ptys: FakePty[] = [];
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const spawn = vi.fn<TerminalSpawner>(() => {
    const pty = new FakePty(12340 + ptys.length);
    ptys.push(pty);
    return pty;
  });
  const signalProcess = vi.fn();
  const instance = new TerminalService({
    onData: (event) => data.push(event),
    onExit: (event) => exits.push(event),
    spawn,
    platform: "darwin",
    environment: { PATH: "/usr/bin:/bin" },
    homeDirectory: "/home/example",
    userShell: "/bin/zsh",
    listProcesses: async () => [],
    signalProcess,
    ...overrides,
  });
  services.push(instance);
  return { instance, ptys, data, exits, spawn, signalProcess };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((item) => item.dispose()));
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("persistent host terminal", () => {
  it("starts a login shell in the project and reuses the same live session", async () => {
    const { root } = await fixture();
    const { instance, spawn, ptys } = service();
    const [first, second] = await Promise.all([
      instance.start(root, 100, 24),
      instance.start(root, 100, 24),
    ]);
    expect(first.id).toBe(second.id);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({
        cwd: root,
        cols: 100,
        rows: 24,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "1",
          TERM: "xterm-256color",
        }),
      }),
    );
    instance.write(root, first.id, "git status\r");
    instance.write(root, first.id, "\u0003");
    expect(ptys[0].writes).toEqual(["git status\r", "\u0003"]);
    expect((await instance.start(root, 120, 30)).id).toBe(first.id);
    expect(ptys[0].sizes).toEqual([[120, 30]]);
    expect(instance.status(root)?.cols).toBe(120);
  });

  it("bounds output and emits sequence numbers consistent with reconnect snapshots", async () => {
    const { root } = await fixture();
    const { instance, ptys, data, exits } = service();
    const started = await instance.start(root);
    vi.useFakeTimers();
    ptys[0].emitData("first prompt\r\n");
    expect(instance.status(root)?.output).toBe("");
    expect(instance.status(root)?.sequence).toBe(0);
    await vi.advanceTimersByTimeAsync(16);
    const snapshot = await instance.start(root);
    expect(snapshot.output).toBe("first prompt\r\n");
    expect(snapshot.sequence).toBe(data.at(-1)?.sequence);
    ptys[0].emitData("x".repeat(1024 * 1024));
    expect(ptys[0].paused).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(data.every((event) => event.data.length <= 32 * 1024)).toBe(true);
    expect(instance.status(root)!.output.length).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(ptys[0].paused).toBe(false);
    expect(data.map((event) => event.sequence)).toEqual(
      data.map((_event, index) => index + 1),
    );
    ptys[0].emitData("final output\r\n");
    ptys[0].emitExit(7);
    expect(instance.status(root)).toMatchObject({
      id: started.id,
      running: false,
      exitCode: 7,
    });
    expect(exits[0].sequence).toBe(data.at(-1)!.sequence + 1);
    expect(instance.status(root)?.sequence).toBe(exits[0].sequence);
    expect(instance.status(root)?.output.endsWith("final output\r\n")).toBe(
      true,
    );
  });

  it("validates input and dimensions and rejects stale input after project changes", async () => {
    const { root, parent } = await fixture();
    const other = path.join(parent, "second");
    await mkdir(other);
    const { instance, ptys } = service();
    const first = await instance.start(root);
    expect(() => instance.write(root, first.id, "x".repeat(65537))).toThrow(
      "64 KB",
    );
    expect(() => instance.resize(root, first.id, 0, 24)).toThrow("dimensions");
    expect(() => instance.resize(root, first.id, 80.5, 24)).toThrow(
      "dimensions",
    );
    expect(() => instance.resize(root, first.id, 80, Infinity)).toThrow(
      "dimensions",
    );
    const second = await instance.start(other);
    expect(second.id).not.toBe(first.id);
    expect(ptys[0].kills).toContain("SIGHUP");
    expect(instance.status(root)).toBeNull();
    expect(() => instance.write(other, first.id, "pwd\r")).toThrow(
      "different project or session",
    );
    expect(() => instance.write(root, first.id, "pwd\r")).toThrow(
      "different project or session",
    );
    await expect(instance.stop(other, first.id)).rejects.toThrow(
      "different project or session",
    );
    instance.write(other, second.id, "pwd\r");
    expect(ptys[0].writes).toEqual([]);
    expect(ptys[1].writes).toEqual(["pwd\r"]);
    await instance.stop(other, second.id);
    const restarted = await instance.start(other);
    expect(restarted.id).not.toBe(second.id);
    expect(ptys).toHaveLength(3);
  });

  it("cancels startup if the project changes and never spawns after disposal", async () => {
    const { root } = await fixture();
    const { instance, spawn } = service();
    const starting = instance.start(root);
    await instance.stop();
    await expect(starting).rejects.toThrow("cancelled");
    expect(spawn).not.toHaveBeenCalled();
    await instance.dispose();
    await expect(instance.start(root)).rejects.toThrow("closed");
  });

  it("stops descendant process groups without touching unrelated shells or reused PIDs", async () => {
    const { root } = await fixture();
    const initial: TerminalProcess[] = [
      { pid: 12340, ppid: 500, pgid: 12340, started: "shell-start" },
      { pid: 12341, ppid: 12340, pgid: 12341, started: "job-start" },
      { pid: 12342, ppid: 12341, pgid: 12341, started: "grandchild-start" },
      { pid: 999, ppid: 1, pgid: 999, started: "unrelated-shell" },
    ];
    const later = [
      { pid: 12341, ppid: 1, pgid: 12341, started: "job-start" },
      {
        pid: 12342,
        ppid: 1,
        pgid: 12342,
        started: "new-process-with-reused-pid",
      },
      initial[3],
    ];
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(later);
    const { instance, signalProcess } = service({ listProcesses });
    await instance.start(root);
    await instance.dispose();
    expect(signalProcess).toHaveBeenCalledWith(-12340, "SIGHUP");
    expect(signalProcess).toHaveBeenCalledWith(-12341, "SIGHUP");
    expect(signalProcess).toHaveBeenCalledWith(12341, "SIGKILL");
    expect(signalProcess).not.toHaveBeenCalledWith(12342, "SIGKILL");
    expect(
      signalProcess.mock.calls.every(
        ([pid]) => Math.abs(pid) !== 999 && Math.abs(pid) !== 500,
      ),
    ).toBe(true);
    expect(descendantProcesses(initial, 12340).map((item) => item.pid)).toEqual(
      [12340, 12341, 12342],
    );
  });
});

describe("terminal platform integration", () => {
  it("opens Mac Terminal with the complete project path as a separate argument", async () => {
    const { root } = await fixture('paper "quoted"; $(not-a-command)');
    const launchNative = vi.fn(async () => {});
    const { instance } = service({ launchNative });
    await instance.openNativeTerminal(root);
    expect(launchNative).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "Terminal", root],
      root,
    );
  });

  it("provides local CLI paths and preserves interactive auth without reading credentials", () => {
    const env = terminalEnvironment(
      {
        PATH: "/bin:/custom/bin",
        ELECTRON_RUN_AS_NODE: "1",
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        SSH_AUTH_SOCK: "/example/socket",
      },
      "/home/example",
      "darwin",
    );
    expect(env.PATH.split(":")).toContain("/home/example/.local/bin");
    expect(env.PATH.split(":")).toContain("/opt/homebrew/bin");
    expect(env.PATH.split(":")).toContain("/custom/bin");
    expect(env.GIT_TERMINAL_PROMPT).toBe("1");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBe("/example/socket");
  });

  it("uses PowerShell on Windows", async () => {
    const { root } = await fixture();
    const { instance, spawn, ptys } = service({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" },
    });
    await instance.start(root);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo"],
      expect.objectContaining({ cwd: root }),
    );
    ptys[0].emitExit(0);
  });
});
