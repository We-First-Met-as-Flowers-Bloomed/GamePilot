import { win32, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const equalPath = (a, b) =>
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
const safePath = (value) =>
  typeof value === "string" &&
  win32.isAbsolute(value) &&
  !value.split(/[\\/]/).includes("..");
function releaseVersion(directory, root) {
  if (!safePath(directory) || !equalPath(win32.dirname(directory), root))
    return;
  const match = /^GamePilot-(\d+)\.(\d+)\.(\d+)$/i.exec(
    win32.basename(directory),
  );
  if (match) return match.slice(1).map(Number);
}
function selectedRelease(options) {
  if (!safePath(options.releaseRoot)) throw Error("Invalid release root");
  const version = releaseVersion(options.releaseDirectory, options.releaseRoot);
  if (!version)
    throw Error(
      "Selected release must be a direct versioned child of release root",
    );
  return {
    version,
    targetPath: win32.join(options.releaseDirectory, "GamePilot.exe"),
  };
}
function olderExecutable(path, root, selected) {
  if (!safePath(path) || win32.basename(path).toLowerCase() !== "gamepilot.exe")
    return false;
  const version = releaseVersion(win32.dirname(path), root);
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== selected[i]) return version[i] < selected[i];
  }
  return false;
}

export function planLaunchPointerUpdates(options, snapshot) {
  const { version, targetPath } = selectedRelease(options);
  const plan = {
    releaseRoot: options.releaseRoot,
    releaseDirectory: options.releaseDirectory,
    targetPath,
    shortcuts: [],
  };
  const allowed = new Set(
    snapshot.allowedShortcutPaths
      .filter(safePath)
      .map((path) => win32.normalize(path).toLowerCase()),
  );
  const visited = new Set();
  for (const before of snapshot.shortcuts) {
    const key = win32.normalize(before.path).toLowerCase();
    if (visited.has(key))
      throw Error("Duplicate shortcut in launch pointer inventory");
    visited.add(key);
    if (
      !allowed.has(key) ||
      !olderExecutable(before.targetPath, options.releaseRoot, version)
    )
      continue;
    const after = { ...before, targetPath };
    if (equalPath(before.workingDirectory, win32.dirname(before.targetPath)))
      after.workingDirectory = options.releaseDirectory;
    const icon = /^(.*),(-?\d+)$/.exec(before.iconLocation);
    if (icon && equalPath(icon[1], before.targetPath))
      after.iconLocation = `${targetPath},${icon[2]}`;
    plan.shortcuts.push({ before: { ...before }, after });
  }
  // Windows Run is an executable command line, never a shell program. Only simple flags are migrated.
  const replacement = (value, allowCurrent = false) => {
    const run =
      typeof value === "string" &&
      /^"([^"\r\n]+)"((?:\s+--?[A-Za-z0-9][A-Za-z0-9_-]*)*)\s*$/.exec(value);
    if (
      run &&
      (olderExecutable(run[1], options.releaseRoot, version) ||
        (allowCurrent && equalPath(run[1], targetPath)))
    )
      return `"${targetPath}"${run[2]}`;
  };
  if (Object.hasOwn(snapshot, "systemRun")) {
    const system = snapshot.systemRun;
    if (
      !system ||
      typeof system.sid !== "string" ||
      !/^S-\d+(?:-\d+)+$/.test(system.sid) ||
      (system.value !== null && typeof system.value !== "string") ||
      (snapshot.run !== null && typeof snapshot.run !== "string")
    )
      throw Error("Invalid system Windows Run evidence");
    const localAfter = replacement(snapshot.run, true);
    const systemAfter = replacement(system.value, true);
    if (
      snapshot.run !== system.value &&
      (!localAfter || !systemAfter || localAfter !== systemAfter)
    )
      throw Error(
        "Windows Run registry views disagree outside a safe migration",
      );
    if (
      systemAfter &&
      (snapshot.run !== systemAfter || system.value !== systemAfter)
    )
      plan.run = {
        before: system.value,
        after: systemAfter,
        localBefore: snapshot.run,
        sid: system.sid,
      };
  } else {
    const after = replacement(snapshot.run);
    if (after) plan.run = { before: snapshot.run, after };
  }
  return plan;
}

const shortcutFields = [
  "path",
  "targetPath",
  "arguments",
  "workingDirectory",
  "iconLocation",
];
function sameShortcut(actual, expected) {
  return actual && shortcutFields.every((key) => actual[key] === expected[key]);
}
function verifyPointers(plan, snapshot, side) {
  for (const change of plan.shortcuts) {
    const expected = change[side];
    const actual = snapshot.shortcuts.find((item) =>
      equalPath(item.path, expected.path),
    );
    if (
      !sameShortcut(actual, expected) ||
      !snapshot.allowedShortcutPaths.some((path) =>
        equalPath(path, expected.path),
      )
    )
      throw Error(
        side === "before"
          ? "Launch pointer changed after review (race)"
          : "Launch pointer readback verification failed",
      );
  }
  if (
    plan.run &&
    (snapshot.run !==
      (side === "before" && plan.run.sid
        ? plan.run.localBefore
        : plan.run[side]) ||
      (plan.run.sid &&
        (snapshot.systemRun?.sid !== plan.run.sid ||
          snapshot.systemRun.value !== plan.run[side])))
  )
    throw Error(
      side === "before"
        ? "Windows Run value changed after review (race)"
        : "Windows Run readback verification failed",
    );
}

export async function refreshLaunchPointers(options, ports = windowsPorts()) {
  selectedRelease(options);
  await ports.validateRelease(options);
  const plan = planLaunchPointerUpdates(options, await ports.read(options));
  const count = plan.shortcuts.length + (plan.run ? 1 : 0);
  if (options.apply && count) {
    verifyPointers(plan, await ports.read(options), "before");
    await ports.apply(plan);
    verifyPointers(plan, await ports.read(options), "after");
  }
  const status = options.apply ? "updated" : "stale";
  return {
    mode: options.apply ? "apply" : "check",
    staleCount: count,
    updatedCount: options.apply ? count : 0,
    entries: plan.shortcuts.map(({ before, after }) => ({
      path: before.path,
      targetPath: before.targetPath,
      newTargetPath: after.targetPath,
      status,
    })),
    ...(plan.run ? { run: { status } } : {}),
  };
}

function powershell(script, input) {
  if (process.platform !== "win32")
    throw Error("Launch pointer inventory requires Windows");
  return new Promise((resolveResult, reject) => {
    const code =
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json;\n" +
      script;
    const child = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(code, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error)
          return reject(
            Error(
              "Windows launch pointer operation failed; no successful refresh is claimed",
            ),
          );
        try {
          resolveResult(JSON.parse(stdout.replace(/^\uFEFF/, "")));
        } catch {
          reject(Error("Invalid launch pointer inventory response"));
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export function windowsPorts(execute = powershell) {
  // StdRegProv runs in the Windows service context. A same-process HKCU readback
  // alone can observe a different view from the one used by Explorer at logon.
  const registryFunctions = `
$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$runSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runArguments = @{ hDefKey=[uint32]2147483651; sSubKeyName=($runSid+'\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'); sValueName='GamePilot' }
function Get-LocalRun {
  try { $value = (Get-ItemProperty -LiteralPath $runKey -ErrorAction Stop).GamePilot }
  catch [System.Management.Automation.ItemNotFoundException] { return $null }
  if ($null -ne $value -and $value -isnot [string]) { throw 'Invalid local Windows Run value' }
  return $value
}
function Get-SystemRun {
  $result = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName GetStringValue -Arguments $runArguments -ErrorAction Stop
  if ($null -ne $result.ReturnValue -and $result.ReturnValue -eq 2) { return $null }
  if ($null -eq $result.ReturnValue -or $result.ReturnValue -ne 0 -or $result.sValue -isnot [string]) { throw 'System Windows Run read failed' }
  return $result.sValue
}
function Assert-RunBefore {
  if ($inputData.run.sid -cne $runSid -or $inputData.run.before -isnot [string] -or $inputData.run.localBefore -isnot [string]) { throw 'System Windows Run identity missing or changed' }
  if ((Get-LocalRun) -cne $inputData.run.localBefore -or (Get-SystemRun) -cne $inputData.run.before) { throw 'Windows Run value changed' }
}
`;
  return {
    async validateRelease(options) {
      const manifest = JSON.parse(
        await readFile(
          win32.join(options.releaseDirectory, "package-manifest.json"),
          "utf8",
        ),
      );
      if (
        `GamePilot-${manifest.version}`.toLowerCase() !==
        win32.basename(options.releaseDirectory).toLowerCase()
      )
        throw Error("Selected release manifest version mismatch");
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL("../package-portable.mjs", import.meta.url)),
          "--verify",
          options.releaseDirectory,
        ],
        { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 },
      );
    },
    async read(options) {
      const snapshot = await execute(
        registryFunctions +
          `
$shell = New-Object -ComObject WScript.Shell
$directories = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup')) + @($inputData.desktopDirectories)
$shortcuts = @(); $allowed = @()
foreach ($directory in @($directories | Where-Object { $_ } | Select-Object -Unique)) {
  if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }
  foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter '*.lnk' -File)) {
    $link = $shell.CreateShortcut($file.FullName)
    $allowed += $file.FullName
    $shortcuts += [pscustomobject]@{ path=$file.FullName; targetPath=$link.TargetPath; arguments=$link.Arguments; workingDirectory=$link.WorkingDirectory; iconLocation=$link.IconLocation }
  }
}
$run = Get-LocalRun
$systemRun = [pscustomobject]@{ sid=$runSid; value=(Get-SystemRun) }
[pscustomobject]@{ allowedShortcutPaths=@($allowed); shortcuts=@($shortcuts); run=$run; systemRun=$systemRun } | ConvertTo-Json -Depth 5 -Compress
`,
        options,
      );
      if (!snapshot || !Object.hasOwn(snapshot, "systemRun"))
        throw Error("System Windows Run inventory missing");
      return snapshot;
    },
    async apply(plan) {
      await execute(
        registryFunctions +
          `
$shell = New-Object -ComObject WScript.Shell
$fields = @('TargetPath','Arguments','WorkingDirectory','IconLocation')
# Recheck every reviewed pointer before writing any. Missing links are never recreated.
foreach ($change in @($inputData.shortcuts)) {
  if (!(Test-Path -LiteralPath $change.before.path -PathType Leaf)) { throw 'Shortcut changed' }
  $link = $shell.CreateShortcut($change.before.path)
  foreach ($field in $fields) { if ($link.$field -cne $change.before.$field) { throw 'Shortcut changed' } }
}
if ($inputData.run) { Assert-RunBefore }
foreach ($change in @($inputData.shortcuts)) {
  $link = $shell.CreateShortcut($change.before.path)
  foreach ($field in $fields) { if ($link.$field -cne $change.before.$field) { throw 'Shortcut changed' } }
  $link.TargetPath = $change.after.targetPath
  $link.WorkingDirectory = $change.after.workingDirectory
  $link.IconLocation = $change.after.iconLocation
  $link.Save()
}
if ($inputData.run) {
  Assert-RunBefore
  if ($inputData.run.localBefore -cne $inputData.run.after) {
    Set-ItemProperty -LiteralPath $runKey -Name 'GamePilot' -Value $inputData.run.after -ErrorAction Stop
  }
  # The local write may already have reached the system view. Never recreate a
  # deleted value, or overwrite an unreviewed command observed before this write.
  $current = Get-SystemRun
  if ($current -cne $inputData.run.before -and $current -cne $inputData.run.after) { throw 'Windows Run value changed' }
  if ($current -cne $inputData.run.after) {
    $writeArguments = $runArguments.Clone()
    $writeArguments.sValue = $inputData.run.after
    $written = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName SetStringValue -Arguments $writeArguments -ErrorAction Stop
    if ($null -eq $written.ReturnValue -or $written.ReturnValue -ne 0) { throw 'System Windows Run write failed' }
  }
  if ((Get-SystemRun) -cne $inputData.run.after -or (Get-LocalRun) -cne $inputData.run.after) { throw 'Windows Run readback verification failed' }
}
'{"ok":true}'
`,
        plan,
      );
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = { desktopDirectories: [] };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") options.apply = true;
    else if (args[i] === "--release-root" && args[i + 1])
      options.releaseRoot = args[++i];
    else if (args[i] === "--release-directory" && args[i + 1])
      options.releaseDirectory = args[++i];
    else if (args[i] === "--desktop-directory" && args[i + 1])
      options.desktopDirectories.push(args[++i]);
    else
      throw Error(
        "Usage: --release-root <root> --release-directory <versioned directory> [--desktop-directory <path>] [--apply]",
      );
  }
  console.log(JSON.stringify(await refreshLaunchPointers(options), null, 2));
}
