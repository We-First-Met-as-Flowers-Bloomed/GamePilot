import { describe, expect, it } from "vitest";
import {
  addressForLane,
  assertCliOptions,
  parseSurveyArgs,
  selectCliDevice,
  selectCliLane,
  selectCliCombos,
} from "../scripts/shared/cli-target.mjs";

const lanes = [
  { id: "custom-b", instance: 1 },
  { id: "custom-a", instance: 0 },
];

describe("explicit CLI device targets", () => {
  it.each(["a", "0"])(
    "maps %s to the uniquely configured instance 0",
    (alias) => {
      expect(selectCliLane(lanes, alias)).toBe(lanes[1]);
    },
  );
  it.each(["b", "1"])(
    "maps %s to the uniquely configured instance 1",
    (alias) => {
      expect(selectCliLane(lanes, alias)).toBe(lanes[0]);
    },
  );
  it("accepts a configured exact lane ID", () => {
    expect(selectCliLane(lanes, "custom-a")).toBe(lanes[1]);
  });
  it("rejects unknown lane IDs instead of falling back to the first account", () => {
    expect(() => selectCliLane(lanes, "typo")).toThrow(/槽位.*typo/);
  });
  it("rejects ambiguous instance aliases", () => {
    expect(() =>
      selectCliLane([...lanes, { id: "duplicate", instance: 0 }], "a"),
    ).toThrow(/唯一|歧义/);
  });
  it("rejects duplicate exact lane IDs", () => {
    expect(() => selectCliLane([lanes[1], lanes[1]], "custom-a")).toThrow(
      /唯一|歧义/,
    );
  });
  it("derives an address from the explicit instance", () => {
    expect(addressForLane(lanes[0])).toBe("127.0.0.1:16416");
  });
  it.each([undefined, -1, 0.5, NaN, 5000])(
    "rejects an invalid instance without silently using instance 0: %s",
    (instance) => {
      expect(() => addressForLane({ instance })).toThrow(/实例/);
    },
  );
  it("selects the exact requested address rather than discovery order", () => {
    const devices = [{ address: "wrong" }, { address: "right" }];
    expect(selectCliDevice(devices, "right")).toBe(devices[1]);
  });
  it("rejects an undiscovered address instead of connecting another account", () => {
    expect(() => selectCliDevice([{ address: "other" }], "missing")).toThrow(
      /设备.*missing/,
    );
  });
  it("rejects duplicate address discoveries", () => {
    expect(() =>
      selectCliDevice([{ address: "same" }, { address: "same" }], "same"),
    ).toThrow(/唯一|歧义/);
  });
});

describe("survey arguments are validated before any device operation", () => {
  it("retains explicit navigation options and repeated taps", () => {
    expect(
      parseSurveyArgs([
        "--lane",
        "b",
        "--label",
        "观察",
        "--tap",
        "0,0",
        "--tap",
        "1919,1079",
        "--wait",
        "2",
        "--ocr",
        "0.8",
        "--launch",
      ]),
    ).toEqual({
      lane: "b",
      label: "观察",
      taps: [
        [0, 0],
        [1919, 1079],
      ],
      waitMs: 2000,
      ocr: "0.8",
      launch: true,
    });
  });
  it("preserves the read-only defaults", () => {
    expect(parseSurveyArgs([])).toEqual({
      lane: "a",
      label: "survey",
      taps: [],
      waitMs: 1500,
      ocr: "0.7",
      launch: false,
    });
  });
  it.each([
    ["--typo"],
    ["--lane"],
    ["--lane", "--tap", "1,1"],
    ["--lane", "a", "--lane", "b"],
    ["--tap"],
    ["--tap", "1"],
    ["--tap", "1,2,3"],
    ["--tap", "NaN,2"],
    ["--tap", "-1,0"],
    ["--tap", "1920,0"],
    ["--tap", "0,1080"],
    ["--wait", "NaN"],
    ["--wait", "-1"],
    ["--ocr", "2"],
  ])("rejects invalid options %j", (...args) => {
    expect(() => parseSurveyArgs(args)).toThrow(/参数|坐标|等待|OCR/);
  });
});

describe("CLI option validation prevents ignored target parameters", () => {
  it("accepts declared options and value-less flags", () => {
    expect(() =>
      assertCliOptions(
        ["--address", "127.0.0.1:16416", "--dry"],
        ["address"],
        ["dry"],
      ),
    ).not.toThrow();
  });
  it.each([
    ["--address"],
    ["--address", "--dry"],
    ["--lane", "b"],
    ["--address", "a", "--address", "b"],
    ["ignored"],
  ])("rejects incomplete or unknown options %j", (...args) => {
    expect(() => assertCliOptions(args, ["address"], ["dry"])).toThrow(/参数/);
  });
});


describe("per-game device instances", () => {
  it("falls back to lane.instance when the game has no override", () => {
    expect(addressForLane({ instance: 0 }, "arknights")).toBe("127.0.0.1:16384");
  });

  it("uses the per-game override for addressing only", () => {
    const lane = { instance: 0, deviceInstances: { onmyoji: 2 } };
    expect(addressForLane(lane, "onmyoji")).toBe("127.0.0.1:16448");
    expect(addressForLane(lane, "arknights")).toBe("127.0.0.1:16384");
    // 不传 game 时只看 lane.instance（保持旧行为）
    expect(addressForLane(lane)).toBe("127.0.0.1:16384");
  });

  it("rejects an out-of-range override instead of silently falling back", () => {
    expect(() =>
      addressForLane({ instance: 0, deviceInstances: { arknights: 9999 } }, "arknights"),
    ).toThrow();
  });
});

describe("migrated account-channel CLI targets", () => {
  const channels = [
    { id: "custom-a", instance: 0, arknights: { enabled: true }, onmyoji: { enabled: false }, legacyBinding: { laneId: "custom-a", instance: 0, scope: '["mumu",0,"profile-a",true]' } },
    { id: "custom-b", instance: 1, arknights: { enabled: true }, onmyoji: { enabled: false }, legacyBinding: { laneId: "custom-b", instance: 1, scope: '["mumu",1,"profile-b",true]' } },
    { id: "custom-a-onmyoji", instance: 2, arknights: { enabled: false }, onmyoji: { enabled: true }, legacyBinding: { laneId: "custom-a", instance: 2, scope: '["mumu",0,"profile-a",true]' } },
    { id: "custom-b-onmyoji", instance: 3, arknights: { enabled: false }, onmyoji: { enabled: true }, legacyBinding: { laneId: "custom-b", instance: 3, scope: '["mumu",1,"profile-b",true]' } },
  ];

  it.each(["a", "0", "custom-a"])("routes original %s to its actual Onmyoji successor", (argument) => {
    expect(selectCliLane(channels, argument, "onmyoji")).toBe(channels[2]);
    expect(addressForLane(selectCliLane(channels, argument, "onmyoji"), "onmyoji")).toBe("127.0.0.1:16448");
  });

  it.each(["b", "1", "custom-b"])("routes original %s to its actual Arknights channel", (argument) => {
    expect(selectCliLane(channels, argument, "arknights")).toBe(channels[1]);
  });

  it("accepts a successor exact ID and rejects the other game without retargeting it", () => {
    expect(selectCliLane(channels, "custom-b-onmyoji", "onmyoji")).toBe(channels[3]);
    expect(() => selectCliLane(channels, "custom-b-onmyoji", "arknights")).toThrow(/槽位/);
  });

  it("resolves the shortened successor ID emitted by catchup commands", () => {
    const successor = { ...channels[2], id: "lane-a-onmyoji" };
    expect(selectCliLane([successor], "a-onmyoji", "onmyoji")).toBe(successor);
  });

  it("uses both game channels for an original alias without creating cross-game combinations", () => {
    expect(selectCliCombos(channels, "a", "all")).toEqual([
      { lane: "custom-a-onmyoji", game: "onmyoji" },
      { lane: "custom-a", game: "arknights" },
    ]);
    expect(selectCliCombos(channels, "b", "onmyoji")).toEqual([{ lane: "custom-b-onmyoji", game: "onmyoji" }]);
  });

  it("retains instance-alias routing for a legacy mixed configuration", () => {
    const mixed = { id: "old-a", instance: 0, deviceInstances: { onmyoji: 2 }, arknights: { enabled: true }, onmyoji: { enabled: true } };
    expect(selectCliLane([mixed], "a", "onmyoji")).toBe(mixed);
    expect(addressForLane(mixed, "onmyoji")).toBe("127.0.0.1:16448");
  });

  it("rejects ambiguous successor lineage rather than picking a physical instance", () => {
    expect(() => selectCliLane([...channels, { ...channels[2], id: "duplicate" }], "a", "onmyoji")).toThrow(/歧义|唯一/);
  });
});
