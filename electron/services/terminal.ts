import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TerminalSession {
  id: string;
  root: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  running: boolean;
  output: string;
  sequence: number;
  exitCode?: number;
  signal?: number;
}
export interface TerminalDataEvent {
  id: string;
  root: string;
  data: string;
  sequence: number;
}
export interface TerminalExitEvent {
  id: string;
  root: string;
  exitCode: number;
  signal?: number;
  sequence: number;
}
interface Disposable {
  dispose(): void;
}
export interface TerminalPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string) => void): Disposable;
  onExit(
    callback: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
}
export interface TerminalSpawnOptions {
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
export type TerminalSpawner = (
  shell: string,
  args: string[],
  options: TerminalSpawnOptions,
) => TerminalPty;
export interface TerminalProcess {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
}
interface TerminalOptions {
  onData: (event: TerminalDataEvent) => void;
  onExit: (event: TerminalExitEvent) => void;
  /** Injectable system boundaries let tests avoid running commands in user projects. */
  spawn?: TerminalSpawner;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  userShell?: string;
  listProcesses?: () => Promise<TerminalProcess[]>;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  launchNative?: (file: string, args: string[], cwd: string) => Promise<void>;
}
interface LiveSession extends TerminalSession {
  boundRoot: string;
  pty: TerminalPty;
  pending: string;
  paused: boolean;
  ended: boolean;
  listeners: Disposable[];
  flushTimer?: ReturnType<typeof setTimeout>;
  termination?: Promise<void>;
  exited: Promise<void>;
  resolveExit: () => void;
}

const MAX_OUTPUT = 256 * 1024;
const MAX_PENDING = 256 * 1024;
const MAX_EVENT = 32 * 1024;
const PAUSE_AT = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

function runFile(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 2000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
async function listHostProcesses(): Promise<TerminalProcess[]> {
  // Process identity only; never inspect command lines, environments, or credentials.
  const output = await runFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="]);
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            started: match[4],
          },
        ]
      : [];
  });
}
export function descendantProcesses(
  processes: TerminalProcess[],
  rootPid: number,
): TerminalProcess[] {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (descendants.has(item.ppid) && !descendants.has(item.pid)) {
        descendants.add(item.pid);
        changed = true;
      }
    }
  }
  return processes.filter((item) => descendants.has(item.pid));
}
function rootKey(root: string): string {
  if (
    typeof root !== "string" ||
    !root ||
    root.includes("\0") ||
    !path.isAbsolute(root)
  )
    throw new Error("Open a project before starting its terminal.");
  return path.resolve(root);
}
function validateSize(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 500 ||
    rows > 500
  ) {
    throw new Error("Terminal dimensions must be integers between 1 and 500.");
  }
}
export function terminalEnvironment(
  environment: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (typeof value === "string") result[key] = value;
  // GUI applications often lack the PATH configured by an interactive shell.
  const delimiter = platform === "win32" ? ";" : ":";
  const additions =
    platform === "win32"
      ? []
      : [
          path.join(home, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ];
  result.PATH = [
    ...new Set([
      ...additions,
      ...(environment.PATH ?? "").split(delimiter).filter(Boolean),
    ]),
  ].join(delimiter);
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  result.TERM_PROGRAM = "Typeset";
  result.GIT_TERMINAL_PROMPT = "1";
  result.GCM_INTERACTIVE = "always";
  delete result.GH_PROMPT_DISABLED;
  delete result.ELECTRON_RUN_AS_NODE;
  delete result.ELECTRON_NO_ATTACH_CONSOLE;
  return result;
}

/** A host terminal, intentionally as capable as the user's ordinary terminal. */
export class TerminalService {
  private readonly options: TerminalOptions;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private active?: LiveSession;
  private readonly sessions = new Set<LiveSession>();
  private pendingStart?: { root: string; promise: Promise<TerminalSession> };
  private generation = 0;
  private disposed = false;

  constructor(options: TerminalOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
  }
  private snapshot(session: LiveSession): TerminalSession {
    const {
      id,
      root,
      shell,
      pid,
      cols,
      rows,
      running,
      output,
      sequence,
      exitCode,
      signal,
    } = session;
    return {
      id,
      root,
      shell,
      pid,
      cols,
      rows,
      running,
      output,
      sequence,
      exitCode,
      signal,
    };
  }
  status(root: string): TerminalSession | null {
    const key = rootKey(root);
    return this.active?.boundRoot === key ? this.snapshot(this.active) : null;
  }
  start(root: string, cols = 100, rows = 24): Promise<TerminalSession> {
    if (this.disposed)
      return Promise.reject(new Error("The terminal service has closed."));
    validateSize(cols, rows);
    const key = rootKey(root);
    if (this.active?.boundRoot === key && this.active.running) {
      this.resize(key, this.active.id, cols, rows);
      return Promise.resolve(this.snapshot(this.active));
    }
    if (this.pendingStart?.root === key) return this.pendingStart.promise;
    const generation = ++this.generation;
    const promise = this.startSession(key, cols, rows, generation).finally(
      () => {
        if (this.pendingStart?.promise === promise)
          this.pendingStart = undefined;
      },
    );
    this.pendingStart = { root: key, promise };
    return promise;
  }
  private async startSession(
    root: string,
    cols: number,
    rows: number,
    generation: number,
  ): Promise<TerminalSession> {
    const cwd = await realpath(root);
    if (!(await stat(cwd)).isDirectory())
      throw new Error("The terminal project directory no longer exists.");
    const checkCurrent = () => {
      if (this.disposed || generation !== this.generation)
        throw new Error(
          "Terminal startup was cancelled because the project changed.",
        );
    };
    checkCurrent();
    if (this.active) await this.terminate(this.active);
    checkCurrent();
    // Lazy loading permits mock tests even when the native module is rebuilt for Electron.
    let spawn = this.options.spawn;
    if (!spawn) {
      try {
        spawn = (await import("node-pty")).spawn;
      } catch {
        throw new Error(
          "The native terminal component is unavailable. Reinstall or rebuild Typeset, then reopen the terminal.",
        );
      }
    }
    checkCurrent();
    const shell = this.selectShell();
    const env = terminalEnvironment(
      this.environment,
      this.options.homeDirectory ?? os.homedir(),
      this.platform,
    );
    env.PWD = cwd;
    if (this.platform !== "win32") env.SHELL = shell;
    const pty = spawn(shell, this.platform === "win32" ? ["-NoLogo"] : ["-l"], {
      name: "xterm-256color",
      cwd,
      env,
      cols,
      rows,
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: LiveSession = {
      id: randomUUID(),
      boundRoot: root,
      root: cwd,
      shell,
      pid: pty.pid,
      cols,
      rows,
      running: true,
      output: "",
      sequence: 0,
      pty,
      pending: "",
      paused: false,
      ended: false,
      listeners: [],
      exited,
      resolveExit,
    };
    this.active = session;
    this.sessions.add(session);
    session.listeners.push(pty.onData((data) => this.receive(session, data)));
    session.listeners.push(
      pty.onExit((event) => this.finish(session, event.exitCode, event.signal)),
    );
    return this.snapshot(session);
  }
  private selectShell(): string {
    if (this.platform === "win32") {
      return path.win32.join(
        this.environment.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
    }
    let userShell = this.options.userShell;
    if (!userShell) {
      try {
        userShell = os.userInfo().shell ?? undefined;
      } catch {
        /* Fall back to the inherited shell. */
      }
    }
    const shell = userShell || this.environment.SHELL;
    return shell && path.isAbsolute(shell)
      ? shell
      : this.platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  }
  private requireSession(root: string, id: string): LiveSession {
    const session = this.active;
    if (
      typeof id !== "string" ||
      !session ||
      session.id !== id ||
      session.boundRoot !== rootKey(root)
    ) {
      throw new Error(
        "This terminal belongs to a different project or session. Reopen the current project's terminal.",
      );
    }
    return session;
  }
  write(root: string, id: string, data: string): void {
    const session = this.requireSession(root, id);
    if (!session.running || session.ended)
      throw new Error(
        "This terminal has ended. Start a new terminal to continue.",
      );
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES
    )
      throw new Error("Terminal input is limited to 64 KB per message.");
    if (data) session.pty.write(data);
  }
  resize(root: string, id: string, cols: number, rows: number): void {
    validateSize(cols, rows);
    const session = this.requireSession(root, id);
    if (!session.running || session.ended) return;
    if (session.cols === cols && session.rows === rows) return;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }
  private receive(session: LiveSession, data: string): void {
    if (session.ended) return;
    session.pending += data;
    if (session.pending.length > MAX_PENDING)
      session.pending =
        "\r\n[Earlier terminal output omitted]\r\n" +
        session.pending.slice(-MAX_PENDING + 64);
    if (!session.paused && session.pending.length >= PAUSE_AT) {
      try {
        session.pty.pause();
        session.paused = true;
      } catch {
        /* A closing PTY may have delivered its final chunk. */
      }
    }
    if (!session.flushTimer)
      session.flushTimer = setTimeout(() => this.flush(session), 16);
  }
  private flush(session: LiveSession, all = false): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    do {
      const data = session.pending.slice(0, MAX_EVENT);
      if (!data) break;
      session.pending = session.pending.slice(data.length);
      session.output = (session.output + data).slice(-MAX_OUTPUT);
      session.sequence++;
      this.options.onData({
        id: session.id,
        root: session.root,
        sequence: session.sequence,
        data,
      });
    } while (all && session.pending);
    if (session.paused && session.pending.length < PAUSE_AT / 2) {
      session.paused = false;
      if (!session.ended) {
        try {
          session.pty.resume();
        } catch {
          /* PTY can close during an exit flush. */
        }
      }
    }
    if (session.pending && !session.ended)
      session.flushTimer = setTimeout(() => this.flush(session), 16);
  }
  private finish(
    session: LiveSession,
    exitCode: number,
    signal?: number,
  ): void {
    if (session.ended) return;
    this.flush(session, true);
    session.ended = true;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.sequence++;
    for (const listener of session.listeners.splice(0)) listener.dispose();
    if (!session.termination) this.sessions.delete(session);
    session.resolveExit();
    this.options.onExit({
      id: session.id,
      root: session.root,
      exitCode,
      signal,
      sequence: session.sequence,
    });
  }
  async stop(root?: string, id?: string): Promise<void> {
    if ((root === undefined) !== (id === undefined))
      throw new Error(
        "Specify both the project and terminal session when stopping a terminal.",
      );
    const session =
      root !== undefined && id !== undefined
        ? this.requireSession(root, id)
        : this.active;
    this.generation++;
    this.pendingStart = undefined;
    if (session) await this.terminate(session);
  }
  private async processes(): Promise<TerminalProcess[]> {
    try {
      return await (this.options.listProcesses ?? listHostProcesses)();
    } catch {
      return [];
    }
  }
  private signal(pid: number, signal: NodeJS.Signals): void {
    if (Math.abs(pid) <= 1) return;
    try {
      (this.options.signalProcess ?? process.kill)(pid, signal);
    } catch {
      /* A process may already have exited. */
    }
  }
  private terminate(session: LiveSession): Promise<void> {
    if (session.termination) return session.termination;
    if (session.ended) return Promise.resolve();
    session.running = false;
    session.termination = (async () => {
      if (this.platform === "win32") {
        const taskkill = path.win32.join(
          this.environment.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        );
        await runFile(taskkill, [
          "/PID",
          String(session.pid),
          "/T",
          "/F",
        ]).catch(() => undefined);
      } else {
        const table = await this.processes();
        const targets = session.ended
          ? []
          : descendantProcesses(table, session.pid);
        const targetPids = new Set(targets.map((item) => item.pid));
        // Each PTY has its own session. Only signal groups led by this terminal
        // or an identified descendant; unrelated login shells are never targets.
        const groups = new Set(
          targets
            .filter((item) => targetPids.has(item.pgid))
            .map((item) => item.pgid),
        );
        if (!session.ended) groups.add(session.pid);
        for (const group of groups) this.signal(-group, "SIGHUP");
        for (const target of targets) this.signal(target.pid, "SIGHUP");
        try {
          session.pty.kill("SIGHUP");
        } catch {
          /* Already closed. */
        }
        if (targets.length > 1 || !session.ended)
          await new Promise((resolve) => setTimeout(resolve, 250));
        const surviving = await this.processes();
        // Recheck start times before forcing termination, guarding against PID reuse.
        const sameProcesses = targets.filter((old) =>
          surviving.some(
            (current) =>
              current.pid === old.pid && current.started === old.started,
          ),
        );
        const remaining = new Map<number, TerminalProcess>();
        for (const target of sameProcesses) {
          for (const descendant of descendantProcesses(surviving, target.pid))
            remaining.set(descendant.pid, descendant);
        }
        for (const target of remaining.values())
          this.signal(target.pid, "SIGKILL");
      }
      if (!session.ended) {
        try {
          session.pty.kill("SIGKILL");
        } catch {
          /* Already closed. */
        }
      }
      await Promise.race([
        session.exited,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
      if (!session.ended) this.finish(session, -1);
    })().finally(() => {
      this.sessions.delete(session);
    });
    return session.termination;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation++;
    this.pendingStart = undefined;
    await Promise.all(
      [...this.sessions].map((session) => this.terminate(session)),
    );
    this.active = undefined;
  }
  async openNativeTerminal(root: string): Promise<void> {
    const cwd = await realpath(rootKey(root));
    if (!(await stat(cwd)).isDirectory())
      throw new Error("The project directory no longer exists.");
    const launch =
      this.options.launchNative ??
      (async (file: string, args: string[], directory: string) => {
        await runFile(file, args, directory);
      });
    if (this.platform === "darwin")
      await launch("/usr/bin/open", ["-a", "Terminal", cwd], cwd);
    else if (this.platform === "win32")
      await launch("wt.exe", ["-d", cwd], cwd);
    else await launch("x-terminal-emulator", [], cwd);
  }
}
