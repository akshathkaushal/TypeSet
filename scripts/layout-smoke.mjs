import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "typeset-layout-"));
const env = { ...process.env, TYPESET_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
let application;
let page;
const errors = [];
async function launch() {
  application = await electron.launch({
    executablePath: process.env.TYPESET_EXECUTABLE || electronPath,
    args: process.env.TYPESET_EXECUTABLE ? [] : ["."],
    env,
  });
  await resizeWindow(1400, 950);
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".cm-content");
}
async function resizeWindow(width, height) {
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(...size);
    },
    [width, height],
  );
}
const handle = (name) => page.getByRole("separator", { name, exact: true });
const bounds = (selector) => page.locator(selector).boundingBox();
const closeTo = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 3,
    `${actual} should be near ${expected}`,
  );
async function poll(read, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function drag(name, dx, dy) {
  const box = await handle(name).boundingBox();
  assert.ok(box, `${name} is visible`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.resizing),
    undefined,
  );
}
const value = async (name) =>
  Number(await handle(name).getAttribute("aria-valuenow"));
const toggleTerminal = () =>
  page
    .locator(".statusbar")
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
const terminalStatus = () =>
  page.evaluate(() => window.typeset.terminalStatus());

try {
  await launch();
  await poll(
    async () => (await bounds(".sidebar"))?.width === 246,
    "initial sidebar size",
  );
  const original = await page.evaluate(() =>
    window.typeset.readFile("main.tex"),
  );
  const sidebarBefore = await bounds(".sidebar");
  await drag("Resize sidebar", 90, 0);
  closeTo((await bounds(".sidebar")).width, sidebarBefore.width + 90);
  const editorBefore = await bounds(".source-pane");
  const previewBefore = await bounds(".preview-pane");
  await drag("Resize editor and preview", -100, 0);
  closeTo((await bounds(".source-pane")).width, editorBefore.width - 100);
  closeTo((await bounds(".preview-pane")).width, previewBefore.width + 100);
  console.log("PASS sidebar and editor/preview dividers follow mouse drags");

  await toggleTerminal();
  await page.locator(".terminal-session-state.running").waitFor();
  const session = await terminalStatus();
  const terminalBefore = await bounds(".terminal-panel");
  const sourceBefore = await bounds(".source-pane");
  await drag("Resize terminal", 0, -110);
  closeTo(
    (await bounds(".terminal-panel")).height,
    terminalBefore.height + 110,
  );
  closeTo((await bounds(".source-pane")).height, sourceBefore.height - 110);
  await poll(
    async () => (await terminalStatus()).rows > session.rows,
    "PTY grows with its panel",
  );
  assert.equal((await terminalStatus()).id, session.id);
  const columns = (await terminalStatus()).cols;
  await drag("Resize sidebar", 30, 0);
  await poll(
    async () => (await terminalStatus()).cols < columns,
    "PTY follows workspace width",
  );
  console.log(
    "PASS terminal resizing updates PTY dimensions and preserves the shell",
  );

  await drag("Resize terminal", 0, -2000);
  assert.ok((await bounds(".source-pane")).height >= 179);
  closeTo(
    (await bounds(".terminal-panel")).height,
    Number(await handle("Resize terminal").getAttribute("aria-valuemax")),
  );
  await drag("Resize terminal", 0, 2000);
  closeTo((await bounds(".terminal-panel")).height, 120);
  await handle("Resize terminal").dblclick();
  closeTo((await bounds(".terminal-panel")).height, 280);
  await handle("Resize sidebar").dblclick();
  closeTo((await bounds(".sidebar")).width, 246);
  await handle("Resize editor and preview").dblclick();
  closeTo(await value("Resize editor and preview"), 51);
  await handle("Resize sidebar").press("ArrowRight");
  closeTo((await bounds(".sidebar")).width, 256);
  await handle("Resize terminal").press("ArrowUp");
  closeTo((await bounds(".terminal-panel")).height, 290);
  await handle("Resize editor and preview").press("ArrowRight");
  closeTo(await value("Resize editor and preview"), 53);
  console.log("PASS limits, double-click reset, and keyboard resizing");

  await drag("Resize sidebar", 64, 0);
  await drag("Resize terminal", 0, -45);
  const preferred = {
    sidebar: 320,
    terminal: 335,
    editor: await value("Resize editor and preview"),
  };
  await page.getByTitle("Hide sidebar", { exact: true }).click();
  await page.getByTitle("Show sidebar", { exact: true }).click();
  closeTo((await bounds(".sidebar")).width, preferred.sidebar);
  await page
    .getByRole("button", { name: "Hide terminal", exact: true })
    .click();
  await toggleTerminal();
  closeTo((await bounds(".terminal-panel")).height, preferred.terminal);
  assert.equal((await terminalStatus()).id, session.id);

  await page
    .locator(".statusbar")
    .getByRole("button", { name: "Compilation output", exact: true })
    .click();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  const logsBefore = await bounds(".logs-panel");
  await drag("Resize compilation output", 0, -60);
  closeTo((await bounds(".logs-panel")).height, logsBefore.height + 60);
  await toggleTerminal();
  closeTo((await bounds(".terminal-panel")).height, preferred.terminal);
  assert.equal(
    await page.evaluate(() => window.typeset.readFile("main.tex")),
    original,
  );
  console.log(
    "PASS independent output sizes and hide/show without losing edits or sessions",
  );

  await poll(
    () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("typeset.workspace-layout.v1"))
            ?.terminal === 335,
      ),
    "saved layout preferences",
  );
  await application.close();
  application = null;
  await launch();
  closeTo((await bounds(".sidebar")).width, preferred.sidebar);
  closeTo(await value("Resize editor and preview"), preferred.editor);
  await toggleTerminal();
  await page.locator(".terminal-session-state.running").waitFor();
  closeTo((await bounds(".terminal-panel")).height, preferred.terminal);
  console.log("PASS panel sizes survive a full application restart");

  await handle("Resize sidebar").press("End");
  await resizeWindow(1050, 680);
  await poll(
    async () => (await bounds(".sidebar")).width < 460,
    "sidebar clamps to a smaller window",
  );
  assert.ok((await bounds(".source-pane")).width >= 219);
  assert.ok((await bounds(".preview-pane")).width >= 219);
  assert.ok((await bounds(".source-pane")).height >= 179);
  assert.ok((await bounds(".terminal-panel")).height < preferred.terminal);
  assert.ok(
    await page.evaluate(() => document.body.scrollWidth <= window.innerWidth),
  );
  await resizeWindow(1400, 950);
  await poll(
    async () => (await bounds(".sidebar")).width === 460,
    "preferred size returns in a larger window",
  );
  closeTo((await bounds(".terminal-panel")).height, preferred.terminal);
  await drag("Resize sidebar", -140, 0);
  console.log(
    "PASS window resizing keeps all panes usable and restores preferred dimensions",
  );

  assert.deepEqual(errors, []);
  await fs.mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/layout-smoke.png" });
  console.log("PASS no renderer errors; test-results/layout-smoke.png saved");
} catch (error) {
  await fs.mkdir("test-results", { recursive: true });
  await page
    ?.screenshot({ path: "test-results/layout-smoke-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await application?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
