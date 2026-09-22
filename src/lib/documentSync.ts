export interface TextDocumentBaseline {
  content: string;
  savedContent: string;
  dirty: boolean;
}

export type TextDocumentRefresh =
  | { kind: "unchanged" }
  | { kind: "reload"; content: string }
  | {
      kind: "conflict";
      reason: "changed" | "deleted";
      diskContent: string | null;
    }
  | { kind: "missing" };

/**
 * Decide against the current editor state, after pending saves have completed.
 * A conflict never discards the editor buffer. Reload advances its saved baseline.
 * Unchanged also clears an earlier conflict when an external edit was reverted.
 */
export function reconcileDocumentText(
  document: TextDocumentBaseline,
  diskContent: string | null,
): TextDocumentRefresh {
  if (diskContent === null) {
    return document.dirty
      ? { kind: "conflict", reason: "deleted", diskContent: null }
      : { kind: "missing" };
  }
  if (diskContent === document.savedContent) return { kind: "unchanged" };
  if (!document.dirty || diskContent === document.content) {
    return { kind: "reload", content: diskContent };
  }
  return { kind: "conflict", reason: "changed", diskContent };
}
