/** Real compiler integration check. Run: node compiler/smoke.mjs */
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporary = await mkdtemp(path.join(os.tmpdir(), "typeset-integration-"));
try {
  const bundle = path.join(temporary, "compiler.mjs");
  await build({
    entryPoints: [path.join(repository, "electron/services/compiler.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { CompilerService } = await import(pathToFileURL(bundle).href);
  const project = path.join(temporary, "project");
  await mkdir(path.join(project, "chapters"), { recursive: true });
  await writeFile(
    path.join(project, "chapters", "intro.tex"),
    "\\section{Introduction}\nA nested chapter with citation~\\cite{knuth1984}.",
  );
  await writeFile(
    path.join(project, "references.bib"),
    "@book{knuth1984, author={Donald E. Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}",
  );
  await writeFile(
    path.join(project, "main.tex"),
    String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage[backend=biber]{biblatex}
\addbibresource{references.bib}
\begin{document}
\tableofcontents
\include{chapters/intro}
\[\int_0^1 x^2\,dx = \frac13\]
\printbibliography
\end{document}
`,
  );
  const service = new CompilerService({
    compilerDir: path.join(repository, "compiler"),
    cacheDir: path.join(temporary, "cache"),
    onLog: (chunk) => process.stdout.write(chunk),
  });
  const status = await service.status();
  if (!status.imageReady) throw new Error(status.message);
  for (const engine of ["pdflatex", "xelatex", "lualatex"]) {
    const result = await service.compile(project, "main.tex", engine);
    if (!result.success) throw new Error(`${engine} failed: ${result.log}`);
    const pdf = await service.readPdf(project);
    if (!pdf || pdf.length < 1000)
      throw new Error(`${engine} did not return a PDF`);
    console.log(
      `PASS: ${engine}, ${pdf.length} PDF bytes, ${result.durationMs} ms`,
    );
  }
  // Generic font regression, intentionally independent of any personal CV.
  await writeFile(
    path.join(project, "resume-fonts.tex"),
    String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{fontawesome5}
\usepackage[default]{lato}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\begin{document}
{\Large\bfseries Sample Resume}\\
\faEnvelope\enspace\href{mailto:person@example.invalid}{person@example.invalid}
\quad\faGithub\enspace example
\section*{Experience}
\begin{itemize}[leftmargin=*]
\item Built a free document editor with live PDF previews.
\end{itemize}
\end{document}
`,
  );
  const resume = await service.compile(project, "resume-fonts.tex", "pdflatex");
  if (!resume.success)
    throw new Error(`Generic resume font compilation failed: ${resume.log}`);
  console.log("PASS: resume template with Lato and Font Awesome 5 Free");
  await writeFile(
    path.join(project, "main.tex"),
    "\\documentclass{article}\\begin{document}A valid document after removing biblatex.\\end{document}",
  );
  const recovery = await service.compile(project, "main.tex", "pdflatex");
  if (!recovery.success || !recovery.log.includes("Retrying with fresh"))
    throw new Error(
      "Could not recover from incompatible cached auxiliary files",
    );
  console.log(
    "PASS: package removal recovers automatically from stale auxiliary files",
  );
  const lastPdf = Buffer.from(await service.readPdf(project));
  await writeFile(
    path.join(project, "main.tex"),
    "\\documentclass{article}\\begin{document}\\unknowncommand\\end{document}",
  );
  const failure = await service.compile(project, "main.tex", "pdflatex");
  if (
    failure.success ||
    !lastPdf.equals(Buffer.from(await service.readPdf(project)))
  )
    throw new Error("A failed compile replaced the last successful PDF");
  console.log("PASS: compiler error preserves last successful preview");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
