import { describe, expect, it } from "vitest";
import {
  asIdentifier,
  asRecord,
  canonical,
  isRecord,
  recordWithKeys,
} from "../packages/protocol/struct";

describe("asRecord / isRecord", () => {
  it("accepts plain objects and rejects arrays, null, primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
  });

  it("supports typed field access through the generic", () => {
    const value = asRecord<Record<string, any>>({ profileId: "p1" });
    expect(value?.profileId).toBe("p1");
  });
});

describe("recordWithKeys", () => {
  it("accepts objects whose keys are a subset", () => {
    expect(recordWithKeys({ a: 1, b: 2 }, ["a", "b", "c"])).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("rejects unknown keys and non-objects", () => {
    expect(recordWithKeys({ a: 1, z: 2 }, ["a"])).toBeUndefined();
    expect(recordWithKeys([], ["length"])).toBeUndefined();
    expect(recordWithKeys(null, ["a"])).toBeUndefined();
    expect(recordWithKeys("a", ["a"])).toBeUndefined();
  });
});

describe("asIdentifier", () => {
  it("accepts ASCII ids within the cap", () => {
    expect(asIdentifier("lane-a:rk_1.2")).toBe(true);
    expect(asIdentifier("a".repeat(240))).toBe(true);
  });

  it("rejects empty, overlong, and non-ASCII", () => {
    expect(asIdentifier("")).toBe(false);
    expect(asIdentifier("a".repeat(241))).toBe(false);
    expect(asIdentifier("任务")).toBe(false);
    expect(asIdentifier("has space")).toBe(false);
    expect(asIdentifier(7)).toBe(false);
  });

  it("honours a custom maximum", () => {
    expect(asIdentifier("abcd", 4)).toBe(true);
    expect(asIdentifier("abcde", 4)).toBe(false);
  });
});

describe("canonical", () => {
  it("is key-order independent and array-order sensitive", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
