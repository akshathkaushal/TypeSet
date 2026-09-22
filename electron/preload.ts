import { contextBridge, ipcRenderer } from "electron";
import type { TypesetAPI } from "../shared/types";

const methods = [
  "getState",
  "saveSettings",
  "createProject",
  "openProject",
  "refreshProject",
  "readFile",
  "readBinary",
  "saveFile",
  "createFile",
  "renameFile",
  "deleteFile",
  "importFiles",
  "importZip",
  "exportZip",
  "exportPdf",
  "setProjectOptions",
  "compilerStatus",
  "setupCompiler",
  "compile",
  "cancelCompile",
  "readPdf",
  "gitStatus",
  "versions",
  "checkpoint",
  "diff",
  "restoreVersion",
  "setRemote",
  "cloneRepository",
  "push",
  "pull",
  "terminalStart",
  "terminalStatus",
  "terminalWrite",
  "terminalResize",
  "terminalStop",
  "openNativeTerminal",
  "driveStatus",
  "connectDrive",
  "disconnectDrive",
  "driveSnapshots",
  "saveDriveSnapshot",
  "restoreDriveSnapshot",
] as const;
const api: Record<string, unknown> = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(`typeset:${method}`, ...args),
  ]),
);
api.onCompileLog = (callback: (line: string) => void) => {
  const listener = (_event: unknown, line: string) => callback(line);
  ipcRenderer.on("typeset:compile-log", listener);
  return () => ipcRenderer.removeListener("typeset:compile-log", listener);
};
for (const [method, channel] of [
  ["onTerminalData", "typeset:terminal-data"],
  ["onTerminalExit", "typeset:terminal-exit"],
] as const) {
  api[method] = (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, event: unknown) => callback(event);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
api.onMenuAction = (callback: (action: string) => void) => {
  const listener = (_event: unknown, action: string) => callback(action);
  ipcRenderer.on("typeset:menu", listener);
  return () => ipcRenderer.removeListener("typeset:menu", listener);
};
contextBridge.exposeInMainWorld("typeset", api as unknown as TypesetAPI);
