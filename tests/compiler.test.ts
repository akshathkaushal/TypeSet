import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMPILER_REVISION,
  CompilerService,
  containerArguments,
  parseDiagnostics,
  stageProject,
  validateMainFile,
  type CommandRunner,
} from "../electron/services/compiler";

const successfulCommand = (args: string[]) => ({
  code: 0,
  stdout:
    args[0] === "image" && args[1] === "inspect" ? COMPILER_REVISION : "{}",
  stderr: "",
});

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "typeset-compiler-"));
  temporary.push(root);
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "main.tex"), "\\documentclass{article}");
  return { root, project, cache: path.join(root, "cache") };
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("compiler isolation", () => {
  it("copies source files but omits secrets in symlinks, .git, and executable latexmk configuration", async () => {
    const { root, project } = await fixture();
    await mkdir(path.join(project, ".git"));
    await writeFile(path.join(project, ".git", "config"), "private remote");
    await writeFile(path.join(root, "outside.txt"), "secret");
    await symlink(
      path.join(root, "outside.txt"),
      path.join(project, "leak.txt"),
    );
    await writeFile(path.join(project, ".latexmkrc"), 'system("something")');
    await mkdir(path.join(project, "chapters"));
    await writeFile(path.join(project, "chapters", "one.tex"), "Chapter one");
    const staged = path.join(root, "staged");
    await stageProject(project, staged);
    expect((await readdir(staged)).sort()).toEqual(["chapters", "main.tex"]);
    expect(
      await readFile(path.join(staged, "chapters", "one.tex"), "utf8"),
    ).toBe("Chapter one");
    await expect(
      stageProject(project, path.join(project, "cache")),
    ).rejects.toThrow("outside");
  });

  it("rejects oversized project snapshots and traversal in the main document", async () => {
    const { root, project } = await fixture();
    await expect(
      stageProject(project, path.join(root, "staged"), { maxBytes: 2 }),
    ).rejects.toThrow("100 MB");
    for (const name of [
      "../secret.tex",
      "/etc/document.tex",
      "C:\\document.tex",
      "one/../../file.tex",
      "main.tex\n-evil",
      "main.pdf",
      "$(touch surprise).tex",
      "`touch surprise`.tex",
      'paper".tex',
    ]) {
      expect(() => validateMainFile(name)).toThrow();
    }
    expect(validateMainFile("chapters\\My paper.tex")).toBe(
      "chapters/My paper.tex",
    );
  });

  it("runs an unprivileged offline container with no host bind mounts", () => {
    const args = containerArguments("typeset-test", "xelatex", "My paper.tex");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--user=1000:1000");
    expect(args).toContain("--cap-drop=ALL");
    expect(args.some((arg) => /type=bind/.test(arg))).toBe(false);
    expect(args.slice(-2)).toEqual(["xelatex", "My paper.tex"]);
    expect(() =>
      containerArguments("test", "evil" as never, "main.tex"),
    ).toThrow();
  });
});

describe("compiler diagnostics", () => {
  it("extracts clickable errors and warnings without linking outside the project", () => {
    const diagnostics = parseDiagnostics(
      [
        "./chapters/intro.tex:12: Undefined control sequence.",
        "./chapters/intro.tex:12: Undefined control sequence.",
        "/workspace/project/main.tex:7: Missing $ inserted.",
        "/usr/share/texmf/unsafe.sty:3: example error",
        "LaTeX Warning: Reference `fig:first` on page 1 undefined on input line 8.",
        "! Emergency stop.",
        "l.22 \\badcommand",
      ].join("\n"),
    );
    expect(diagnostics).toHaveLength(5);
    expect(diagnostics[0]).toEqual({
      file: "chapters/intro.tex",
      line: 12,
      message: "Undefined control sequence.",
      severity: "error",
    });
    expect(diagnostics[1].file).toBe("main.tex");
    expect(diagnostics[2].file).toBeUndefined();
    expect(diagnostics[3]).toMatchObject({ severity: "warning", line: 8 });
    expect(diagnostics[4]).toMatchObject({ severity: "error", line: 22 });
  });
});

describe("compilation lifecycle", () => {
  it("publishes only a successful PDF, preserves it after failure, and cleans disposable containers", async () => {
    const { root, project, cache } = await fixture();
    const calls: string[][] = [];
    let fail = false;
    const runner: CommandRunner = async (_executable, args, options) => {
      calls.push(args);
      if (args[0] === "start") {
        options?.onOutput?.(
          fail
            ? "./main.tex:3: Undefined control sequence.\n"
            : "Output written on typeset.pdf.\n",
        );
        return { code: fail ? 1 : 0, stdout: "", stderr: "" };
      }
      if (args[0] === "cp" && args[1].includes(":/workspace/build")) {
        await writeFile(
          path.join(args[2], "typeset.pdf"),
          "%PDF-1.7\nfirst-success",
        );
        await writeFile(path.join(args[2], "typeset.aux"), "\\relax");
      }
      return successfulCommand(args);
    };
    const service = new CompilerService({
      compilerDir: root,
      cacheDir: cache,
      onLog: () => {},
      runner,
      podmanPath: "mock-podman",
    });
    expect(
      (await service.compile(project, "main.tex", "pdflatex")).success,
    ).toBe(true);
    expect(Buffer.from((await service.readPdf(project))!).toString()).toContain(
      "first-success",
    );
    fail = true;
    const failed = await service.compile(project, "main.tex", "pdflatex");
    expect(failed.success).toBe(false);
    expect(failed.diagnostics[0].line).toBe(3);
    expect(Buffer.from((await service.readPdf(project))!).toString()).toContain(
      "first-success",
    );
    expect(calls.filter((args) => args[0] === "rm")).toHaveLength(3);
    const perProject = path.join(cache, (await readdir(cache))[0]);
    expect(
      (await readdir(perProject)).some((name) => name.startsWith("job-")),
    ).toBe(false);
  });

  it("recovers from incompatible cached auxiliary files with a fresh retry", async () => {
    const { root, project, cache } = await fixture();
    let builds = 0;
    const runner: CommandRunner = async (_executable, args, options) => {
      if (args[0] === "start") {
        builds++;
        if (builds === 2) {
          options?.onOutput?.("! Cached auxiliary file is incompatible.\n");
          return { code: 1, stdout: "", stderr: "" };
        }
      }
      if (args[0] === "cp" && args[1].includes(":/workspace/build")) {
        await writeFile(
          path.join(args[2], "typeset.pdf"),
          "%PDF-1.7\nnew preview",
        );
        await writeFile(path.join(args[2], "typeset.aux"), "\\relax");
      }
      return successfulCommand(args);
    };
    const service = new CompilerService({
      compilerDir: root,
      cacheDir: cache,
      onLog: () => {},
      runner,
      podmanPath: "mock-podman",
    });
    await service.compile(project, "main.tex", "pdflatex");
    const recovered = await service.compile(project, "main.tex", "pdflatex");
    expect(builds).toBe(3);
    expect(recovered.success).toBe(true);
    expect(recovered.log).toContain("Retrying with fresh");
    expect(
      recovered.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
  });

  it("cancels the running container and does not publish its PDF", async () => {
    const { root, project, cache } = await fixture();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: string[][] = [];
    const runner: CommandRunner = async (_executable, args, options) => {
      calls.push(args);
      if (args[0] === "start") {
        started();
        return new Promise((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ code: 130, stdout: "", stderr: "cancelled" }),
            { once: true },
          ),
        );
      }
      return successfulCommand(args);
    };
    const service = new CompilerService({
      compilerDir: root,
      cacheDir: cache,
      onLog: () => {},
      runner,
      podmanPath: "mock-podman",
    });
    const compiling = service.compile(project, "main.tex", "pdflatex");
    await startedPromise;
    await service.cancel();
    expect((await compiling).success).toBe(false);
    expect((await compiling).log).toContain("cancelled");
    expect(await service.readPdf(project)).toBeNull();
    expect(
      calls.some((args) => args[0] === "rm" && args.includes("--force")),
    ).toBe(true);
  });
});

describe("compiler image upgrades", () => {
  it("rebuilds an old image even when its tag already exists", async () => {
    const { root, cache } = await fixture();
    let revision = "1";
    let builds = 0;
    const runner: CommandRunner = async (_executable, args) => {
      if (args[0] === "image" && args[1] === "inspect")
        return { code: 0, stdout: revision, stderr: "" };
      if (args[0] === "build") {
        builds++;
        revision = COMPILER_REVISION;
      }
      return successfulCommand(args);
    };
    const service = new CompilerService({
      compilerDir: root,
      cacheDir: cache,
      onLog: () => {},
      runner,
      podmanPath: "mock-podman",
    });
    expect(await service.status()).toMatchObject({
      installed: true,
      running: true,
      imageReady: false,
    });
    expect((await service.setup()).imageReady).toBe(true);
    expect(builds).toBe(1);
    await service.setup();
    expect(builds).toBe(1);
  });
});
