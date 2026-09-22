import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  ProjectService,
  validateRelative,
} from "../electron/services/projects";
const temp: string[] = [];
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "typeset-test-"));
  temp.push(parent);
  const service = new ProjectService();
  const project = await service.create(parent, "Paper");
  return { parent, service, project };
}
afterEach(async () => {
  await Promise.all(
    temp.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
describe("Project files and archives", () => {
  it("saves only when an optional editor baseline still matches disk", async () => {
    const { service, project } = await fixture();
    const original = await service.read(project.root, "main.tex");
    await service.save(project.root, "main.tex", "First edit", original);
    expect(await service.read(project.root, "main.tex")).toBe("First edit");
    await service.save(project.root, "main.tex", "Second edit", "First edit");
    expect(await service.read(project.root, "main.tex")).toBe("Second edit");
  });

  it("rejects stale editor saves after external changes without overwriting either file version", async () => {
    const { service, project } = await fixture();
    const filename = path.join(project.root, "main.tex");
    const baseline = "Original";
    await fs.writeFile(filename, baseline);
    await fs.writeFile(filename, "Terminal"); // Same byte length: mtime/size-only checks are insufficient.
    await expect(
      service.save(
        project.root,
        "main.tex",
        "Unsaved editor changes",
        baseline,
      ),
    ).rejects.toThrow("changed outside Typeset");
    expect(await fs.readFile(filename, "utf8")).toBe("Terminal");
    expect(
      (await fs.readdir(project.root)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("does not recreate a file removed outside Typeset when saving a stale buffer", async () => {
    const { service, project } = await fixture();
    const baseline = await service.read(project.root, "main.tex");
    await fs.rm(path.join(project.root, "main.tex"));
    await expect(
      service.save(
        project.root,
        "main.tex",
        "Unsaved editor changes",
        baseline,
      ),
    ).rejects.toThrow("changed outside Typeset");
    await expect(
      fs.access(path.join(project.root, "main.tex")),
    ).rejects.toThrow();
  });

  it("rejects a stale save if the external command replaced a file with a directory", async () => {
    const { service, project } = await fixture();
    const filename = path.join(project.root, "main.tex");
    const baseline = await service.read(project.root, "main.tex");
    await fs.rm(filename);
    await fs.mkdir(filename);
    await expect(
      service.save(
        project.root,
        "main.tex",
        "Unsaved editor changes",
        baseline,
      ),
    ).rejects.toThrow("changed outside Typeset");
    expect((await fs.stat(filename)).isDirectory()).toBe(true);
  });

  it("creates, edits, renames and round-trips a complete project archive", async () => {
    const { parent, service, project } = await fixture();
    await service.add(project.root, "sections/methods.tex");
    await service.save(project.root, "sections/methods.tex", "A method");
    await service.rename(
      project.root,
      "sections/methods.tex",
      "sections/approach.tex",
    );
    expect(await service.read(project.root, "sections/approach.tex")).toBe(
      "A method",
    );
    const zip = await service.zip(project.root);
    const copy = await service.importArchive(parent, "Copy", zip);
    expect(copy.mainFile).toBe("main.tex");
    expect(await service.read(copy.root, "sections/approach.tex")).toBe(
      "A method",
    );
    expect((await service.metadata(copy.root)).id).toBe(
      (await service.metadata(project.root)).id,
    );
  });
  it("blocks traversal, hidden version directories, symlinks and overwrites", async () => {
    const { parent, service, project } = await fixture();
    for (const value of [
      "../secret",
      "/tmp/secret",
      "a/../../secret",
      ".git/config",
      "a\\b",
      "C:/secret",
      ".typeset.json",
    ])
      expect(() => validateRelative(value)).toThrow();
    await fs.writeFile(path.join(parent, "secret"), "private");
    await fs.symlink(
      path.join(parent, "secret"),
      path.join(project.root, "linked.tex"),
    );
    await expect(service.read(project.root, "linked.tex")).rejects.toThrow(
      "Symbolic",
    );
    await expect(
      service.save(project.root, "linked.tex", "changed"),
    ).rejects.toThrow();
    await expect(service.create(parent, "Paper")).rejects.toThrow();
    expect(await fs.readFile(path.join(parent, "secret"), "utf8")).toBe(
      "private",
    );
  });
  it("rejects zip traversal before creating files", async () => {
    const { parent, service } = await fixture();
    const zip = zipSync({
      "../escaped.tex": strToU8("no"),
      "main.tex": strToU8("yes"),
    });
    await expect(
      service.importArchive(parent, "Unsafe", zip),
    ).rejects.toThrow();
    await expect(fs.access(path.join(parent, "Unsafe"))).rejects.toThrow();
  });
  it("strips a single enclosing folder in imported archives and updates renamed main file", async () => {
    const { parent, service } = await fixture();
    const zip = zipSync({
      "enclosing/main.tex": strToU8("hello"),
      "enclosing/part.tex": strToU8("world"),
    });
    const project = await service.importArchive(parent, "Imported", zip);
    expect(await service.read(project.root, "main.tex")).toBe("hello");
    const renamed = await service.rename(project.root, "main.tex", "paper.tex");
    expect(renamed.mainFile).toBe("paper.tex");
  });
  it("rejects reserved aliases and paths that would resolve differently on Windows", () => {
    for (const value of [
      ".GIT/config",
      ".TYPESET/build.tex",
      ".TYPESET.JSON",
      "main.tex:stream",
      "folder./main.tex",
      "folder /main.tex",
      "CON.tex",
      "aux",
      "__proto__",
    ])
      expect(() => validateRelative(value)).toThrow();
  });
  it("rejects legacy non-UTF-8 text without replacing its original bytes", async () => {
    const { service, project } = await fixture();
    const filename = path.join(project.root, "legacy.tex");
    const data = Buffer.from([0x25, 0x20, 0xe9]);
    await fs.writeFile(filename, data);
    await expect(service.read(project.root, "legacy.tex")).rejects.toThrow(
      "not valid UTF-8",
    );
    expect(await fs.readFile(filename)).toEqual(data);
    await service.save(project.root, "main.tex", "Café — α");
    expect(await service.read(project.root, "main.tex")).toBe("Café — α");
  });
  it("preserves files beyond the old sixteen-folder export boundary", async () => {
    const { parent, service, project } = await fixture();
    const relative =
      Array.from({ length: 18 }, (_, index) => `folder-${index}`).join("/") +
      "/chapter.tex";
    await service.add(project.root, relative);
    await service.save(project.root, relative, "A deeply nested chapter");
    const copy = await service.importArchive(
      parent,
      "Deep copy",
      await service.zip(project.root),
    );
    expect(await service.read(copy.root, relative)).toBe(
      "A deeply nested chapter",
    );
  });
  it("rejects archive traversal even when every entry shares the malicious prefix", async () => {
    const { parent, service } = await fixture();
    const zip = zipSync({ "../escaped.tex": strToU8("no") });
    await expect(
      service.importArchive(parent, "Unsafe prefix", zip),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(parent, "Unsafe prefix")),
    ).rejects.toThrow();
  });
  it("rejects conflicting archive names before creating the destination", async () => {
    const { parent, service } = await fixture();
    const zip = zipSync({
      "main.tex": strToU8("one"),
      "MAIN.tex": strToU8("two"),
    });
    await expect(
      service.importArchive(parent, "Conflicting", zip),
    ).rejects.toThrow("conflicting");
    await expect(fs.access(path.join(parent, "Conflicting"))).rejects.toThrow();
  });
  it("rejects inconsistent stored ZIP sizes instead of bypassing extraction limits", async () => {
    const { parent, service } = await fixture();
    const zip = zipSync({ "main.tex": strToU8("text") }, { level: 0 });
    const bytes = Buffer.from(zip);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(0, central + 24);
    await expect(
      service.importArchive(parent, "Bad sizes", bytes),
    ).rejects.toThrow("invalid file size");
    await expect(fs.access(path.join(parent, "Bad sizes"))).rejects.toThrow();
  });
  it("does not export a file too large to import again", async () => {
    const { service, project } = await fixture();
    const filename = path.join(project.root, "large.pdf");
    await fs.writeFile(filename, "");
    await fs.truncate(filename, 21 * 1024 * 1024);
    await expect(service.zip(project.root)).rejects.toThrow(
      "20 MB archive limit",
    );
  });
  it("requires the main document to be a regular file", async () => {
    const { service, project } = await fixture();
    await service.add(project.root, "folder.tex", true);
    await expect(
      service.options(project.root, { mainFile: "folder.tex" }),
    ).rejects.toThrow("main file");
  });
  it("detects a resume entrypoint rather than nested sections, helpers, or another project", async () => {
    const { parent, service } = await fixture();
    const root = path.join(parent, "Imported resume");
    await fs.mkdir(path.join(root, "Resume", "sections"), { recursive: true });
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "Resume", "sections", "introduction.tex"),
      "\\section{A sample section}",
    );
    await fs.writeFile(
      path.join(root, "Resume", "main.tex"),
      "\\documentclass{article}\\begin{document}Sample\\end{document}",
    );
    await fs.writeFile(
      path.join(root, "custom-commands.tex"),
      "\\newcommand{\\itemName}{Example}",
    );
    await fs.writeFile(path.join(root, "src", "heading.tex"), "A heading");
    await fs.writeFile(
      path.join(root, "resume.tex"),
      "% A resume\n\\documentclass[letterpaper,11pt]{article}\n\\begin{document}Example\\end{document}",
    );
    expect((await service.open(root)).mainFile).toBe("resume.tex");
  });
  it("ignores commented document declarations and recognizes a split preamble", async () => {
    const { parent, service } = await fixture();
    const root = path.join(parent, "Split preamble");
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, "a-commands.tex"),
      "% \\documentclass{article}\n\\newcommand{\\percent}{\\%} % \\documentclass{book}",
    );
    await fs.writeFile(
      path.join(root, "paper.tex"),
      "\\input{preamble}\n\\begin{document}Content\\end{document}",
    );
    await fs.writeFile(
      path.join(root, "preamble.tex"),
      "\\documentclass{article}",
    );
    await fs.mkdir(path.join(root, "Sample"));
    await fs.writeFile(
      path.join(root, "Sample", "main.tex"),
      "\\documentclass{article}\n\\begin{document}Sample\\end{document}",
    );
    expect((await service.open(root)).mainFile).toBe("paper.tex");
  });
  it("prefers main.tex among equivalent documents and preserves an explicit selection", async () => {
    const { service, project } = await fixture();
    await fs.writeFile(
      path.join(project.root, "a-paper.tex"),
      "\\documentclass{article}",
    );
    await fs.rm(path.join(project.root, ".typeset.json"));
    expect((await service.open(project.root)).mainFile).toBe("main.tex");
    await service.options(project.root, { mainFile: "a-paper.tex" });
    expect((await service.open(project.root)).mainFile).toBe("a-paper.tex");
  });
});
