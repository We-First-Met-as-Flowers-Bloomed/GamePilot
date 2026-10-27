import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  planLaunchPointerUpdates,
  refreshLaunchPointers,
  windowsPorts,
  type LaunchPointerSnapshot,
  type LaunchShortcut,
} from "../scripts/release/check-launch-pointers.mjs";

const releaseRoot = "D:\\Projects\\GamePilot\\release";
const previous = `${releaseRoot}\\GamePilot-0.14.47`;
const selected = `${releaseRoot}\\GamePilot-0.15.2`;
const targetPath = `${selected}\\GamePilot.exe`;
const desktop = "D:\\Desktop\\GamePilot.lnk";
const taskbar =
  "C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Electron.lnk";
const unrelated =
  "C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Other Electron.lnk";
const shortcut = (path = taskbar): LaunchShortcut => ({
  path,
  targetPath: `${previous}\\GamePilot.exe`,
  arguments: "",
  workingDirectory: previous,
  iconLocation: ",0",
});
const snapshot = (): LaunchPointerSnapshot => ({
  allowedShortcutPaths: [desktop, taskbar],
  shortcuts: [shortcut(desktop), shortcut(taskbar)],
  run: `"${previous}\\GamePilot.exe" --autostart`,
});
const options = { releaseRoot, releaseDirectory: selected };
const sid = "S-1-5-21-11-22-33-1001";
const oldRun = `"${previous}\\GamePilot.exe" --autostart`;
const selectedRun = `"${targetPath}" --autostart`;
const systemSnapshot = (
  local: string | null = selectedRun,
  system: string | null = oldRun,
) => ({
  allowedShortcutPaths: [],
  shortcuts: [],
  run: local,
  systemRun: { sid, value: system },
});

// Execute the real adapter scripts with only their registry/shortcut I/O replaced.
// No test calls a real registry write, COM shortcut, or application executable.
describe.skipIf(process.platform !== "win32")(
  "Windows registry adapter",
  () => {
    function registryHarness(overrides: Record<string, unknown> = {}) {
      let state = {
        local: selectedRun as string | null,
        system: oldRun as string | null,
        systemReadCode: 0,
        systemWriteCode: 0,
        localReadError: false,
        sharedView: false,
        ignoreSystemWrite: false,
        raceBeforeWrite: false,
        systemReads: 0,
        localWrites: 0,
        systemWrites: 0,
        ...overrides,
      };
      const execute = async (script: string, input: unknown) => {
        const encoded = Buffer.from(JSON.stringify({ state, input })).toString(
          "base64",
        );
        const code = `
$ErrorActionPreference = 'Stop'
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$script:registry = $fixture.state
$inputData = $fixture.input
function New-Object {
  param($ComObject)
  if ($ComObject -cne 'WScript.Shell') { throw 'Unexpected COM access' }
  return $null
}
function Test-Path { param($LiteralPath, $PathType) return $false }
function Get-ItemProperty {
  param($LiteralPath, $Name)
  if ($script:registry.localReadError) { throw 'Local registry access denied' }
  if ($LiteralPath -cne 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run') { throw 'Unexpected registry key' }
  return [pscustomobject]@{ GamePilot=$script:registry.local }
}
function Set-ItemProperty {
  param($LiteralPath, $Name, $Value)
  if ($LiteralPath -cne 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -or $Name -cne 'GamePilot') { throw 'Unexpected registry write' }
  if ($null -eq $script:registry.local) { throw 'Must not create local startup' }
  $script:registry.localWrites++
  $script:registry.local = $Value
  if ($script:registry.sharedView) { $script:registry.system = $Value }
}
function Invoke-CimMethod {
  param($Namespace, $ClassName, $MethodName, $Arguments)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($Namespace -cne 'root/default' -or $ClassName -cne 'StdRegProv' -or $Arguments.hDefKey -ne 2147483651 -or $Arguments.sSubKeyName -cne ($sid+'\\Software\\Microsoft\\Windows\\CurrentVersion\\Run') -or $Arguments.sValueName -cne 'GamePilot') { throw 'Unexpected system registry access' }
  if ($MethodName -ceq 'GetStringValue') {
    $script:registry.systemReads++
    if ($script:registry.raceBeforeWrite -and $script:registry.systemReads -ge 3) { $script:registry.system = $null }
    $status = $script:registry.systemReadCode
    if ($status -eq 0 -and $null -eq $script:registry.system) { $status = 2 }
    return [pscustomobject]@{ ReturnValue=$status; sValue=$script:registry.system }
  }
  if ($MethodName -ceq 'SetStringValue') {
    if ($null -eq $script:registry.system) { throw 'Must not create system startup' }
    $script:registry.systemWrites++
    if ($script:registry.systemWriteCode -eq 0 -and !$script:registry.ignoreSystemWrite) {
      $script:registry.system = $Arguments.sValue
      if ($script:registry.sharedView) { $script:registry.local = $Arguments.sValue }
    }
    return [pscustomobject]@{ ReturnValue=$script:registry.systemWriteCode }
  }
  throw 'Unexpected registry method'
}
$result = & {
${script}
} | ConvertFrom-Json
[pscustomobject]@{ result=$result; state=$script:registry } | ConvertTo-Json -Depth 10 -Compress
`;
        let output: string;
        try {
          output = execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(code, "utf16le").toString("base64"),
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              timeout: 15000,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
        } catch (error) {
          throw Error(String((error as { stderr?: unknown }).stderr ?? error));
        }
        const parsed = JSON.parse(output.replace(/^\uFEFF/, ""));
        state = parsed.state;
        return parsed.result;
      };
      return { ports: windowsPorts(execute), state: () => state };
    }

    it("reads the actual system command alongside the local registry view", async () => {
      const harness = registryHarness();
      const actual = await harness.ports.read(options);
      expect(actual).toMatchObject({
        run: selectedRun,
        systemRun: { value: oldRun },
      });
      expect(actual.systemRun?.sid).toMatch(/^S-1-/);
    });

    it.each([5, 13, null])(
      "does not treat failed system read status %s as absent",
      async (code) => {
        const harness = registryHarness({ systemReadCode: code });
        await expect(harness.ports.read(options)).rejects.toThrow(
          /system.*Run|Run.*system/i,
        );
      },
      // Includes a real Windows PowerShell process; match the fixture deadline.
      15_000,
    );

    it("does not swallow local registry access errors", async () => {
      const harness = registryHarness({ localReadError: true });
      await expect(harness.ports.read(options)).rejects.toThrow(/denied/i);
    });

    it("reports a missing startup without creating it", async () => {
      const harness = registryHarness({ local: null, system: null });
      const actual = await harness.ports.read(options);
      expect(actual).toMatchObject({ run: null, systemRun: { value: null } });
      expect(planLaunchPointerUpdates(options, actual).run).toBeUndefined();
    });

    it.each([false, true])(
      "updates existing values with sharedView=%s",
      async (sharedView) => {
        const harness = registryHarness({ local: oldRun, sharedView });
        const plan = planLaunchPointerUpdates(
          options,
          await harness.ports.read(options),
        );
        await harness.ports.apply(plan);
        expect(await harness.ports.read(options)).toMatchObject({
          run: selectedRun,
          systemRun: { value: selectedRun },
        });
        expect(harness.state().systemWrites).toBe(sharedView ? 0 : 1);
        expect(harness.state().localWrites).toBe(1);
      },
      // Three real PowerShell launches can exceed 5s under the full-suite load.
      15_000,
    );

    it("updates a stale system value even when the local view is already current", async () => {
      const harness = registryHarness();
      const plan = planLaunchPointerUpdates(
        options,
        await harness.ports.read(options),
      );
      await harness.ports.apply(plan);
      expect(harness.state()).toMatchObject({
        system: selectedRun,
        localWrites: 0,
        systemWrites: 1,
      });
    });

    it("rechecks the system value immediately before writing", async () => {
      const harness = registryHarness({ raceBeforeWrite: true });
      const plan = planLaunchPointerUpdates(
        options,
        await harness.ports.read(options),
      );
      await expect(harness.ports.apply(plan)).rejects.toThrow(/Run.*changed/i);
    });

    it("rejects a system write error instead of reporting success", async () => {
      const harness = registryHarness({ systemWriteCode: 5 });
      const plan = planLaunchPointerUpdates(
        options,
        await harness.ports.read(options),
      );
      await expect(harness.ports.apply(plan)).rejects.toThrow(
        /system.*Run|Run.*system/i,
      );
    });

    it("independently reads back the system value after an apparently successful write", async () => {
      const harness = registryHarness({ ignoreSystemWrite: true });
      const plan = planLaunchPointerUpdates(
        options,
        await harness.ports.read(options),
      );
      await expect(harness.ports.apply(plan)).rejects.toThrow(/Run.*readback/i);
    });
  },
);

describe("release launch pointer matching", () => {
  it("migrates the exact existing taskbar Electron alias and desktop GamePilot links", () => {
    const result = planLaunchPointerUpdates(options, snapshot());
    expect(result.shortcuts).toHaveLength(2);
    expect(result.shortcuts[1]).toEqual({
      before: shortcut(taskbar),
      after: { ...shortcut(taskbar), targetPath, workingDirectory: selected },
    });
    expect(result.run).toEqual({
      before: snapshot().run,
      after: `"${targetPath}" --autostart`,
    });
  });

  it("keeps all arguments and custom working directory/icon untouched", () => {
    const before = shortcut();
    before.arguments = "--autostart --minimized";
    before.workingDirectory = "D:\\custom workspace";
    before.iconLocation = "D:\\shared\\custom.ico,4";
    const result = planLaunchPointerUpdates(options, {
      ...snapshot(),
      shortcuts: [before],
    });
    expect(result.shortcuts[0].after).toEqual({ ...before, targetPath });
  });

  it("refreshes a versioned icon pointer while preserving the icon index", () => {
    const before = shortcut();
    before.iconLocation = `${before.targetPath},3`;
    expect(
      planLaunchPointerUpdates(options, { ...snapshot(), shortcuts: [before] })
        .shortcuts[0].after.iconLocation,
    ).toBe(`${targetPath},3`);
  });

  it("matches Windows case and slash forms without broad executable-name matching", () => {
    const before = shortcut();
    before.targetPath = `${previous.toUpperCase().replaceAll("\\", "/")}/GAMEPILOT.EXE`;
    before.workingDirectory = previous.toUpperCase();
    expect(
      planLaunchPointerUpdates(options, { ...snapshot(), shortcuts: [before] })
        .shortcuts[0].after,
    ).toMatchObject({ targetPath, workingDirectory: selected });
  });

  it.each([
    "another-electron",
    "outside-release-root",
    "non-release-folder",
    "other-executable",
    "newer-release",
    "same-release",
    "traversal-release",
    "not-allowlisted",
  ])("does not update %s or broaden the original shortcut set", (variant) => {
    const before = shortcut();
    if (variant === "another-electron")
      before.targetPath = "D:\\other-app\\Electron.exe";
    if (variant === "outside-release-root")
      before.targetPath =
        "C:\\other\\release\\GamePilot-0.14.47\\GamePilot.exe";
    if (variant === "non-release-folder")
      before.targetPath = `${releaseRoot}\\backup\\GamePilot.exe`;
    if (variant === "other-executable")
      before.targetPath = `${previous}\\Electron.exe`;
    if (variant === "newer-release")
      before.targetPath = `${releaseRoot}\\GamePilot-0.16.0\\GamePilot.exe`;
    if (variant === "same-release") before.targetPath = targetPath;
    if (variant === "traversal-release")
      before.targetPath = `${previous}\\..\\..\\outside\\GamePilot.exe`;
    if (variant === "not-allowlisted") before.path = unrelated;
    expect(
      planLaunchPointerUpdates(options, {
        ...snapshot(),
        shortcuts: [before],
        run: undefined,
      }).shortcuts,
    ).toEqual([]);
  });

  it("does not create missing shortcuts or enable a missing Windows Run value", () => {
    const result = planLaunchPointerUpdates(options, {
      allowedShortcutPaths: [desktop, taskbar],
      shortcuts: [],
    });
    expect(result.shortcuts).toEqual([]);
    expect(result.run).toBeUndefined();
  });

  it.each([
    "D:\\other\\GamePilot-0.15.2",
    `${releaseRoot}\\GamePilot-0.15.2\\nested`,
    `${releaseRoot}\\not-a-release`,
  ])("rejects an unscoped selected release %s", (releaseDirectory) => {
    expect(() =>
      planLaunchPointerUpdates({ ...options, releaseDirectory }, snapshot()),
    ).toThrow(/release/i);
  });

  it.each([
    `"C:\\Other App\\Electron.exe" --autostart`,
    `cmd.exe /c "${previous}\\GamePilot.exe"`,
    `"${previous}\\GamePilot.exe" & calc.exe`,
    `"${releaseRoot}\\GamePilot-0.16.0\\GamePilot.exe" --autostart`,
  ])("preserves an unrelated/ambiguous/newer Run command: %s", (run) => {
    expect(
      planLaunchPointerUpdates(options, { ...snapshot(), run }).run,
    ).toBeUndefined();
  });
});

describe("Windows Run reconciliation across registry views", () => {
  it("detects an old system startup command when local readback already has the release", () => {
    expect(planLaunchPointerUpdates(options, systemSnapshot()).run).toEqual({
      before: oldRun,
      after: selectedRun,
      localBefore: selectedRun,
      sid,
    });
  });

  it("also reconciles an old local view when the system command is current", () => {
    expect(
      planLaunchPointerUpdates(options, systemSnapshot(oldRun, selectedRun))
        .run,
    ).toMatchObject({
      before: selectedRun,
      after: selectedRun,
      localBefore: oldRun,
      sid,
    });
  });

  it("does not create a Run value missing from both registry views", () => {
    expect(
      planLaunchPointerUpdates(options, systemSnapshot(null, null)).run,
    ).toBeUndefined();
  });

  it.each([
    [null, oldRun],
    [oldRun, null],
    [selectedRun, `"C:\\Other App\\Electron.exe" --autostart`],
    [oldRun, `"${releaseRoot}\\GamePilot-0.16.0\\GamePilot.exe" --autostart`],
    [oldRun, `"${previous}\\GamePilot.exe" --different-flag`],
  ])("rejects an unsafe registry view mismatch (%s / %s)", (local, system) => {
    expect(() =>
      planLaunchPointerUpdates(options, systemSnapshot(local, system)),
    ).toThrow(/Run.*view|view.*Run/i);
  });

  it("rejects incomplete system evidence instead of treating a read failure as absence", () => {
    expect(() =>
      planLaunchPointerUpdates(options, {
        ...systemSnapshot(),
        // @ts-expect-error Simulate an incomplete external inventory response.
        systemRun: { sid, value: undefined },
      }),
    ).toThrow(/system.*Run|Run.*system/i);
  });

  it.each(["local-only", "system-only", "system-read-missing"])(
    "does not claim success after %s readback",
    async (variant) => {
      const before = systemSnapshot(oldRun, oldRun);
      const after = systemSnapshot(selectedRun, selectedRun);
      if (variant === "local-only") after.systemRun.value = oldRun;
      if (variant === "system-only") after.run = oldRun;
      if (variant === "system-read-missing")
        Reflect.deleteProperty(after, "systemRun");
      const ports = {
        validateRelease: vi.fn(async () => {}),
        read: vi
          .fn()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
        apply: vi.fn(async () => {}),
      };
      await expect(
        refreshLaunchPointers({ ...options, apply: true }, ports),
      ).rejects.toThrow(/Run.*readback/i);
    },
  );

  it("rejects a changed system command before any writes", async () => {
    const ports = {
      validateRelease: vi.fn(async () => {}),
      read: vi
        .fn()
        .mockResolvedValueOnce(systemSnapshot())
        .mockResolvedValueOnce(systemSnapshot(selectedRun, null)),
      apply: vi.fn(async () => {}),
    };
    await expect(
      refreshLaunchPointers({ ...options, apply: true }, ports),
    ).rejects.toThrow(/Run.*changed|race/i);
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it("counts a dual-view Run migration once and verifies both results", async () => {
    const ports = {
      validateRelease: vi.fn(async () => {}),
      read: vi
        .fn()
        .mockResolvedValueOnce(systemSnapshot())
        .mockResolvedValueOnce(systemSnapshot())
        .mockResolvedValueOnce(systemSnapshot(selectedRun, selectedRun)),
      apply: vi.fn(async () => {}),
    };
    await expect(
      refreshLaunchPointers({ ...options, apply: true }, ports),
    ).resolves.toMatchObject({ staleCount: 1, updatedCount: 1 });
    expect(ports.apply).toHaveBeenCalledOnce();
  });
});

describe("launch pointer refresh stays opt-in and checks for races", () => {
  function fakePorts() {
    let current = snapshot();
    return {
      validateRelease: vi.fn(async () => {}),
      read: vi.fn(async () => structuredClone(current)),
      apply: vi.fn(async (plan) => {
        current.shortcuts = current.shortcuts.map(
          (before) =>
            plan.shortcuts.find((item: any) => item.before.path === before.path)
              ?.after ?? before,
        );
        if (plan.run) current.run = plan.run.after;
      }),
    };
  }

  it("defaults to read-only reporting without printing arguments or launching anything", async () => {
    const ports = fakePorts();
    const result = await refreshLaunchPointers(options, ports);
    expect(ports.validateRelease).toHaveBeenCalledOnce();
    expect(ports.apply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "check",
      staleCount: 3,
      updatedCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain("arguments");
    expect(JSON.stringify(result)).not.toContain("--autostart");
  });

  it("only applies the specific planned pointers and verifies the resulting reads", async () => {
    const ports = fakePorts();
    const result = await refreshLaunchPointers(
      { ...options, apply: true },
      ports,
    );
    expect(ports.apply).toHaveBeenCalledOnce();
    expect(ports.read).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      mode: "apply",
      staleCount: 3,
      updatedCount: 3,
    });
    expect(result.entries.every((entry) => entry.status === "updated")).toBe(
      true,
    );
  });

  it("rejects a shortcut changed after review rather than overwriting it", async () => {
    const ports = fakePorts();
    const changed = snapshot();
    changed.shortcuts[1].targetPath = "D:\\other-app\\Electron.exe";
    ports.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(changed);
    await expect(
      refreshLaunchPointers({ ...options, apply: true }, ports),
    ).rejects.toThrow(/changed|race/i);
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it("reports failed readback rather than saying release pointers were updated", async () => {
    const ports = fakePorts();
    ports.apply.mockImplementationOnce(async () => {});
    await expect(
      refreshLaunchPointers({ ...options, apply: true }, ports),
    ).rejects.toThrow(/readback|verify/i);
  });

  it("does not read or apply any pointers if selected-release verification fails", async () => {
    const ports = fakePorts();
    ports.validateRelease.mockRejectedValueOnce(
      Error("release manifest does not match"),
    );
    await expect(
      refreshLaunchPointers({ ...options, apply: true }, ports),
    ).rejects.toThrow(/manifest/);
    expect(ports.read).not.toHaveBeenCalled();
    expect(ports.apply).not.toHaveBeenCalled();
  });
});
