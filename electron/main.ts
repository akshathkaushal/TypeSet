import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectService, atomicWrite } from "./services/projects";
import { CompilerService } from "./services/compiler";
import { GitService } from "./services/git";
import { systemGitEnvironment } from "./services/gitProxy";
import { DriveService } from "./services/drive";
import { TerminalService } from "./services/terminal";
import type { AppState, Project, Settings, TypesetAPI } from "../shared/types";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "typeset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
if (process.env.TYPESET_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.TYPESET_DATA_DIR));
app.setName("Typeset");
let win: BrowserWindow;
let current: Project | undefined;
const projects = new ProjectService();
const prepareGitEnvironment = (root: string, environment: NodeJS.ProcessEnv) =>
  systemGitEnvironment(root, environment, (url) =>
    session.defaultSession.resolveProxy(url),
  );
const git = new GitService({ networkEnvironment: prepareGitEnvironment });
let compiler: CompilerService;
let drive: DriveService;
const terminal = new TerminalService({
  prepareEnvironment: prepareGitEnvironment,
  onData: (event) => {
    if (win && !win.isDestroyed())
      win.webContents.send("typeset:terminal-data", event);
  },
  onExit: (event) => {
    if (win && !win.isDestroyed())
      win.webContents.send("typeset:terminal-exit", event);
  },
});
let state: AppState = {
  recent: [],
  version: app.getVersion(),
  settings: {
    autoCompile: false,
    fontSize: 14,
    theme: "light",
    googleClientId: "",
    googleClientSecret: "",
  },
};
const root = () => {
  if (!current) throw new Error("Open a project first.");
  return current.root;
};
const persist = () =>
  atomicWrite(
    path.join(app.getPath("userData"), "settings.json"),
    JSON.stringify(state, null, 2),
  );
async function activate(project: Project): Promise<Project> {
  await compiler.cancel();
  await terminal.stop();
  current = project;
  state.recent = [
    {
      root: project.root,
      name: project.name,
      openedAt: new Date().toISOString(),
    },
    ...state.recent.filter((p) => p.root !== project.root),
  ].slice(0, 12);
  await persist();
  win?.setTitle(`${project.name} — Typeset`);
  return project;
}
async function pickParent(title: string) {
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
}
function requireText(value: unknown, max = 10000): asserts value is string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid input.");
}
function setupHandlers() {
  const handlers: Omit<
    TypesetAPI,
    "onCompileLog" | "onMenuAction" | "onTerminalData" | "onTerminalExit"
  > = {
    getState: async () => ({ ...state, initialProject: current }),
    saveSettings: async (incoming) => {
      if (
        incoming.fontSize !== undefined &&
        (!Number.isFinite(incoming.fontSize) ||
          incoming.fontSize < 11 ||
          incoming.fontSize > 24)
      )
        throw new Error("Choose a font size between 11 and 24.");
      const next: Settings = { ...state.settings };
      if (typeof incoming.autoCompile === "boolean")
        next.autoCompile = incoming.autoCompile;
      if (incoming.theme === "light" || incoming.theme === "dark")
        next.theme = incoming.theme;
      if (incoming.fontSize !== undefined) next.fontSize = incoming.fontSize;
      for (const key of ["googleClientId", "googleClientSecret"] as const)
        if (incoming[key] !== undefined) {
          requireText(incoming[key], 2000);
          next[key] = incoming[key]!.trim();
        }
      state.settings = next;
      await persist();
      return next;
    },
    createProject: async (name) => {
      requireText(name, 100);
      const parent = await pickParent("Choose where to create your project");
      return parent ? activate(await projects.create(parent, name)) : null;
    },
    openProject: async (location) => {
      if (location !== undefined) {
        requireText(location, 4096);
        if (!state.recent.some((p) => p.root === location))
          throw new Error("Choose this folder using Open project.");
      }
      const selected = location || (await pickParent("Open a LaTeX project"));
      return selected ? activate(await projects.open(selected)) : null;
    },
    refreshProject: async () => {
      const projectRoot = root();
      const refreshed = await projects.describe(projectRoot);
      if (current?.root === projectRoot) current = refreshed;
      return refreshed;
    },
    readFile: async (file) => {
      requireText(file);
      return projects.read(root(), file);
    },
    readBinary: async (file) => {
      requireText(file);
      return projects.readBinary(root(), file);
    },
    saveFile: async (file, content, expectedContent, projectRoot) => {
      requireText(file);
      requireText(content, 5 * 1024 * 1024);
      requireText(expectedContent, 5 * 1024 * 1024);
      requireText(projectRoot, 4096);
      if (projectRoot !== root())
        throw new Error(
          "The active project changed. Your unsaved edits have been kept in the editor.",
        );
      await projects.save(root(), file, content, expectedContent);
    },
    createFile: async (file, directory) => {
      requireText(file);
      return (current = await projects.add(root(), file, !!directory));
    },
    renameFile: async (from, to) => {
      requireText(from);
      requireText(to);
      return (current = await projects.rename(root(), from, to));
    },
    deleteFile: async (file) => {
      requireText(file);
      const filename = await projects.remove(root(), file);
      const answer = await dialog.showMessageBox(win, {
        type: "question",
        message: `Move “${file}” to the Trash?`,
        detail: "You can recover it from your operating system’s Trash.",
        buttons: ["Cancel", "Move to Trash"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) await shell.trashItem(filename);
      return (current = await projects.describe(root()));
    },
    importFiles: async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "Add files to project",
        properties: ["openFile", "multiSelections"],
      });
      return (current = r.canceled
        ? await projects.describe(root())
        : await projects.importFiles(root(), r.filePaths));
    },
    importZip: async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "Import a project archive",
        properties: ["openFile"],
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (r.canceled) return null;
      const parent = await pickParent("Choose where to extract the project");
      if (!parent) return null;
      if ((await fs.stat(r.filePaths[0])).size > 100 * 1024 * 1024)
        throw new Error("Archive exceeds the 100 MB limit.");
      const name = path.basename(r.filePaths[0], ".zip");
      return activate(
        await projects.importArchive(
          parent,
          name,
          await fs.readFile(r.filePaths[0]),
        ),
      );
    },
    exportZip: async () => {
      const project = root();
      const r = await dialog.showSaveDialog(win, {
        title: "Export project",
        defaultPath: `${current!.name}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (r.canceled || !r.filePath) return null;
      await atomicWrite(r.filePath, await projects.zip(project));
      return r.filePath;
    },
    exportPdf: async () => {
      const data = await compiler.readPdf(root());
      if (!data)
        throw new Error("Compile successfully before exporting a PDF.");
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `${current!.name}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (r.canceled || !r.filePath) return null;
      await atomicWrite(r.filePath, data);
      return r.filePath;
    },
    setProjectOptions: async (options) =>
      (current = await projects.options(root(), options)),
    compilerStatus: () => compiler.status(),
    setupCompiler: () => compiler.setup(),
    compile: async () => {
      const project = await projects.describe(root());
      return compiler.compile(project.root, project.mainFile, project.engine);
    },
    cancelCompile: () => compiler.cancel(),
    readPdf: () => compiler.readPdf(root()),
    terminalStart: (cols, rows) => terminal.start(root(), cols, rows),
    terminalStatus: async () => terminal.status(root()),
    terminalWrite: async (id, data) => {
      requireText(id, 100);
      requireText(data, 65536);
      terminal.write(root(), id, data);
    },
    terminalResize: async (id, cols, rows) => {
      requireText(id, 100);
      terminal.resize(root(), id, cols, rows);
    },
    terminalStop: async (id) => {
      requireText(id, 100);
      await terminal.stop(root(), id);
    },
    openNativeTerminal: () => terminal.openNativeTerminal(root()),
    gitStatus: () => git.status(root()),
    versions: () => git.versions(root()),
    checkpoint: async (message) => {
      requireText(message, 300);
      return git.checkpoint(root(), message);
    },
    diff: async (hash) => {
      if (hash) requireText(hash, 64);
      return git.diff(root(), hash);
    },
    restoreVersion: async (hash) => {
      requireText(hash, 64);
      const project = root();
      await git.restore(project, hash);
      return (current = await projects.describe(project));
    },
    setRemote: async (url) => {
      requireText(url, 2048);
      return git.setRemote(root(), url);
    },
    cloneRepository: async (url) => {
      requireText(url, 2048);
      const parent = await pickParent("Choose where to clone the repository");
      if (!parent) return null;
      const name = url
        .replace(/\/$/, "")
        .split("/")
        .pop()!
        .replace(/\.git$/, "");
      if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
        throw new Error("Invalid repository name.");
      const destination = path.join(parent, name);
      await git.clone(url, destination);
      return activate(await projects.open(destination));
    },
    push: () => git.push(root()),
    pull: async () => {
      const project = root();
      await git.pull(project);
      return (current = await projects.describe(project));
    },
    driveStatus: () => drive.status(),
    connectDrive: () => drive.connect(),
    disconnectDrive: () => drive.disconnect(),
    driveSnapshots: async () =>
      drive.listSnapshots((await projects.metadata(root())).id),
    saveDriveSnapshot: async (label) => {
      requireText(label, 150);
      const project = root();
      return drive.saveSnapshot(
        (await projects.metadata(project)).id,
        current!.name,
        label,
        await projects.zip(project),
      );
    },
    restoreDriveSnapshot: async (id) => {
      requireText(id, 256);
      const parent = await pickParent(
        "Choose where to restore a separate copy",
      );
      if (!parent) return null;
      return activate(
        await projects.importArchive(
          parent,
          `Restored project ${Date.now()}`,
          await drive.downloadSnapshot(id),
        ),
      );
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`typeset:${name}`, async (event, ...args: unknown[]) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error("Untrusted application request.");
      return (handler as (...args: unknown[]) => unknown)(...args);
    });
}

async function main() {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  try {
    const saved = JSON.parse(
      await fs.readFile(
        path.join(app.getPath("userData"), "settings.json"),
        "utf8",
      ),
    );
    state = {
      ...state,
      ...saved,
      settings: { ...state.settings, ...saved.settings },
    };
    delete state.initialProject;
  } catch {}
  compiler = new CompilerService({
    compilerDir: app.isPackaged
      ? path.join(process.resourcesPath, "compiler")
      : path.join(app.getAppPath(), "compiler"),
    cacheDir: path.join(app.getPath("userData"), "builds"),
    onLog: (line) => win?.webContents.send("typeset:compile-log", line),
  });
  drive = new DriveService({
    storageDir: app.getPath("userData"),
    getCredentials: () => ({
      clientId: state.settings.googleClientId,
      clientSecret: state.settings.googleClientSecret,
    }),
    encrypt: (text) => {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw new Error(
          "An operating-system keyring is required to store your Google connection securely.",
        );
      return safeStorage.encryptString(text);
    },
    decrypt: (data) => safeStorage.decryptString(data),
    openExternal: (url) => shell.openExternal(url),
    fetch: (url, init) => net.fetch(url, init),
  });
  protocol.handle("typeset", (request) => {
    const url = new URL(request.url);
    const dist = path.join(app.getAppPath(), "dist");
    const relative =
      decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filename = path.resolve(dist, relative);
    if (url.host !== "app" || !filename.startsWith(dist + path.sep))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filename).toString());
  });
  session.defaultSession.setPermissionRequestHandler(
    (_web, _permission, callback) => callback(false),
  );
  win = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: "#f7f6f2",
    title: "Typeset",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  setupHandlers();
  for (const recent of state.recent) {
    try {
      current = await projects.open(recent.root);
      break;
    } catch {}
  }
  if (!current) {
    const welcomeDir = path.join(app.getPath("userData"), "projects");
    await fs.mkdir(welcomeDir, { recursive: true });
    try {
      current = await projects.open(
        path.join(welcomeDir, "The shape of an idea"),
      );
    } catch {
      current = await projects.create(welcomeDir, "The shape of an idea");
    }
    await activate(current);
  }
  const send = (action: string) => () =>
    win.webContents.send("typeset:menu", action);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "Typeset",
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                {
                  label: "Settings…",
                  accelerator: "CmdOrCtrl+,",
                  click: send("settings"),
                },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          {
            label: "New project…",
            accelerator: "CmdOrCtrl+N",
            click: send("new-project"),
          },
          {
            label: "Open project…",
            accelerator: "CmdOrCtrl+O",
            click: send("open-project"),
          },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: send("save") },
          {
            label: "Recompile",
            accelerator: "CmdOrCtrl+Enter",
            click: send("compile"),
          },
          { type: "separator" },
          { label: "Export PDF…", click: send("export-pdf") },
          { label: "Export project…", click: send("export-zip") },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle terminal",
            accelerator: "Ctrl+`",
            click: send("terminal"),
          },
          ...(process.platform === "darwin"
            ? [
                {
                  label: "Open project in Terminal",
                  click: send("native-terminal"),
                },
              ]
            : []),
          { role: "togglefullscreen" },
          { label: "Toggle theme", click: send("theme") },
          ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
        ],
      },
    ]),
  );
  if (process.env.VITE_DEV_SERVER_URL && !app.isPackaged)
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadURL("typeset://app/index.html");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(main)
    .catch((error) => {
      dialog.showErrorBox("Typeset could not start", String(error));
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void compiler?.cancel();
});
let terminalQuitCleanupStarted = false;
app.on("will-quit", (event) => {
  if (terminalQuitCleanupStarted) return;
  event.preventDefault();
  terminalQuitCleanupStarted = true;
  void terminal
    .dispose()
    .catch(() => {})
    // Even an unused terminal resolves asynchronously. Let Electron finish
    // cancelling this quit before requesting the next one.
    .finally(() => setImmediate(() => app.quit()));
});
