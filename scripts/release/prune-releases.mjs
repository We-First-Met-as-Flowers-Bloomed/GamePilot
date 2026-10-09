import { win32, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

function absolutePath(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]:[\\/]/.test(value) ||
    /[\x00-\x1f<>"|?*]/.test(value) ||
    value.slice(2).includes(":") ||
    value
      .split(/[\\/]/)
      .slice(1)
      .some((part) => part === ".." || part === "." || /[ .]$/.test(part))
  )
    throw Error("Unsafe absolute Windows path");
  return win32.normalize(value).replace(/[\\/]$/, "");
}
const samePath = (a, b) =>
  absolutePath(a).toLowerCase() === absolutePath(b).toLowerCase();
function versionOf(name) {
  if (name === "GamePilot-0.14.45-native-tested") return [0, 14, 45];
  const match =
    /^GamePilot-((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/i.exec(
      name,
    );
  const version = match?.slice(1).map(Number);
  return version?.every(Number.isSafeInteger) ? version : undefined;
}
function validOptions(options) {
  const releaseRoot = absolutePath(options.releaseRoot);
  if (
    win32.basename(releaseRoot).toLowerCase() !== "release" ||
    releaseRoot.length < 11
  )
    throw Error("Release root must be an explicit existing release directory");
  if (options.apply !== undefined && typeof options.apply !== "boolean")
    throw Error("Apply must be explicit");
  const keep = options.keep ?? [];
  if (
    !Array.isArray(keep) ||
    keep.some((name) => typeof name !== "string" || !versionOf(name))
  )
    throw Error("Explicit keep must name known releases");
  return { releaseRoot, keep, apply: options.apply === true };
}
function referenced(name, values) {
  // Also retain a matching release basename reached through an alternate path alias.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(^|[\\\\/\\s"'])${escaped}($|[\\\\/\\s"',])`,
    "i",
  );
  return values.some((value) => pattern.test(value));
}

export function planReleaseRetention(options, inventory) {
  const { releaseRoot, keep } = validOptions(options);
  if (
    !inventory?.root ||
    inventory.root.reparsePoint !== false ||
    !samePath(inventory.root.path, releaseRoot) ||
    !samePath(inventory.root.resolvedPath, releaseRoot)
  )
    throw Error("Unknown, changed or reparse release root");
  if (
    !Array.isArray(inventory.releases) ||
    inventory.references?.complete !== true ||
    !Array.isArray(inventory.references.values) ||
    inventory.references.values.some((value) => typeof value !== "string")
  )
    throw Error("Reference inventory incomplete");
  const seen = new Set();
  const releases = inventory.releases.map((entry) => {
    const path = absolutePath(entry.path);
    const name = win32.basename(path),
      version = versionOf(name);
    if (
      !version ||
      !samePath(win32.dirname(path), releaseRoot) ||
      !samePath(entry.resolvedPath, path) ||
      entry.reparsePoint !== false ||
      entry.treeHasReparsePoint !== false ||
      entry.manifestVersion !== version.join(".") ||
      entry.manifestFilesMatch !== true ||
      !/^[a-f0-9]{64}$/i.test(entry.manifestSha256 ?? "")
    )
      throw Error("Unsafe release directory or nested reparse point");
    if (seen.has(path.toLowerCase()))
      throw Error("Duplicate release directory");
    seen.add(path.toLowerCase());
    return { path, name, version, manifestSha256: entry.manifestSha256 };
  });
  for (const name of keep)
    if (
      !releases.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
    )
      throw Error("Explicit keep release does not exist");
  const ordered = [...releases].sort((a, b) => {
    for (let i = 0; i < 3; i++)
      if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
    return a.name.localeCompare(b.name);
  });
  const latest = new Set(
    [...new Set(ordered.map((entry) => entry.version.join(".")))].slice(0, 2),
  );
  const retained = [],
    candidates = [];
  for (const entry of releases) {
    const reasons = [];
    if (latest.has(entry.version.join("."))) reasons.push("latest-two");
    if (keep.some((name) => name.toLowerCase() === entry.name.toLowerCase()))
      reasons.push("explicit-keep");
    if (referenced(entry.name, inventory.references.values))
      reasons.push("referenced");
    if (reasons.length) retained.push({ path: entry.path, reasons });
    else candidates.push(entry.path);
  }
  return {
    releaseRoot,
    inventoryPaths: releases.map((entry) => entry.path).sort(),
    inventoryHashes: Object.fromEntries(
      releases
        .map((entry) => [entry.path, entry.manifestSha256])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    keep: [...keep],
    retained,
    candidates,
  };
}

export async function pruneReleases(options, ports = windowsRetentionPorts()) {
  const normalized = validOptions(options);
  const plan = planReleaseRetention(normalized, await ports.read(normalized));
  if (!normalized.apply || !plan.candidates.length)
    return { mode: normalized.apply ? "apply" : "preview", plan, deleted: [] };
  const fresh = planReleaseRetention(normalized, await ports.read(normalized));
  if (
    JSON.stringify(fresh.inventoryPaths) !==
      JSON.stringify(plan.inventoryPaths) ||
    JSON.stringify(fresh.inventoryHashes) !==
      JSON.stringify(plan.inventoryHashes) ||
    JSON.stringify(fresh.candidates) !== JSON.stringify(plan.candidates)
  )
    throw Error("Release inventory or references changed; preview again");
  const result = await ports.apply(plan);
  if (
    !result ||
    JSON.stringify(result.deleted) !== JSON.stringify(plan.candidates)
  )
    throw Error("Release deletion verification failed");
  return { mode: "apply", plan, deleted: result.deleted };
}

const windowsFunctions = String.raw`
function Assert-SafeDirectory([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (!$item.PSIsContainer) { throw 'Expected directory' }
  $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).ProviderPath
  if (![string]::Equals($resolved.TrimEnd('\'), $path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved path changed' }
  for ($parent = $item; $null -ne $parent; $parent = $parent.Parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse directory or ancestor' }
  }
  return $resolved
}
function Get-ReleaseDirectory([string]$root, [string]$path) {
  $null = Assert-SafeDirectory $root
  $resolved = Assert-SafeDirectory $path
  if (![string]::Equals([IO.Path]::GetDirectoryName($resolved), $root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release outside root' }
  $name = [IO.Path]::GetFileName($path)
  if ($name -notmatch '^GamePilot-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$' -and $name -cne 'GamePilot-0.14.45-native-tested') { throw 'Unknown release name' }
  $version = $name.Substring(10).Replace('-native-tested','')
  $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($path)
  while ($pending.Count) {
    foreach ($entry in [IO.DirectoryInfo]::new($pending.Pop()).EnumerateFileSystemInfos()) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Nested reparse point' }
      if ($entry.Attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry.FullName) }
      else { $null = $files.Add($entry.FullName.Substring($path.Length + 1).Replace('\','/')) }
    }
  }
  if (!$files.Contains('GamePilot.exe') -or !$files.Contains('package-manifest.json')) { throw 'Release manifest or executable missing' }
  $manifestBytes = [IO.File]::ReadAllBytes((Join-Path $path 'package-manifest.json'))
  $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json -ErrorAction Stop
  if ($manifest.version -cne $version -or $null -eq $manifest.files -or $manifest.files -isnot [pscustomobject]) { throw 'Manifest version or inventory invalid' }
  $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $null = $expected.Add('package-manifest.json')
  foreach ($property in $manifest.files.PSObject.Properties) {
    $relative = $property.Name
    if (!$relative -or [IO.Path]::IsPathRooted($relative) -or $relative -match '[:\\]' -or $relative -match '(^|/)\.\.?(/|$)' -or $relative -match '[ .](/|$)' -or $property.Value -notmatch '^[a-fA-F0-9]{64}$' -or !$expected.Add($relative)) { throw 'Invalid manifest file path or hash' }
  }
  if (!$files.SetEquals($expected)) { throw 'Manifest file inventory differs (extra or missing files)' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($manifestBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  return [pscustomobject]@{ path=$path; resolvedPath=$resolved; reparsePoint=$false; treeHasReparsePoint=$false; manifestVersion=$version; manifestSha256=$hash; manifestFilesMatch=$true }
}
function Get-ReferenceValues {
  $values = [Collections.Generic.List[string]]::new()
  foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
    if ($process.Name -match '^(GamePilot|GamePilot.MaaBridge|electron|node)\.exe$' -and !$process.ExecutablePath -and !$process.CommandLine) {
      if ([string]$process.ProcessId -notmatch '^[1-9][0-9]*$') { throw 'Relevant process reference has no valid PID' }
      $processIdToCheck = [uint32]$process.ProcessId
      $stillPresent = @(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$processIdToCheck) -ErrorAction Stop)
      if ($stillPresent.Count -eq 0) { continue }
      throw ('Relevant process reference unreadable (PID '+$processIdToCheck+')')
    }
    foreach ($value in @($process.ExecutablePath, $process.CommandLine)) { if ($value) { $values.Add($value) } }
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $keys = @('Software\Microsoft\Windows\CurrentVersion\Run', 'Software\Microsoft\Windows\CurrentVersion\RunOnce', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')
  foreach ($hive in @('HKCU','HKLM')) { foreach ($key in $keys) {
    try { $local = Get-Item -LiteralPath ($hive+':\'+$key) -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { $local = $null }
    if ($null -ne $local) { foreach ($name in $local.GetValueNames()) {
      $value = $local.GetValue($name)
      if ($value -is [string]) { $values.Add([Environment]::ExpandEnvironmentVariables($value)) }
      elseif ($name -match 'GamePilot') { throw 'Run reference is not a string' }
    } }
    $arguments = @{hDefKey=[uint32]2147483650; sSubKeyName=$key}
    if ($hive -eq 'HKCU') { $arguments.hDefKey=[uint32]2147483651; $arguments.sSubKeyName=$sid+'\'+$key }
    $names = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName EnumValues -Arguments $arguments -ErrorAction Stop
    if ($names.ReturnValue -eq 2) { continue }
    if ($null -eq $names.ReturnValue -or $names.ReturnValue -ne 0) { throw 'System Run reference enumeration failed' }
    if ($null -eq $names.sNames) { continue }
    if (@($names.sNames).Count -ne @($names.Types).Count) { throw 'System Run reference enumeration incomplete' }
    for ($i=0; $i -lt @($names.sNames).Count; $i++) {
      if ($names.Types[$i] -notin @(1,2)) { if ($names.sNames[$i] -match 'GamePilot') { throw 'System Run type invalid' }; continue }
      $read = $arguments.Clone(); $read.sValueName=$names.sNames[$i]
      $method = 'GetStringValue'; if ($names.Types[$i] -eq 2) { $method='GetExpandedStringValue' }
      $value = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $method -Arguments $read -ErrorAction Stop
      if ($null -eq $value.ReturnValue -or $value.ReturnValue -ne 0 -or $value.sValue -isnot [string]) { throw 'System Run reference read failed' }
      $values.Add([Environment]::ExpandEnvironmentVariables($value.sValue))
    }
  } }
  $shell = New-Object -ComObject WScript.Shell -ErrorAction Stop
  $roots = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ } | Select-Object -Unique
  foreach ($root in $roots) {
    if (!(Test-Path -LiteralPath $root -PathType Container -ErrorAction Stop)) { continue }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
    $recursive = $root -in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
    while ($pending.Count) { foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { if ($entry.Extension -eq '.lnk' -or $recursive) { throw 'Shortcut inventory contains reparse point' }; continue }
      if ($entry.PSIsContainer -and $recursive) { $pending.Push($entry.FullName) }
      elseif ($entry.Extension -eq '.lnk') {
        $link = $shell.CreateShortcut($entry.FullName)
        foreach ($value in @($link.TargetPath,$link.Arguments,$link.WorkingDirectory,$link.IconLocation)) { if ($value) { $values.Add([Environment]::ExpandEnvironmentVariables($value)) } }
      }
    } }
  }
  foreach ($task in Get-ScheduledTask -ErrorAction Stop) { foreach ($action in $task.Actions) {
    foreach ($value in @($action.Execute,$action.Arguments,$action.WorkingDirectory)) { if ($value) { $values.Add([Environment]::ExpandEnvironmentVariables($value)) } }
  } }
  return $values.ToArray()
}
function Get-RetentionInventory([string]$root) {
  $resolved = Assert-SafeDirectory $root
  $releases = @()
  foreach ($entry in Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop) {
    if ($entry.Name -match '^GamePilot-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$' -or $entry.Name -ceq 'GamePilot-0.14.45-native-tested') {
      $releases += Get-ReleaseDirectory $root $entry.FullName
    }
  }
  return [pscustomobject]@{root=[pscustomobject]@{path=$root;resolvedPath=$resolved;reparsePoint=$false}; releases=@($releases); references=[pscustomobject]@{complete=$true;values=@(Get-ReferenceValues)} }
}
function Assert-Unreferenced([string]$path, [string[]]$values) {
  $name = [regex]::Escape([IO.Path]::GetFileName($path))
  foreach ($value in $values) {
    if ($value -match ('(?i)(^|[\\/\s"''])'+$name+'($|[\\/\s"'',])')) { throw 'Release acquired a reference; preview again' }
  }
}
`;

function powershellError(stderr, error) {
  if (error.killed || error.signal)
    return "操作超时或被终止，需检查已完成删除；不能将本次操作视为全部完成。";
  const raw = String(stderr || error.message);
  const records = [...raw.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/g)];
  // Truncated XML can end with the actual failure after earlier complete records.
  const message = records.length && /<\/Objs>\s*$/.test(raw)
    ? records.map((record) => record[1]
        .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) =>
          ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity])
        .replace(/_x([\da-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
        .join("")
    : raw;
  return message.slice(-4000).trim();
}

function powershell(script, input) {
  if (process.platform !== "win32")
    throw Error("Release retention requires Windows");
  return new Promise((done, reject) => {
    const code =
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $payload=[Console]::In.ReadToEnd() | ConvertFrom-Json; $inputData=$payload.input; & ([scriptblock]::Create($payload.script))";
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
        timeout: Array.isArray(input?.candidates)
          ? Math.min(3600000, 600000 + input.candidates.length * 30000)
          : 600000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            Error(
              `Retention stopped; no complete deletion is claimed. ${powershellError(stderr, error)}`,
            ),
          );
        try {
          done(JSON.parse(stdout.replace(/^\uFEFF/, "")));
        } catch {
          reject(Error("Invalid retention inventory response"));
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ script, input }));
  });
}

export function windowsRetentionPorts(execute = powershell) {
  return {
    async read(options) {
      return execute(
        windowsFunctions +
          "\n# RETENTION_OPERATION\nGet-RetentionInventory $inputData.releaseRoot | ConvertTo-Json -Depth 8 -Compress",
        validOptions(options),
      );
    },
    async apply(plan) {
      // Validate even direct adapter callers; never trust a caller-supplied deletion list.
      const allowed = planReleaseRetention(
        { releaseRoot: plan.releaseRoot, keep: plan.keep },
        {
          root: {
            path: plan.releaseRoot,
            resolvedPath: plan.releaseRoot,
            reparsePoint: false,
          },
          releases: plan.inventoryPaths.map((path) => ({
            path,
            resolvedPath: path,
            reparsePoint: false,
            treeHasReparsePoint: false,
            manifestVersion: versionOf(win32.basename(path))?.join("."),
            manifestSha256: plan.inventoryHashes[path],
            manifestFilesMatch: true,
          })),
          references: { complete: true, values: [] },
        },
      );
      if (
        !Array.isArray(plan.candidates) ||
        new Set(plan.candidates).size !== plan.candidates.length ||
        plan.candidates.some((path) => !allowed.candidates.includes(path))
      )
        throw Error("Unsafe deletion plan");
      return execute(
        windowsFunctions +
          String.raw`
# RETENTION_OPERATION
$fresh = Get-RetentionInventory $inputData.releaseRoot
if (@($fresh.releases).Count -ne @($inputData.inventoryPaths).Count) { throw 'Release inventory changed' }
foreach ($entry in $fresh.releases) {
  if ($entry.path -cnotin @($inputData.inventoryPaths) -or $inputData.inventoryHashes.PSObject.Properties[$entry.path].Value -cne $entry.manifestSha256) { throw 'Release manifest or paths changed' }
}
$deleted = @()
try {
  foreach ($path in $inputData.candidates) {
    $entry = Get-ReleaseDirectory $inputData.releaseRoot $path
    if ($inputData.inventoryHashes.PSObject.Properties[$path].Value -cne $entry.manifestSha256) { throw 'Release manifest changed' }
    Assert-Unreferenced $path @(Get-ReferenceValues)
    # The same process resolves and checks the literal absolute target immediately before removal.
    $null = Assert-SafeDirectory $inputData.releaseRoot
    $resolved = Assert-SafeDirectory $path
    if (![string]::Equals([IO.Path]::GetDirectoryName($resolved), $inputData.releaseRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Deletion target outside release root' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $resolved -ErrorAction Stop) { throw 'Deletion readback failed' }
    $deleted += $path
  }
} catch { throw ('Stopped after '+$deleted.Count+' deletions: '+$_.Exception.Message) }
[pscustomobject]@{deleted=@($deleted)} | ConvertTo-Json -Compress
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
  const options = { keep: [] };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply" && options.apply === undefined)
      options.apply = true;
    else if (
      args[i] === "--release-root" &&
      args[i + 1] &&
      !options.releaseRoot
    )
      options.releaseRoot = args[++i];
    else if (args[i] === "--keep" && args[i + 1]) options.keep.push(args[++i]);
    else
      throw Error(
        "Usage: --release-root <absolute release directory> [--keep GamePilot-x.y.z] [--apply]",
      );
  }
  console.log(JSON.stringify(await pruneReleases(options), null, 2));
}
