import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import { expect, it } from "vitest";

// Exercise the actual installer in a disposable PowerShell process. These cmdlets
// capture its registration instead of loading TaskScheduler or changing Windows.
const driver = `
param([string]$InstallPath, [string]$AuditRoot)
$ErrorActionPreference = 'Stop'
function Get-ScheduledTask { param([string]$TaskName, [string]$ErrorAction) }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger { param([switch]$Daily,[switch]$Once,[datetime]$At) [pscustomobject]@{Daily=[bool]$Daily;Once=[bool]$Once;StartBoundary=$At.ToString('s');EndBoundary=$null} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,$MultipleInstances,$ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$DeleteExpiredTaskAfter) [pscustomobject]@{StartWhenAvailable=[bool]$StartWhenAvailable;MultipleInstances=$MultipleInstances;ExecutionTimeLimit=$ExecutionTimeLimit.ToString();DeleteExpiredTaskAfter=$DeleteExpiredTaskAfter.ToString()} }
function New-ScheduledTask { param($Action,$Trigger,$Principal,$Settings,$Description) [pscustomobject]@{Action=$Action;Triggers=@($Trigger);Principal=$Principal;Settings=$Settings;Description=$Description} }
function Register-ScheduledTask { param($TaskName,$InputObject) $global:Captured=[pscustomobject]@{TaskName=$TaskName;Task=$InputObject}; [pscustomobject]@{TaskName=$TaskName;State='Ready'} }
& $InstallPath -Out $AuditRoot | Out-Null
$global:Captured | ConvertTo-Json -Depth 10 -Compress
`;

it.skipIf(process.platform !== "win32")(
  "collects the final evening after the seven-day window without changing either daily trigger",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gp-acceptance-install-"));
    try {
      const out = join(root, "reports");
      await mkdir(out);
      await writeFile(
        join(out, "baseline.json"),
        JSON.stringify({
          start: "2026-10-04",
          end: "2026-10-10",
          data: join(root, "data"),
        }),
      );
      await writeFile(join(out, "audit.cjs"), "// capture-only fixture");
      const file = join(root, "capture.ps1");
      await writeFile(file, driver);
      const { stdout, stderr } = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          file,
          "-InstallPath",
          resolve("scripts/acceptance/install-task.ps1"),
          "-AuditRoot",
          out,
        ],
        { windowsHide: true },
      );
      expect(stderr).toBe("");
      const capture = JSON.parse(stdout.trim());
      expect(capture.TaskName).toBe("GamePilot-Acceptance-20261004");
      expect(capture.Task.Triggers.slice(0, 2)).toEqual([
        {
          Daily: true,
          Once: false,
          StartBoundary: "2026-10-04T02:00:00",
          EndBoundary: "2026-10-10T23:59:59",
        },
        {
          Daily: true,
          Once: false,
          StartBoundary: "2026-10-04T11:00:00",
          EndBoundary: "2026-10-10T23:59:59",
        },
      ]);
      expect(capture.Task.Triggers).toHaveLength(3);
      expect(capture.Task.Triggers[2]).toEqual({
        Daily: false,
        Once: true,
        StartBoundary: "2026-10-11T02:00:00",
        EndBoundary: "2026-10-11T23:59:59",
      });
      expect(capture.Task.Settings.StartWhenAvailable).toBe(true);
      expect(capture.Task.Settings.MultipleInstances).toBe("IgnoreNew");
      expect(capture.Task.Action.Arguments).toContain("invoke-audit.ps1");
      expect(capture.Task.Action.Arguments).not.toContain("--init");
      expect(capture.Task.Action.Arguments).not.toContain("GamePilot.exe");
    } finally {
      const rel = relative(tmpdir(), root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw Error("unsafe cleanup");
      await rm(root, { recursive: true, force: true });
    }
  },
);
