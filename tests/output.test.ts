import { describe, it, expect } from "vitest";
import { sanitizeDeep, sanitizeForTerminal, showControls, toSafeJson } from "../src/output.js";

const ESC = "\x1b";

describe("sanitizeForTerminal", () => {
  it.each([
    ["CSI clear screen", `a${ESC}[2Jb`, "ab"],
    ["CSI colour", `${ESC}[31;1mred${ESC}[0m`, "red"],
    ["CSI cursor move with private params", `x${ESC}[?25l${ESC}[10;20Hy`, "xy"],
    ["OSC 52 clipboard (BEL)", `hi${ESC}]52;c;cm0gLXJmIH4=\x07there`, "hithere"],
    ["OSC title (ST)", `${ESC}]0;pwned${ESC}\\ok`, "ok"],
    ["OSC 8 hyperlink", `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    ["DCS", `${ESC}Pq#0;2;0;0;0${ESC}\\after`, "after"],
    ["8-bit CSI", "a\x9b2Jb", "ab"],
    ["8-bit OSC", "a\x9d0;title\x07b", "ab"],
    ["two-byte escapes", `${ESC}c${ESC}(Bplain${ESC}7`, "plain"],
    ["carriage return overwrite", "safe\rEVIL", "safeEVIL"],
    ["backspaces and bell", "ab\b\b\x07cd", "abcd"],
    ["NUL, DEL, other C0/C1", "a\x00b\x7fc\x85d\x1ce", "abcde"],
    ["bidi overrides and isolates", "abc‮dcba‬ ⁦x⁩", "abcdcba x"],
  ])("removes %s", (_label, input, expected) => {
    expect(sanitizeForTerminal(input)).toBe(expected);
  });

  it("keeps newlines, tabs and ordinary Unicode", () => {
    const text = "line 1\n\tindented — café 🚀 日本語 <@U123> *bold*";
    expect(sanitizeForTerminal(text)).toBe(text);
  });

  it("an unterminated OSC loses its introducer, leaving inert text", () => {
    const out = sanitizeForTerminal(`a${ESC}]52;c;AAAA`);
    expect(out).not.toContain(ESC);
    expect(out).toBe("a52;c;AAAA");
  });

  it("leaves no control characters in hostile input", () => {
    const hostile = Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i)).join("") + `${ESC}]52;c;x\x07${ESC}[2J`;
    expect(sanitizeForTerminal(hostile)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});

describe("sanitizeDeep", () => {
  it("sanitizes every string in nested objects and arrays, keeping other values", () => {
    const input = {
      text: `hi${ESC}[2J`,
      n: 3,
      ok: true,
      none: null,
      list: [`a${ESC}]0;t\x07`, { name: "b\rc" }],
      [`k${ESC}[1m`]: "v",
    };
    expect(sanitizeDeep(input)).toEqual({ text: "hi", n: 3, ok: true, none: null, list: ["a", { name: "bc" }], k: "v" });
    expect(input.text).toBe(`hi${ESC}[2J`); // the original is untouched
  });
});

describe("toSafeJson (D4)", () => {
  const HOSTILE = "a\x1b[2Jb\x9b2Jc\u202eevil\x7fd\u2066iso\u2069\u202a\x85e\u200eLRM\u200fRLM";

  it("writes DEL, C1 and bidi embedding/override/isolate characters as \\u escapes", () => {
    const text = toSafeJson({ text: HOSTILE });
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/); // only the indent's newlines remain
    for (const esc of ["\\u001b", "\\u009b", "\\u202e", "\\u007f", "\\u2066", "\\u2069", "\\u202a", "\\u0085"]) expect(text).toContain(esc);
    expect(text).toContain("\u200eLRM\u200fRLM"); // LRM/RLM stay as they are
  });

  it("is still valid JSON that parses back to the identical value (keys too, any indent)", () => {
    const value = { [HOSTILE]: [HOSTILE, { n: 1, ok: true, none: null }] };
    expect(JSON.parse(toSafeJson(value))).toEqual(value);
    expect(JSON.parse(toSafeJson(value, undefined))).toEqual(value);
    expect(toSafeJson({ a: "plain ✅ émoji" })).toBe(JSON.stringify({ a: "plain ✅ émoji" }, null, 2));
  });
});

describe("showControls (D7)", () => {
  it("shows the controls sanitizeForTerminal would strip as escapes; keeps newlines, tabs and ordinary text", () => {
    expect(showControls("line1\r\x1b[2Jx\u202eevil\x7f\x9b\u2066")).toBe("line1\\r\\x1b[2Jx\\u202eevil\\x7f\\x9b\\u2066");
    expect(showControls("a\tb\nc ✅ שלום \u200e")).toBe("a\tb\nc ✅ שלום \u200e");
    expect(sanitizeForTerminal(showControls("\x1b]52;c;x\x07"))).toBe("\\x1b]52;c;x\\x07"); // nothing left to strip
  });
});
