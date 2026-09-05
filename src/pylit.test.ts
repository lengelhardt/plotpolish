import { describe, expect, it } from "vitest";
import { formatPyValue, isPyCycler, isPyTuple, parsePyDict, parsePyString, PyLitError, type PyValue } from "./pylit";

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

describe("numbers", () => {
  it("parses integers", () => {
    expect(parsePyDict('{"a": 1}').value).toEqual({ a: 1 });
    expect(parsePyDict('{"a": 42}').value).toEqual({ a: 42 });
  });

  it("parses floats", () => {
    expect(parsePyDict('{"a": 1.5}').value).toEqual({ a: 1.5 });
    expect(parsePyDict('{"a": 3.0}').value).toEqual({ a: 3.0 });
  });

  it("parses negative numbers", () => {
    expect(parsePyDict('{"a": -3}').value).toEqual({ a: -3 });
    expect(parsePyDict('{"a": -3.5}').value).toEqual({ a: -3.5 });
  });

  it("parses exponents", () => {
    expect(parsePyDict('{"a": 1e-3}').value).toEqual({ a: 0.001 });
    expect(parsePyDict('{"a": 1E+5}').value).toEqual({ a: 100000 });
    expect(parsePyDict('{"a": 2.5e10}').value).toEqual({ a: 2.5e10 });
  });

  it("parses leading-dot numbers", () => {
    expect(parsePyDict('{"a": .5}').value).toEqual({ a: 0.5 });
    expect(parsePyDict('{"a": -.5}').value).toEqual({ a: -0.5 });
  });
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

describe("strings", () => {
  it("parses single- and double-quoted strings", () => {
    expect(parsePyDict('{"a": "hello"}').value).toEqual({ a: "hello" });
    expect(parsePyDict("{\"a\": 'hello'}").value).toEqual({ a: "hello" });
  });

  it("handles \\n, \\\", and \\\\ escapes", () => {
    expect(parsePyDict('{"a": "line1\\nline2"}').value).toEqual({ a: "line1\nline2" });
    expect(parsePyDict('{"a": "say \\"hi\\""}').value).toEqual({ a: 'say "hi"' });
    expect(parsePyDict('{"a": "back\\\\slash"}').value).toEqual({ a: "back\\slash" });
  });

  it("passes literal non-ASCII characters through unchanged", () => {
    expect(parsePyDict('{"a": "café"}').value).toEqual({ a: "café" });
  });

  it("handles \\u unicode escapes (é)", () => {
    expect(parsePyDict('{"a": "caf\\u00e9"}').value).toEqual({ a: "café" });
  });

  it("handles \\x hex escapes", () => {
    expect(parsePyDict('{"a": "\\x41"}').value).toEqual({ a: "A" });
  });
});

// ---------------------------------------------------------------------------
// Booleans, empty dict, trailing commas, whitespace, comments
// ---------------------------------------------------------------------------

describe("booleans", () => {
  it("parses True and False", () => {
    expect(parsePyDict('{"a": True, "b": False}').value).toEqual({ a: true, b: false });
  });
});

describe("empty dict", () => {
  it("parses {}", () => {
    expect(parsePyDict("{}").value).toEqual({});
  });
});

describe("trailing commas", () => {
  it("tolerates a trailing comma in a dict", () => {
    expect(parsePyDict('{"a": 1, "b": 2,}').value).toEqual({ a: 1, b: 2 });
  });

  it("tolerates a trailing comma in a list", () => {
    expect(parsePyDict('{"a": [1, 2, 3,]}').value).toEqual({ a: [1, 2, 3] });
  });
});

describe("cycler", () => {
  it("parses mpl.cycler(color=[...])", () => {
    const { value } = parsePyDict('{"a": mpl.cycler(color=["#a", "#b"])}');
    expect(value.a).toEqual({ cycler: { color: ["#a", "#b"] } });
    expect(isPyCycler(value.a!)).toBe(true);
  });

  it("tolerates a trailing comma inside mpl.cycler(...)", () => {
    const { value } = parsePyDict('{"a": mpl.cycler(color=["#a", "#b"],)}');
    expect(value.a).toEqual({ cycler: { color: ["#a", "#b"] } });
  });
});

describe("tuples", () => {
  it("parses a two-element tuple", () => {
    const { value } = parsePyDict('{"a": (0.6, 0.2)}');
    expect(value.a).toEqual({ tuple: [0.6, 0.2] });
    expect(isPyTuple(value.a!)).toBe(true);
  });

  it("tolerates a trailing comma", () => {
    expect(parsePyDict('{"a": (1, 2,)}').value).toEqual({ a: { tuple: [1, 2] } });
  });

  it("parses a single-element tuple", () => {
    expect(parsePyDict('{"a": (1,)}').value).toEqual({ a: { tuple: [1] } });
  });

  it("parses an empty tuple", () => {
    expect(parsePyDict('{"a": ()}').value).toEqual({ a: { tuple: [] } });
  });

  it("rejects a nested tuple", () => {
    expect(() => parsePyDict('{"a": ((1, 2), 3)}')).toThrow(PyLitError);
  });

  it("rejects a tuple inside a list", () => {
    expect(() => parsePyDict('{"a": [(1, 2)]}')).toThrow(PyLitError);
  });

  it("rejects a list inside a tuple", () => {
    expect(() => parsePyDict('{"a": ([1, 2],)}')).toThrow(PyLitError);
  });
});

describe("comments", () => {
  it("skips # comments anywhere inside the dict", () => {
    const src = `{
  # leading comment
  "a": 1, # trailing comment
  # standalone comment
  "b": [1, 2], # another
}`;
    expect(parsePyDict(src).value).toEqual({ a: 1, b: [1, 2] });
  });
});

describe("whitespace and newlines", () => {
  it("tolerates whitespace/newlines/tabs anywhere between tokens", () => {
    const src = `
{
\t"a"\t:\t1\t,
    "b":
        [ 1 ,  2 ,
           3 ] ,
}`;
    expect(parsePyDict(src).value).toEqual({ a: 1, b: [1, 2, 3] });
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("errors", () => {
  it("rejects a non-string key", () => {
    expect(() => parsePyDict("{1: 2}")).toThrow(PyLitError);
  });

  it("rejects a duplicate key", () => {
    expect(() => parsePyDict('{"a": 1, "a": 2}')).toThrow(PyLitError);
  });

  it("rejects an unterminated string (reaches end of input)", () => {
    expect(() => parsePyDict('{"a": "abc}')).toThrow(PyLitError);
  });

  it("rejects a string literal that spans a raw newline", () => {
    expect(() => parsePyDict('{"a": "abc\ndef"}')).toThrow(PyLitError);
  });

  it("rejects None", () => {
    expect(() => parsePyDict('{"a": None}')).toThrow(PyLitError);
  });

  it("rejects a nested dict as a value", () => {
    expect(() => parsePyDict('{"a": {"b": 1}}')).toThrow(PyLitError);
  });

  it("rejects a list nested inside a list", () => {
    expect(() => parsePyDict('{"a": [[1, 2]]}')).toThrow(PyLitError);
  });

  it("rejects a list value that itself contains a list element", () => {
    expect(() => parsePyDict('{"a": [1, [2, 3]]}')).toThrow(PyLitError);
  });

  it('rejects cycler(...) without the "mpl." prefix', () => {
    expect(() => parsePyDict('{"a": cycler(color=["#fff"])}')).toThrow(PyLitError);
  });

  it("rejects mpl.cycler with a keyword other than color", () => {
    expect(() => parsePyDict('{"a": mpl.cycler(linestyle=["--"])}')).toThrow(PyLitError);
  });

  it("rejects an unexpected character like @", () => {
    expect(() => parsePyDict('{"a": @}')).toThrow(PyLitError);
  });

  it("rejects a missing colon", () => {
    expect(() => parsePyDict('{"a" 1}')).toThrow(PyLitError);
  });

  it("rejects a missing closing brace", () => {
    expect(() => parsePyDict('{"a": 1')).toThrow(PyLitError);
  });
});

// ---------------------------------------------------------------------------
// parsePyDict `end` / laziness
// ---------------------------------------------------------------------------

describe("parsePyDict end offset", () => {
  it("is the offset just past the closing brace", () => {
    const { end } = parsePyDict('{"a": 1}');
    expect(end).toBe('{"a": 1}'.length);
  });

  it("never tokenizes text after the closing brace, even if it is garbage", () => {
    const { value, end } = parsePyDict('{"a": 1}) @@@ garbage !!');
    expect(value).toEqual({ a: 1 });
    expect(end).toBe('{"a": 1}'.length);
  });
});

// ---------------------------------------------------------------------------
// parsePyString
// ---------------------------------------------------------------------------

describe("parsePyString", () => {
  it("reads a double- or single-quoted string", () => {
    expect(parsePyString('"bmh"')).toBe("bmh");
    expect(parsePyString("'bmh'")).toBe("bmh");
  });

  it("tolerates trailing whitespace after the string", () => {
    expect(parsePyString('"bmh"   ')).toBe("bmh");
  });

  it("rejects text after the string", () => {
    expect(() => parsePyString('"bmh" extra')).toThrow(PyLitError);
  });

  it("rejects input that is not a string literal", () => {
    expect(() => parsePyString("123")).toThrow(PyLitError);
  });
});

// ---------------------------------------------------------------------------
// formatPyValue
// ---------------------------------------------------------------------------

describe("formatPyValue", () => {
  it("formats booleans as True/False", () => {
    expect(formatPyValue(true)).toBe("True");
    expect(formatPyValue(false)).toBe("False");
  });

  it("formats numbers via String()", () => {
    expect(formatPyValue(1)).toBe("1");
    expect(formatPyValue(1.5)).toBe("1.5");
    expect(formatPyValue(-3)).toBe("-3");
  });

  it("formats strings via JSON.stringify (double-quoted, escaped)", () => {
    expect(formatPyValue("hello")).toBe('"hello"');
    const tricky = 'quote:"here"\\end';
    expect(formatPyValue(tricky)).toBe(JSON.stringify(tricky));
  });

  it("formats lists", () => {
    expect(formatPyValue([1, 2, 3])).toBe("[1, 2, 3]");
    expect(formatPyValue(["a", "b"])).toBe('["a", "b"]');
  });

  it("formats a cycler as mpl.cycler(color=[...])", () => {
    expect(formatPyValue({ cycler: { color: ["#111111", "#222222"] } })).toBe(
      'mpl.cycler(color=["#111111", "#222222"])',
    );
  });

  it("formats tuples", () => {
    expect(formatPyValue({ tuple: [0.6, 0.2] })).toBe("(0.6, 0.2)");
    expect(formatPyValue({ tuple: [1, 2, 3] })).toBe("(1, 2, 3)");
  });

  it("formats a single-element tuple with a trailing comma", () => {
    expect(formatPyValue({ tuple: [1] })).toBe("(1,)");
  });

  it("formats an empty tuple", () => {
    expect(formatPyValue({ tuple: [] })).toBe("()");
  });

  it("throws PyLitError for non-finite numbers", () => {
    expect(() => formatPyValue(NaN)).toThrow(PyLitError);
    expect(() => formatPyValue(Infinity)).toThrow(PyLitError);
    expect(() => formatPyValue(-Infinity)).toThrow(PyLitError);
  });
});

// ---------------------------------------------------------------------------
// isPyCycler
// ---------------------------------------------------------------------------

describe("isPyCycler", () => {
  it("recognizes a cycler value", () => {
    expect(isPyCycler({ cycler: { color: ["#fff"] } })).toBe(true);
  });

  it("rejects arrays and primitives", () => {
    expect(isPyCycler(["#fff"])).toBe(false);
    expect(isPyCycler("cycler")).toBe(false);
    expect(isPyCycler(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPyTuple
// ---------------------------------------------------------------------------

describe("isPyTuple", () => {
  it("recognizes a tuple value", () => {
    expect(isPyTuple({ tuple: [0.6, 0.2] })).toBe(true);
  });

  it("rejects arrays and primitives", () => {
    expect(isPyTuple([0.6, 0.2])).toBe(false);
    expect(isPyTuple("tuple")).toBe(false);
    expect(isPyTuple(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("round trip", () => {
  it("formatPyValue then parsePyDict recovers the same value", () => {
    const original: Record<string, PyValue> = {
      name: 'café "quoted" \\slash\\',
      count: 42,
      ratio: -1.5,
      flag: true,
      tags: ["a", "b", "c"],
      nums: [1, 2, 3.5],
      cycle: { cycler: { color: ["#111111", "#222222"] } },
      loc: { tuple: [0.6, 0.2] },
    };
    const src =
      "{" +
      Object.entries(original)
        .map(([k, v]) => `${JSON.stringify(k)}: ${formatPyValue(v)}`)
        .join(", ") +
      "}";
    const { value } = parsePyDict(src);
    expect(value).toEqual(original);
  });
});
