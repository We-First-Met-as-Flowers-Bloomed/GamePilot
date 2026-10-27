import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  new URL("../scripts/daily-arknights.ps1", import.meta.url),
  "utf8",
);

describe("legacy daily script safety", () => {
  it("never closes or kills all MAA processes by process name", () => {
    expect(/Get-Process\s+MAA\b/.test(script)).toBe(false);
  });

  it("does not tap fixed coordinates without fresh screen confirmation", () => {
    expect(/input tap \d+ \d+/.test(script)).toBe(false);
  });

  it("does not use accumulated daily completions as the launched round terminal", () => {
    expect(/\$completedToday\s*-ge\s*\$expectTasks/.test(script)).toBe(false);
    expect(/\$finished\s*=\s*\$completedToday/.test(script)).toBe(false);
  });

  it("never automatically retries a possibly unfinished external run", () => {
    expect(/&\s*'powershell\.exe'\s+@childArgs/.test(script)).toBe(false);
  });
});

function helper(body: string) {
  const module = fileURLToPath(
    new URL("../scripts/shared/daily-arknights.psm1", import.meta.url),
  ).replaceAll("'", "''");
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; if (-not (Test-Path -LiteralPath '${module}')) { '{"available":false}'; exit 0 }; Import-Module '${module}' -Force -DisableNameChecking; ${body}`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
}

describe("daily round evidence and process identity", () => {
  it("ignores yesterday and earlier same-day completions when the new round is empty", () => {
    expect(
      helper(
        `$baseline = "完成任务: 开始唤醒\n完成任务: 理智作战\n任务已全部完成！\n"; Get-DailyRoundProgress $baseline $baseline | ConvertTo-Json -Compress`,
      ),
    ).toMatchObject({
      Completed: 0,
      Failed: 0,
      Terminal: false,
      Unknown: false,
    });
  });

  it("counts each top task once and treats errors as unsuccessful terminals", () => {
    expect(
      helper(
        `$current = "完成任务: 开始唤醒\n完成任务: 开始唤醒\n完成任务: 访问好友\n任务出错: 理智作战\n任务已全部完成！\n"; Get-DailyRoundProgress '' $current | ConvertTo-Json -Compress`,
      ),
    ).toMatchObject({
      Completed: 1,
      Failed: 1,
      Terminal: true,
      Succeeded: false,
    });
  });

  it("log truncation cannot prove this round finished", () => {
    expect(
      helper(
        `Get-DailyRoundProgress 'old-prefix' '任务已全部完成！' | ConvertTo-Json -Compress`,
      ),
    ).toMatchObject({ Unknown: true, Terminal: false });
  });

  it("requires PID, executable path and start time to match before closing", () => {
    expect(
      helper(
        `$owned = [pscustomobject]@{ Id=120; Path='D:\\maa\\MAA.exe'; StartTime=[datetime]'2026-10-23T08:00:00Z' }; $other = [pscustomobject]@{ Id=120; Path='D:\\maa - 副本\\MAA.exe'; StartTime=$owned.StartTime }; $reused = [pscustomobject]@{ Id=120; Path=$owned.Path; StartTime=$owned.StartTime.AddMinutes(1) }; @{ same=(Test-DailyProcessIdentity $owned $owned); other=(Test-DailyProcessIdentity $owned $other); reused=(Test-DailyProcessIdentity $owned $reused); unknown=(Test-DailyProcessIdentity $owned $null) } | ConvertTo-Json -Compress`,
      ),
    ).toEqual({ same: true, other: false, reused: false, unknown: false });
  });

  it("reclaims a closed lock only when its owner PID is definitively absent", () => {
    expect(
      helper(
        `$path = Join-Path $env:TEMP ('gamepilot-lock-' + [guid]::NewGuid().ToString('N')); @{ pid=2147483647; startedAt='2026-10-20T00:00:00Z'; token='old' } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8; try { $lock = Enter-DailyLock $path; @{ acquired=($null -ne $lock) } | ConvertTo-Json -Compress } catch { '{"acquired":false}' } finally { if ($null -ne $lock) { Exit-DailyLock $lock } elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }`,
      ),
    ).toEqual({ acquired: true });
  });

  it("a lock older than 50 minutes with a live PID cannot be reclaimed", () => {
    expect(
      helper(
        `$path = Join-Path $env:TEMP ('gamepilot-lock-' + [guid]::NewGuid().ToString('N')); @{ pid=$PID; startedAt='2026-10-20T00:00:00Z'; token='old' } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8; try { $lock = Enter-DailyLock $path; '{"blocked":false}' } catch { '{"blocked":true}' } finally { if ($null -ne $lock) { Exit-DailyLock $lock } elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }`,
      ),
    ).toEqual({ blocked: true });
  });

  it("an inaccessible managed PID is unknown rather than confirmed exited", () => {
    expect(
      helper(
        `function global:Get-Process { [CmdletBinding()] param($Id) Write-Error -Message 'cannot inspect' -Category PermissionDenied }; try { Get-DailyOwnedProcess ([pscustomobject]@{Id=120;Path='D:\\maa\\MAA.exe';StartTime=[datetime]'2026-10-23T08:00:00Z'}) | Out-Null; '{"blocked":false}' } catch { '{"blocked":true}' }`,
      ),
    ).toEqual({ blocked: true });
  });

  it("a missing process start time cannot establish ownership", () => {
    expect(
      helper(
        `$value=[pscustomobject]@{Id=120;Path='D:\\maa\\MAA.exe'}; @{owned=(Test-DailyProcessIdentity $value $value)} | ConvertTo-Json -Compress`,
      ),
    ).toEqual({ owned: false });
  });
});
