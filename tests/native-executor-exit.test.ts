import { beforeEach, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: probe.execute }));
import {
  verifyNativeExecutorExit,
  type NativeExecutorInventory,
} from "../apps/desktop/main/native-executor-exit";

const name = "GamePilot.MaaBridge.exe" as const;
const firstAt = "2026-10-07T00:00:00.000Z";
const secondAt = "2026-10-07T00:00:00.250Z";
const empty = (): NativeExecutorInventory => ({
  version: 1,
  complete: true,
  processName: name,
  processes: [],
});
const deps = () => ({
  inventory: vi.fn(async () => empty()),
  clock: vi.fn().mockReturnValueOnce(firstAt).mockReturnValue(secondAt),
  pause: vi.fn(async (_ms: number, _signal: AbortSignal) => {}),
});
beforeEach(() => {
  probe.execute.mockReset();
});

it("requires two complete empty inventories and records a reproducible proof at the second observation", async () => {
  const observations = deps();
  const signal = new AbortController().signal;
  const proof = await verifyNativeExecutorExit(signal, observations);
  expect(proof).toMatchObject({ verified: true, observedAt: secondAt });
  expect(proof.evidenceReference).toMatch(
    /^native-executor-exit:sha256:[a-f0-9]{64}$/,
  );
  expect(observations.inventory.mock.calls).toHaveLength(2);
  expect(observations.pause).toHaveBeenCalledExactlyOnceWith(250, signal);
  expect(
    await verifyNativeExecutorExit(new AbortController().signal, deps()),
  ).toEqual(proof);
  expect(probe.execute).not.toHaveBeenCalled();
});

it.each([0, 1])(
  "refuses any bridge process in observation %s without treating another lane as exited",
  async (index) => {
    const observations = deps();
    const occupied = { ...empty(), processes: [{ name, processId: 4321 }] };
    observations.inventory
      .mockResolvedValueOnce(index === 0 ? occupied : empty())
      .mockResolvedValueOnce(occupied);
    await expect(
      verifyNativeExecutorExit(new AbortController().signal, observations),
    ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
  },
);

it.each([0, 1])(
  "refuses enumeration failures at observation %s without leaking raw errors",
  async (index) => {
    const observations = deps();
    if (index) observations.inventory.mockResolvedValueOnce(empty());
    observations.inventory.mockRejectedValueOnce(
      new Error("private command/output detail"),
    );
    await expect(
      verifyNativeExecutorExit(new AbortController().signal, observations),
    ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
    expect(probe.execute).not.toHaveBeenCalled();
  },
);

it.each([
  undefined,
  [],
  {},
  { ...empty(), complete: false },
  { ...empty(), version: 2 },
  { ...empty(), processName: "another.exe" },
  { ...empty(), processes: undefined },
  { ...empty(), processes: "[]" },
  { ...empty(), processes: [{ name, processId: "123" }] },
  { ...empty(), processes: [{ name: "other.exe", processId: 123 }] },
  { ...empty(), unexpected: "not a full inventory" },
])(
  "refuses malformed or explicitly incomplete inventory: %j",
  async (value) => {
    const observations = deps();
    observations.inventory.mockResolvedValue(value as NativeExecutorInventory);
    await expect(
      verifyNativeExecutorExit(new AbortController().signal, observations),
    ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
  },
);

it("rejects cancellation before any inventory and at each asynchronous boundary", async () => {
  const already = new AbortController();
  already.abort();
  const before = deps();
  await expect(
    verifyNativeExecutorExit(already.signal, before),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(before.inventory).not.toHaveBeenCalled();
  for (const boundary of ["first", "pause", "second"] as const) {
    const abort = new AbortController();
    const observations = deps();
    if (boundary === "pause")
      observations.pause.mockImplementation(async () => {
        abort.abort();
      });
    else
      observations.inventory.mockImplementation(async () => {
        if (
          boundary === "first" ||
          observations.inventory.mock.calls.length === 2
        )
          abort.abort();
        return empty();
      });
    await expect(
      verifyNativeExecutorExit(abort.signal, observations),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  }
});

it.each(["not-a-time", "2026-02-30T00:00:00.000Z", "2026-10-07 08:00:00"])(
  "refuses invalid proof time %s",
  async (at) => {
    const observations = deps();
    observations.clock.mockReset().mockReturnValue(at);
    await expect(
      verifyNativeExecutorExit(new AbortController().signal, observations),
    ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
  },
);

it("refuses backwards observation times and cancellation by a late clock callback", async () => {
  const backwards = deps();
  backwards.clock
    .mockReset()
    .mockReturnValueOnce(secondAt)
    .mockReturnValue(firstAt);
  await expect(
    verifyNativeExecutorExit(new AbortController().signal, backwards),
  ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
  const abort = new AbortController();
  const observations = deps();
  observations.clock.mockImplementation(() => {
    if (observations.clock.mock.calls.length === 2) abort.abort();
    return secondAt;
  });
  await expect(
    verifyNativeExecutorExit(abort.signal, observations),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

it.skipIf(process.platform !== "win32")(
  "uses bounded hidden read-only CIM enumeration and validates its JSON",
  async () => {
    probe.execute.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify(empty()), "");
    });
    const observations = deps();
    const signal = new AbortController().signal;
    await expect(
      verifyNativeExecutorExit(signal, {
        clock: observations.clock,
        pause: observations.pause,
      }),
    ).resolves.toMatchObject({ verified: true });
    expect(probe.execute).toHaveBeenCalledTimes(2);
    const [file, args, options] = probe.execute.mock.calls[0];
    expect(file).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
    );
    expect(args.at(-1)).toContain("Get-CimInstance");
    expect(args.at(-1)).toContain("Win32_Process");
    expect(args.at(-1)).toContain(name);
    expect(args.at(-1)).toContain("-ErrorAction Stop");
    expect(args.at(-1)).not.toMatch(/taskkill|Stop-Process|\.Kill\(/i);
    expect(options).toMatchObject({
      windowsHide: true,
      timeout: 10000,
      encoding: "utf8",
      signal,
    });
  },
);

it.skipIf(process.platform !== "win32").each([
  {
    stdout: JSON.stringify(empty()),
    error: Object.assign(new Error("private failure"), { code: 1 }),
  },
  { stdout: "", error: null },
  { stdout: "[]", error: null },
  { stdout: "{invalid", error: null },
])(
  "refuses unsuccessful or malformed CIM output %j",
  async ({ stdout, error }) => {
    probe.execute.mockImplementation((_file, _args, _options, callback) => {
      callback(error, stdout, "");
    });
    const observations = deps();
    await expect(
      verifyNativeExecutorExit(new AbortController().signal, {
        clock: observations.clock,
        pause: observations.pause,
      }),
    ).rejects.toMatchObject({ code: "NATIVE_EXECUTOR_EXIT_UNCONFIRMED" });
  },
);
