import { useEffect, useRef, useState } from "react";
import {
  Eraser,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  X,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession,
} from "../../shared/types";
import "@xterm/xterm/css/xterm.css";
import "./components.css";

export interface TerminalPanelProps {
  projectRoot: string;
  visible: boolean;
  height?: number;
  onClose: () => void;
  onBeforeCommand: () => Promise<void>;
  onRefresh: () => void | Promise<void>;
  onError?: (message: string) => void;
  onOpenInTerminal?: () => void | Promise<void>;
}

type SessionState = "idle" | "starting" | "running" | "exited" | "error";
type SessionEvent =
  | { kind: "data"; value: TerminalDataEvent }
  | { kind: "exit"; value: TerminalExitEvent };

const messageFrom = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export default function TerminalPanel(props: TerminalPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const startSession = useRef<((restart?: boolean) => Promise<void>) | null>(
    null,
  );
  const fitAndFocus = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<SessionState>("idle");
  const [shell, setShell] = useState("");
  const [exitCode, setExitCode] = useState<number>();
  const [feedback, setFeedback] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [openingNative, setOpeningNative] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const api = window.typeset;
    const root = props.projectRoot;
    let disposed = false;
    let session: TerminalSession | null = null;
    let sequence = -1;
    let receivingSnapshot = false;
    let queuedEvents: SessionEvent[] = [];
    let opening: Promise<void> | null = null;
    let inputChain: Promise<void> = Promise.resolve();
    let resizeFrame = 0;
    const term = new Terminal({
      cols: 80,
      rows: 12,
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      screenReaderMode: true,
      disableStdin: true,
      allowProposedApi: false,
      // OSC 8 output may describe a link; it must never navigate the app.
      linkHandler: { activate: () => {} },
      theme: {
        background: "#202621",
        foreground: "#e3e5da",
        cursor: "#e3a386",
        cursorAccent: "#202621",
        selectionBackground: "#667e6866",
        selectionInactiveBackground: "#667e683b",
        black: "#202621",
        red: "#d8907f",
        green: "#a1bb92",
        yellow: "#d4bc89",
        blue: "#94acbc",
        magenta: "#bfa0b7",
        cyan: "#99bfba",
        white: "#e3e5da",
        brightBlack: "#7d8a7f",
        brightRed: "#edaa95",
        brightGreen: "#c0d6af",
        brightYellow: "#e6d3a5",
        brightBlue: "#b7cdda",
        brightMagenta: "#d7b6ce",
        brightCyan: "#b8ddd5",
        brightWhite: "#faf9f2",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    term.textarea?.setAttribute("aria-label", "Project terminal input");
    terminal.current = term;

    const report = (cause: unknown, prefix = "") => {
      if (disposed) return;
      const message = prefix + messageFrom(cause);
      setFeedback(message);
      latest.current.onError?.(message);
    };
    const resize = () => {
      if (
        disposed ||
        !latest.current.visible ||
        !host.current?.clientWidth ||
        !host.current.clientHeight
      )
        return;
      fit.fit();
    };
    const scheduleFit = (focus = false) => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resize();
        if (focus && !disposed && latest.current.visible) term.focus();
      });
    };
    fitAndFocus.current = () => scheduleFit(true);
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host.current);
    const resizeListener = term.onResize(({ cols, rows }) => {
      const id = session?.running ? session.id : null;
      if (id)
        void api.terminalResize(id, cols, rows).catch((cause) => {
          if (session?.id === id && session.running)
            report(cause, "Could not resize the terminal: ");
        });
    });

    const applyEvent = (event: SessionEvent) => {
      if (
        !session ||
        event.value.id !== session.id ||
        event.value.sequence <= sequence
      )
        return;
      sequence = event.value.sequence;
      if (event.kind === "data") {
        term.write(event.value.data);
      } else {
        session = {
          ...session,
          running: false,
          exitCode: event.value.exitCode,
          signal: event.value.signal,
        };
        term.options.disableStdin = true;
        setExitCode(event.value.exitCode);
        setStatus("exited");
      }
    };
    const receive = (event: SessionEvent) => {
      if (disposed || event.value.root !== root) return;
      if (receivingSnapshot) queuedEvents.push(event);
      else applyEvent(event);
    };
    // Subscribe first: the shell may print a prompt before terminalStart returns.
    const unsubscribeData = api.onTerminalData((value) =>
      receive({ kind: "data", value }),
    );
    const unsubscribeExit = api.onTerminalExit((value) =>
      receive({ kind: "exit", value }),
    );

    const start = (restart = false): Promise<void> => {
      if (opening) return opening;
      if (disposed || (!restart && session)) return Promise.resolve();
      const run = async () => {
        setStatus("starting");
        setFeedback("");
        setExitCode(undefined);
        term.options.disableStdin = true;
        try {
          if (restart && session) {
            const previous = session.id;
            session = null;
            await api.terminalStop(previous);
          }
          if (disposed) return;
          resize();
          queuedEvents = [];
          receivingSnapshot = true;
          const snapshot = await api.terminalStart(term.cols, term.rows);
          if (disposed) return;
          if (snapshot.root !== root)
            throw new Error(
              "The active project changed. Reopen the terminal for this project.",
            );
          session = snapshot;
          sequence = snapshot.sequence;
          term.reset();
          term.write(snapshot.output);
          term.options.disableStdin = !snapshot.running;
          setShell(snapshot.shell.split(/[\\/]/).pop() || "Shell");
          setExitCode(snapshot.exitCode);
          setStatus(snapshot.running ? "running" : "exited");
          receivingSnapshot = false;
          // The snapshot already contains output through its sequence number.
          // Replaying only later events prevents both missing and doubled output.
          for (const event of queuedEvents.sort(
            (a, b) => a.value.sequence - b.value.sequence,
          ))
            applyEvent(event);
          queuedEvents = [];
          if (session.running)
            await api.terminalResize(session.id, term.cols, term.rows);
          scheduleFit(true);
        } catch (cause) {
          if (!disposed) {
            session = null;
            term.options.disableStdin = true;
            setStatus("error");
            report(cause, "Could not open the terminal: ");
          }
        } finally {
          receivingSnapshot = false;
          queuedEvents = [];
        }
      };
      opening = run().finally(() => {
        opening = null;
      });
      return opening;
    };
    startSession.current = start;

    const inputListener = term.onData((data) => {
      const id = session?.running ? session.id : null;
      if (!id) return;
      // Preserve ordering while saving editor buffers before Enter or a pasted
      // command. A failed save withholds that command rather than running it on
      // stale source files. Ctrl+C and ordinary typing are passed through.
      inputChain = inputChain
        .catch(() => {})
        .then(async () => {
          if (disposed || session?.id !== id || !session.running) return;
          if (/[\r\n]/.test(data)) await latest.current.onBeforeCommand();
          if (disposed || session?.id !== id || !session.running) return;
          await api.terminalWrite(id, data);
        })
        .catch((cause) => {
          if (session?.id === id)
            report(cause, "Could not send terminal input: ");
        });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      unsubscribeData();
      unsubscribeExit();
      inputListener.dispose();
      resizeListener.dispose();
      term.dispose();
      if (terminal.current === term) terminal.current = null;
      if (startSession.current === start) startSession.current = null;
      fitAndFocus.current = null;
      // The main process owns project/app lifetime. Killing here would race
      // React StrictMode's remount against a reused PTY for the same project.
    };
  }, [props.projectRoot]);

  useEffect(() => {
    if (!props.visible) return;
    void startSession.current?.();
    fitAndFocus.current?.();
  }, [props.visible, props.projectRoot]);

  const runToolbarAction = async (
    action: () => void | Promise<void>,
    kind: "refresh" | "native",
  ) => {
    const setPending = kind === "refresh" ? setRefreshing : setOpeningNative;
    setPending(true);
    setFeedback("");
    try {
      await action();
    } catch (cause) {
      const message = messageFrom(cause);
      setFeedback(message);
      latest.current.onError?.(message);
    } finally {
      setPending(false);
    }
  };
  const statusLabel =
    status === "starting"
      ? "Starting…"
      : status === "exited"
        ? `Exited${exitCode === undefined ? "" : ` · ${exitCode}`}`
        : status === "error"
          ? "Unavailable"
          : shell || "Shell";

  return (
    <section
      className="terminal-panel"
      id="project-terminal"
      style={{ height: props.height }}
      hidden={!props.visible}
      aria-label="Project terminal"
    >
      <div className="terminal-panel-toolbar">
        <div className="terminal-panel-heading">
          <TerminalSquare size={15} aria-hidden="true" />
          <strong>Terminal</strong>
          <span className={`terminal-session-state ${status}`} role="status">
            {status === "starting" ? (
              <LoaderCircle size={11} className="terminal-panel-spin" />
            ) : (
              <span className="terminal-session-dot" />
            )}
            {statusLabel}
          </span>
          <span className="terminal-project-path" title={props.projectRoot}>
            {props.projectRoot}
          </span>
        </div>
        <div
          className="terminal-panel-actions"
          role="toolbar"
          aria-label="Terminal controls"
        >
          {props.onOpenInTerminal && (
            <button
              type="button"
              className="terminal-native-button"
              title="Open this project in macOS Terminal"
              onClick={() =>
                void runToolbarAction(
                  () => latest.current.onOpenInTerminal?.(),
                  "native",
                )
              }
              disabled={openingNative}
            >
              {openingNative ? (
                <LoaderCircle size={13} className="terminal-panel-spin" />
              ) : (
                <ExternalLink size={13} />
              )}
              <span>Open in Terminal</span>
            </button>
          )}
          <button
            type="button"
            title="Refresh project files after terminal changes"
            aria-label="Refresh project files"
            onClick={() =>
              void runToolbarAction(() => latest.current.onRefresh(), "refresh")
            }
            disabled={refreshing}
          >
            <RefreshCw
              size={14}
              className={refreshing ? "terminal-panel-spin" : undefined}
            />
          </button>
          <button
            type="button"
            title="Clear terminal scrollback"
            aria-label="Clear terminal"
            onClick={() => {
              terminal.current?.clear();
              terminal.current?.focus();
            }}
          >
            <Eraser size={14} />
          </button>
          <button
            type="button"
            title="Restart terminal session"
            aria-label="Restart terminal"
            disabled={status === "starting"}
            onClick={() => void startSession.current?.(true)}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            title="Hide terminal — keep session running"
            aria-label="Hide terminal"
            onClick={props.onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      {feedback && (
        <div className="terminal-panel-feedback" role="alert">
          <span>{feedback}</span>
          <button
            type="button"
            title="Dismiss terminal message"
            aria-label="Dismiss terminal message"
            onClick={() => setFeedback("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="terminal-emulator" ref={host} />
    </section>
  );
}
