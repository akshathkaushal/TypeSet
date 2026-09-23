import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Cloud,
  Code2,
  File,
  FilePlus2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Github,
  History,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Moon,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Editor from "./components/Editor";
import PdfViewer from "./components/PdfViewer";
import TerminalPanel from "./components/TerminalPanel";
import ResizeHandle from "./components/ResizeHandle";
import {
  DEFAULT_LAYOUT,
  useElementSize,
  useWorkspaceLayout,
} from "./lib/workspaceLayout";
import { reconcileDocumentText } from "./lib/documentSync";
import type {
  CompilerStatus,
  CompileResult,
  DriveSnapshot,
  DriveStatus,
  FileEntry,
  GitStatus,
  Project,
  RecentProject,
  Settings,
  Version,
} from "../shared/types";

const api = window.typeset;
const defaults: Settings = {
  autoCompile: false,
  fontSize: 14,
  theme: "light",
  googleClientId: "",
  googleClientSecret: "",
};
type Doc = {
  path: string;
  content: string;
  dirty: boolean;
  savedContent?: string;
  conflict?: "changed" | "deleted";
  kind: "text" | "image" | "binary";
  url?: string;
};
type Modal =
  | "new-project"
  | "new-file"
  | "new-folder"
  | "rename"
  | "clone"
  | "checkpoint"
  | "save-copy"
  | "settings"
  | "setup"
  | "about"
  | null;
type Side = "files" | "history" | "sync";
const allFiles = (entries: FileEntry[]): string[] =>
  entries.flatMap((f) =>
    f.kind === "directory" ? allFiles(f.children || []) : [f.path],
  );
const errorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [settings, setSettings] = useState(defaults);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsWrite = useRef(Promise.resolve(defaults));
  const settingsRevision = useRef(0);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const docsRef = useRef(documents);
  docsRef.current = documents;
  const [active, setActive] = useState("");
  const [side, setSide] = useState<Side>("files");
  const [sidebar, setSidebar] = useState(true);
  const [modal, setModal] = useState<Modal>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [renameSource, setRenameSource] = useState("");
  const [copySource, setCopySource] = useState("");
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [menu, setMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [compiler, setCompiler] = useState<CompilerStatus | null>(null);
  const [compiling, setCompiling] = useState(false);
  const compilingRef = useRef(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [logs, setLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [externalTerminalUsed, setExternalTerminalUsed] = useState(false);
  const refreshPending = useRef<Promise<void> | null>(null);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [pdfRevision, setPdfRevision] = useState(0);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [snapshots, setSnapshots] = useState<DriveSnapshot[]>([]);
  const [remote, setRemote] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [goToLine, setGoToLine] = useState<{ line: number; nonce: number }>();
  const [savedAt, setSavedAt] = useState("All changes saved");
  const { layout, resize } = useWorkspaceLayout();
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>();
  const [panesRef, panesSize] = useElementSize<HTMLDivElement>();
  const [splitRef, splitSize] = useElementSize<HTMLDivElement>();
  const sidebarMax = Math.max(
    180,
    Math.min(460, (bodySize.width || window.innerWidth) - 608),
  );
  const sidebarWidth = Math.min(layout.sidebar, sidebarMax);
  const editorSpace = Math.max(1, splitSize.width - 8);
  const editorMin = Math.min(45, Math.max(15, (220 / editorSpace) * 100));
  const editorSplit = Math.max(
    editorMin,
    Math.min(100 - editorMin, layout.editor),
  );
  const panelMax = Math.max(
    120,
    (panesSize.height || window.innerHeight - 210) - 188,
  );
  const bottomPanel = showTerminal ? "terminal" : showLogs ? "logs" : null;
  const panelHeight = Math.min(layout[bottomPanel ?? "terminal"], panelMax);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef(Promise.resolve());
  const generation = useRef(0);
  const editRevision = useRef(0);
  const queuedCompile = useRef(false);
  const currentProject = useRef(project);
  currentProject.current = project;
  const runCompileRef = useRef<() => Promise<void>>(async () => {});
  const notify = useCallback(
    (message: string, error = false) => setNotice({ message, error }),
    [],
  );
  const updateDocs = (updater: (docs: Doc[]) => Doc[]) => {
    docsRef.current = updater(docsRef.current);
    setDocuments(docsRef.current);
  };
  const action = async <T,>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    if (compileTimer.current) clearTimeout(compileTimer.current);
    try {
      return await fn();
    } catch (error) {
      notify(errorText(error), true);
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const saveAll = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const projectRoot = currentProject.current?.root;
    const task = async () => {
      if (!projectRoot || projectRoot !== currentProject.current?.root) return;
      const dirty = docsRef.current.filter((doc) => doc.dirty);
      if (!dirty.length) return;
      setSavedAt("Saving…");
      for (const doc of dirty) {
        if (doc.conflict)
          throw new Error(
            `${doc.path} changed outside Typeset. Use the disk version or save your edits as a copy.`,
          );
        try {
          await api.saveFile(
            doc.path,
            doc.content,
            doc.savedContent ?? "",
            projectRoot,
          );
        } catch (error) {
          if (errorText(error).includes("changed outside Typeset")) {
            updateDocs((list) =>
              list.map((current) =>
                current.path === doc.path
                  ? { ...current, conflict: "changed" }
                  : current,
              ),
            );
            if (compileTimer.current) clearTimeout(compileTimer.current);
            queuedCompile.current = false;
          }
          throw error;
        }
        updateDocs((list) =>
          list.map((current) =>
            current.path === doc.path
              ? {
                  ...current,
                  savedContent: doc.content,
                  dirty: current.content !== doc.content,
                  conflict: undefined,
                }
              : current,
          ),
        );
      }
      setSavedAt(
        docsRef.current.some((d) => d.dirty)
          ? "Unsaved changes"
          : "All changes saved",
      );
    };
    const next = saveChain.current.catch(() => {}).then(task);
    saveChain.current = next;
    try {
      await next;
    } catch (error) {
      setSavedAt("Could not save");
      throw error;
    }
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      setFileMenu(null);
      if (docsRef.current.some((doc) => doc.path === path)) {
        setActive(path);
        return;
      }
      const token = generation.current;
      try {
        let doc: Doc;
        if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
          const bytes = await api.readBinary(path);
          const type = path.endsWith(".png")
            ? "image/png"
            : /\.jpe?g$/i.test(path)
              ? "image/jpeg"
              : path.endsWith(".gif")
                ? "image/gif"
                : "image/webp";
          doc = {
            path,
            content: "",
            dirty: false,
            kind: "image",
            url: URL.createObjectURL(
              new Blob([new Uint8Array(bytes)], { type }),
            ),
          };
        } else if (/\.(pdf|woff2?|ttf|otf|zip)$/i.test(path))
          doc = { path, content: "", dirty: false, kind: "binary" };
        else {
          const content = await api.readFile(path);
          doc = {
            path,
            content,
            savedContent: content,
            dirty: false,
            kind: "text",
          };
        }
        if (token !== generation.current) {
          if (doc.url) URL.revokeObjectURL(doc.url);
          return;
        }
        updateDocs((list) =>
          list.some((d) => d.path === path) ? list : [...list, doc],
        );
        setActive(path);
      } catch (error) {
        notify(errorText(error), true);
      }
    },
    [notify],
  );

  const refreshVersions = useCallback(async (preserveRemoteInput = false) => {
    const token = generation.current;
    const [status, history] = await Promise.all([
      api.gitStatus(),
      api.versions(),
    ]);
    if (token !== generation.current) return;
    setGit(status);
    setVersions(history);
    if (!preserveRemoteInput) setRemote(status.remote);
  }, []);
  const refreshDrive = useCallback(async () => {
    const token = generation.current;
    const status = await api.driveStatus();
    if (token !== generation.current) return;
    setDrive(status);
    if (status.connected) {
      const list = await api.driveSnapshots();
      if (token === generation.current) setSnapshots(list);
    } else setSnapshots([]);
  }, []);

  const refreshFromDisk = useCallback(async () => {
    if (!currentProject.current || busyRef.current) return;
    if (refreshPending.current) return refreshPending.current;
    const token = generation.current;
    const projectRoot = currentProject.current.root;
    const isCurrent = () =>
      token === generation.current &&
      projectRoot === currentProject.current?.root;
    const task = async () => {
      if (!isCurrent()) return;
      const next = await api.refreshProject();
      if (!isCurrent() || next.root !== projectRoot) return;
      const paths = new Set(allFiles(next.files));
      const contents = new Map<string, string | null>();
      for (const doc of docsRef.current.filter((doc) => doc.kind === "text")) {
        if (!paths.has(doc.path)) contents.set(doc.path, null);
        else {
          try {
            contents.set(doc.path, await api.readFile(doc.path));
          } catch (error) {
            if (/ENOENT|not found|does not exist/i.test(errorText(error)))
              contents.set(doc.path, null);
            else throw error;
          }
        }
        if (!isCurrent()) return;
      }
      updateDocs((list) =>
        list.map((doc) => {
          if (!contents.has(doc.path)) return doc;
          const change = reconcileDocumentText(
            { ...doc, savedContent: doc.savedContent ?? "" },
            contents.get(doc.path)!,
          );
          if (change.kind === "reload")
            return {
              ...doc,
              content: change.content,
              savedContent: change.content,
              dirty: false,
              conflict: undefined,
            };
          if (change.kind === "conflict")
            return { ...doc, conflict: change.reason };
          if (change.kind === "missing") return { ...doc, conflict: "deleted" };
          return { ...doc, conflict: undefined };
        }),
      );
      if (docsRef.current.some((doc) => doc.conflict)) {
        if (compileTimer.current) clearTimeout(compileTimer.current);
        queuedCompile.current = false;
        setSavedAt("External changes need attention");
      } else if (!docsRef.current.some((doc) => doc.dirty))
        setSavedAt("All changes saved");
      setProject(next);
      await refreshVersions(true).catch(() => {});
    };
    const pending = saveChain.current.catch(() => {}).then(task);
    saveChain.current = pending;
    refreshPending.current = pending;
    try {
      await pending;
    } finally {
      if (refreshPending.current === pending) refreshPending.current = null;
    }
  }, [refreshVersions]);

  const loadProject = useCallback(
    async (next: Project) => {
      generation.current++;
      queuedCompile.current = false;
      if (compileTimer.current) clearTimeout(compileTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      docsRef.current.forEach((d) => {
        if (d.url) URL.revokeObjectURL(d.url);
      });
      updateDocs(() => []);
      setActive("");
      currentProject.current = next;
      setProject(next);
      setResult(null);
      setLogs("");
      setShowLogs(false);
      setShowTerminal(false);
      setTerminalMounted(false);
      setExternalTerminalUsed(false);
      setDiff(null);
      setSavedAt("All changes saved");
      setSide("files");
      setPdf(await api.readPdf());
      setPdfRevision((v) => v + 1);
      const list = allFiles(next.files);
      const first = list.includes(next.mainFile)
        ? next.mainFile
        : list.find((f) => f.endsWith(".tex")) || list[0];
      if (first) await openFile(first);
      await Promise.all([
        refreshVersions().catch((error) => notify(errorText(error), true)),
        refreshDrive().catch((error) => notify(errorText(error), true)),
      ]);
      setRecent((await api.getState()).recent);
    },
    [openFile, refreshVersions, refreshDrive, notify],
  );

  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .getState()
      .then(async (state) => {
        if (!live) return;
        setSettings(state.settings);
        setRecent(state.recent);
        if (state.initialProject) await loadProject(state.initialProject);
      })
      .catch((error) => notify(errorText(error), true));
    api
      .compilerStatus()
      .then((status) => {
        if (live) setCompiler(status);
      })
      .catch((error) => notify(errorText(error), true));
    const unsubscribe = api.onCompileLog((line) =>
      setLogs((text) => (text + line).slice(-200000)),
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [loadProject, notify]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    const refresh = () => {
      void refreshFromDisk().catch((error) => notify(errorText(error), true));
    };
    window.addEventListener("focus", refresh);
    const timer =
      terminalMounted || externalTerminalUsed
        ? setInterval(refresh, 2000)
        : null;
    return () => {
      window.removeEventListener("focus", refresh);
      if (timer) clearInterval(timer);
    };
  }, [refreshFromDisk, notify, terminalMounted, externalTerminalUsed]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (docsRef.current.some((d) => d.dirty)) {
        event.preventDefault();
        void saveAll()
          .then(() => window.close())
          .catch((error) => notify(errorText(error), true));
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveAll, notify]);

  const compileNow = useCallback(async () => {
    if (!currentProject.current) return;
    if (compilingRef.current) {
      queuedCompile.current = true;
      return;
    }
    compilingRef.current = true;
    setCompiling(true);
    setLogs("");
    const token = generation.current;
    try {
      await saveAll();
      const revision = editRevision.current;
      const next = await api.compile();
      if (token !== generation.current) return;
      setResult(next);
      if (next.success) {
        if (
          revision === editRevision.current ||
          !settingsRef.current.autoCompile
        ) {
          setPdf(await api.readPdf());
          setPdfRevision((v) => v + 1);
        }
        setCompiler({
          installed: true,
          running: true,
          imageReady: true,
          message: "Ready to compile",
        });
      } else {
        setShowTerminal(false);
        setShowLogs(true);
      }
    } catch (error) {
      if (token === generation.current) {
        notify(errorText(error), true);
        setShowTerminal(false);
        setShowLogs(true);
      }
    } finally {
      compilingRef.current = false;
      setCompiling(false);
      if (queuedCompile.current && token === generation.current) {
        queuedCompile.current = false;
        void runCompileRef.current();
      }
    }
  }, [saveAll, notify]);
  runCompileRef.current = compileNow;

  const changeContent = (content: string) => {
    editRevision.current++;
    updateDocs((list) =>
      list.map((doc) =>
        doc.path === active ? { ...doc, content, dirty: true } : doc,
      ),
    );
    setSavedAt("Unsaved changes");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (docsRef.current.some((doc) => doc.conflict && doc.dirty)) {
      if (compileTimer.current) clearTimeout(compileTimer.current);
      queuedCompile.current = false;
      setSavedAt("Edits kept in editor — resolve external changes");
      return;
    }
    saveTimer.current = setTimeout(() => {
      void saveAll().catch((error) => notify(errorText(error), true));
    }, 650);
    if (settingsRef.current.autoCompile) {
      if (compileTimer.current) clearTimeout(compileTimer.current);
      compileTimer.current = setTimeout(() => void compileNow(), 1200);
    }
  };
  const changeSettings = async (next: Partial<Settings>) => {
    const previous = settingsRef.current;
    const merged = { ...previous, ...next };
    const revision = ++settingsRevision.current;
    settingsRef.current = merged;
    setSettings(merged);
    const pending = settingsWrite.current
      .catch(() => previous)
      .then(() => api.saveSettings(merged));
    settingsWrite.current = pending;
    try {
      const saved = await pending;
      if (revision === settingsRevision.current) setSettings(saved);
      return true;
    } catch (error) {
      if (revision === settingsRevision.current) setSettings(previous);
      notify(errorText(error), true);
      return false;
    }
  };
  const switchProject = async (fn: () => Promise<Project | null>) => {
    setMenu(false);
    await action("Opening project", async () => {
      await saveAll();
      await api.cancelCompile();
      const next = await fn();
      if (next) await loadProject(next);
    });
  };
  const changeMainDocument = (mainFile: string) =>
    action("Changing main document", async () => {
      await saveAll();
      setProject(await api.setProjectOptions({ mainFile }));
    });
  const openModal = (name: Modal, value = "") => {
    if (busyRef.current) return;
    if (name === "rename") setRenameSource(value);
    setInput(value);
    setModal(name);
    setMenu(false);
    setFileMenu(null);
  };
  const closeTab = async (path: string) => {
    try {
      await saveAll();
      const existing = docsRef.current.find((d) => d.path === path);
      if (existing?.url) URL.revokeObjectURL(existing.url);
      updateDocs((list) => list.filter((d) => d.path !== path));
      if (active === path) setActive(docsRef.current.at(-1)?.path || "");
    } catch (error) {
      notify(errorText(error), true);
    }
  };
  const selectSide = (next: Side) => {
    setSide(next);
    setSidebar(true);
    if (next === "history")
      void refreshVersions().catch((error) => notify(errorText(error), true));
    if (next === "sync")
      void refreshDrive().catch((error) => notify(errorText(error), true));
  };

  const toggleTerminal = () => {
    if (showTerminal) {
      setShowTerminal(false);
      return;
    }
    if (!currentProject.current) {
      notify("Open a project to use the terminal.");
      return;
    }
    void action("Opening terminal", async () => {
      await saveAll();
      setShowLogs(false);
      setTerminalMounted(true);
      setShowTerminal(true);
    });
  };
  const openNativeTerminal = async () => {
    if (!currentProject.current) {
      notify("Open a project to use the terminal.");
      return;
    }
    await action("Opening macOS Terminal", async () => {
      await saveAll();
      await api.openNativeTerminal();
      setExternalTerminalUsed(true);
    });
  };
  const useDiskVersion = (path: string) =>
    action("Loading disk version", async () => {
      const content = await api.readFile(path);
      updateDocs((list) =>
        list.map((doc) =>
          doc.path === path
            ? {
                ...doc,
                content,
                savedContent: content,
                dirty: false,
                conflict: undefined,
              }
            : doc,
        ),
      );
      setSavedAt(
        docsRef.current.some((doc) => doc.dirty)
          ? "Unsaved changes"
          : "All changes saved",
      );
      setNotice(null);
    });
  const saveEditsAsCopy = (path: string) => {
    setCopySource(path);
    const dot = path.lastIndexOf(".");
    openModal(
      "save-copy",
      dot > path.lastIndexOf("/")
        ? `${path.slice(0, dot)}.local${path.slice(dot)}`
        : `${path}.local`,
    );
  };

  const submitModal = async () => {
    if (modal === "settings") {
      await changeSettings(settings);
      setModal(null);
      return;
    }
    const result = await action("Working", async () => {
      if (modal === "save-copy") {
        const doc = docsRef.current.find((doc) => doc.path === copySource);
        const projectRoot = currentProject.current?.root;
        if (!doc || !projectRoot)
          throw new Error("The document is no longer open.");
        const copyPath = input.trim();
        const next = await api.createFile(copyPath);
        await api.saveFile(copyPath, doc.content, "", projectRoot);
        setProject(next);
        const diskContent = allFiles(next.files).includes(copySource)
          ? await api.readFile(copySource)
          : null;
        updateDocs((list) => [
          ...list
            .filter(
              (item) =>
                item.path !== copyPath &&
                (item.path !== copySource || diskContent !== null),
            )
            .map((item) =>
              item.path === copySource
                ? {
                    ...item,
                    content: diskContent!,
                    savedContent: diskContent!,
                    dirty: false,
                    conflict: undefined,
                  }
                : item,
            ),
          {
            path: copyPath,
            content: doc.content,
            savedContent: doc.content,
            dirty: false,
            kind: "text",
          },
        ]);
        setActive(copyPath);
        setSavedAt(
          docsRef.current.some((item) => item.dirty)
            ? "Unsaved changes"
            : "All changes saved",
        );
        notify(`Your edits were saved as ${copyPath}.`);
        return true;
      }
      await saveAll();
      if (modal === "new-project") {
        const next = await api.createProject(input.trim());
        if (next) await loadProject(next);
      }
      if (modal === "clone") {
        const next = await api.cloneRepository(input.trim());
        if (next) await loadProject(next);
      }
      if (modal === "new-file" || modal === "new-folder") {
        const next = await api.createFile(input.trim(), modal === "new-folder");
        setProject(next);
        if (modal === "new-file") await openFile(input.trim());
      }
      if (modal === "rename") {
        const old = renameSource;
        const next = await api.renameFile(old, input.trim());
        setProject(next);
        updateDocs((list) =>
          list.map((d) => (d.path === old ? { ...d, path: input.trim() } : d)),
        );
        if (active === old) setActive(input.trim());
      }
      if (modal === "checkpoint") {
        setVersions(await api.checkpoint(input.trim()));
        await refreshVersions();
        notify("Version saved on your computer.");
      }
      return true;
    });
    if (result) setModal(null);
  };
  const exportProject = () =>
    action("Exporting", async () => {
      await saveAll();
      if (await api.exportZip()) notify("Project archive exported.");
    });
  const exportPdf = () =>
    action("Exporting", async () => {
      if (await api.exportPdf()) notify("PDF exported.");
    });
  const handleMenuRef = useRef<(name: string) => void>(() => {});
  handleMenuRef.current = (name) => {
    if (busyRef.current) return;
    if (name === "settings") openModal("settings");
    if (name === "new-project") openModal("new-project");
    if (name === "open-project") void switchProject(() => api.openProject());
    if (name === "save")
      void saveAll().catch((e) => notify(errorText(e), true));
    if (name === "compile") void compileNow();
    if (name === "terminal") toggleTerminal();
    if (name === "native-terminal") void openNativeTerminal();
    if (name === "export-pdf") void exportPdf();
    if (name === "export-zip") void exportProject();
    if (name === "theme")
      void changeSettings({
        theme: settings.theme === "light" ? "dark" : "light",
      });
  };
  useEffect(() => api?.onMenuAction((name) => handleMenuRef.current(name)), []);
  const selected = documents.find((d) => d.path === active);
  const words =
    selected?.content.trim().split(/\s+/).filter(Boolean).length || 0;
  const ready = compiler?.running && compiler.imageReady;

  if (!api)
    return (
      <div className="browser-fallback">
        <span className="wordmark">
          typeset<span>.</span>
        </span>
        <h1>A little space for big ideas.</h1>
        <p>
          Typeset is a desktop application. Launch it with <code>pnpm dev</code>{" "}
          to use local files, Podman compilation, and version history.
        </p>
      </div>
    );

  return (
    <div className="application">
      <header className="titlebar">
        <span className="titlebar-caption">
          TYPESET <span>/</span> YOUR LOCAL LATEX WORKSPACE
        </span>
        <span className="local-badge">
          <span />
          Local & private
        </span>
      </header>
      <div className="app-body" inert={!!busy} ref={bodyRef}>
        <nav className="activity-rail" aria-label="Workspace views">
          <button
            className="brand-mark"
            title="About Typeset"
            onClick={() => openModal("about")}
          >
            t<span>.</span>
          </button>
          <div className="rail-main">
            <button
              title="Project files"
              className={side === "files" && sidebar ? "selected" : ""}
              onClick={() => selectSide("files")}
            >
              <Files size={20} />
            </button>
            <button
              title="Version history"
              className={side === "history" && sidebar ? "selected" : ""}
              onClick={() => selectSide("history")}
            >
              <History size={21} />
            </button>
            <button
              title="GitHub and Google Drive"
              className={side === "sync" && sidebar ? "selected" : ""}
              onClick={() => selectSide("sync")}
            >
              <Cloud size={21} />
            </button>
          </div>
          <div className="rail-bottom">
            <button
              title="Toggle light or dark theme"
              onClick={() =>
                void changeSettings({
                  theme: settings.theme === "light" ? "dark" : "light",
                })
              }
            >
              {settings.theme === "light" ? (
                <Moon size={19} />
              ) : (
                <Sun size={19} />
              )}
            </button>
            <button title="Settings" onClick={() => openModal("settings")}>
              <Settings2 size={20} />
            </button>
          </div>
        </nav>
        {sidebar && (
          <aside
            className="sidebar"
            id="project-sidebar"
            style={{ width: sidebarWidth }}
          >
            <div className="project-switcher">
              <button className="project-button" onClick={() => setMenu(!menu)}>
                <span className="project-initial">
                  <BookOpen size={18} />
                </span>
                <span>
                  <small>WORKSPACE</small>
                  <strong>{project?.name || "Your projects"}</strong>
                </span>
                <ChevronDown size={15} />
              </button>
              {menu && (
                <>
                  <button
                    aria-label="Close project menu"
                    className="dismiss-overlay"
                    onClick={() => setMenu(false)}
                  />
                  <div className="dropdown project-dropdown">
                    <button onClick={() => openModal("new-project")}>
                      <Plus size={15} />
                      New project
                    </button>
                    <button
                      onClick={() =>
                        void switchProject(() => api.openProject())
                      }
                    >
                      <FolderOpen size={15} />
                      Open folder…
                    </button>
                    <button
                      onClick={() => void switchProject(() => api.importZip())}
                    >
                      <Upload size={15} />
                      Import ZIP…
                    </button>
                    <button onClick={() => openModal("clone")}>
                      <Github size={15} />
                      Clone from GitHub…
                    </button>
                    {recent.length > 0 && (
                      <>
                        <div className="menu-label">RECENT PROJECTS</div>
                        {recent.map((p) => (
                          <button
                            key={p.root}
                            onClick={() =>
                              void switchProject(() => api.openProject(p.root))
                            }
                            title={p.root}
                          >
                            <FileText size={14} />
                            <span className="truncate">{p.name}</span>
                            {p.root === project?.root && <Check size={14} />}
                          </button>
                        ))}
                      </>
                    )}
                    <div className="menu-separator" />
                    <button
                      onClick={() => {
                        setMenu(false);
                        void exportProject();
                      }}
                    >
                      <ArrowDownToLine size={15} />
                      Export project ZIP
                    </button>
                  </div>
                </>
              )}
            </div>
            {side === "files" && (
              <>
                <div className="sidebar-heading">
                  <span>PROJECT FILES</span>
                  <div>
                    <button
                      title="New file"
                      onClick={() => openModal("new-file")}
                    >
                      <FilePlus2 size={15} />
                    </button>
                    <button
                      title="New folder"
                      onClick={() => openModal("new-folder")}
                    >
                      <FolderPlus size={15} />
                    </button>
                    <button
                      title="Import files"
                      onClick={() =>
                        void action("Importing", async () =>
                          setProject(await api.importFiles()),
                        )
                      }
                    >
                      <Upload size={15} />
                    </button>
                  </div>
                </div>
                <div className="file-search">
                  <Search size={14} />
                  <input
                    aria-label="Filter project files"
                    placeholder="Find a file…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <kbd>⌕</kbd>
                </div>
                <div className="file-tree">
                  {project?.files.map((entry) => (
                    <TreeEntry
                      key={entry.path}
                      entry={entry}
                      depth={0}
                      active={active}
                      mainFile={project.mainFile}
                      filter={filter}
                      onOpen={openFile}
                      onMenu={setFileMenu}
                    />
                  ))}
                  {!project?.files.length && (
                    <p className="subtle empty-sidebar">
                      Add your first file to get started.
                    </p>
                  )}
                </div>
                {fileMenu && (
                  <div className="file-actions">
                    <span className="truncate">{fileMenu}</span>
                    <button onClick={() => openModal("rename", fileMenu)}>
                      <Code2 size={14} />
                      Rename file
                    </button>
                    {fileMenu.endsWith(".tex") && (
                      <button
                        onClick={() =>
                          void action("Updating", async () => {
                            await saveAll();
                            setProject(
                              await api.setProjectOptions({
                                mainFile: fileMenu,
                              }),
                            );
                            setFileMenu(null);
                          })
                        }
                      >
                        <Check size={14} />
                        Set as main document
                      </button>
                    )}
                    <button
                      className="danger-text"
                      onClick={() =>
                        void action("Moving to Trash", async () => {
                          await saveAll();
                          const updated = await api.deleteFile(fileMenu);
                          setProject(updated);
                          if (!allFiles(updated.files).includes(fileMenu))
                            await closeTab(fileMenu);
                          setFileMenu(null);
                        })
                      }
                    >
                      <Trash2 size={14} />
                      Move to Trash
                    </button>
                    <button onClick={() => setFileMenu(null)}>Cancel</button>
                  </div>
                )}
                <div className="sidebar-bottom">
                  <span className="eyebrow">A SPACE TO THINK</span>
                  <p>
                    Good ideas start
                    <br />
                    with a blank page.
                  </p>
                  <button
                    className={`compiler-chip ${ready ? "ready" : ""}`}
                    onClick={() => openModal("setup")}
                  >
                    <span className="status-dot" />
                    <span>
                      {ready ? "LaTeX engine ready" : "Set up LaTeX engine"}
                    </span>
                    <ChevronRight size={13} />
                  </button>
                </div>
              </>
            )}
            {side === "history" && (
              <>
                <div className="sidebar-heading">
                  <span>VERSION HISTORY</span>
                  <button
                    title="Refresh history"
                    onClick={() => void action("Refreshing", refreshVersions)}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                <div className="side-content">
                  <p className="side-description">
                    A record of your ideas,
                    <br />
                    one milestone at a time.
                  </p>
                  <button
                    className="primary full"
                    onClick={() => openModal("checkpoint")}
                  >
                    <Plus size={15} />
                    Save a version
                  </button>
                  <button
                    className="text-button full"
                    onClick={() =>
                      void action("Comparing", async () => {
                        await saveAll();
                        setDiff(await api.diff());
                      })
                    }
                  >
                    View unsaved version changes <ChevronRight size={14} />
                  </button>
                  <div className="version-list">
                    {versions.map((version, i) => (
                      <div className="version" key={version.hash}>
                        <span
                          className={`version-dot ${i === 0 ? "latest" : ""}`}
                        />
                        <div>
                          <div className="version-label">{version.message}</div>
                          <small>{dateLabel(version.date)}</small>
                          <div className="version-actions">
                            <button
                              onClick={() =>
                                void action("Comparing", async () =>
                                  setDiff(await api.diff(version.hash)),
                                )
                              }
                            >
                              Compare
                            </button>
                            <button
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Restore “${version.message}”? Your current work will be saved as a safety version first.`,
                                  )
                                )
                                  void action("Restoring", async () => {
                                    await saveAll();
                                    await loadProject(
                                      await api.restoreVersion(version.hash),
                                    );
                                    setSide("history");
                                    notify(
                                      "Version restored. Your previous work is preserved in history.",
                                    );
                                  });
                              }}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {!versions.length && (
                    <div className="side-empty">
                      <History size={25} />
                      <p>Your story starts here.</p>
                      <small>
                        Save your first version to keep a checkpoint you can
                        come back to.
                      </small>
                    </div>
                  )}
                </div>
              </>
            )}
            {side === "sync" && (
              <>
                <div className="sidebar-heading">
                  <span>CONNECTED WORKSPACE</span>
                </div>
                <div className="side-content sync-content">
                  <div className="integration-heading">
                    <Github size={21} />
                    <h3>GitHub</h3>
                    <span className={`pill ${git?.remote ? "connected" : ""}`}>
                      {git?.remote ? "Linked" : "Not linked"}
                    </span>
                  </div>
                  <p className="side-description">
                    Keep your project and version history in a repository.
                  </p>
                  <label className="field-label">
                    Repository URL
                    <input
                      value={remote}
                      onChange={(e) => setRemote(e.target.value)}
                      placeholder="https://github.com/you/paper"
                    />
                  </label>
                  <button
                    className="secondary full"
                    disabled={!!busy || !remote.trim()}
                    onClick={() =>
                      void action("Linking repository", async () => {
                        await saveAll();
                        setGit(await api.setRemote(remote.trim()));
                        notify("Repository linked.");
                      })
                    }
                  >
                    Link repository
                  </button>
                  <div className="button-row">
                    <button
                      className="secondary"
                      disabled={!!busy || !git?.remote}
                      onClick={() =>
                        void action("Pushing", async () => {
                          await saveAll();
                          notify(await api.push());
                          await refreshVersions();
                        })
                      }
                    >
                      <ArrowUpFromLine size={14} />
                      Push
                    </button>
                    <button
                      className="secondary"
                      disabled={!!busy || !git?.remote}
                      onClick={() =>
                        void action("Pulling", async () => {
                          await saveAll();
                          await loadProject(await api.pull());
                          setSide("sync");
                          notify("Project updated from GitHub.");
                        })
                      }
                    >
                      <ArrowDownToLine size={14} />
                      Pull
                    </button>
                  </div>
                  <p className="microcopy">
                    Save a version before pushing. Uses your local Git
                    authentication.
                  </p>
                  <button className="secondary full" onClick={toggleTerminal}>
                    <Terminal size={14} /> Open terminal
                  </button>
                  <p className="microcopy">
                    Linking this local project for the first time? Use an empty
                    GitHub repository without a README, then Push first. Use
                    Clone from GitHub to start from an existing repository.
                  </p>
                  <details className="github-auth-help">
                    <summary>GitHub sign-in help</summary>
                    <p className="microcopy">
                      For HTTPS, install the free GitHub CLI and run these
                      commands in Terminal. Complete the browser sign-in, then
                      return here and retry Push.
                    </p>
                    <pre>
                      <code>
                        {
                          "gh auth login --hostname github.com --git-protocol https --web\ngh auth setup-git --hostname github.com"
                        }
                      </code>
                    </pre>
                    <p className="microcopy">
                      Linking a repository does not sign you in. A saved Git
                      credential or an authenticated SSH key also works.
                    </p>
                  </details>
                  <div className="integration-divider" />
                  <div className="integration-heading">
                    <DriveIcon />
                    <h3>Google Drive</h3>
                    <span
                      className={`pill ${drive?.connected ? "connected" : ""}`}
                    >
                      {drive?.connected ? "Connected" : "Not linked"}
                    </span>
                  </div>
                  <p className="side-description">
                    Save complete project snapshots and restore them on any
                    computer.
                  </p>
                  {!drive?.connected ? (
                    <button
                      className="secondary full"
                      disabled={!!busy}
                      onClick={() => {
                        if (!drive?.configured) {
                          openModal("settings");
                          return;
                        }
                        void action("Connecting Google Drive", async () => {
                          setDrive(await api.connectDrive());
                          await refreshDrive();
                          notify("Google Drive connected.");
                        });
                      }}
                    >
                      <Plus size={14} />
                      {drive?.configured
                        ? "Connect Google Drive"
                        : "Configure Google Drive"}
                    </button>
                  ) : (
                    <>
                      <button
                        className="secondary full"
                        disabled={!!busy}
                        onClick={() =>
                          void action("Saving snapshot", async () => {
                            await saveAll();
                            await api.saveDriveSnapshot(
                              `Snapshot ${new Date().toLocaleDateString()}`,
                            );
                            await refreshDrive();
                            notify("Project snapshot saved to Google Drive.");
                          })
                        }
                      >
                        <Cloud size={14} />
                        Save snapshot
                      </button>
                      <div className="snapshot-list">
                        {snapshots.map((item) => (
                          <div key={item.id}>
                            <strong>{item.name}</strong>
                            <small>{dateLabel(item.createdTime)}</small>
                            <button
                              className="text-button"
                              onClick={() =>
                                void switchProject(() =>
                                  api.restoreDriveSnapshot(item.id),
                                )
                              }
                            >
                              Restore as a new project
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        className="text-button subtle"
                        onClick={() =>
                          void action("Disconnecting", async () => {
                            await api.disconnectDrive();
                            await refreshDrive();
                          })
                        }
                      >
                        Disconnect
                      </button>
                    </>
                  )}
                  <div className="privacy-note">
                    <ShieldCheck size={16} />
                    <span>Your files stay local until you choose to sync.</span>
                  </div>
                </div>
              </>
            )}
          </aside>
        )}
        {sidebar && (
          <ResizeHandle
            label="Resize sidebar"
            controls="project-sidebar"
            orientation="vertical"
            value={sidebarWidth}
            min={180}
            max={sidebarMax}
            onChange={(value) => resize("sidebar", value)}
            onReset={() => resize("sidebar", DEFAULT_LAYOUT.sidebar)}
          />
        )}
        <main className="workspace">
          <div className="workspace-header">
            <div className="workspace-heading">
              <button
                className="icon-button"
                title={sidebar ? "Hide sidebar" : "Show sidebar"}
                onClick={() => setSidebar(!sidebar)}
              >
                <PanelLeftClose size={18} />
              </button>
              <span className="breadcrumb">
                Projects <ChevronRight size={13} />
              </span>
              <h1>{project?.name || "Opening your workspace…"}</h1>
            </div>
            <div className="workspace-actions">
              <button
                className="quiet-button"
                onClick={() => openModal("checkpoint")}
              >
                <History size={16} />
                <span>Save version</span>
              </button>
              <button
                className="quiet-button"
                onClick={() => selectSide("sync")}
              >
                <Cloud size={17} />
                <span>Sync</span>
              </button>
              <div className="toolbar-divider" />
              <button
                className="icon-button"
                title="Export PDF"
                disabled={!pdf}
                onClick={() => void exportPdf()}
              >
                <ArrowDownToLine size={18} />
              </button>
            </div>
          </div>
          <div className="document-toolbar">
            <label className="editor-label main-document">
              <Code2 size={15} />
              <span>Main document</span>
              <select
                aria-label="Main document"
                title="The document to compile, including all of its input files"
                value={project?.mainFile || ""}
                disabled={!project || compiling}
                onChange={(e) => void changeMainDocument(e.target.value)}
              >
                {allFiles(project?.files || [])
                  .filter((file) => /\.tex$/i.test(file))
                  .map((file) => (
                    <option key={file}>{file}</option>
                  ))}
              </select>
            </label>
            <div className="compile-actions">
              <label className="auto-toggle">
                <input
                  type="checkbox"
                  checked={settings.autoCompile}
                  onChange={(e) =>
                    void changeSettings({ autoCompile: e.target.checked })
                  }
                />
                <span className="switch" />
                Auto-compile
              </label>
              <button
                className="compile-button"
                onClick={() => {
                  if (compiling) {
                    queuedCompile.current = false;
                    void api.cancelCompile();
                  } else if (!ready) openModal("setup");
                  else void compileNow();
                }}
              >
                {compiling ? (
                  <>
                    <Square size={12} fill="currentColor" />
                    Stop compilation
                  </>
                ) : (
                  <>
                    <Play size={13} fill="currentColor" />
                    Recompile
                  </>
                )}
                <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} ↵</kbd>
              </button>
            </div>
          </div>
          <div className="workspace-panes" ref={panesRef}>
            <div className="split-workspace" ref={splitRef}>
              <section
                className="source-pane"
                id="source-pane"
                style={{ flex: `${editorSplit} 1 0px` }}
              >
                <div className="file-tabs">
                  {documents.map((doc) => (
                    <div
                      className={`file-tab ${active === doc.path ? "active" : ""}`}
                      key={doc.path}
                    >
                      <button onClick={() => setActive(doc.path)}>
                        <FileText size={13} />
                        <span>{doc.path.split("/").pop()}</span>
                        {doc.dirty && <span className="unsaved-dot" />}
                      </button>
                      <button
                        className="close-tab"
                        title={`Close ${doc.path}`}
                        onClick={() => void closeTab(doc.path)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="tab-add"
                    title="New file"
                    onClick={() => openModal("new-file")}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {selected?.conflict && (
                  <div className="external-change-banner" role="alert">
                    <p>
                      {selected.conflict === "deleted"
                        ? "This file was removed outside Typeset."
                        : "This file changed outside Typeset."}{" "}
                      Your editor contents are preserved.
                    </p>
                    <div>
                      {selected.conflict !== "deleted" && (
                        <button
                          className="secondary"
                          onClick={() => void useDiskVersion(selected.path)}
                        >
                          Use disk version
                        </button>
                      )}
                      <button
                        className="secondary"
                        onClick={() => saveEditsAsCopy(selected.path)}
                      >
                        Save edits as copy
                      </button>
                      {selected.conflict === "deleted" && !selected.dirty && (
                        <button
                          className="text-button"
                          onClick={() => void closeTab(selected.path)}
                        >
                          Close file
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {selected?.kind === "text" ? (
                  <Editor
                    key={project?.root}
                    path={active}
                    value={selected.content}
                    onChange={changeContent}
                    onCursorChange={(line, column) =>
                      setCursor({ line, column })
                    }
                    fontSize={settings.fontSize}
                    dark={settings.theme === "dark"}
                    goToLine={goToLine}
                  />
                ) : selected?.kind === "image" ? (
                  <div className="asset-preview">
                    <img alt={active} src={selected.url} />
                    <p>{active}</p>
                  </div>
                ) : (
                  <div className="editor-empty">
                    <FileText size={34} />
                    <h2>
                      {selected ? "Project asset" : "Find your next words."}
                    </h2>
                    <p>
                      {selected
                        ? "This file is included when your project compiles."
                        : "Choose a file from the sidebar, or create a new one."}
                    </p>
                    {!selected && (
                      <button
                        className="secondary"
                        onClick={() => openModal("new-file")}
                      >
                        <Plus size={15} />
                        New file
                      </button>
                    )}
                  </div>
                )}
                <div className="editor-footer">
                  <span>
                    <CheckCheck size={13} />
                    {savedAt}
                  </span>
                  <span>
                    Ln {cursor.line}, Col {cursor.column}
                  </span>
                </div>
              </section>
              <ResizeHandle
                label="Resize editor and preview"
                controls="source-pane preview-pane"
                orientation="vertical"
                value={editorSplit}
                min={editorMin}
                max={100 - editorMin}
                unit="percent"
                step={2}
                pixelsPerUnit={editorSpace / 100}
                onChange={(value) => resize("editor", value)}
                onReset={() => resize("editor", DEFAULT_LAYOUT.editor)}
              />
              <section
                className="preview-pane"
                id="preview-pane"
                style={{ flex: `${100 - editorSplit} 1 0px` }}
              >
                <PdfViewer
                  data={pdf}
                  revision={pdfRevision}
                  dark={settings.theme === "dark"}
                  onError={(message) => notify(message, true)}
                />
                {compiling && (
                  <div className="compile-progress">
                    <LoaderCircle size={14} className="spin" />
                    Typesetting your document…
                  </div>
                )}
              </section>
            </div>
            {bottomPanel && (
              <ResizeHandle
                key={bottomPanel}
                label={
                  bottomPanel === "terminal"
                    ? "Resize terminal"
                    : "Resize compilation output"
                }
                controls={
                  bottomPanel === "terminal"
                    ? "project-terminal"
                    : "compilation-output"
                }
                orientation="horizontal"
                direction={-1}
                value={panelHeight}
                min={120}
                max={panelMax}
                onChange={(value) => resize(bottomPanel, value)}
                onReset={() => resize(bottomPanel, DEFAULT_LAYOUT[bottomPanel])}
              />
            )}
            {bottomPanel === "logs" && (
              <section
                className="logs-panel"
                id="compilation-output"
                style={{ height: panelHeight }}
              >
                <div className="logs-heading">
                  <div>
                    <Terminal size={15} />
                    <strong>Compilation output</strong>
                    {result && (
                      <span
                        className={`pill ${result.success ? "connected" : "failed"}`}
                      >
                        {result.success ? "Successful" : "Needs attention"}
                      </span>
                    )}
                  </div>
                  <button
                    className="icon-button"
                    title="Close output"
                    onClick={() => setShowLogs(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {result?.diagnostics.map((diagnostic, index) => (
                  <button
                    className={`diagnostic ${diagnostic.severity}`}
                    key={index}
                    onClick={() => {
                      if (diagnostic.file) {
                        const file = diagnostic.file.replace(/^\.\//, "");
                        void openFile(file).then(() =>
                          setGoToLine({
                            line: diagnostic.line || 1,
                            nonce: Date.now(),
                          }),
                        );
                      } else if (diagnostic.line)
                        setGoToLine({
                          line: diagnostic.line,
                          nonce: Date.now(),
                        });
                    }}
                  >
                    {diagnostic.file &&
                      `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""} — `}
                    {diagnostic.message}
                  </button>
                ))}
                <pre>
                  {logs ||
                    result?.log ||
                    "Compile your document to see the output here."}
                </pre>
              </section>
            )}
            {project && terminalMounted && (
              <TerminalPanel
                key={project.root}
                projectRoot={project.root}
                visible={showTerminal}
                height={panelHeight}
                onClose={() => setShowTerminal(false)}
                onBeforeCommand={saveAll}
                onRefresh={refreshFromDisk}
                onError={(message) => notify(message, true)}
                onOpenInTerminal={
                  navigator.platform.includes("Mac")
                    ? openNativeTerminal
                    : undefined
                }
              />
            )}
          </div>
          <footer className="statusbar">
            <div>
              <button onClick={() => selectSide("history")}>
                <GitBranch size={13} />
                {git?.branch || "Local project"}
              </button>
              <span className="status-separator" />
              <button onClick={() => openModal("settings")}>
                {project?.engine === "xelatex"
                  ? "XeLaTeX"
                  : project?.engine === "lualatex"
                    ? "LuaLaTeX"
                    : "pdfLaTeX"}
                <ChevronDown size={11} />
              </button>
            </div>
            <div>
              <span>{words.toLocaleString()} source words</span>
              <span className="status-separator" />
              <button
                className={showTerminal ? "active" : ""}
                title="Toggle terminal (Control+`)"
                onClick={toggleTerminal}
              >
                <Terminal size={13} /> Terminal
              </button>
              <span className="status-separator" />
              <button
                className={result && !result.success ? "danger-text" : ""}
                onClick={() => {
                  if (!showLogs) setShowTerminal(false);
                  setShowLogs(!showLogs);
                }}
              >
                {compiling ? (
                  <LoaderCircle className="spin" size={12} />
                ) : result?.success ? (
                  <Check size={13} />
                ) : (
                  <Terminal size={13} />
                )}
                <span>
                  {compiling
                    ? "Compiling"
                    : result
                      ? result.success
                        ? `Compiled in ${(result.durationMs / 1000).toFixed(1)}s`
                        : "Compilation failed"
                      : "Compilation output"}
                </span>
              </button>
            </div>
          </footer>
        </main>
      </div>
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <Info size={17} />
          <span>{notice.message}</span>
          <button title="Dismiss notification" onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {!!busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={15} className="spin" />
          {busy}…
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === "settings" ? "settings-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close icon-button"
              title="Close dialog"
              disabled={!!busy}
              onClick={() => setModal(null)}
            >
              <X size={19} />
            </button>
            {modal === "about" ? (
              <>
                <span className="wordmark">
                  typeset<span>.</span>
                </span>
                <h2 id="modal-title">A little space for big ideas.</h2>
                <p>
                  A free, open-source LaTeX workspace.
                  <br />
                  Made for focused writing, with your files on your computer.
                </p>
                <div className="about-details">
                  <span>Electron · React · CodeMirror · PDF.js</span>
                  <span>TeX Live · latexmk · Podman · Git</span>
                  <span>Version 0.1.0 · MIT license</span>
                </div>
                <button className="primary" onClick={() => setModal(null)}>
                  Back to your work
                </button>
              </>
            ) : modal === "setup" ? (
              <>
                <span className="modal-icon">
                  <Code2 size={25} />
                </span>
                <h2 id="modal-title">Your local typesetting engine.</h2>
                <p>
                  Typeset uses Podman to run TeX Live on your computer. The
                  first setup downloads the LaTeX packages; after that, you can
                  compile offline.
                </p>
                <div className="setup-steps">
                  <div>
                    <Check size={16} />
                    <span>Open-source tools, no subscriptions</span>
                  </div>
                  <div>
                    <ShieldCheck size={16} />
                    <span>Compilation stays on your computer</span>
                  </div>
                  <div>
                    <Folder size={16} />
                    <span>
                      Initial download requires several GB of disk space
                    </span>
                  </div>
                </div>
                <div className="setup-status">
                  <span className={`status-dot ${ready ? "green" : ""}`} />
                  {compiler?.message || "Checking Podman…"}
                </div>
                <div className="modal-actions">
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void action("Checking Podman", async () =>
                        setCompiler(await api.compilerStatus()),
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    Check again
                  </button>
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() => {
                      if (ready) {
                        setModal(null);
                        void compileNow();
                      } else
                        void action(
                          "Preparing LaTeX — this may take a few minutes",
                          async () => {
                            setShowLogs(true);
                            const status = await api.setupCompiler();
                            setCompiler(status);
                            if (status.imageReady && status.running) {
                              setModal(null);
                              notify(
                                "LaTeX is ready. You can now compile your project.",
                              );
                              void compileNow();
                            }
                          },
                        );
                    }}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Play size={14} />
                    )}{" "}
                    {ready ? "Compile document" : "Set up compiler"}
                  </button>
                </div>
                <small className="microcopy">
                  Podman must be installed. A stopped machine will be started
                  during setup. Docker is not needed.
                </small>
              </>
            ) : modal === "settings" ? (
              <>
                <span className="eyebrow">MAKE IT YOURS</span>
                <h2 id="modal-title">Workspace settings</h2>
                <div className="settings-grid">
                  <label className="field-label">
                    Editor font size
                    <select
                      value={settings.fontSize}
                      onChange={(e) =>
                        void changeSettings({
                          fontSize: Number(e.target.value),
                        })
                      }
                    >
                      {[12, 13, 14, 15, 16, 18, 20, 22].map((size) => (
                        <option key={size} value={size}>
                          {size} px
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    Appearance
                    <select
                      value={settings.theme}
                      onChange={(e) =>
                        void changeSettings({
                          theme: e.target.value as Settings["theme"],
                        })
                      }
                    >
                      <option value="light">Paper</option>
                      <option value="dark">Midnight</option>
                    </select>
                  </label>
                  <label className="field-label">
                    LaTeX engine
                    <select
                      value={project?.engine || "pdflatex"}
                      disabled={compiling}
                      onChange={(e) => {
                        const engine = e.target.value as Project["engine"];
                        void action("Changing engine", async () => {
                          await saveAll();
                          setProject(await api.setProjectOptions({ engine }));
                        });
                      }}
                    >
                      <option value="pdflatex">pdfLaTeX</option>
                      <option value="xelatex">XeLaTeX</option>
                      <option value="lualatex">LuaLaTeX</option>
                    </select>
                  </label>
                  <label className="field-label">
                    Main document
                    <select
                      value={project?.mainFile || ""}
                      disabled={compiling}
                      onChange={(e) => void changeMainDocument(e.target.value)}
                    >
                      {project &&
                        allFiles(project.files)
                          .filter((f) => /\.tex$/i.test(f))
                          .map((f) => <option key={f}>{f}</option>)}
                    </select>
                  </label>
                </div>
                <div className="integration-divider" />
                <h3 className="settings-subtitle">
                  <DriveIcon />
                  Google Drive connection
                </h3>
                <p className="microcopy">
                  Use a Google OAuth client with application type “Desktop app”
                  and the Drive API enabled. Sign-in opens in your browser. See
                  the setup guide in the project README.
                </p>
                <label className="field-label">
                  OAuth client ID
                  <input
                    autoComplete="off"
                    value={settings.googleClientId}
                    placeholder="…apps.googleusercontent.com"
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        googleClientId: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="field-label">
                  OAuth client secret
                  <input
                    type="password"
                    autoComplete="off"
                    value={settings.googleClientSecret}
                    placeholder="Desktop client secret"
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        googleClientSecret: e.target.value,
                      })
                    }
                  />
                </label>
                <p className="microcopy">
                  Tokens are protected by your operating system’s credential
                  storage. No paid billing configuration is needed.
                </p>
                <div className="modal-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setModal("setup");
                    }}
                  >
                    Compiler setup
                  </button>
                  <button
                    className="primary"
                    onClick={() =>
                      void action("Saving settings", async () => {
                        if (!(await changeSettings(settings))) return;
                        await refreshDrive();
                        setModal(null);
                        notify("Settings saved.");
                      })
                    }
                  >
                    Save settings
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitModal();
                }}
              >
                <span className="modal-icon">
                  {modal === "checkpoint" ? (
                    <History size={25} />
                  ) : modal === "clone" ? (
                    <Github size={25} />
                  ) : modal === "new-folder" ? (
                    <FolderPlus size={25} />
                  ) : (
                    <FilePlus2 size={25} />
                  )}
                </span>
                <h2 id="modal-title">
                  {modal === "new-project"
                    ? "Room for a new idea."
                    : modal === "new-file"
                      ? "Add a file"
                      : modal === "new-folder"
                        ? "Add a folder"
                        : modal === "rename"
                          ? "Rename file"
                          : modal === "clone"
                            ? "Bring your project home."
                            : modal === "save-copy"
                              ? "Save your edits as a copy"
                              : "Remember this moment."}
                </h2>
                <p>
                  {modal === "new-project"
                    ? "Start with a simple LaTeX template in a folder of your choice."
                    : modal === "clone"
                      ? "Clone a GitHub repository into a local project folder."
                      : modal === "checkpoint"
                        ? "Give this version a name. You can compare or restore it later."
                        : modal === "save-copy"
                          ? "Save the editor contents in a new file, then reload the original from disk."
                          : "Keep your project organized. Use a folder/file.tex path for nested files."}
                </p>
                <label className="field-label">
                  {modal === "new-project"
                    ? "Project name"
                    : modal === "clone"
                      ? "GitHub repository URL"
                      : modal === "checkpoint"
                        ? "Version name"
                        : "Name"}
                  <input
                    autoFocus
                    required
                    maxLength={modal === "clone" ? 2000 : 150}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={
                      modal === "new-project"
                        ? "My next paper"
                        : modal === "new-file"
                          ? "sections/methods.tex"
                          : modal === "new-folder"
                            ? "figures"
                            : modal === "clone"
                              ? "https://github.com/you/paper.git"
                              : modal === "checkpoint"
                                ? "First draft"
                                : ""
                    }
                  />
                </label>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary"
                    disabled={!!busy || !input.trim()}
                  >
                    {busy && <LoaderCircle size={15} className="spin" />}
                    {modal === "checkpoint"
                      ? "Save version"
                      : modal === "clone"
                        ? "Clone repository"
                        : modal === "rename"
                          ? "Rename"
                          : modal === "save-copy"
                            ? "Save copy"
                            : "Create"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
      {diff !== null && (
        <div className="modal-backdrop">
          <section
            className="modal diff-modal"
            role="dialog"
            aria-label="Version comparison"
          >
            <div className="diff-header">
              <div>
                <span className="eyebrow">VERSION COMPARISON</span>
                <h2>What changed</h2>
              </div>
              <button
                className="icon-button"
                title="Close comparison"
                onClick={() => setDiff(null)}
              >
                <X size={19} />
              </button>
            </div>
            <pre>
              {diff
                ? diff.split("\n").map((line, i) => (
                    <span
                      className={
                        line.startsWith("+")
                          ? "diff-added"
                          : line.startsWith("-")
                            ? "diff-removed"
                            : line.startsWith("@@")
                              ? "diff-location"
                              : ""
                      }
                      key={i}
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))
                : "No differences. Your project matches this version."}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}

function TreeEntry({
  entry,
  depth,
  active,
  mainFile,
  filter,
  onOpen,
  onMenu,
}: {
  entry: FileEntry;
  depth: number;
  active: string;
  mainFile: string;
  filter: string;
  onOpen: (path: string) => Promise<void>;
  onMenu: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const matches = (file: FileEntry): boolean =>
    file.name.toLowerCase().includes(filter.toLowerCase()) ||
    !!file.children?.some(matches);
  if (filter && !matches(entry)) return null;
  return (
    <div>
      <div
        className={`tree-row ${active === entry.path ? "active" : ""}`}
        style={{ paddingLeft: 14 + depth * 16 }}
      >
        <button
          className="tree-file"
          onClick={() =>
            entry.kind === "directory"
              ? setExpanded(!expanded)
              : void onOpen(entry.path)
          }
          title={entry.path}
        >
          {entry.kind === "directory" ? (
            <>
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
              <Folder size={15} />
            </>
          ) : (
            <>
              <span className="tree-spacer" />
              {/\.(png|jpg|jpeg|svg|webp)$/i.test(entry.name) ? (
                <ImageIcon size={15} />
              ) : entry.name.endsWith(".tex") ? (
                <FileText size={15} />
              ) : (
                <File size={15} />
              )}
            </>
          )}
          <span className="truncate">{entry.name}</span>
          {entry.path === mainFile && (
            <span className="main-file-dot" title="Main document" />
          )}
        </button>
        {entry.kind === "file" && (
          <button
            className="tree-more"
            title={`Actions for ${entry.name}`}
            onClick={() => onMenu(entry.path)}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </div>
      {entry.kind === "directory" &&
        (expanded || filter) &&
        entry.children?.map((child) => (
          <TreeEntry
            key={child.path}
            entry={child}
            depth={depth + 1}
            active={active}
            mainFile={mainFile}
            filter={filter}
            onOpen={onOpen}
            onMenu={onMenu}
          />
        ))}
    </div>
  );
}
function DriveIcon() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8.5 3H15.5L22 14L18.5 20H5.5L2 14L8.5 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 3L15 14H22M2 14H15L18.5 20M5.5 20L12 9"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
