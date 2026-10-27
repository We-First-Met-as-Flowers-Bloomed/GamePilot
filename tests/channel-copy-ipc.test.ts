import { describe, expect, it, vi } from "vitest";
import {
  registerSettingsIpc,
  type MainBusySnapshot,
  type SettingsIpcPorts,
} from "../apps/desktop/main/ipc/settings";
import {
  defaultDeviceLanes,
  validateDeviceLanes,
  type DeviceLanes,
} from "../packages/protocol";
import {
  defaultArknightsProfiles,
  type ArknightsProfiles,
} from "../games/arknights/config";
import type { ChannelCopyResult } from "../packages/protocol/channel";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let lanes = defaultDeviceLanes({
    managerPath: "D:/MuMu/nx_main/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  });
  let profiles = structuredClone(defaultArknightsProfiles);
  profiles.profiles[0].expectedUid = "123456789";
  profiles.profiles[0].accountName = "原账号";
  profiles.profiles[0].copilotFile = "D:/private/source.json";
  const state: MainBusySnapshot = {
    starting: false, connecting: false, finishing: false, configuring: false,
    automaticReserved: false, startupInspectionRunning: false,
    chatBusy: false, executionsActive: false, historyActive: false,
  };
  const handlers = new Map<string, (input: unknown) => unknown>();
  const deviceSave = vi.fn(async (value: DeviceLanes) => {
    lanes = structuredClone(value);
    return structuredClone(lanes);
  });
  const profileSave = vi.fn(async (value: ArknightsProfiles) => {
    profiles = structuredClone(value);
    return structuredClone(profiles);
  });
  const settingsSave = vi.fn(async (input: unknown) => input);
  const anyLaneRunning = vi.fn(() => false);
  const invalidatePreview = vi.fn();
  const ports: SettingsIpcPorts = {
    register: (channel, handler) => { handlers.set(channel, handler); },
    busy: () => ({ ...state }),
    withConfiguring: async (action) => {
      state.configuring = true;
      try { return await action(); }
      finally { state.configuring = false; }
    },
    anyLaneRunning,
    validateDeviceLanes,
    deviceLanes: { read: async () => structuredClone(lanes), save: deviceSave },
    arknights: { read: async () => structuredClone(profiles), save: profileSave },
    settings: { save: settingsSave },
    automation: { read: async () => ({}) },
    invalidatePreview,
    discoverInstances: async () => [],
    probeArknights: async () => ({}),
  };
  registerSettingsIpc(ports);
  function invoke(channel: string, input?: unknown) {
    const handler = handlers.get(channel);
    if (!handler) throw Error(`Handler missing: ${channel}`);
    return Promise.resolve().then(() => handler(input));
  }
  return {
    state, invoke, deviceSave, profileSave, settingsSave,
    anyLaneRunning, invalidatePreview,
    snapshot: () => structuredClone({ lanes, profiles }),
  };
}

const copyInput = {
  sourceLaneId: "lane-a",
  gameId: "arknights",
  targets: [{ instance: 2, name: "账号三" }, { instance: 3, name: "账号四" }],
};

describe("channel-copy through registered settings IPC", () => {
  it.each<keyof MainBusySnapshot>([
    "starting", "connecting", "finishing", "configuring", "automaticReserved",
    "startupInspectionRunning", "chatBusy", "executionsActive", "historyActive",
  ])("refuses while %s without writing either store", async (flag) => {
    const fixture = setup();
    const before = fixture.snapshot();
    fixture.state[flag] = true;
    await expect(fixture.invoke("gp:channel-copy", copyInput)).rejects.toThrow(/任务结束/);
    expect(fixture.deviceSave).not.toHaveBeenCalled();
    expect(fixture.profileSave).not.toHaveBeenCalled();
    expect(fixture.invalidatePreview).not.toHaveBeenCalled();
    expect(fixture.snapshot()).toEqual(before);
  });

  it("refuses a running device even when the other busy flags are clear", async () => {
    const fixture = setup();
    fixture.anyLaneRunning.mockReturnValue(true);
    const before = fixture.snapshot();
    await expect(fixture.invoke("gp:channel-copy", copyInput)).rejects.toThrow(/设备正在执行/);
    expect(fixture.deviceSave).not.toHaveBeenCalled();
    expect(fixture.profileSave).not.toHaveBeenCalled();
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.state.configuring).toBe(false);
  });

  it("keeps all stores unchanged when a batch contains an occupied target", async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    await expect(fixture.invoke("gp:channel-copy", {
      ...copyInput, targets: [...copyInput.targets, { instance: 0, name: "已有设备" }],
    })).rejects.toThrow(/绑定|占用/);
    expect(fixture.profileSave).not.toHaveBeenCalled();
    expect(fixture.deviceSave).not.toHaveBeenCalled();
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.state.configuring).toBe(false);
  });

  it("holds the configuration gate until the final store write completes", async () => {
    const fixture = setup();
    const writing = deferred();
    const release = deferred();
    const saveLanes = fixture.deviceSave.getMockImplementation()!;
    fixture.deviceSave.mockImplementation(async (value) => {
      writing.resolve();
      await release.promise;
      return saveLanes(value);
    });
    const operation = fixture.invoke("gp:channel-copy", copyInput);
    await writing.promise;
    expect(fixture.state.configuring).toBe(true);
    expect(fixture.invalidatePreview).not.toHaveBeenCalled();
    await expect(fixture.invoke("gp:settings", {})).rejects.toThrow(/正在进行/);
    await expect(fixture.invoke("gp:channel-copy", copyInput)).rejects.toThrow(/任务结束/);
    expect(fixture.settingsSave).not.toHaveBeenCalled();
    expect(fixture.profileSave).toHaveBeenCalledTimes(1);
    expect(fixture.deviceSave).toHaveBeenCalledTimes(1);
    release.resolve();
    await operation;
    expect(fixture.state.configuring).toBe(false);
    expect(fixture.invalidatePreview).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot().lanes.lanes).toHaveLength(3);
    await fixture.invoke("gp:settings", { test: "after-copy" });
    expect(fixture.settingsSave).toHaveBeenCalledTimes(1);
  });

  it("restores profiles before releasing the configuration gate after a device-store failure", async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    const rollbackStarted = deferred();
    const releaseRollback = deferred();
    const saveProfiles = fixture.profileSave.getMockImplementation()!;
    fixture.profileSave.mockImplementation(async (value) => {
      if (value.profiles.length === before.profiles.profiles.length) {
        rollbackStarted.resolve();
        await releaseRollback.promise;
      }
      return saveProfiles(value);
    });
    fixture.deviceSave.mockRejectedValueOnce(Error("device disk failure"));
    const operation = fixture.invoke("gp:channel-copy", copyInput);
    const rejected = expect(operation).rejects.toThrow("device disk failure");
    await rollbackStarted.promise;
    expect(fixture.state.configuring).toBe(true);
    await expect(fixture.invoke("gp:settings", {})).rejects.toThrow(/正在进行/);
    expect(fixture.invalidatePreview).not.toHaveBeenCalled();
    releaseRollback.resolve();
    await rejected;
    expect(fixture.profileSave).toHaveBeenCalledTimes(2);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.state.configuring).toBe(false);
    expect(fixture.settingsSave).not.toHaveBeenCalled();
  });

  it("does not write channels if saving independent profiles fails", async () => {
    const fixture = setup();
    const before = fixture.snapshot();
    fixture.profileSave.mockRejectedValueOnce(Error("profile disk failure"));
    await expect(fixture.invoke("gp:channel-copy", copyInput)).rejects.toThrow("profile disk failure");
    expect(fixture.deviceSave).not.toHaveBeenCalled();
    expect(fixture.invalidatePreview).not.toHaveBeenCalled();
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.state.configuring).toBe(false);
  });

  it("returns both storage failures when rollback itself fails", async () => {
    const fixture = setup();
    const saveProfiles = fixture.profileSave.getMockImplementation()!;
    fixture.profileSave.mockImplementationOnce(saveProfiles).mockRejectedValueOnce(Error("rollback disk failure"));
    fixture.deviceSave.mockRejectedValueOnce(Error("channel disk failure"));
    const error = await fixture.invoke("gp:channel-copy", copyInput).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/回滚失败/);
    expect((error as AggregateError).errors.map((reason: Error) => reason.message))
      .toEqual(["channel disk failure", "rollback disk failure"]);
    expect(fixture.snapshot().lanes.lanes).toHaveLength(1);
    expect(fixture.invalidatePreview).not.toHaveBeenCalled();
    expect(fixture.state.configuring).toBe(false);
  });

  it("requires each copied channel's own UID binding through the normal save IPC", async () => {
    const fixture = setup();
    const original = fixture.snapshot();
    const copied = await fixture.invoke("gp:channel-copy", copyInput) as ChannelCopyResult;
    const [first, second] = copied.lanes.lanes.slice(1);
    expect(first.enabled).toBe(false);
    expect(second.enabled).toBe(false);
    expect(first.arknights.profileId).not.toBe(second.arknights.profileId);
    expect(copied.profiles.activeProfileId).toBe(original.profiles.activeProfileId);
    for (const lane of [first, second]) {
      const profile = copied.profiles.profiles.find((value) => value.id === lane.arknights.profileId)!;
      expect(profile.expectedUid).toBe("");
      expect(profile.accountName).toBe("");
      expect(profile.copilotFile).toBe("");
    }
    const enabled = structuredClone(copied.lanes);
    enabled.lanes[1].enabled = true;
    enabled.lanes[2].enabled = true;
    await expect(fixture.invoke("gp:device-lanes-save", enabled)).rejects.toThrow(/UID/);
    expect(fixture.deviceSave).toHaveBeenCalledTimes(1);
    const profiles = structuredClone(copied.profiles);
    profiles.profiles.find((value) => value.id === first.arknights.profileId)!.expectedUid = "222222222";
    await fixture.invoke("gp:arknights-save", profiles);
    await expect(fixture.invoke("gp:device-lanes-save", enabled)).rejects.toThrow(/账号四.*UID/);
    expect(fixture.deviceSave).toHaveBeenCalledTimes(1);
    profiles.profiles.find((value) => value.id === second.arknights.profileId)!.expectedUid = "333333333";
    await fixture.invoke("gp:arknights-save", profiles);
    await fixture.invoke("gp:device-lanes-save", enabled);
    const stored = fixture.snapshot();
    expect(stored.lanes.lanes.slice(1).every((lane) => lane.enabled)).toBe(true);
    expect(stored.profiles.profiles[0]).toEqual(original.profiles.profiles[0]);
    expect(stored.lanes.lanes[0]).toEqual(original.lanes.lanes[0]);
  });
});
