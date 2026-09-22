import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Real PTY checks use only a disposable project. No authentication, network,
// native Terminal launch, or compilation is involved.
const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "typeset-terminal-")),
);
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
let page;

// Keep asynchronous polling outside waitForFunction: Playwright versions can
// adopt an async predicate's first result without retrying a false result.
async function poll(read, description, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".cm-content");
  const state = await page.evaluate(() => window.typeset.getState());
  const root = state.initialProject?.root;
  assert.ok(root && root.startsWith(directory + path.sep));
  const mainFile = path.join(root, "main.tex");
  await page.evaluate(() => window.typeset.checkpoint("Terminal smoke baseline"));
  const editor = page.locator(".cm-content");
  const terminalToggle = page.locator(".statusbar").getByRole("button", {
    name: "Terminal",
    exact: true,
  });
  await terminalToggle.click();
  await page.locator(".terminal-session-state.running").waitFor();
  const terminalInput = page.getByLabel("Project terminal input", { exact: true });
  const status = () => page.evaluate(() => window.typeset.terminalStatus());
  const initialSession = await status();
  assert.equal(initialSession.root, await fs.realpath(root));
  assert.ok(initialSession.running);
  const powershell = /powershell|pwsh/i.test(initialSession.shell);
  const writeText = (file, content) => powershell
    ? `Set-Content -LiteralPath '${file}' -Value '${content}'`
    : `printf '%s\\n' '${content}' > '${file}'`;
  const marker = (label) => powershell
    ? `Write-Output ('${label}_' + 'COMPLETE')`
    : `printf '${label}_%s\\n' 'COMPLETE'`;
  const queueCommand = async (command) => {
    await terminalInput.focus();
    await page.keyboard.insertText(command);
  };
  const runCommand = async (command, label) => {
    await queueCommand(`${command}; ${marker(label)}`);
    await page.keyboard.press("Enter");
    return poll(async () => {
      const current = await status();
      return current?.output.includes(`${label}_COMPLETE`) ? current : false;
    }, `${label} shell completion`);
  };

  const pwdCommand = powershell
    ? "Write-Output ('PROJECT_' + 'ROOT:' + (Get-Location).Path)"
    : "printf 'PROJECT_ROOT:%s\\n' \"$PWD\"";
  const pwd = await runCommand(pwdCommand, "PWD");
  assert.ok(pwd.output.includes(`PROJECT_ROOT:${await fs.realpath(root)}`));
  const git = await runCommand("git status --short; git rev-parse --is-inside-work-tree", "GIT");
  assert.match(git.output, /\r?\ntrue\r?\n/);
  await page.waitForFunction(() =>
    document.querySelector(".xterm-accessibility-tree")?.textContent?.includes("GIT_COMPLETE"),
  );
  console.log("PASS real terminal starts in the project and runs pwd/Git");

  await runCommand(
    powershell ? "$env:TYPESET_SMOKE_SESSION='preserved'" : "export TYPESET_SMOKE_SESSION=preserved",
    "SESSION_SET",
  );
  await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  assert.equal(await page.locator(".terminal-emulator .xterm").count(), 1);
  await terminalToggle.click();
  await page.locator(".terminal-panel").waitFor({ state: "visible" });
  assert.equal((await status()).id, initialSession.id);
  const preserved = await runCommand(
    powershell ? "Write-Output ('PERSIST:' + $env:TYPESET_SMOKE_SESSION)" : "printf 'PERSIST:%s\\n' \"$TYPESET_SMOKE_SESSION\"",
    "SESSION_CHECK",
  );
  assert.ok(preserved.output.includes("PERSIST:preserved"));
  console.log("PASS hiding and reopening preserves the shell and environment");

  const externalText = "% Modified by the embedded terminal.";
  const createdText = "% Created by the embedded terminal.";
  await runCommand(
    `${writeText("main.tex", externalText)}; ${writeText("terminal-created.tex", createdText)}`,
    "FILES",
  );
  await page.locator('.tree-file[title="terminal-created.tex"]').waitFor();
  await page.waitForFunction((expected) => document.querySelector(".cm-content")?.textContent?.includes(expected), externalText);
  assert.equal((await fs.readFile(mainFile, "utf8")).trim(), externalText);
  console.log("PASS terminal file creation and clean editor changes refresh automatically");

  const freshText = "% Fresh editor text saved before terminal Enter.\n";
  const readCommand = powershell
    ? "Copy-Item -LiteralPath 'main.tex' -Destination 'saved-before-enter.tex'"
    : "cat 'main.tex' > 'saved-before-enter.tex'";
  await queueCommand(`${readCommand}; ${marker("FRESH")}`);
  await editor.fill(freshText);
  assert.notEqual(await fs.readFile(mainFile, "utf8"), freshText);
  await terminalInput.focus();
  await page.keyboard.press("Enter");
  await poll(async () => (await status())?.output.includes("FRESH_COMPLETE"), "save-before-command output");
  assert.equal(await fs.readFile(path.join(root, "saved-before-enter.tex"), "utf8"), freshText);
  console.log("PASS terminal Enter saves a pending editor buffer before executing");

  const localCopy = "% Local changes that must survive an external edit.\n";
  const diskCopy = "% Independently changed on disk.\n";
  await editor.fill(localCopy);
  await fs.writeFile(mainFile, diskCopy);
  await page.locator(".external-change-banner").waitFor();
  assert.ok((await editor.textContent()).includes(localCopy.trim()));
  assert.equal(await fs.readFile(mainFile, "utf8"), diskCopy);
  await page.getByRole("button", { name: "Save edits as copy", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("main.local.tex");
  await page.getByRole("button", { name: "Save copy", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".file-tab.active")?.textContent?.includes("main.local.tex"));
  assert.equal(await fs.readFile(path.join(root, "main.local.tex"), "utf8"), localCopy);
  assert.equal(await fs.readFile(mainFile, "utf8"), diskCopy);
  assert.equal(await page.locator(".external-change-banner").count(), 0);
  console.log("PASS conflicting editor/disk edits are preserved and Save edits as copy retains both");

  await page.locator('.tree-file[title="main.tex"]').click();
  const secondLocal = "% Another unsaved editor change.\n";
  const secondDisk = "% Disk version selected explicitly.\n";
  await editor.fill(secondLocal);
  await fs.writeFile(mainFile, secondDisk);
  await page.locator(".external-change-banner").waitFor();
  assert.ok((await editor.textContent()).includes(secondLocal.trim()));
  assert.equal(await fs.readFile(mainFile, "utf8"), secondDisk);
  await page.getByRole("button", { name: "Use disk version", exact: true }).click();
  await page.locator(".external-change-banner").waitFor({ state: "hidden" });
  assert.ok((await editor.textContent()).includes(secondDisk.trim()));
  assert.equal(await fs.readFile(mainFile, "utf8"), secondDisk);
  console.log("PASS Use disk version explicitly resolves a second edit conflict");

  await page.getByRole("button", { name: "Restart terminal", exact: true }).click();
  const restarted = await poll(async () => {
    const current = await status();
    return current?.running && current.id !== initialSession.id ? current : false;
  }, "a new terminal session");
  await page.locator(".terminal-session-state.running").waitFor();
  assert.notEqual(restarted.pid, initialSession.pid);
  const reset = await runCommand(
    powershell ? "Write-Output ('AFTER_RESTART:' + $env:TYPESET_SMOKE_SESSION)" : "printf 'AFTER_RESTART:%s\\n' \"${TYPESET_SMOKE_SESSION-unset}\"",
    "RESTART",
  );
  assert.ok(!reset.output.includes("PERSIST:preserved"));
  if (!powershell) assert.ok(reset.output.includes("AFTER_RESTART:unset"));
  console.log("PASS Restart creates a fresh shell and buffer");

  assert.deepEqual(errors, []);
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/terminal-smoke.png" });
  console.log("PASS no renderer errors; screenshot saved to test-results/terminal-smoke.png");
} catch (error) {
  await fs.mkdir("test-results", { recursive: true });
  await page?.screenshot({ path: "test-results/terminal-smoke-failure.png" }).catch(() => {});
  throw error;
} finally {
  await application.close();
  if (!process.env.TYPESET_KEEP_TEST_DATA)
    await fs.rm(directory, { recursive: true, force: true });
}
