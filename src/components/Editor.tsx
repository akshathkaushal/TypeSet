import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import "./components.css";

export interface EditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onCursorChange?: (line: number, column: number) => void;
  fontSize: number;
  dark: boolean;
  goToLine?: { line: number; nonce: number };
}

const externalChange = Annotation.define<boolean>();
const latexLanguage = StreamLanguage.define(stex);
const texFile = (path: string) => /\.(?:tex|sty|cls|ltx|dtx)$/i.test(path);
const latexCompletions = [
  snippetCompletion("\\begin{${environment}}\n\t${}\n\\end{${environment}}", {
    label: "\\begin",
    detail: "environment",
    type: "keyword",
  }),
  snippetCompletion("\\section{${title}}", {
    label: "\\section",
    detail: "section",
    type: "keyword",
  }),
  snippetCompletion("\\subsection{${title}}", {
    label: "\\subsection",
    type: "keyword",
  }),
  snippetCompletion("\\subsubsection{${title}}", {
    label: "\\subsubsection",
    type: "keyword",
  }),
  snippetCompletion("\\textbf{${text}}", {
    label: "\\textbf",
    detail: "bold",
    type: "function",
  }),
  snippetCompletion("\\textit{${text}}", {
    label: "\\textit",
    detail: "italic",
    type: "function",
  }),
  snippetCompletion("\\emph{${text}}", { label: "\\emph", type: "function" }),
  snippetCompletion("\\cite{${key}}", {
    label: "\\cite",
    detail: "citation",
    type: "function",
  }),
  snippetCompletion("\\ref{${label}}", { label: "\\ref", type: "function" }),
  snippetCompletion("\\label{${name}}", { label: "\\label", type: "function" }),
  snippetCompletion("\\includegraphics[width=${\\linewidth}]{${file}}", {
    label: "\\includegraphics",
    type: "function",
  }),
  snippetCompletion("\\input{${file}}", { label: "\\input", type: "function" }),
  snippetCompletion("\\usepackage{${package}}", {
    label: "\\usepackage",
    type: "keyword",
  }),
  snippetCompletion("\\frac{${numerator}}{${denominator}}", {
    label: "\\frac",
    type: "function",
  }),
  snippetCompletion("\\sqrt{${expression}}", {
    label: "\\sqrt",
    type: "function",
  }),
  ...[
    "item",
    "title",
    "author",
    "date",
    "maketitle",
    "tableofcontents",
    "newpage",
    "clearpage",
    "centering",
    "caption",
    "bibliography",
    "bibliographystyle",
    "printbibliography",
    "addbibresource",
    "footnote",
    "url",
    "href",
    "alpha",
    "beta",
    "gamma",
    "theta",
    "lambda",
    "pi",
    "sigma",
    "sum",
    "int",
    "infty",
    "cdot",
    "times",
    "left",
    "right",
  ].map((command) => ({ label: `\\${command}`, type: "keyword" })),
];

function completeLatex(context: CompletionContext) {
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  return word
    ? { from: word.from, options: latexCompletions, validFor: /\\[a-zA-Z]*/ }
    : null;
}

// StreamLanguage does not supply structural folding. Keep environment endings
// visible, and fold headings up to the next heading at the same or higher level.
const latexFolding = foldService.of((state, from, to) => {
  const current = state.doc.sliceString(from, to).replace(/(?<!\\)%.*/, "");
  const environment = current.match(/\\begin\{([^}]+)\}/)?.[1];
  if (environment) {
    let depth = 0;
    for (const match of current.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
      if (match[2] === environment) depth += match[1] === "begin" ? 1 : -1;
    }
    if (depth <= 0) return null;
    for (let n = state.doc.lineAt(to).number + 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const content = line.text.replace(/(?<!\\)%.*/, "");
      for (const match of content.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
        if (match[2] !== environment) continue;
        depth += match[1] === "begin" ? 1 : -1;
        if (!depth)
          return line.from > to + 1 ? { from: to, to: line.from - 1 } : null;
      }
    }
  }
  const headings = [
    "part",
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
  ];
  const heading = current.match(
    /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/,
  );
  if (heading) {
    const rank = headings.indexOf(heading[1]);
    let end = state.doc.length;
    for (let n = state.doc.lineAt(to).number + 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const next = line.text.match(
        /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/,
      );
      if (
        (next && headings.indexOf(next[1]) <= rank) ||
        /^\s*\\end\{document\}/.test(line.text)
      ) {
        end = line.from - 1;
        break;
      }
    }
    if (end > to) return { from: to, to: end };
  }
  return null;
});

function editorTheme(dark: boolean, fontSize: number) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: dark ? "#ddd8ce" : "#35342f",
        backgroundColor: dark ? "#242522" : "#fdfcf9",
        fontSize: `${fontSize}px`,
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
        lineHeight: "1.85",
      },
      ".cm-content": {
        padding: "22px 0 80px",
        caretColor: dark ? "#dec2a9" : "#b55236",
      },
      ".cm-line": { padding: "0 26px 0 12px" },
      ".cm-gutters": {
        padding: "0 0 0 10px",
        backgroundColor: dark ? "#242522" : "#fdfcf9",
        color: dark ? "#686d64" : "#b9b8af",
        border: "none",
        userSelect: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "30px",
        padding: "0 10px 0 0",
        fontSize: "11px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        padding: "0 5px",
        cursor: "pointer",
      },
      ".cm-activeLine": { backgroundColor: dark ? "#ffffff04" : "#eee9df44" },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: dark ? "#c1aa93" : "#b55236",
      },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused .cm-cursor": {
        borderLeftColor: dark ? "#dec2a9" : "#b55236",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: dark ? "#70675270" : "#d6c6a766" },
      ".cm-selectionMatch": {
        backgroundColor: dark ? "#80795540" : "#e8ddba80",
      },
      ".cm-matchingBracket": {
        backgroundColor: dark ? "#4c655b80" : "#dce6de",
        outline: "1px solid #4c655b50",
      },
      ".cm-panels": {
        backgroundColor: dark ? "#2d2e29" : "#f3f0e9",
        color: dark ? "#ddd8ce" : "#35342f",
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${dark ? "#3d3e36" : "#e4e0d6"}`,
      },
      ".cm-search": {
        padding: "10px 14px",
        fontFamily: "inherit",
        fontSize: "12px",
      },
      ".cm-search input, .cm-search button": { borderRadius: "4px" },
      ".cm-tooltip": {
        border: `1px solid ${dark ? "#4c4c43" : "#ded9cd"}`,
        backgroundColor: dark ? "#30312b" : "#fffefb",
        color: dark ? "#ddd8ce" : "#35342f",
        borderRadius: "6px",
        boxShadow: "0 8px 24px #17170f16",
        overflow: "hidden",
      },
      ".cm-tooltip-autocomplete ul li": { padding: "4px 10px" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: dark ? "#4c655b" : "#e5eade",
        color: dark ? "#fff" : "#314c40",
      },
      ".cm-completionDetail": { marginLeft: "12px", opacity: "0.65" },
      ".cm-foldPlaceholder": {
        backgroundColor: dark ? "#3d3e34" : "#eee9dd",
        border: "none",
        color: "#93826c",
        padding: "0 5px",
      },
    },
    { dark },
  );
}

export default function Editor(props: EditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const currentPath = useRef(props.path);
  const documents = useRef(new Map<string, EditorState>());
  const theme = useRef(new Compartment());
  const language = useRef(new Compartment());
  const stateFactory = useRef<
    ((path: string, value: string) => EditorState) | null
  >(null);

  useEffect(() => {
    if (!container.current) return;
    const makeState = (path: string, value: string) =>
      EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          language.current.of(
            texFile(path)
              ? [
                  latexLanguage,
                  latexFolding,
                  autocompletion({ override: [completeLatex] }),
                ]
              : [],
          ),
          theme.current.of(
            editorTheme(latest.current.dark, latest.current.fontSize),
          ),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": `Source editor: ${path}`,
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalChange),
              )
            ) {
              latest.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const position = update.state.selection.main.head;
              const line = update.state.doc.lineAt(position);
              latest.current.onCursorChange?.(
                line.number,
                position - line.from + 1,
              );
            }
          }),
        ],
      });
    const instance = new EditorView({
      state: makeState(latest.current.path, latest.current.value),
      parent: container.current,
    });
    view.current = instance;
    // Keep the state factory on this stable view's lifecycle, without recreating
    // the editor each time its controlled value changes.
    stateFactory.current = makeState;
    latest.current.onCursorChange?.(1, 1);
    return () => {
      instance.destroy();
      view.current = null;
      documents.current.clear();
    };
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (currentPath.current !== props.path) {
      documents.current.set(currentPath.current, instance.state);
      currentPath.current = props.path;
      const saved = documents.current.get(props.path);
      const state = saved ?? stateFactory.current?.(props.path, props.value);
      if (state) instance.setState(state);
      instance.dispatch({
        effects: theme.current.reconfigure(
          editorTheme(props.dark, props.fontSize),
        ),
      });
    }
    if (instance.state.doc.toString() !== props.value) {
      instance.dispatch({
        changes: {
          from: 0,
          to: instance.state.doc.length,
          insert: props.value,
        },
        annotations: externalChange.of(true),
      });
    }
    const line = instance.state.doc.lineAt(instance.state.selection.main.head);
    latest.current.onCursorChange?.(
      line.number,
      instance.state.selection.main.head - line.from + 1,
    );
  }, [props.path, props.value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: theme.current.reconfigure(
        editorTheme(props.dark, props.fontSize),
      ),
    });
  }, [props.dark, props.fontSize]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || !props.goToLine) return;
    const line = instance.state.doc.line(
      Math.min(instance.state.doc.lines, Math.max(1, props.goToLine.line)),
    );
    instance.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    instance.focus();
  }, [props.goToLine, props.path]);

  return (
    <div
      className="source-editor"
      ref={container}
      data-theme={props.dark ? "dark" : "light"}
    />
  );
}
