/**
 * CodeSink: where the user's source lives. The panel reads it to find the
 * existing fence and writes it back with the fence replaced. Nothing else in
 * the source is ever touched (see block.ts).
 */

export interface CodeSink {
  /** The whole source, or `null` for a write-only sink (e.g. clipboard). */
  getSource(): string | null;
  /** Replace the whole source. For write-only sinks this receives just the block. */
  setSource(source: string): void;
  /** Optional: call `listener` when the source changes outside the panel. Returns an unsubscribe. */
  subscribe?(listener: () => void): () => void;
}

/** In-memory sink for tests and simple hosts (a textarea, say). */
export class MemorySink implements CodeSink {
  private source: string;
  private listeners = new Set<() => void>();
  readonly writes: string[] = [];

  constructor(initial = "", private readonly onChange?: (source: string) => void) {
    this.source = initial;
  }

  getSource(): string {
    return this.source;
  }

  setSource(source: string): void {
    this.source = source;
    this.writes.push(source);
    this.onChange?.(source);
  }

  /** Simulate an external edit (the user typing): updates and notifies subscribers. */
  externalEdit(source: string): void {
    this.source = source;
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface ClipboardSinkOptions {
  /** Element to render the fallback textarea into. Created lazily if omitted and `mount` is called. */
  container?: HTMLElement;
  /** Called after each write with whether the async clipboard write succeeded. */
  onCopied?: (copied: boolean, block: string) => void;
  /** Injected for tests. Defaults to `navigator.clipboard`. */
  clipboard?: Pick<Clipboard, "writeText"> | null;
}

/**
 * Write-only sink: copies the block to the clipboard when the browser allows
 * it and always shows it in a selectable textarea, because the async clipboard
 * API needs a user gesture and, inside cross-origin iframes, a
 * permissions-policy allow. Assume it can fail.
 */
export class ClipboardSink implements CodeSink {
  lastBlock = "";
  lastCopied: boolean | null = null;
  private textarea: HTMLTextAreaElement | null = null;

  constructor(private readonly options: ClipboardSinkOptions = {}) {}

  getSource(): null {
    return null;
  }

  setSource(block: string): void {
    this.lastBlock = block;
    this.render(block);
    const clipboard =
      this.options.clipboard === undefined
        ? (typeof navigator !== "undefined" ? navigator.clipboard : undefined) ?? null
        : this.options.clipboard;
    if (!clipboard || !block) {
      this.lastCopied = false;
      this.options.onCopied?.(false, block);
      return;
    }
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(clipboard.writeText(block));
    } catch (e) {
      attempt = Promise.reject(e);
    }
    void attempt
      .then(() => {
        this.lastCopied = true;
        this.options.onCopied?.(true, block);
      })
      .catch(() => {
        this.lastCopied = false;
        this.options.onCopied?.(false, block);
      });
  }

  /** The fallback textarea (created on first write) so hosts can place it. */
  get element(): HTMLTextAreaElement | null {
    return this.textarea;
  }

  private render(block: string): void {
    if (typeof document === "undefined") return;
    if (!this.textarea) {
      this.textarea = document.createElement("textarea");
      this.textarea.readOnly = true;
      this.textarea.spellcheck = false;
      this.textarea.setAttribute("aria-label", "Generated plot style block");
      this.textarea.rows = 8;
      this.textarea.addEventListener("focus", () => this.textarea?.select());
      this.options.container?.appendChild(this.textarea);
    }
    this.textarea.value = block;
    this.textarea.placeholder = block ? "" : "No block: every setting is at its default.";
  }
}
