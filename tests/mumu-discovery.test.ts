import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mumuDiscoveryScript,
  parseMuMuInstances,
  parseMuMuInfo,
  classifyGamePackages,
} from "../apps/desktop/main/mumu";

it.skipIf(process.platform !== "win32")(
  "filters MuMu processes and registry entries in real PowerShell",
  () => {
    const fixtures = String.raw`
function Get-CimInstance {
  [pscustomobject]@{Name='MuMuNxDevice.exe';ExecutablePath='D:\process\MuMuNxDevice.exe'}
  [pscustomobject]@{Name='MuMuXexe';ExecutablePath='D:\invalid\MuMuXexe'}
  [pscustomobject]@{Name='other.exe';ExecutablePath='D:\other\other.exe'}
}
function Get-ItemProperty {
  [pscustomobject]@{DisplayName='MuMu Player';InstallLocation='D:\registry\MuMu'}
  [pscustomobject]@{DisplayName='Other';InstallLocation='D:\registry\Other'}
}
`;
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(fixtures + mumuDiscoveryScript, "utf16le").toString(
          "base64",
        ),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    expect(JSON.parse(output.trim())).toEqual([
      String.raw`D:\process\MuMuNxDevice.exe`,
      String.raw`D:\registry\MuMu`,
    ]);
  },
  // The subprocess already has a 10s deadline; allow startup under parallel load.
  15000,
);

it("parses all MuMu instances using their reported ADB ports", () => {
  const result = parseMuMuInstances(
    JSON.stringify({
      "0": {
        index: "0",
        name: "MuMu安卓设备",
        error_code: 0,
        is_process_started: true,
        is_android_started: true,
        adb_port: 16384,
      },
      "1": {
        index: "1",
        name: "MuMu安卓设备-1",
        error_code: 0,
        is_process_started: true,
        is_android_started: true,
        adb_port: 16416,
      },
    }),
  );
  expect(result).toEqual([
    expect.objectContaining({
      instance: 0,
      name: "MuMu安卓设备",
      address: "127.0.0.1:16384",
      ready: true,
    }),
    expect.objectContaining({
      instance: 1,
      name: "MuMu安卓设备-1",
      address: "127.0.0.1:16416",
      ready: true,
    }),
  ]);
});

it("classifies installed game variants without guessing accounts", () => {
  expect(
    classifyGamePackages([
      "com.hypergryph.arknights.bilibili",
      "com.netease.onmyoji.wyzymnqsd_cps",
    ]),
  ).toEqual({ arknights: "Bilibili", onmyoji: true });
  expect(classifyGamePackages(["com.hypergryph.arknights"])).toEqual({
    arknights: "Official",
    onmyoji: false,
  });
  expect(classifyGamePackages(["com.example.game"])).toEqual({
    arknights: null,
    onmyoji: false,
  });
});

const readyInstance = {
  index: "0",
  error_code: 0,
  is_process_started: true,
  is_android_started: true,
  adb_port: 16384,
  pid: 123,
};

it.each([
  { label: "mismatched key/index", records: { "9": readyInstance } },
  {
    label: "duplicate instance",
    records: { "0": readyInstance, "1": readyInstance },
  },
  {
    label: "conflicting ready endpoint",
    records: {
      "0": readyInstance,
      "1": { ...readyInstance, index: "1", pid: 456 },
    },
  },
])(
  "rejects $label instead of publishing ambiguous device identity",
  ({ records }) => {
    expect(() => parseMuMuInstances(JSON.stringify(records))).toThrow(/MuMu/);
  },
);

it.each([
  { index: true },
  { index: "00" },
  { index: 1000 },
  { is_process_started: undefined },
  { is_android_started: undefined },
  { is_process_started: "true" },
  { is_android_started: "false" },
  { is_process_started: false },
  { adb_port: true },
  { adb_port: [16384] },
  { error_code: "0" },
  { errcode: false },
  { pid: -1 },
  { pid: "123" },
  { player_state: 5 },
])("rejects malformed fields %j in both single and list queries", (patch) => {
  const record = { ...readyInstance, ...patch };
  expect(() =>
    parseMuMuInfo(JSON.stringify(record), Number(record.index)),
  ).toThrow(/MuMu/);
  expect(() =>
    parseMuMuInstances(JSON.stringify({ [String(record.index)]: record })),
  ).toThrow(/MuMu/);
});

it("rejects multiple matches in a single-instance array response", () => {
  expect(() =>
    parseMuMuInfo(JSON.stringify([readyInstance, readyInstance]), 0),
  ).toThrow(/MuMu/);
});

it("keeps duplicate display names distinct when instance numbers and endpoints differ", () => {
  const records = {
    "0": { ...readyInstance, index: 0, name: "MuMu" },
    "1": {
      ...readyInstance,
      index: 1,
      name: "MuMu",
      adb_port: 16416,
      pid: 456,
    },
  };
  expect(
    parseMuMuInstances(JSON.stringify(records)).map(
      ({ instance, address }) => ({ instance, address }),
    ),
  ).toEqual([
    { instance: 0, address: "127.0.0.1:16384" },
    { instance: 1, address: "127.0.0.1:16416" },
  ]);
});

it("accepts a zero PID only for an explicitly stopped ordinary record", () => {
  const stopped = {
    ...readyInstance,
    is_process_started: false,
    is_android_started: false,
    pid: 0,
    adb_port: 0,
  };
  expect(parseMuMuInfo(JSON.stringify(stopped), 0)).toMatchObject({
    running: false,
    ready: false,
    address: "",
  });
  expect(() =>
    parseMuMuInfo(JSON.stringify({ ...readyInstance, pid: 0 }), 0),
  ).toThrow(/MuMu/);
});
