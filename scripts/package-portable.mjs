import {
  cp,
  mkdir,
  rename,
  writeFile,
  readFile,
  access,
  readdir,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, join, relative, isAbsolute } from "node:path";
import { prepareLicenses } from "./portable-licenses.mjs";
import { validateDshRuntime, copyDshRuntime } from "./dsh-portable-runtime.mjs";
import { pruneReleases } from "./release/prune-releases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const engineContract = await json(
  join(root, "games/arknights/engine-contract.json"),
);
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function inventory(directory) {
  const files = {};
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Portable packages cannot contain links: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(directory, path).replaceAll("\\", "/")] =
          await sha256(path);
      else throw new Error(`Unsupported package entry: ${path}`);
    }
  }
  await walk(directory);
  return files;
}
async function requireFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0)
    throw new Error(`Missing or empty required file: ${path}`);
}
async function requireX64PE(path) {
  const bytes = await readFile(path);
  const pe = bytes.readUInt32LE(0x3c);
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    bytes.readUInt32LE(pe) !== 0x4550 ||
    bytes.readUInt16LE(pe + 4) !== 0x8664
  )
    throw new Error(`Not a Windows x64 binary: ${path}`);
}
async function verifyPackage(directory) {
  const manifest = await json(join(directory, "package-manifest.json"));
  for (const name of Object.keys(manifest.files)) {
    const rel = relative(directory, resolve(directory, name));
    if (isAbsolute(rel) || rel.startsWith(".."))
      throw new Error("Invalid manifest path");
  }
  const actual = await inventory(directory);
  delete actual["package-manifest.json"];
  if (Object.keys(actual).length !== Object.keys(manifest.files).length)
    throw new Error("Package file count changed");
  for (const [name, hash] of Object.entries(manifest.files))
    if (actual[name] !== hash)
      throw new Error(`Package integrity failed: ${name}`);
  const packaged = await json(join(directory, "resources/app/package.json"));
  if (packaged.version !== manifest.version)
    throw new Error("Packaged version mismatch");
  const runtime = await validateDshRuntime(
    join(directory, "resources/gamepilot-dsh-runtime"),
  );
  if (
    manifest.dsh?.version !== runtime.dshVersion ||
    manifest.dsh?.nodeVersion !== runtime.node.version ||
    manifest.dsh?.lockSha256 !== runtime.lockSha256
  )
    throw new Error("Packaged DSH provenance mismatch");
  console.log(`Verified ${Object.keys(actual).length} files: ${directory}`);
}

const args = process.argv.slice(2);
if (args[0] === "--verify" && args.length === 2) {
  await verifyPackage(resolve(args[1]));
} else {
  if (args.length && !(args.length === 1 && args[0] === "--check"))
    throw new Error(
      "Usage: node scripts/package-portable.mjs [--check | --verify <directory>]",
    );
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Build the Windows x64 portable package on Windows x64");
  const metadata = await json(join(root, "package.json"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version))
    throw new Error("Invalid package version");
  const lock = await json(join(root, "package-lock.json"));
  if (
    lock.version !== metadata.version ||
    lock.packages[""].version !== metadata.version
  )
    throw new Error(
      "Root package.json and package-lock.json versions differ; run npm version <version> --no-git-tag-version",
    );
  const modules = join(root, "node_modules");
  // Worktree junctions cannot be shipped. An alternate physical copy still
  // passes the same complete runtime and portable-file validation.
  const dshSource = process.env.GAMEPILOT_DSH_PACKAGE_RUNTIME
    ? resolve(process.env.GAMEPILOT_DSH_PACKAGE_RUNTIME)
    : join(root, "integrations/deepseek-harness/runtime");
  const dsh = await validateDshRuntime(dshSource);
  const maa = await json(join(modules, "@maaxyz/maa-node/package.json"));
  const native = await json(
    join(modules, "@maaxyz/maa-node-win32-x64/package.json"),
  );
  const electron = await json(join(modules, "electron/package.json"));
  if (
    maa.version !== native.version ||
    metadata.dependencies["@maaxyz/maa-node"] !== maa.version
  )
    throw new Error("Maa package versions do not match");
  if (metadata.devDependencies.electron !== electron.version)
    throw new Error("Electron installation does not match root package.json");
  for (const packageInfo of [maa, native])
    if (Object.keys(packageInfo.dependencies ?? {}).length)
      throw new Error(`Review new runtime dependencies of ${packageInfo.name}`);
  for (const file of [
    "dist/maa-bridge/GamePilot.MaaBridge.exe",
    "dist/maa-bridge/GamePilot.MaaBridge.runtimeconfig.json",
    `dist/resources/maa-${engineContract.version}/MaaCore.dll`,
    `dist/resources/maa-${engineContract.version}/resource/config.json`,
    `dist/resources/maa-${engineContract.version}/gamepilot-provenance.json`,
    "dist/main/index.cjs",
    "dist/preload/index.cjs",
    "dist/worker/index.cjs",
    "dist/renderer/index.html",
    "dist/resources/onmyoji/model/ocr/det.onnx",
    "dist/resources/onmyoji/model/ocr/rec.onnx",
    "dist/resources/onmyoji/model/ocr/keys.txt",
    "dist/resources/onmyoji/image/courtyard-tasks.png",
    "dist/resources/onmyoji/licenses/MaaCommonAssets-MIT.txt",
    "dist/resources/onmyoji/licenses/PaddleOCR-Apache-2.0.txt",
    "docs/daily-app-guide.md",
    "docs/gamepilot-chat-use-0.15.0.md",
    "docs/gamepilot-chat-use-0.15.1.md",
    "docs/live-chat-acceptance-2026-10-07.md",
    "docs/third-party-notices.md",
    "node_modules/electron/dist/LICENSE",
    "node_modules/electron/dist/LICENSES.chromium.html",
  ])
    await requireFile(join(root, file));
  for (const file of [
    "electron.exe",
    "resources/default_app.asar",
    "icudtl.dat",
    "resources.pak",
    "v8_context_snapshot.bin",
  ])
    await requireFile(join(modules, "electron/dist", file));
  await requireX64PE(join(modules, "electron/dist/electron.exe"));
  for (const file of [
    "MaaNode.node",
    "MaaFramework.dll",
    "MaaToolkit.dll",
    "MaaUtils.dll",
    "MaaAdbControlUnit.dll",
    "opencv_world4_maa.dll",
    "onnxruntime_maa.dll",
    "fastdeploy_ppocr_maa.dll",
    "DirectML.dll",
  ])
    await requireX64PE(join(modules, "@maaxyz/maa-node-win32-x64", file));
  const licenses = await prepareLicenses(root, maa.version);
  console.log(
    "Target prerequisite: Microsoft Visual C++ v14 x64 runtime (not bundled); see third-party notices. No native module is loaded by this check.",
  );
  const output = join(root, "release", `GamePilot-${metadata.version}`);
  if (args[0] === "--check") {
    console.log(
      `Preflight passed for GamePilot ${metadata.version}; no app launched or release created. Target: ${output}`,
    );
  } else {
    try {
      await access(output);
      throw new Error(`Release already exists: ${output}; use a new version`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const staging = `${output}.staging-${process.pid}-${Date.now()}`;
    await mkdir(staging, { recursive: true });
    try {
      await cp(join(modules, "electron/dist"), staging, { recursive: true });
      await rename(
        join(staging, "electron.exe"),
        join(staging, "GamePilot.exe"),
      );
      const app = join(staging, "resources/app");
      await copyDshRuntime(
        dshSource,
        join(staging, "resources/gamepilot-dsh-runtime"),
      );
      await mkdir(app, { recursive: true });
      await cp(join(root, "dist"), join(app, "dist"), { recursive: true });
      await mkdir(join(app, "scripts/agent"), { recursive: true });
      await mkdir(join(app, "packages/protocol"), { recursive: true });
      for (const name of ["control.mjs", "mcp.mjs", "local-control-client.mjs"])
        await cp(
          join(root, "scripts/agent", name),
          join(app, "scripts/agent", name),
        );
      await cp(
        join(root, "packages/protocol/local-control-schema.json"),
        join(app, "packages/protocol/local-control-schema.json"),
      );
      await writeFile(
        join(app, "package.json"),
        JSON.stringify(
          {
            name: metadata.name,
            productName: "GamePilot",
            version: metadata.version,
            main: "dist/main/index.cjs",
          },
          null,
          2,
        ),
      );
      for (const name of ["maa-node", "maa-node-win32-x64"])
        await cp(
          join(modules, "@maaxyz", name),
          join(app, "node_modules/@maaxyz", name),
          { recursive: true },
        );
      const packagedRequire = createRequire(join(app, "package.json"));
      for (const name of ["@maaxyz/maa-node", "@maaxyz/maa-node-win32-x64"]) {
        const resolved = packagedRequire.resolve(name);
        const rel = relative(app, resolved);
        if (isAbsolute(rel) || rel.startsWith(".."))
          throw new Error(
            `Runtime dependency resolved outside portable app: ${name}`,
          );
      }
      await cp(
        join(root, "docs/daily-app-guide.md"),
        join(staging, "使用说明.md"),
      );
      await cp(
        join(root, "docs/local-control.md"),
        join(staging, "CLI与MCP.md"),
      );
      await cp(
        join(root, "docs/gamepilot-chat-use-0.15.3.md"),
        join(staging, "Agent新功能.md"),
      );
      await cp(
        join(root, "docs/gamepilot-chat-use-0.15.0.md"),
        join(staging, "gamepilot-chat-use-0.15.0.md"),
      );
      for (const name of [
        "gamepilot-chat-use-0.15.1.md",
        "live-chat-acceptance-2026-10-07.md",
        "player-agent-live-2026-10-09.md",
        "mumu-foundation-review-2026-10-09.md",
      ])
        await cp(join(root, "docs", name), join(staging, name));
      await cp(
        join(root, "docs/third-party-notices.md"),
        join(staging, "第三方组件说明.md"),
      );
      await cp(licenses, join(staging, "licenses"), { recursive: true });
      const files = await inventory(staging);
      await writeFile(
        join(staging, "package-manifest.json"),
        JSON.stringify(
          {
            version: metadata.version,
            platform: "win32-x64",
            electron: electron.version,
            maa: maa.version,
            dsh: {
              version: dsh.dshVersion,
              reviewedSourceCommit: dsh.reviewedSourceCommit,
              nodeVersion: dsh.node.version,
              lockSha256: dsh.lockSha256,
            },
            prerequisites: [
              "Windows x64",
              "Microsoft Visual C++ v14 x64 Redistributable",
              "User-supplied emulator ADB",
            ],
            createdAt: new Date().toISOString(),
            files,
          },
          null,
          2,
        ),
      );
      await verifyPackage(staging);
      await rename(staging, output);
      console.log(join(output, "GamePilot.exe"));
      // A verified new package is durable before any old-version maintenance.
      // Unknown references or modified packages keep all existing versions.
      try {
        const retention = await pruneReleases({
          releaseRoot: join(root, "release"),
          keep: [`GamePilot-${metadata.version}`],
          apply: true,
        });
        console.log(
          `Release retention: removed ${retention.deleted.length} old package(s); kept ${retention.plan.retained.length} latest/referenced package(s).`,
        );
      } catch (error) {
        console.warn(
          `Package verified; old-version maintenance stopped: ${error.message}`,
        );
      }
    } catch (error) {
      throw new Error(
        `Packaging failed; incomplete staging retained for inspection at ${staging}`,
        { cause: error },
      );
    }
  }
}
