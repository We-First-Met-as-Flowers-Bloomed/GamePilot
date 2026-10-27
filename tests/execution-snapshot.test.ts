import { describe, expect, it } from "vitest";
import {
  parseContinuationLink,
  parseExecutionSnapshot,
  parseFrozenPlan,
} from "../packages/protocol/execution-snapshot";

describe("parseContinuationLink", () => {
  const good = {
    parentId: "req-1",
    parentFingerprint: "f".repeat(64),
    retained: [{ gameId: "arknights", skillIds: ["login", "fight"] }],
    excluded: [{ gameId: "onmyoji", skillIds: ["mail"] }],
    acknowledgedPartial: false,
  };

  it("accepts a well-formed link", () => {
    expect(parseContinuationLink(good)).toEqual(good);
  });

  it("rejects bad ids, oversized selections, and unknown games", () => {
    expect(parseContinuationLink({ ...good, parentId: "" })).toBeUndefined();
    // 原实现只限指纹上限 128，无下限——行为冻结
    expect(
      parseContinuationLink({ ...good, parentFingerprint: "f".repeat(129) }),
    ).toBeUndefined();
    expect(
      parseContinuationLink({
        ...good,
        retained: [{ gameId: "wuthering", skillIds: ["x"] }],
      }),
    ).toBeUndefined();
    expect(
      parseContinuationLink({
        ...good,
        retained: [{ gameId: "arknights", skillIds: ["a"] }, 1, 2, 3],
      }),
    ).toBeUndefined();
    expect(
      parseContinuationLink({ ...good, acknowledgedPartial: "no" }),
    ).toBeUndefined();
    expect(parseContinuationLink("nope")).toBeUndefined();
  });
});

describe("parseFrozenPlan", () => {
  it("accepts a valid plan and rejects malformed ones", () => {
    expect(
      parseFrozenPlan({
        gameId: "arknights",
        skillIds: ["login"],
        mode: "live",
      }),
    ).toEqual({
      gameId: "arknights",
      skillIds: ["login"],
      mode: "live",
    });
    expect(
      parseFrozenPlan({ gameId: "arknights", skillIds: [], mode: "live" }),
    ).toBeUndefined();
    expect(
      parseFrozenPlan({
        gameId: "arknights",
        skillIds: ["login"],
        mode: "other",
      }),
    ).toBeUndefined();
    expect(parseFrozenPlan(null)).toBeUndefined();
    expect(
      parseFrozenPlan({
        gameId: "arknights",
        skillIds: ["login", "login"],
        mode: "live",
      }),
    ).toBeUndefined();
  });
});

describe("parseExecutionSnapshot", () => {
  it("exposes legacy/current version status without changing raw data", () => {
    const legacy = { future: { kept: true } };
    const before = JSON.stringify(legacy);
    expect(parseExecutionSnapshot(legacy)).toMatchObject({
      raw: legacy,
      schemaStatus: "legacy",
    });
    expect(JSON.stringify(legacy)).toBe(before);
    expect(parseExecutionSnapshot({ schemaVersion: 1 })).toMatchObject({
      schemaStatus: "current",
    });
  });

  it.each([2, 0, "1", null, 1.5])(
    "does not interpret unsupported or malformed schema %s",
    (schemaVersion) => {
      const raw = {
        schemaVersion,
        plan: { gameId: "arknights", skillIds: ["login"], mode: "live" },
        unknown: "kept",
      };
      const view = parseExecutionSnapshot(raw)!;
      expect(view.schemaStatus).toBe(
        typeof schemaVersion === "number" &&
          Number.isInteger(schemaVersion) &&
          schemaVersion > 0
          ? "unsupported"
          : "invalid",
      );
      expect(view.raw).toBe(raw);
      expect(view.plan).toBeUndefined();
    },
  );

  it("returns undefined for non-objects", () => {
    expect(parseExecutionSnapshot("x")).toBeUndefined();
    expect(parseExecutionSnapshot([])).toBeUndefined();
  });

  it("types known sections and preserves unknown keys in raw", () => {
    const raw = {
      appVersion: "0.15.13",
      plan: { gameId: "arknights", skillIds: ["fight"], mode: "live" },
      continuation: {
        parentId: "req-1",
        parentFingerprint: "f".repeat(64),
        retained: [],
        excluded: [],
        acknowledgedPartial: true,
      },
      device: { adbPath: "adb.exe", address: "127.0.0.1:16384" },
      futureSection: { anything: true },
    };
    const view = parseExecutionSnapshot(raw)!;
    expect(view.appVersion).toBe("0.15.13");
    expect(view.plan?.skillIds).toEqual(["fight"]);
    expect(view.continuation?.acknowledgedPartial).toBe(true);
    expect(view.device?.address).toBe("127.0.0.1:16384");
    // 指纹必须对 raw 计算：视图不改写、不丢弃未知键
    expect(view.raw.futureSection).toEqual({ anything: true });
    expect(view.raw).toBe(raw);
  });

  it("drops invalid sections instead of rejecting the whole snapshot", () => {
    const view = parseExecutionSnapshot({
      plan: { gameId: "", skillIds: ["x"], mode: "live" },
      device: { address: 42 },
    })!;
    expect(view.plan).toBeUndefined();
    expect(view.device?.address).toBeUndefined();
    expect(view.device?.adbPath).toBeUndefined();
  });
});
