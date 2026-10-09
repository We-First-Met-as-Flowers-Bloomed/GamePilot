import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const contract = JSON.parse(
  await readFile(
    new URL("../games/arknights/engine-contract.json", import.meta.url),
    "utf8",
  ),
);
const version = contract.version;
const sha256 = contract.archiveSha256;
const asset = `MAA-${version}-win-x64.zip`;
const url = `https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/download/${version}/${asset}`;
const zip = resolve("artifacts/vendor", asset);
const destination = resolve(`artifacts/vendor/maa-${version}`);
await mkdir("artifacts/vendor", { recursive: true });
async function digest(path) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
if ((await digest(zip)) !== sha256) {
  const download = spawnSync(
    "curl.exe",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--retry-all-errors",
      "--connect-timeout",
      "20",
      "--max-time",
      "300",
      url,
      "--output",
      zip,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (download.status !== 0)
    throw new Error(
      "Official MaaCore download failed; rerun setup:maacore to retry",
    );
}
if ((await digest(zip)) !== sha256)
  throw new Error(
    "MaaCore release SHA-256 mismatch; archive was not extracted",
  );
// The verified official ZIP contains a Chinese filename that Windows bsdtar cannot decode.
await mkdir(destination, { recursive: true });
const extractScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($env:MAA_DEST) + [IO.Path]::DirectorySeparatorChar
$archive = [IO.Compression.ZipFile]::OpenRead($env:MAA_ARCHIVE)
try {
  foreach ($entry in $archive.Entries) {
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ZIP path' }
    if ($entry.Name -eq '') { [IO.Directory]::CreateDirectory($target) | Out-Null }
    else {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  }
} finally { $archive.Dispose() }
`;
const extract = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-Command", extractScript],
  {
    env: { ...process.env, MAA_ARCHIVE: zip, MAA_DEST: destination },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (extract.status !== 0) throw new Error("MaaCore extraction failed");
await access(`${destination}/MaaCore.dll`);
await access(`${destination}/resource/config.json`);
await writeFile(
  `${destination}/gamepilot-provenance.json`,
  JSON.stringify(
    {
      version,
      asset,
      url,
      sha256,
      digestSource: `https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/expanded_assets/${version}`,
      source: `https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/${version}`,
      license: "AGPL-3.0",
    },
    null,
    2,
  ),
);
console.log(`Verified and extracted ${version} to ${destination}`);
