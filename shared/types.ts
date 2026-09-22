export type Engine = "pdflatex" | "xelatex" | "lualatex";
export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  children?: FileEntry[];
}
export interface Project {
  root: string;
  name: string;
  files: FileEntry[];
  mainFile: string;
  engine: Engine;
}
export interface RecentProject {
  root: string;
  name: string;
  openedAt: string;
}
export interface Diagnostic {
  file?: string;
  line?: number;
  message: string;
  severity: "error" | "warning";
}
export interface CompileResult {
  id: string;
  success: boolean;
  log: string;
  durationMs: number;
  diagnostics: Diagnostic[];
  pdfPath?: string;
}
export interface CompilerStatus {
  installed: boolean;
  running: boolean;
  imageReady: boolean;
  message: string;
}
export interface Version {
  hash: string;
  message: string;
  date: string;
  author: string;
}
export interface GitStatus {
  initialized: boolean;
  branch: string;
  remote: string;
  changed: number;
  changes: string[];
}
export interface DriveSnapshot {
  id: string;
  name: string;
  createdTime: string;
  size?: string;
}
export interface DriveStatus {
  connected: boolean;
  configured: boolean;
}
export interface Settings {
  autoCompile: boolean;
  fontSize: number;
  theme: "light" | "dark";
  googleClientId: string;
  googleClientSecret: string;
}
export interface AppState {
  recent: RecentProject[];
  settings: Settings;
  version: string;
  initialProject?: Project;
}
export interface TerminalSession {
  id: string;
  root: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  running: boolean;
  output: string;
  sequence: number;
  exitCode?: number;
  signal?: number;
}
export interface TerminalDataEvent {
  id: string;
  root: string;
  data: string;
  sequence: number;
}
export interface TerminalExitEvent {
  id: string;
  root: string;
  exitCode: number;
  signal?: number;
  sequence: number;
}
export interface TypesetAPI {
  getState(): Promise<AppState>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
  createProject(name: string): Promise<Project | null>;
  openProject(root?: string): Promise<Project | null>;
  refreshProject(): Promise<Project>;
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  saveFile(
    path: string,
    content: string,
    expectedContent: string,
    projectRoot: string,
  ): Promise<void>;
  createFile(path: string, directory?: boolean): Promise<Project>;
  renameFile(from: string, to: string): Promise<Project>;
  deleteFile(path: string): Promise<Project>;
  importFiles(): Promise<Project>;
  importZip(): Promise<Project | null>;
  exportZip(): Promise<string | null>;
  exportPdf(): Promise<string | null>;
  setProjectOptions(options: {
    mainFile?: string;
    engine?: Engine;
  }): Promise<Project>;
  compilerStatus(): Promise<CompilerStatus>;
  setupCompiler(): Promise<CompilerStatus>;
  compile(): Promise<CompileResult>;
  cancelCompile(): Promise<void>;
  readPdf(): Promise<Uint8Array | null>;
  gitStatus(): Promise<GitStatus>;
  versions(): Promise<Version[]>;
  checkpoint(message: string): Promise<Version[]>;
  diff(hash?: string): Promise<string>;
  restoreVersion(hash: string): Promise<Project>;
  setRemote(url: string): Promise<GitStatus>;
  cloneRepository(url: string): Promise<Project | null>;
  push(): Promise<string>;
  pull(): Promise<Project>;
  terminalStart(cols: number, rows: number): Promise<TerminalSession>;
  terminalStatus(): Promise<TerminalSession | null>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalStop(id: string): Promise<void>;
  openNativeTerminal(): Promise<void>;
  driveStatus(): Promise<DriveStatus>;
  connectDrive(): Promise<DriveStatus>;
  disconnectDrive(): Promise<void>;
  driveSnapshots(): Promise<DriveSnapshot[]>;
  saveDriveSnapshot(label: string): Promise<DriveSnapshot>;
  restoreDriveSnapshot(id: string): Promise<Project | null>;
  onCompileLog(callback: (line: string) => void): () => void;
  onTerminalData(callback: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(callback: (event: TerminalExitEvent) => void): () => void;
  onMenuAction(callback: (action: string) => void): () => void;
}
