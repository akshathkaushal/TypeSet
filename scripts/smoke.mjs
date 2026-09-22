import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "typeset-desktop-"));
const env = { ...process.env, TYPESET_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const application = await electron.launch({
  executablePath: process.env.TYPESET_EXECUTABLE || electronPath,
  args: process.env.TYPESET_EXECUTABLE ? [] : ["."],
  env,
  timeout: 30000,
});
const errors = [];
try {
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".cm-content");
  assert.equal(await page.locator("h1").textContent(), "The shape of an idea");
  const state = await page.evaluate(() => window.typeset.getState());
  const mainDocument = page.getByRole("combobox", {
    name: "Main document",
    exact: true,
  });
  assert.ok(await mainDocument.isVisible());
  assert.equal(await mainDocument.inputValue(), "main.tex");
  console.log("PASS desktop launch and real project load");
  await page.getByTitle("New file", { exact: true }).first().click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("notes.tex");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".file-tab.active")
      ?.textContent?.includes("notes.tex"),
  );
  await page.locator(".cm-content").fill("% An autosaved note.");
  await page.waitForFunction(() =>
    document
      .querySelector(".editor-footer")
      ?.textContent?.includes("All changes saved"),
  );
  assert.equal(
    await fs.readFile(
      path.join(state.initialProject.root, "notes.tex"),
      "utf8",
    ),
    "% An autosaved note.",
  );
  console.log("PASS new file and persisted editor autosave");
  await page.locator('.tree-file[title="notes.tex"]').hover();
  await page.getByTitle("Actions for notes.tex", { exact: true }).click();
  await page.getByRole("button", { name: "Rename file", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("research-notes.tex");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".file-tab.active")
      ?.textContent?.includes("research-notes.tex"),
  );
  assert.equal(
    await fs.readFile(
      path.join(state.initialProject.root, "research-notes.tex"),
      "utf8",
    ),
    "% An autosaved note.",
  );
  console.log("PASS rename without losing content");
  const latestNote = "% Changing the main document saves this edit.";
  await page.locator(".cm-content").fill(latestNote);
  for (const mainFile of ["research-notes.tex", "main.tex"]) {
    await mainDocument.selectOption(mainFile);
    await page.waitForFunction(
      (expected) =>
        document.querySelector('select[aria-label="Main document"]')?.value ===
          expected,
      mainFile,
    );
    assert.equal(await mainDocument.inputValue(), mainFile);
    assert.equal(
      (await page.evaluate(() => window.typeset.getState())).initialProject
        ?.mainFile,
      mainFile,
    );
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(state.initialProject.root, ".typeset.json"),
        "utf8",
      ),
    );
    assert.equal(metadata.mainFile, mainFile);
  }
  assert.equal(
    await fs.readFile(
      path.join(state.initialProject.root, "research-notes.tex"),
      "utf8",
    ),
    latestNote,
  );
  console.log(
    "PASS visible main-document selector saves edits and persists choices",
  );
  await page
    .getByRole("button", { name: "Save version", exact: true })
    .first()
    .click();
  await page.getByLabel("Version name").fill("Desktop smoke checkpoint");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save version", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await page.evaluate(() => window.typeset.versions()))[0]?.message,
    "Desktop smoke checkpoint",
  );
  console.log("PASS UI checkpoint saved to real Git repository");
  await page.getByTitle("Version history", { exact: true }).click();
  await page.getByText("Desktop smoke checkpoint", { exact: true }).waitFor();
  await page.getByTitle("Project files", { exact: true }).click();
  await page.locator('.tree-file[title="main.tex"]').click();
  const status = await page.evaluate(() => window.typeset.compilerStatus());
  console.log("Compiler status:", status.message);
  if (!status.running || !status.imageReady)
    throw new Error(
      "Desktop compile check requires a running Podman machine and built compiler image.",
    );
  await page.locator(".compiler-chip.ready").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /Recompile/ }).click();
  await page.waitForSelector(".pdf-page canvas", { timeout: 120000 });
  const before = await page.evaluate(async () =>
    Array.from(await window.typeset.readPdf()),
  );
  assert.equal(Buffer.from(before).subarray(0, 4).toString(), "%PDF");
  console.log("PASS actual Podman compilation and embedded PDF canvas");
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/workspace.png" });
  await page.getByLabel("Auto-compile", { exact: true }).check();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n% Auto-compile smoke checkpoint\n");
  await page.waitForFunction(
    () =>
      document.querySelector(".statusbar")?.textContent?.includes("Compiling"),
    {},
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(".statusbar")
        ?.textContent?.includes("Compiled in"),
    {},
    { timeout: 120000 },
  );
  assert.match(
    await fs.readFile(path.join(state.initialProject.root, "main.tex"), "utf8"),
    /Auto-compile smoke checkpoint/,
  );
  console.log("PASS automatic recompile after an editor change");
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/workspace.png" });
  await page.getByLabel("Auto-compile", { exact: true }).uncheck();
  await page
    .locator(".cm-content")
    .fill(
      "\\documentclass{article}\n\\begin{document}\n\\notARealCommand\n\\end{document}\n",
    );
  await page.getByRole("button", { name: /Recompile/ }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".statusbar")
        ?.textContent?.includes("Compilation failed"),
    {},
    { timeout: 120000 },
  );
  assert.ok(await page.locator(".pdf-page canvas").isVisible());
  const retained = await page.evaluate(async () =>
    Array.from(await window.typeset.readPdf()),
  );
  assert.equal(Buffer.from(retained).subarray(0, 4).toString(), "%PDF");
  await page.locator(".diagnostic.error").first().waitFor();
  console.log("PASS failed compile diagnostics and retained PDF");
  await page.getByTitle("Version history", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".version")
    .filter({ hasText: "Desktop smoke checkpoint" })
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".cm-content")
      ?.textContent?.includes("The shape of an idea"),
  );
  assert.match(
    await fs.readFile(path.join(state.initialProject.root, "main.tex"), "utf8"),
    /The shape of an idea/,
  );
  console.log("PASS restore records previous work and restores source");
  await page.getByTitle("Project files", { exact: true }).click();
  await page.getByTitle("Close output", { exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+Home");
  assert.deepEqual(errors, []);
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/desktop-smoke.png" });
  console.log("PASS no renderer errors");
} finally {
  await application.close();
  if (!process.env.TYPESET_KEEP_TEST_DATA)
    await fs.rm(directory, { recursive: true, force: true });
}
