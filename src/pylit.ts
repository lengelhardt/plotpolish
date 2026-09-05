/**
 * A reader for the tiny subset of Python the fenced block is written in.
 *
 * Grammar (and nothing more):
 *   dict    := "{" [ entry { "," entry } [ "," ] ] "}"
 *   entry   := string ":" value
 *   value   := string | number | "True" | "False" | list | tuple | cycler
 *   list    := "[" [ scalar { "," scalar } [ "," ] ] "]"
 *   tuple   := "(" [ scalar { "," scalar } [ "," ] ] ")"
 *   scalar  := string | number
 *   cycler  := "mpl.cycler" "(" "color" "=" list ")"
 *
 * Anything else is a `PyLitError`. That strictness is deliberate: a block the
 * tool did not write must surface as an error, never be silently reinterpreted.
 */

export type PyScalar = number | boolean | string;
export type PyValue = PyScalar | PyScalar[] | PyCycler | PyTuple;

export interface PyCycler {
  cycler: { color: string[] };
}

export interface PyTuple {
  tuple: PyScalar[];
}

export function isPyCycler(v: PyValue): v is PyCycler {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "cycler" in v;
}

export function isPyTuple(v: PyValue): v is PyTuple {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "tuple" in v;
}

export class PyLitError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = "PyLitError";
    this.offset = offset;
  }
}

type Tok =
  | { kind: "punct"; value: string; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "num"; value: number; pos: number }
  | { kind: "name"; value: string; pos: number }
  | { kind: "eof"; pos: number };

const PUNCT = new Set(["{", "}", "[", "]", "(", ")", ":", ",", "="]);
const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*/;

/** Lazy tokenizer: only reads as far as the parser asks, so text after the
 * dict (the rest of the user's block) is never inspected. */
class Lexer {
  private i = 0;
  private buffered: Tok | null = null;
  constructor(private readonly src: string) {}

  /** Offset just past the last token handed out. */
  get offset(): number {
    return this.buffered ? this.buffered.pos : this.i;
  }

  peek(): Tok {
    if (!this.buffered) this.buffered = this.read();
    return this.buffered;
  }

  next(): Tok {
    const t = this.peek();
    this.buffered = null;
    return t;
  }

  private read(): Tok {
    const src = this.src;
    while (this.i < src.length) {
      const ch = src[this.i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.i++;
        continue;
      }
      if (ch === "#") {
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
        continue;
      }
      break;
    }
    if (this.i >= src.length) return { kind: "eof", pos: src.length };
    const pos = this.i;
    const ch = src[pos]!;
    if (PUNCT.has(ch)) {
      this.i++;
      return { kind: "punct", value: ch, pos };
    }
    if (ch === '"' || ch === "'") {
      const { value, end } = readString(src, pos);
      this.i = end;
      return { kind: "str", value, pos };
    }
    const rest = src.slice(pos);
    const num = NUM_RE.exec(rest);
    if (num && (ch === "-" || ch === "." || (ch >= "0" && ch <= "9"))) {
      const n = Number(num[0]);
      if (!Number.isFinite(n)) throw new PyLitError(`Bad number ${num[0]}`, pos);
      this.i += num[0].length;
      return { kind: "num", value: n, pos };
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      this.i += name[0].length;
      return { kind: "name", value: name[0], pos };
    }
    throw new PyLitError(`Unexpected character ${JSON.stringify(ch)}`, pos);
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0", b: "\b", f: "\f", v: "\v",
};

function readString(src: string, start: number): { value: string; end: number } {
  const quote = src[start]!;
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === quote) return { value, end: i + 1 };
    if (ch === "\n") throw new PyLitError("Unterminated string", start);
    if (ch === "\\") {
      const esc = src[i + 1];
      if (esc === undefined) throw new PyLitError("Unterminated escape", i);
      if (esc === "u" || esc === "x") {
        const len = esc === "u" ? 4 : 2;
        const hex = src.slice(i + 2, i + 2 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new PyLitError("Bad escape", i);
        value += String.fromCharCode(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      const simple = SIMPLE_ESCAPES[esc];
      if (simple === undefined) throw new PyLitError(`Unsupported escape \\${esc}`, i);
      value += simple;
      i += 2;
      continue;
    }
    value += ch;
    i++;
  }
  throw new PyLitError("Unterminated string", start);
}

class Parser {
  constructor(readonly lexer: Lexer) {}

  peek(): Tok {
    return this.lexer.peek();
  }
  next(): Tok {
    return this.lexer.next();
  }
  expectPunct(p: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== p) {
      throw new PyLitError(`Expected ${JSON.stringify(p)}`, t.pos);
    }
  }
  isPunct(p: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === p;
  }

  dict(): Record<string, PyValue> {
    this.expectPunct("{");
    const out: Record<string, PyValue> = {};
    while (!this.isPunct("}")) {
      const k = this.next();
      if (k.kind !== "str") throw new PyLitError("Dict keys must be strings", k.pos);
      if (k.value in out) throw new PyLitError(`Duplicate key ${JSON.stringify(k.value)}`, k.pos);
      this.expectPunct(":");
      out[k.value] = this.value();
      if (this.isPunct(",")) {
        this.next();
      } else if (!this.isPunct("}")) {
        throw new PyLitError('Expected "," or "}"', this.peek().pos);
      }
    }
    this.expectPunct("}");
    return out;
  }

  value(): PyValue {
    const t = this.peek();
    if (t.kind === "str" || t.kind === "num") {
      this.next();
      return t.value;
    }
    if (t.kind === "name") {
      if (t.value === "True" || t.value === "False") {
        this.next();
        return t.value === "True";
      }
      if (t.value === "mpl.cycler") return this.cycler();
      throw new PyLitError(`Unsupported name ${t.value}`, t.pos);
    }
    if (t.kind === "punct" && t.value === "[") return this.list();
    if (t.kind === "punct" && t.value === "(") return this.tuple();
    throw new PyLitError("Expected a value", t.pos);
  }

  list(): PyScalar[] {
    this.expectPunct("[");
    const out: PyScalar[] = [];
    while (!this.isPunct("]")) {
      const t = this.next();
      if (t.kind === "str" || t.kind === "num") out.push(t.value);
      else if (t.kind === "name" && (t.value === "True" || t.value === "False")) out.push(t.value === "True");
      else throw new PyLitError("Lists may only hold strings and numbers", t.pos);
      if (this.isPunct(",")) this.next();
      else if (!this.isPunct("]")) throw new PyLitError('Expected "," or "]"', this.peek().pos);
    }
    this.expectPunct("]");
    return out;
  }

  tuple(): PyTuple {
    this.expectPunct("(");
    const out: PyScalar[] = [];
    while (!this.isPunct(")")) {
      const t = this.next();
      if (t.kind === "str" || t.kind === "num") out.push(t.value);
      else if (t.kind === "name" && (t.value === "True" || t.value === "False")) out.push(t.value === "True");
      else throw new PyLitError("Tuples may only hold strings and numbers", t.pos);
      if (this.isPunct(",")) this.next();
      else if (!this.isPunct(")")) throw new PyLitError('Expected "," or ")"', this.peek().pos);
    }
    this.expectPunct(")");
    return { tuple: out };
  }

  cycler(): PyCycler {
    const start = this.next(); // mpl.cycler
    this.expectPunct("(");
    const kw = this.next();
    if (kw.kind !== "name" || kw.value !== "color") throw new PyLitError("Only mpl.cycler(color=[...]) is supported", start.pos);
    this.expectPunct("=");
    const colors = this.list();
    if (!colors.every((c) => typeof c === "string")) throw new PyLitError("Colours must be strings", start.pos);
    if (this.isPunct(",")) this.next();
    this.expectPunct(")");
    return { cycler: { color: colors as string[] } };
  }
}

/**
 * Parse a Python dict literal in the restricted grammar at the start of `src`.
 * Returns the dict and the offset just past its closing "}"; nothing after
 * that is read.
 */
export function parsePyDict(src: string): { value: Record<string, PyValue>; end: number } {
  const lexer = new Lexer(src);
  const p = new Parser(lexer);
  const value = p.dict();
  return { value, end: lexer.offset };
}

/** Parse a single Python string literal (used for the style name). */
export function parsePyString(src: string): string {
  const lexer = new Lexer(src);
  const t = lexer.next();
  if (t.kind !== "str") throw new PyLitError("Expected a string literal", t.pos);
  const after = lexer.next();
  if (after.kind !== "eof") throw new PyLitError("Unexpected text after the string", after.pos);
  return t.value;
}

/** Python source for a value the grammar above can read back. */
export function formatPyValue(value: PyValue): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PyLitError(`Cannot emit ${value}`, 0);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatPyValue).join(", ")}]`;
  if (isPyCycler(value)) return `mpl.cycler(color=${formatPyValue(value.cycler.color)})`;
  if (isPyTuple(value)) {
    if (value.tuple.length === 0) return "()";
    if (value.tuple.length === 1) return `(${formatPyValue(value.tuple[0]!)},)`;
    return `(${value.tuple.map(formatPyValue).join(", ")})`;
  }
  throw new PyLitError("Unsupported value", 0);
}
