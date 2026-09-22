import { describe, expect, it } from "vitest";
import { reconcileDocumentText } from "../src/lib/documentSync";

describe("editor refresh after external file changes", () => {
  it("reloads a clean buffer after a Git checkout changes its file", () => {
    expect(
      reconcileDocumentText(
        { content: "Old branch", savedContent: "Old branch", dirty: false },
        "New branch",
      ),
    ).toEqual({ kind: "reload", content: "New branch" });
  });

  it("retains unsaved edits when disk still matches the saved baseline", () => {
    expect(
      reconcileDocumentText(
        { content: "My unsaved edits", savedContent: "Original", dirty: true },
        "Original",
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("reports both versions when dirty text and external text diverge", () => {
    const document = {
      content: "My unsaved edits",
      savedContent: "Original",
      dirty: true,
    };
    expect(reconcileDocumentText(document, "Terminal edits")).toEqual({
      kind: "conflict",
      reason: "changed",
      diskContent: "Terminal edits",
    });
    expect(document.content).toBe("My unsaved edits");
    expect(document.savedContent).toBe("Original");
  });

  it("advances the baseline when another writer saved the same text", () => {
    expect(
      reconcileDocumentText(
        { content: "Matching edits", savedContent: "Original", dirty: true },
        "Matching edits",
      ),
    ).toEqual({ kind: "reload", content: "Matching edits" });
  });

  it("retains dirty text when Git removes the file instead of recreating it", () => {
    expect(
      reconcileDocumentText(
        { content: "My unsaved edits", savedContent: "Original", dirty: true },
        null,
      ),
    ).toEqual({ kind: "conflict", reason: "deleted", diskContent: null });
  });

  it("reports a clean deleted file separately from a dirty conflict", () => {
    expect(
      reconcileDocumentText(
        { content: "Original", savedContent: "Original", dirty: false },
        null,
      ),
    ).toEqual({ kind: "missing" });
  });

  it("distinguishes an empty file from a deleted one", () => {
    expect(
      reconcileDocumentText(
        { content: "Original", savedContent: "Original", dirty: false },
        "",
      ),
    ).toEqual({ kind: "reload", content: "" });
    expect(
      reconcileDocumentText(
        { content: "", savedContent: "", dirty: false },
        "",
      ),
    ).toEqual({ kind: "unchanged" });
  });
});
