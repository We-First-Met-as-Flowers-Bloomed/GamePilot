import { spawnSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { patchStartupAnnouncements } from "../games/arknights/maa-startup-patch.mjs";
const contract = JSON.parse(
  readFileSync(
    new URL("../games/arknights/engine-contract.json", import.meta.url),
    "utf8",
  ),
);
mkdirSync("artifacts/maa-bridge/obj", { recursive: true });
const result = spawnSync(
  "dotnet",
  [
    "publish",
    "packages/maa-bridge/MaaBridge.csproj",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-o",
    "dist/maa-bridge",
    `-p:BaseIntermediateOutputPath=${resolve("artifacts/maa-bridge/obj")}/`,
    `-p:BaseOutputPath=${resolve("artifacts/maa-bridge/bin")}/`,
  ],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const vendor = `artifacts/vendor/maa-${contract.version}`;
if (existsSync(`${vendor}/gamepilot-provenance.json`)) {
  const provenance = JSON.parse(
    readFileSync(`${vendor}/gamepilot-provenance.json`, "utf8"),
  );
  if (
    provenance.version !== contract.version ||
    provenance.sha256 !== contract.archiveSha256
  )
    throw new Error(
      "MaaCore vendor provenance does not match engine contract; run setup:maacore",
    );
  const output = `dist/resources/maa-${contract.version}`;
  mkdirSync(output, { recursive: true });
  for (const entry of readdirSync(vendor, { withFileTypes: true })) {
    const requiredDirectory =
      entry.isDirectory() && ["resource", "externals"].includes(entry.name);
    const requiredFile =
      entry.isFile() &&
      ([
        "DirectML.dll",
        "fastdeploy_ppocr_maa.dll",
        "MaaAdbControlUnit.dll",
        "MaaCore.dll",
        "MaaUtils.dll",
        "MaaWin32ControlUnit.dll",
        "onnxruntime_maa.dll",
        "opencv_world4_maa.dll",
      ].includes(entry.name) ||
        /license|notice|gamepilot-provenance/i.test(entry.name));
    if (requiredDirectory || requiredFile)
      cpSync(`${vendor}/${entry.name}`, `${output}/${entry.name}`, {
        recursive: true,
      });
  }
  cpSync("packages/maa-bridge/MAA-LICENSE.txt", `${output}/MAA-LICENSE.txt`);
  const taskFile = `${output}/resource/tasks/tasks.json`;
  const tasks = JSON.parse(readFileSync(taskFile, "utf8"));
  writeFileSync(
    taskFile,
    JSON.stringify(patchStartupAnnouncements(tasks), null, 4),
  );
  writeFileSync(
    `${output}/gamepilot-resource-patches.json`,
    JSON.stringify(
      {
        base: contract.version,
        patches: ["games/arknights/maa-startup-patch.mjs"],
        note: "Built copy only; upstream archive and its provenance are unchanged.",
      },
      null,
      2,
    ),
  );
}
for (const name of [
  "MAA-LICENSE.txt",
  "DOTNET-LICENSE.txt",
  "DOTNET-THIRD-PARTY-NOTICES.txt",
  "README.md",
]) {
  cpSync(`packages/maa-bridge/${name}`, `dist/maa-bridge/${name}`);
}
