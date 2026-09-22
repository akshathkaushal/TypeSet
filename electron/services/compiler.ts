import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type {
  CompileResult,
  CompilerStatus,
  Diagnostic,
  Engine,
} from "../../shared/types";

export const COMPILER_IMAGE = "localhost/typeset-tex:1";
export const COMPILER_REVISION = "2";
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 10_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const AUX_EXTENSIONS =
  /\.(aux|bbl|bcf|blg|fdb_latexmk|fls|idx|ilg|ind|lof|log|lot|nav|out|run\.xml|snm|toc|vrb)$/i;
const OMIT_DIRECTORIES = new Set([
  ".git",
  ".typeset",
  "node_modules",
  ".DS_Store",
]);

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}
export type CommandRunner = (
  executable: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** No command is executed through a host shell. Output and run time are bounded. */
export const runCommand: CommandRunner = async (
  executable,
  args,
  options = {},
) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: 130, stdout: "", stderr: "Compilation cancelled." });
      return;
    }
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const append = (chunk: Buffer, isError: boolean) => {
      const text = chunk.toString("utf8");
      options.onOutput?.(text);
      if (isError) stderr = (stderr + text).slice(-MAX_LOG_BYTES);
      else stdout = (stdout + text).slice(-MAX_LOG_BYTES);
    };
    const abort = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => append(chunk, false));
    child.stderr.on("data", (chunk) => append(chunk, true));
    const finish = (code: number, error = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr: stderr + error });
    };
    child.once("error", (error) => finish(127, error.message));
    child.once("close", (code) =>
      finish(
        options.signal?.aborted ? 130 : timedOut ? 124 : (code ?? 1),
        timedOut
          ? "\nCommand timed out."
          : options.signal?.aborted
            ? "\nCompilation cancelled."
            : "",
      ),
    );
  });

/** Paths remain project-relative, including when a nested file reports an error. */
export function parseDiagnostics(log: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const lines = log.replace(/\r/g, "").split("\n");
  const add = (diagnostic: Diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key) && diagnostics.length < 200) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const located = line.match(
      /^(.+?\.(?:tex|bib|sty|cls|ltx)):(\d+):\s*(.+)$/i,
    );
    if (located) {
      let file = located[1]
        .replace(/^\/workspace\/project\//, "")
        .replace(/^\.\//, "");
      if (file.startsWith("/") || file.split("/").includes("..")) file = "";
      add({
        file: file || undefined,
        line: Number(located[2]),
        message: located[3],
        severity: /warning/i.test(located[3]) ? "warning" : "error",
      });
    } else if (/^!\s/.test(line)) {
      const following = lines
        .slice(i + 1, i + 6)
        .find((item) => /^l\.\d+/.test(item.trim()));
      add({
        line: following
          ? Number(following.trim().match(/^l\.(\d+)/)?.[1])
          : undefined,
        message: line.replace(/^!\s*/, ""),
        severity: "error",
      });
    } else if (/^(?:LaTeX|Package .+?|Class .+?|pdfTeX) Warning:/.test(line)) {
      const location = line.match(/on input line (\d+)/);
      add({
        line: location ? Number(location[1]) : undefined,
        message: line,
        severity: "warning",
      });
    } else if (/^(?:Overfull|Underfull) \\[hv]box/.test(line)) {
      add({ message: line, severity: "warning" });
    }
  }
  return diagnostics;
}

export function validateMainFile(mainFile: string): string {
  const normalized = mainFile.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\x00-\x1f]/.test(normalized) ||
    normalized
      .split("/")
      .some((part) => part === ".." || part === "." || !part) ||
    !/\.tex$/i.test(normalized)
  ) {
    throw new Error("Select a .tex main document inside the project.");
  }
  // latexmk invokes TeX through an in-container shell with quoted file names.
  // Do not permit expansion characters to turn a filename into a command.
  if (/["`$]/.test(normalized))
    throw new Error(
      "Rename the main document to remove double quotes, backticks, or dollar signs before compiling.",
    );
  return normalized;
}

/** Stage a fresh snapshot so deleting a source file cannot leave a stale copy. */
export async function stageProject(
  root: string,
  destination: string,
  options: { maxBytes?: number; maxFiles?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const canonicalRoot = await realpath(root);
  await mkdir(destination, { recursive: true });
  // macOS /var and /tmp are symlinks: compare canonical paths on both sides.
  const canonicalDestination = await realpath(destination);
  if (
    canonicalDestination === canonicalRoot ||
    canonicalDestination.startsWith(canonicalRoot + path.sep)
  ) {
    throw new Error("Compiler staging must be outside the project.");
  }
  let bytes = 0;
  let count = 0;
  const visit = async (relative: string) => {
    if (options.signal?.aborted) throw new Error("Compilation cancelled.");
    for (const entry of await readdir(path.join(canonicalRoot, relative), {
      withFileTypes: true,
    })) {
      if (
        OMIT_DIRECTORIES.has(entry.name) ||
        entry.name === ".latexmkrc" ||
        entry.name === "latexmkrc"
      )
        continue;
      const source = path.join(canonicalRoot, relative, entry.name);
      const target = path.join(destination, relative, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true });
        await visit(path.join(relative, entry.name));
      } else if (entry.isFile()) {
        // O_NOFOLLOW prevents a replaced final symlink from importing a host file.
        const file = await open(
          source,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const info = await file.stat();
          const actual = await realpath(source);
          if (!actual.startsWith(canonicalRoot + path.sep) || !info.isFile())
            throw new Error(
              "A project file changed while taking its snapshot. Try compiling again.",
            );
          bytes += info.size;
          count++;
          if (bytes > (options.maxBytes ?? MAX_PROJECT_BYTES))
            throw new Error(
              "This project exceeds the 100 MB compilation limit.",
            );
          if (count > (options.maxFiles ?? MAX_FILE_COUNT))
            throw new Error(
              "This project exceeds the 10,000 file compilation limit.",
            );
          // Read through the verified handle instead of reopening a mutable path.
          const content = await file.readFile();
          const output = await open(target, "wx", 0o644);
          try {
            await output.writeFile(content);
          } finally {
            await output.close();
          }
        } finally {
          await file.close();
        }
      }
    }
  };
  await visit("");
}

export function containerArguments(
  name: string,
  engine: Engine,
  mainFile: string,
): string[] {
  if (!["pdflatex", "xelatex", "lualatex"].includes(engine))
    throw new Error("Unsupported LaTeX engine.");
  return [
    "create",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--read-only-tmpfs=false",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1536m",
    "--cpus=1",
    "--ulimit=fsize=104857600:104857600",
    "--user=1000:1000",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--mount=type=volume,destination=/workspace",
    COMPILER_IMAGE,
    engine,
    validateMainFile(mainFile),
  ];
}

interface CompilerOptions {
  compilerDir: string;
  cacheDir: string;
  onLog: (line: string) => void;
  /** Explicit path and injected runner support packaged installations and integration tests. */
  podmanPath?: string;
  runner?: CommandRunner;
}
interface ActiveCompilation {
  id: string;
  name: string;
  abort: AbortController;
  done?: Promise<CompileResult>;
}

export class CompilerService {
  private readonly options: CompilerOptions;
  private readonly runner: CommandRunner;
  private executable?: string;
  private active?: ActiveCompilation;
  private setupPromise?: Promise<CompilerStatus>;
  private readonly pdfPaths = new Map<string, string>();

  constructor(options: CompilerOptions) {
    this.options = options;
    this.runner = options.runner ?? runCommand;
    this.executable = options.podmanPath;
  }

  private projectCache(root: string): string {
    return path.join(
      this.options.cacheDir,
      createHash("sha256")
        .update(path.resolve(root))
        .digest("hex")
        .slice(0, 24),
    );
  }
  private async findPodman(): Promise<string | undefined> {
    if (this.executable) return this.executable;
    const binary = process.platform === "win32" ? "podman.exe" : "podman";
    const candidates = [
      process.env.TYPESET_PODMAN_PATH,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary)),
      "/opt/podman/bin/podman",
      "/opt/homebrew/bin/podman",
      "/usr/local/bin/podman",
      "/usr/bin/podman",
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, "RedHat", "Podman", binary)
        : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        this.executable = candidate;
        return candidate;
      } catch {
        /* next installation */
      }
    }
    return undefined;
  }
  private async command(
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const executable = await this.findPodman();
    if (!executable)
      throw new Error(
        "Podman is not installed. Install the free Podman application, then run compiler setup.",
      );
    return this.runner(executable, args, options);
  }
  private async checked(
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const result = await this.command(args, options);
    if (result.code !== 0)
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Podman command failed (${result.code}).`,
      );
    return result;
  }

  async status(): Promise<CompilerStatus> {
    if (!(await this.findPodman()))
      return {
        installed: false,
        running: false,
        imageReady: false,
        message: "Install free Podman, then set up the TeX Live compiler.",
      };
    const info = await this.command(["info", "--format=json"], {
      timeoutMs: 10_000,
    });
    if (info.code !== 0)
      return {
        installed: true,
        running: false,
        imageReady: false,
        message:
          "Podman is installed but its engine is not running. Start your Podman machine, then try setup.",
      };
    const image = await this.command(["image", "exists", COMPILER_IMAGE], {
      timeoutMs: 10_000,
    });
    const revision =
      image.code === 0
        ? await this.command(
            [
              "image",
              "inspect",
              '--format={{ index .Labels "org.typeset.compiler-revision" }}',
              COMPILER_IMAGE,
            ],
            { timeoutMs: 10_000 },
          )
        : undefined;
    const imageReady =
      image.code === 0 &&
      revision?.code === 0 &&
      revision.stdout.trim() === COMPILER_REVISION;
    return {
      installed: true,
      running: true,
      imageReady,
      message: imageReady
        ? "TeX Live is ready. Compilation works offline."
        : image.code === 0
          ? "The TeX Live compiler needs an update. Run compiler setup to install the latest free packages."
          : "Podman is ready. Set up the free TeX Live compiler (a one-time download).",
    };
  }

  async setup(): Promise<CompilerStatus> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.performSetup().finally(() => {
      this.setupPromise = undefined;
    });
    return this.setupPromise;
  }
  private async performSetup(): Promise<CompilerStatus> {
    let state = await this.status();
    if (!state.installed) throw new Error(state.message);
    const output = (chunk: string) => this.options.onLog(chunk);
    if (
      !state.running &&
      (process.platform === "darwin" || process.platform === "win32")
    ) {
      const list = await this.checked(["machine", "list", "--format=json"]);
      const machines = JSON.parse(list.stdout) as {
        Name: string;
        Running: boolean;
        Starting?: boolean;
        Default?: boolean;
      }[];
      const machine = machines.find((item) => item.Default) ?? machines[0];
      if (!machine) {
        output("Creating a Podman machine for local compilation…\n");
        await this.checked(["machine", "init", "--cpus=2", "--memory=2048"], {
          timeoutMs: 20 * 60_000,
          onOutput: output,
        });
      } else if (machine.Starting) {
        throw new Error(
          "Your Podman machine reports that it is still starting. Finish or repair its startup in Podman, then retry setup.",
        );
      }
      output("Starting the Podman machine…\n");
      await this.checked(
        ["machine", "start", ...(machine ? [machine.Name] : [])],
        { timeoutMs: 180_000, onOutput: output },
      );
      state = await this.status();
    }
    if (!state.running) throw new Error(state.message);
    if (!state.imageReady) {
      output(
        "Downloading and building TeX Live. The first setup can take several minutes.\n",
      );
      await this.checked(
        [
          "build",
          "--tag",
          COMPILER_IMAGE,
          "--file",
          path.join(this.options.compilerDir, "Containerfile"),
          this.options.compilerDir,
        ],
        { timeoutMs: 30 * 60_000, onOutput: output },
      );
    }
    return this.status();
  }

  async compile(
    root: string,
    mainFile: string,
    engine: Engine,
  ): Promise<CompileResult> {
    if (this.active)
      throw new Error(
        "A compilation is already running. Wait for it or cancel it first.",
      );
    const id = randomUUID();
    const job: ActiveCompilation = {
      id,
      name: `typeset-${id}`,
      abort: new AbortController(),
    };
    this.active = job;
    job.done = this.performCompile(job, root, mainFile, engine).finally(() => {
      if (this.active === job) this.active = undefined;
    });
    return job.done;
  }
  private async performCompile(
    job: ActiveCompilation,
    root: string,
    mainFile: string,
    engine: Engine,
  ): Promise<CompileResult> {
    const started = Date.now();
    const cache = this.projectCache(root);
    const staging = path.join(cache, `job-${job.id}`);
    const source = path.join(staging, "project");
    const build = path.join(staging, "build");
    let log = "";
    let success = false;
    let pdfPath: string | undefined;
    let diagnosticOffset = 0;
    const output = (chunk: string) => {
      log = (log + chunk).slice(-MAX_LOG_BYTES);
      this.options.onLog(chunk);
    };
    const opts: CommandOptions = {
      signal: job.abort.signal,
      timeoutMs: 60_000,
    };
    try {
      const normalizedMain = validateMainFile(mainFile);
      const state = await this.status();
      if (!state.imageReady) throw new Error(state.message);
      if (job.abort.signal.aborted) throw new Error("Compilation cancelled.");
      await mkdir(build, { recursive: true });
      await stageProject(root, source, { signal: job.abort.signal });
      const main = await lstat(path.join(source, normalizedMain)).catch(
        () => undefined,
      );
      if (!main?.isFile())
        throw new Error(
          `Main document not found in project: ${normalizedMain}`,
        );
      const auxCache = path.join(
        cache,
        "aux",
        engine,
        createHash("sha256").update(normalizedMain).digest("hex").slice(0, 16),
      );
      const reusedAuxiliary = await this.copyAuxiliaryFiles(auxCache, build);
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.checked(
          containerArguments(job.name, engine, normalizedMain),
          opts,
        );
        await this.checked(
          ["cp", `${staging}${path.sep}.`, `${job.name}:/workspace`],
          opts,
        );
        output(`Compiling ${normalizedMain} with ${engine}…\n`);
        const result = await this.command(["start", "--attach", job.name], {
          ...opts,
          timeoutMs: 120_000,
          onOutput: output,
        });
        if (job.abort.signal.aborted) throw new Error("Compilation cancelled.");
        if (result.code === 124)
          throw new Error("Compilation exceeded the two minute time limit.");
        if (result.code !== 0) {
          if (result.stderr && !log.includes(result.stderr))
            output(result.stderr + "\n");
          // Package changes can invalidate generated .aux files. Recover without
          // requiring users to know when LaTeX needs a clean build.
          if (attempt === 0 && reusedAuxiliary > 0) {
            output("\nRetrying with fresh auxiliary files…\n");
            await this.checked(["rm", "--force", "--volumes", job.name], opts);
            await rm(build, { recursive: true, force: true });
            await mkdir(build, { recursive: true });
            diagnosticOffset = log.length;
            continue;
          }
          throw new Error(
            "LaTeX compilation failed. See the errors and build log.",
          );
        }
        break;
      }
      // Fixed output paths avoid copying arbitrary container files onto the host.
      const returned = path.join(staging, "returned");
      await mkdir(returned, { recursive: true });
      await this.checked(
        ["cp", `${job.name}:/workspace/build/.`, returned],
        opts,
      );
      const pdf = path.join(returned, "typeset.pdf");
      const pdfInfo = await lstat(pdf).catch(() => undefined);
      if (
        !pdfInfo?.isFile() ||
        pdfInfo.isSymbolicLink() ||
        pdfInfo.size > MAX_PDF_BYTES
      )
        throw new Error(
          "The compiler did not produce a valid PDF within the 100 MB limit.",
        );
      const header = await open(pdf, "r");
      try {
        const bytes = Buffer.alloc(5);
        await header.read(bytes, 0, 5, 0);
        if (bytes.toString() !== "%PDF-")
          throw new Error("The compiler output is not a PDF.");
      } finally {
        await header.close();
      }
      if (job.abort.signal.aborted) throw new Error("Compilation cancelled.");
      try {
        await rm(auxCache, { recursive: true, force: true });
        await this.copyAuxiliaryFiles(returned, auxCache);
      } catch {
        output(
          "The PDF compiled, but auxiliary files could not be cached. The next build will start fresh.\n",
        );
      }
      pdfPath = path.join(cache, "preview.pdf");
      const nextPdf = path.join(cache, `preview-${job.id}.pdf`);
      await copyFile(pdf, nextPdf);
      if (job.abort.signal.aborted) {
        await rm(nextPdf, { force: true });
        throw new Error("Compilation cancelled.");
      }
      await rename(nextPdf, pdfPath);
      this.pdfPaths.set(path.resolve(root), pdfPath);
      success = true;
      output("Compilation complete.\n");
    } catch (error) {
      output(`\n${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await this.command(["rm", "--force", "--volumes", job.name], {
        timeoutMs: 15_000,
      }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    const diagnostics = parseDiagnostics(log.slice(diagnosticOffset));
    if (!success && !diagnostics.some((item) => item.severity === "error")) {
      diagnostics.push({
        message:
          log.trim().split("\n").filter(Boolean).at(-1) ??
          "Compilation failed.",
        severity: "error",
      });
    }
    return {
      id: job.id,
      success,
      log,
      durationMs: Date.now() - started,
      diagnostics,
      pdfPath: success ? pdfPath : undefined,
    };
  }

  private async copyAuxiliaryFiles(from: string, to: string): Promise<number> {
    const entries = await readdir(from, { withFileTypes: true }).catch(
      () => [],
    );
    await mkdir(to, { recursive: true });
    let total = 0;
    let copied = 0;
    const visit = async (
      sourceDirectory: string,
      targetDirectory: string,
      children: typeof entries,
    ) => {
      for (const entry of children) {
        const source = path.join(sourceDirectory, entry.name);
        const target = path.join(targetDirectory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await mkdir(target, { recursive: true });
          await visit(
            source,
            target,
            await readdir(source, { withFileTypes: true }),
          );
        } else if (entry.isFile() && AUX_EXTENSIONS.test(entry.name)) {
          const info = await lstat(source);
          total += info.size;
          if (info.isSymbolicLink() || total > 20 * 1024 * 1024) continue;
          await copyFile(source, target);
          await chmod(target, 0o644);
          copied++;
        }
      }
    };
    await visit(from, to, entries);
    return copied;
  }
  async cancel(): Promise<void> {
    const job = this.active;
    if (!job) return;
    job.abort.abort();
    await this.command(["rm", "--force", "--volumes", job.name], {
      timeoutMs: 15_000,
    }).catch(() => undefined);
    await job.done;
  }
  getPdfPath(root: string): string | undefined {
    return this.pdfPaths.get(path.resolve(root));
  }
  async readPdf(root: string): Promise<Uint8Array | null> {
    const filename =
      this.getPdfPath(root) ??
      path.join(this.projectCache(root), "preview.pdf");
    try {
      const info = await stat(filename);
      if (!info.isFile() || info.size > MAX_PDF_BYTES) return null;
      const pdf = await readFile(filename);
      this.pdfPaths.set(path.resolve(root), filename);
      return pdf;
    } catch {
      return null;
    }
  }
}
