/**
 * The fenced block: generate, find, parse, upsert, remove.
 *
 * This module is the only thing that ever touches the user's source, and it
 * only touches the lines between the two fence markers (plus one blank line of
 * spacing). See README design rule 1.
 */

import { FENCE_END, FENCE_START } from "./constants";
import { formatPyValue, isPyCycler, parsePyDict, parsePyString, PyLitError, type PyValue } from "./pylit";
import { CONTROL_FOR_KEY, RC_KEYS, type RcValue } from "./schema";

export interface StyleSettings {
  /** A name from `plt.style.available`, or "default". */
  style: string;
  /** Only the rc keys the user has set. Unknown keys are preserved verbatim. */
  rc: Record<string, RcValue>;
}

export type FenceErrorKind =
  | "multiple-start"
  | "multiple-end"
  | "unterminated"
  | "orphan-end"
  | "out-of-order"
  | "indented"
  | "malformed";

export class FenceError extends Error {
  readonly kind: FenceErrorKind;
  /** 0-based line where the problem was noticed, if known. */
  readonly line: number | undefined;
  constructor(kind: FenceErrorKind, message: string, line?: number) {
    super(message);
    this.name = "FenceError";
    this.kind = kind;
    this.line = line;
  }
}

export interface FenceRange {
  /** 0-based index of the FENCE_START line. */
  start: number;
  /** 0-based index of the FENCE_END line (inclusive). */
  end: number;
}

export interface ParsedBlock {
  settings: StyleSettings;
  range: FenceRange;
  /** rc keys in the block that no control owns. Kept in `settings.rc`, re-emitted on regenerate. */
  unknownKeys: string[];
}

export function defaultSettings(): StyleSettings {
  return { style: "default", rc: {} };
}

export function isDefaultSettings(s: StyleSettings): boolean {
  return (s.style === "default" || s.style === "") && Object.keys(s.rc).length === 0;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function detectEol(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

function isStart(line: string): boolean {
  return line.trimEnd() === FENCE_START;
}
function isEnd(line: string): boolean {
  return line.trimEnd() === FENCE_END;
}

/**
 * Locate the fence. Returns null when there is none. Throws FenceError for
 * anything that is not exactly one well-formed fence at column 0.
 */
export function findFence(source: string): FenceRange | null {
  const lines = splitLines(source);
  let start = -1;
  let end = -1;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === FENCE_START || t === FENCE_END) {
      if (line.trimEnd() !== t) {
        throw new FenceError("indented", `Fence marker on line ${i + 1} is indented; markers must start the line.`, i);
      }
    }
    if (isStart(line)) {
      if (start !== -1) throw new FenceError("multiple-start", `Second plot-style block starts on line ${i + 1}; there must be exactly one.`, i);
      start = i;
    } else if (isEnd(line)) {
      if (end !== -1) throw new FenceError("multiple-end", `Second "end plot style" marker on line ${i + 1}.`, i);
      end = i;
    }
  });
  if (start === -1 && end === -1) return null;
  if (start === -1) throw new FenceError("orphan-end", `"end plot style" marker on line ${end + 1} has no start.`, end);
  if (end === -1) throw new FenceError("unterminated", `Plot-style block starting on line ${start + 1} has no end marker.`, start);
  if (end < start) throw new FenceError("out-of-order", `"end plot style" marker (line ${end + 1}) comes before the start (line ${start + 1}).`, end);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function toPyValue(key: string, value: RcValue): PyValue {
  if (key === "axes.prop_cycle" && Array.isArray(value)) {
    return { cycler: { color: value.map(String) } };
  }
  return value as PyValue;
}

/** Ordered keys: schema order first, then unknown keys in insertion order. */
function orderedKeys(rc: Record<string, RcValue>): string[] {
  const known = RC_KEYS.filter((k) => k in rc);
  const unknown = Object.keys(rc).filter((k) => !CONTROL_FOR_KEY.has(k));
  return [...known, ...unknown];
}

/**
 * The block as text (lines joined with "\n", no trailing newline), or null when
 * the settings are entirely default and there is nothing to say.
 */
export function generateBlock(settings: StyleSettings): string | null {
  if (isDefaultSettings(settings)) return null;
  const lines = [FENCE_START, "import matplotlib as mpl"];
  if (settings.style && settings.style !== "default") {
    lines.push(`mpl.style.use(${JSON.stringify(settings.style)})`);
  }
  const keys = orderedKeys(settings.rc);
  if (keys.length) {
    lines.push("mpl.rcParams.update({");
    for (const key of keys) {
      lines.push(`    ${JSON.stringify(key)}: ${formatPyValue(toPyValue(key, settings.rc[key]!))},`);
    }
    lines.push("})");
  }
  lines.push(FENCE_END);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const STYLE_RE = /^\s*mpl\.style\.use\((.*)\)\s*$/;

function fromPyValue(key: string, value: PyValue, line: number): RcValue {
  if (isPyCycler(value)) {
    if (key !== "axes.prop_cycle") throw new FenceError("malformed", `mpl.cycler is only valid for "axes.prop_cycle" (line ${line + 1}).`, line);
    return value.cycler.color;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "number")) return value as number[];
    if (value.every((v) => typeof v === "string")) return value as string[];
    throw new FenceError("malformed", `Mixed list for ${JSON.stringify(key)} (line ${line + 1}).`, line);
  }
  return value;
}

/**
 * Parse the fence in `source`. Returns null when there is no fence. Throws
 * FenceError when the fence is malformed or its contents are not something
 * the generator could have written.
 */
export function parseBlock(source: string): ParsedBlock | null {
  const range = findFence(source);
  if (!range) return null;
  const lines = splitLines(source);
  const body = lines.slice(range.start + 1, range.end);
  const settings = defaultSettings();
  let sawImport = false;
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    const lineNo = range.start + 1 + i;
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      i++;
      continue;
    }
    if (t === "import matplotlib as mpl") {
      sawImport = true;
      i++;
      continue;
    }
    const styleMatch = STYLE_RE.exec(line);
    if (styleMatch) {
      try {
        settings.style = parsePyString(styleMatch[1]!);
      } catch (e) {
        throw new FenceError("malformed", `Could not read the style name on line ${lineNo + 1}: ${(e as Error).message}`, lineNo);
      }
      i++;
      continue;
    }
    if (t.startsWith("mpl.rcParams.update(")) {
      // Consume from here to the closing ")" of the call, however many lines.
      const rest = body.slice(i).join("\n");
      const open = rest.indexOf("(");
      let parsed;
      try {
        parsed = parsePyDict(rest.slice(open + 1));
      } catch (e) {
        if (e instanceof PyLitError) {
          throw new FenceError("malformed", `Could not read the rcParams block starting on line ${lineNo + 1}: ${e.message}`, lineNo);
        }
        throw e;
      }
      const afterDict = rest.slice(open + 1 + parsed.end);
      const close = /^\s*\)/.exec(afterDict);
      if (!close) throw new FenceError("malformed", `rcParams.update starting on line ${lineNo + 1} is missing its closing ")".`, lineNo);
      const afterCall = afterDict.slice(close[0].length);
      const sameLine = afterCall.split("\n")[0]!;
      if (sameLine.trim() !== "") {
        throw new FenceError("malformed", `Unexpected text after rcParams.update(...): ${JSON.stringify(sameLine.trim())}`, lineNo);
      }
      for (const [key, value] of Object.entries(parsed.value)) {
        settings.rc[key] = fromPyValue(key, value, lineNo);
      }
      const consumed = rest.length - afterCall.length + sameLine.length;
      i += rest.slice(0, consumed).split("\n").length;
      continue;
    }
    throw new FenceError("malformed", `Line ${lineNo + 1} is not something the style panel writes: ${JSON.stringify(t)}`, lineNo);
  }
  if (!sawImport && (settings.style !== "default" || Object.keys(settings.rc).length)) {
    throw new FenceError("malformed", `The block is missing "import matplotlib as mpl".`, range.start);
  }
  const unknownKeys = Object.keys(settings.rc).filter((k) => !CONTROL_FOR_KEY.has(k));
  return { settings, range, unknownKeys };
}

// ---------------------------------------------------------------------------
// Insert / replace / remove
// ---------------------------------------------------------------------------

const ENCODING_RE = /^#.*coding[:=]/;
const FUTURE_RE = /^from\s+__future__\s+import\b/;
const DOCSTRING_OPEN_RE = /^[rRuUbB]{0,2}("""|''')/;

/**
 * Line index at which the block should be inserted: after a shebang, an
 * encoding comment, leading comments, a module docstring and any
 * `from __future__` imports — but before the first real statement.
 */
export function insertionIndex(lines: string[]): number {
  let i = 0;
  let lastHeader = 0; // one past the last line that must precede the block
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (i === 0 && t.startsWith("#!")) {
      i++;
      lastHeader = i;
      continue;
    }
    if (i < 2 && ENCODING_RE.test(t)) {
      i++;
      lastHeader = i;
      continue;
    }
    if (t === "") {
      i++;
      continue;
    }
    if (t.startsWith("#")) {
      i++;
      lastHeader = i;
      continue;
    }
    const doc = DOCSTRING_OPEN_RE.exec(t);
    if (doc && lastHeaderIsOnlyComments(lines, i)) {
      const quote = doc[1]!;
      const afterOpen = t.slice(doc[0].length);
      let j = i;
      if (!afterOpen.includes(quote)) {
        j = i + 1;
        while (j < lines.length && !lines[j]!.includes(quote)) j++;
        if (j >= lines.length) return lastHeader; // unterminated: give up, insert before it
      }
      i = j + 1;
      lastHeader = i;
      continue;
    }
    if (FUTURE_RE.test(t)) {
      let j = i;
      if (t.includes("(") && !t.includes(")")) {
        while (j < lines.length && !lines[j]!.includes(")")) j++;
      } else if (t.endsWith("\\")) {
        while (j < lines.length && lines[j]!.trimEnd().endsWith("\\")) j++;
      }
      i = j + 1;
      lastHeader = i;
      continue;
    }
    break;
  }
  return Math.min(lastHeader, lines.length);
}

function lastHeaderIsOnlyComments(lines: string[], upto: number): boolean {
  for (let k = 0; k < upto; k++) {
    const t = lines[k]!.trim();
    if (t !== "" && !t.startsWith("#")) return false;
  }
  return true;
}

/**
 * Return `source` with the block for `settings` in place: replacing an
 * existing fence, inserting one at the top when there is none, or removing
 * the fence when the settings are entirely default. Throws FenceError if the
 * existing fence is malformed (use `removeBlock`/`replaceFence` explicitly).
 */
export function upsertBlock(source: string, settings: StyleSettings): string {
  const block = generateBlock(settings);
  const range = findFence(source);
  if (block === null) return range ? removeRange(source, range) : source;
  const eol = detectEol(source);
  const lines = splitLines(source);
  const blockLines = block.split("\n");
  if (range) {
    lines.splice(range.start, range.end - range.start + 1, ...blockLines);
    return lines.join(eol);
  }
  const at = insertionIndex(lines);
  const insert = [...blockLines];
  if (at > 0 && lines[at - 1]!.trim() !== "") insert.unshift("");
  if (at < lines.length && lines[at]!.trim() !== "") insert.push("");
  lines.splice(at, 0, ...insert);
  return lines.join(eol);
}

/** Remove the fence (and one adjacent blank line) if present. */
export function removeBlock(source: string): string {
  const range = findFence(source);
  return range ? removeRange(source, range) : source;
}

/**
 * Force-replace whatever lies between the first FENCE_START and the last
 * FENCE_END with a fresh block. For recovering from a malformed fence when
 * the user has explicitly asked for it.
 */
export function replaceFence(source: string, settings: StyleSettings): string {
  const lines = splitLines(source);
  const eol = detectEol(source);
  const start = lines.findIndex((l) => l.trim() === FENCE_START);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === FENCE_END) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1 || end < start) {
    // Nothing coherent to replace: strip stray markers, then insert normally.
    const cleaned = lines.filter((l) => l.trim() !== FENCE_START && l.trim() !== FENCE_END).join(eol);
    return upsertBlock(cleaned, settings);
  }
  const block = generateBlock(settings);
  lines.splice(start, end - start + 1, ...(block === null ? [] : block.split("\n")));
  return lines.join(eol);
}

function removeRange(source: string, range: FenceRange): string {
  const eol = detectEol(source);
  const lines = splitLines(source);
  let count = range.end - range.start + 1;
  if (range.end + 1 < lines.length && lines[range.end + 1]!.trim() === "") count++;
  lines.splice(range.start, count);
  if (range.start === 0) while (lines.length && lines[0]!.trim() === "") lines.shift();
  return lines.join(eol);
}
