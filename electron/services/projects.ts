import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync, unzipSync } from "fflate";
import type { Engine, FileEntry, Project } from "../../shared/types";

const EXCLUDED = new Set([".git", ".typeset", "node_modules", ".DS_Store"]);
const EXCLUDED_CASELESS = new Set(
  [...EXCLUDED].map((name) => name.toLowerCase()),
);
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 5000;
const META = ".typeset.json";
export const WELCOME_TEX = String.raw`\documentclass[11pt]{article}

% A small beginning. Make it yours.
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[margin=1in]{geometry}
\usepackage[colorlinks=true,linkcolor=black,urlcolor=blue]{hyperref}

\title{The shape of an idea}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every good paper begins with a question.
This is a little space to think, write, and turn
your next idea into something worth sharing.
\end{abstract}

\input{sections/introduction}

\section{A little mathematics}
Beautiful ideas deserve beautiful typography.
For example, the Gaussian integral:
\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}

\section{What comes next}
Add a section, bring in a figure, or start fresh.
Your files live on your computer, and your work
is always yours.

% Uncomment to add a bibliography:
% \bibliographystyle{plain}
% \bibliography{references}

\end{document}
`;

function validateProjectPath(input: string, allowMetadata = false): string {
  if (
    !input ||
    typeof input !== "string" ||
    input.includes("\0") ||
    input.includes("\\") ||
    path.posix.isAbsolute(input) ||
    /^[a-z]:/i.test(input)
  )
    throw new Error("Use a relative project path.");
  const parts = input.split("/");
  if (
    parts.some((part, index) => {
      const lower = part.toLowerCase();
      return (
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) ||
        lower === "__proto__" ||
        EXCLUDED_CASELESS.has(lower) ||
        (lower === META &&
          !(allowMetadata && part === META && index === parts.length - 1))
      );
    })
  )
    throw new Error(
      "This path is reserved, outside the project, or unsupported on another operating system.",
    );
  return parts.join("/");
}
export function validateRelative(input: string): string {
  return validateProjectPath(input);
}

export async function safePath(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  const clean = validateRelative(relative);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of clean.split("/")) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink())
        throw new Error("Symbolic links are not supported inside a project.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw error;
    }
  }
  return current;
}

export async function atomicWrite(
  filename: string,
  contents: string | Uint8Array,
): Promise<void> {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, contents);
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

interface Metadata {
  id: string;
  mainFile: string;
  engine: Engine;
}

/** Sections and command files are editable sources, not compilation entrypoints. */
async function detectMainDocument(
  root: string,
  files: FileEntry[],
): Promise<string> {
  const tex = flatten(files).filter((file) => /\.tex$/i.test(file));
  const byLocation = (a: string, b: string) =>
    a.split("/").length - b.split("/").length ||
    Number(path.posix.basename(b).toLowerCase() === "main.tex") -
      Number(path.posix.basename(a).toLowerCase() === "main.tex") ||
    a.localeCompare(b);
  const candidates = tex.sort(byLocation);
  const documents: string[] = [];
  const preambles: string[] = [];
  for (const file of candidates) {
    const handle = await fs.open(await safePath(root, file), "r");
    let prefix: string;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      prefix = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    // Ignore commented-out document declarations, including after escaped %.
    const source = prefix
      .split("\n")
      .map((line) => {
        for (let i = 0; i < line.length; i++) {
          if (line[i] !== "%") continue;
          let slashes = 0;
          for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
          if (slashes % 2 === 0) return line.slice(0, i);
        }
        return line;
      })
      .join("\n");
    if (/\\begin\s*\{document\}/.test(source)) documents.push(file);
    else if (
      /\\(?:documentclass|documentstyle)\s*(?:\[[\s\S]*?\]\s*)?\{/.test(source)
    )
      preambles.push(file);
  }
  // Prefer an actual document at the project root over a nested example project.
  // Keep conventional wrappers usable when their preamble is in an input file.
  return documents[0] || preambles[0] || candidates[0] || "main.tex";
}

export class ProjectService {
  private roots = new Set<string>();
  async open(root: string): Promise<Project> {
    const real = await fs.realpath(root);
    if (!(await fs.stat(real)).isDirectory())
      throw new Error("Choose a project folder.");
    this.roots.add(real);
    return this.describe(real);
  }
  private assert(root: string) {
    if (!this.roots.has(root)) throw new Error("Open this project first.");
  }
  async metadata(root: string): Promise<Metadata> {
    this.assert(root);
    try {
      const metaPath = path.join(root, META);
      if ((await fs.lstat(metaPath)).isSymbolicLink())
        throw new Error("Invalid project metadata.");
      const data = JSON.parse(await fs.readFile(metaPath, "utf8")) as Metadata;
      validateRelative(data.mainFile);
      if (
        !["pdflatex", "xelatex", "lualatex"].includes(data.engine) ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(data.id)
      )
        throw new Error("Invalid project settings.");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const files = await this.list(root);
      const meta: Metadata = {
        id: randomUUID(),
        mainFile: await detectMainDocument(root, files),
        engine: "pdflatex",
      };
      await atomicWrite(path.join(root, META), JSON.stringify(meta, null, 2));
      return meta;
    }
  }
  async describe(root: string): Promise<Project> {
    this.assert(root);
    const meta = await this.metadata(root);
    return {
      root,
      name: path.basename(root),
      files: await this.list(root),
      mainFile: meta.mainFile,
      engine: meta.engine,
    };
  }
  async create(parent: string, name: string): Promise<Project> {
    if (
      !name.trim() ||
      /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new Error(
        "Choose a name without path separators or special characters.",
      );
    const root = path.join(parent, name.trim());
    await fs.mkdir(root); // Never overwrite an existing folder.
    await fs.mkdir(path.join(root, "sections"));
    await fs.writeFile(path.join(root, "main.tex"), WELCOME_TEX);
    await fs.writeFile(
      path.join(root, "sections/introduction.tex"),
      String.raw`\section{Introduction}
Welcome to Typeset, your quiet space for focused writing.
Edit this document on the left, then press Recompile
to see your work take shape on the right.

Use the file sidebar to organize a larger project.
Create a named version whenever you reach a milestone,
and connect GitHub or Google Drive when you want a backup.
`,
    );
    await fs.writeFile(
      path.join(root, "references.bib"),
      "@book{knuth1984,\n  author = {Donald E. Knuth},\n  title = {The TeXbook},\n  year = {1984},\n  publisher = {Addison-Wesley}\n}\n",
    );
    return this.open(root);
  }
  async list(root: string, relative = "", depth = 0): Promise<FileEntry[]> {
    this.assert(root);
    if (depth > 64)
      throw new Error(
        "This project has more than 64 nested folders. Shorten its folder structure before opening or exporting it.",
      );
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (
        EXCLUDED_CASELESS.has(entry.name.toLowerCase()) ||
        entry.name.toLowerCase() === META ||
        entry.isSymbolicLink()
      )
        continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        result.push({
          name: entry.name,
          path: rel,
          kind: "directory",
          children: await this.list(root, rel, depth + 1),
        });
      else if (entry.isFile())
        result.push({ name: entry.name, path: rel, kind: "file" });
    }
    return result.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "directory"
          ? -1
          : 1,
    );
  }
  async read(root: string, relative: string): Promise<string> {
    this.assert(root);
    const filename = await safePath(root, relative);
    if ((await fs.stat(filename)).size > 5 * 1024 * 1024)
      throw new Error(
        "This file is too large for the text editor (5 MB limit).",
      );
    const data = await fs.readFile(filename);
    if (data.includes(0))
      throw new Error(
        "This is a binary file. You can keep it in the project, but it cannot be edited as text.",
      );
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        data,
      );
    } catch {
      throw new Error(
        "This file is not valid UTF-8 text. Convert it to UTF-8 before editing in Typeset; its original bytes have been preserved.",
      );
    }
  }
  async readBinary(root: string, relative: string): Promise<Uint8Array> {
    this.assert(root);
    const filename = await safePath(root, relative);
    if ((await fs.stat(filename)).size > MAX_FILE)
      throw new Error("File exceeds the 20 MB preview limit.");
    return fs.readFile(filename);
  }
  async save(
    root: string,
    relative: string,
    content: string,
    expectedContent?: string,
  ): Promise<void> {
    this.assert(root);
    if (Buffer.byteLength(content) > 5 * 1024 * 1024)
      throw new Error("Text files must be smaller than 5 MB.");
    const changedOutside = () =>
      new Error(
        `“${relative}” changed outside Typeset. Your editor changes have not been saved over it. Reload the disk version or save your edits as a separate copy.`,
      );
    let filename: string;
    try {
      filename = await safePath(root, relative);
      const info = await fs.stat(filename);
      if (!info.isFile()) {
        if (expectedContent !== undefined) throw changedOutside();
        throw new Error("Only existing regular files can be saved.");
      }
      if (expectedContent !== undefined) {
        // An optimistic guard catches Git/terminal edits even between renderer refreshes.
        // Compare bytes, so a changed encoding cannot be silently normalized and overwritten.
        const expected = Buffer.from(expectedContent, "utf8");
        if (
          info.size !== expected.length ||
          !(await fs.readFile(filename)).equals(expected)
        )
          throw changedOutside();
      }
    } catch (error) {
      if (
        expectedContent !== undefined &&
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      )
        throw changedOutside();
      throw error;
    }
    await atomicWrite(filename, content);
  }
  async add(
    root: string,
    relative: string,
    directory = false,
  ): Promise<Project> {
    this.assert(root);
    const filename = await safePath(root, relative, true);
    if (directory) await fs.mkdir(filename, { recursive: false });
    else {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "", { flag: "wx" });
    }
    return this.describe(root);
  }
  async rename(root: string, from: string, to: string): Promise<Project> {
    this.assert(root);
    const source = await safePath(root, from);
    const target = await safePath(root, to, true);
    try {
      await fs.lstat(target);
      throw new Error("A file already exists at that path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    const meta = await this.metadata(root);
    if (meta.mainFile === from || meta.mainFile.startsWith(from + "/"))
      await this.options(root, {
        mainFile: to + meta.mainFile.slice(from.length),
      });
    return this.describe(root);
  }
  async remove(root: string, relative: string): Promise<string> {
    this.assert(root);
    return safePath(root, relative);
  }
  async options(
    root: string,
    options: { mainFile?: string; engine?: Engine },
  ): Promise<Project> {
    const meta = await this.metadata(root);
    if (options.mainFile) {
      const main = await safePath(root, options.mainFile);
      if (!options.mainFile.endsWith(".tex") || !(await fs.stat(main)).isFile())
        throw new Error("The main file must be a .tex file.");
      meta.mainFile = options.mainFile;
    }
    if (options.engine) {
      if (!["pdflatex", "xelatex", "lualatex"].includes(options.engine))
        throw new Error("Unknown compiler engine.");
      meta.engine = options.engine;
    }
    await atomicWrite(path.join(root, META), JSON.stringify(meta, null, 2));
    return this.describe(root);
  }
  async importFiles(root: string, filenames: string[]): Promise<Project> {
    this.assert(root);
    for (const source of filenames) {
      const sourceInfo = await fs.lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.size > MAX_FILE)
        throw new Error("Import regular files smaller than 20 MB.");
      const target = await safePath(root, path.basename(source), true);
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
    return this.describe(root);
  }
  async zip(root: string): Promise<Uint8Array> {
    this.assert(root);
    const files: Record<string, Uint8Array> = Object.create(null);
    let total = 0;
    const paths = [...flatten(await this.list(root)), META];
    if (paths.length > MAX_FILES)
      throw new Error("Project archives are limited to 5,000 files.");
    for (const relative of paths) {
      const filename =
        relative === META
          ? path.join(root, META)
          : await safePath(root, relative);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink())
        throw new Error("Cannot archive symbolic links.");
      if (!stat.isFile() || stat.size > MAX_FILE)
        throw new Error(
          `The file “${relative}” exceeds the 20 MB archive limit.`,
        );
      total += stat.size;
      if (total > MAX_TOTAL)
        throw new Error("Project archives are limited to 100 MB.");
      files[relative] = await fs.readFile(filename);
    }
    return zipSync(files, { level: 6 });
  }
  async importArchive(
    parent: string,
    name: string,
    archive: Uint8Array,
  ): Promise<Project> {
    if (archive.length > MAX_TOTAL)
      throw new Error("Archive exceeds the 100 MB limit.");
    let total = 0;
    let count = 0;
    const archivePaths = new Map<string, boolean>();
    const files = unzipSync(archive, {
      filter(file) {
        const directory = file.name.endsWith("/");
        const relative = directory ? file.name.slice(0, -1) : file.name;
        validateProjectPath(relative, !directory);
        const normalized = relative.normalize("NFC").toLowerCase();
        if (
          archivePaths.has(normalized) &&
          (!directory || !archivePaths.get(normalized))
        )
          throw new Error(
            "The archive contains duplicate or conflicting file names.",
          );
        archivePaths.set(normalized, directory);
        if (file.compression === 0 && file.size !== file.originalSize)
          throw new Error("The archive contains an invalid file size.");
        total += file.originalSize;
        if (
          ++count > MAX_FILES ||
          total > MAX_TOTAL ||
          file.originalSize > MAX_FILE
        )
          throw new Error("Archive is too large to extract safely.");
        return !directory;
      },
    });
    const keys = Object.keys(files);
    // Overleaf archives may contain one enclosing project directory.
    const first = keys[0]?.split("/")[0];
    const prefix =
      first && keys.every((k) => k.startsWith(first + "/")) ? first + "/" : "";
    const prepared = keys.map((key) => {
      const relative = key.slice(prefix.length);
      if (relative !== META) validateRelative(relative);
      return { relative, content: files[key] };
    });
    if (!prepared.length) throw new Error("The archive is empty.");
    if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..")
      throw new Error("Invalid project name.");
    const root = path.join(parent, name);
    await fs.mkdir(root);
    try {
      for (const file of prepared) {
        const destination = path.join(root, file.relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, { flag: "wx" });
      }
      return await this.open(root);
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}
export function flatten(files: FileEntry[]): string[] {
  return files.flatMap((f) =>
    f.kind === "directory" ? flatten(f.children || []) : [f.path],
  );
}
