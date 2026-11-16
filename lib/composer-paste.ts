// The composer's paste: images go to the attachments, a pasted rich text keeps its
// browser-side insertion, and a plain-text paste the browser dropped is recovered from
// the event the page was handed (#1513).

/** The editor the paste landed in, as the composer's helpers take it. */
export interface ComposerPasteTarget {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  isConnected: boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

/** The part of a paste event the composer reads. */
export interface ComposerPasteEvent<Target extends ComposerPasteTarget = ComposerPasteTarget> {
  clipboardData?: {
    items: ArrayLike<{ type: string; getAsFile(): File | null }>;
    getData(type: string): string;
  };
  currentTarget: Target;
  nativeEvent: { defaultPrevented: boolean };
  preventDefault(): void;
}

export interface ComposerPasteDeps<Target extends ComposerPasteTarget = ComposerPasteTarget> {
  processImageFiles: (files: File[]) => void;
  replaceTextareaRange: (ta: Target, start: number, end: number, value: string, cursorOffset?: number) => void;
  replaceLinksWithMarkdown: (text: string, links: { label: string; href: string; occurrence: number }[]) => string | null;
  valueRef: { current: string };
  pendingPasteRef: { current: object | null };
  setValue: (value: string) => void;
  setHistoryMenuOpen: (open: boolean) => void;
  updateAtQuery: (value: string, caret: number) => void;
  scrollTextareaCaretIntoView: (ta: Target) => void;
  setTimeout: (callback: () => void, delay: number) => void;
  requestAnimationFrame: (callback: () => void) => void;
  DOMParser: typeof DOMParser;
}

export function handleComposerPaste<Target extends ComposerPasteTarget>(
  e: ComposerPasteEvent<Target>,
  deps: ComposerPasteDeps<Target>,
): void {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length) {
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    deps.processImageFiles(files);
    return;
  }

  const clipboardData = e.clipboardData;
  if (!clipboardData) return;
  const html = clipboardData.getData("text/html");
  const text = clipboardData.getData("text/plain");
  if (text) {
    // A dictation tool that pastes and then restores the clipboard can write
    // it during this event; Chrome then drops its own insertion (#1513). When
    // no input followed the paste, insert the text the event delivered.
    const ta = e.currentTarget;
    const native = e.nativeEvent;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const paste = {};
    deps.pendingPasteRef.current = paste;
    deps.setTimeout(() => {
      if (deps.pendingPasteRef.current !== paste) return;
      deps.pendingPasteRef.current = null;
      if (!native.defaultPrevented && ta.isConnected) deps.replaceTextareaRange(ta, start, end, text);
    }, 0);
  }
  if (!html || !text) return;
  const document = new deps.DOMParser().parseFromString(html, "text/html");
  const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
    const label = link.textContent ?? "";
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(link);
    return {
      label,
      href: link.getAttribute("href")?.trim() ?? "",
      occurrence: label ? range.toString().split(label).length - 1 : 0,
    };
  });
  const markdown = deps.replaceLinksWithMarkdown(text, links);
  if (markdown === null) return;

  const ta = e.currentTarget;
  const start = ta.selectionStart;
  const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
  e.preventDefault();
  deps.valueRef.current = nextValue;
  deps.setValue(nextValue);
  deps.setHistoryMenuOpen(false);
  deps.updateAtQuery(nextValue, start + markdown.length);
  deps.requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(start + markdown.length, start + markdown.length);
    deps.scrollTextareaCaretIntoView(ta);
  });
}
