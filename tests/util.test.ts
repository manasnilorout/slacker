import { describe, it, expect } from "vitest";
import { errorMessage, isPlainObject, quoteNames } from "../src/util.js";

describe("util", () => {
  it("isPlainObject accepts only non-null, non-array objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const v of [null, undefined, [], "x", 1, true]) expect(isPlainObject(v)).toBe(false);
  });

  it("errorMessage handles errors and thrown values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("quoteNames quotes and joins", () => {
    expect(quoteNames(["a", "b"])).toBe('"a", "b"');
    expect(quoteNames(["solo"])).toBe('"solo"');
    expect(quoteNames([])).toBe("");
  });
});
