import { cp, readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePin = fileURLToPath(
  new URL(
    "../integrations/deepseek-harness/runtime/node-runtime.json",
    import.meta.url,
  ),
);
const fixedVersion = "0.2.1-alpha.1";
const sourceCommit = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";
const roots = new Set([
  "node",
  "node_modules",
  "licenses",
  "package.json",
  "package-lock.json",
  "node-runtime.json",
  "gamepilot.cordis.patch.yml",
  "plugin.mjs",
  "launcher.mjs",
  "runtime-build-info.json",
  "README.md",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0 || stat.isSymbolicLink())
    throw new Error("Missing or linked required DSH runtime file");
}

export function portableDshEntry(relativePath) {
  const path = relativePath.replaceAll("\\", "/");
  if (!path) return true;
  const parts = path.split("/");
  if (
    !roots.has(parts[0]) ||
    parts.some(
      (part) =>
        part === ".." ||
        part === ".bin" ||
        part === ".cache" ||
        part === ".env" ||
        part.startsWith(".env."),
    ) ||
    path.toLowerCase().endsWith(".log")
  )
    return false;
  return true;
}

/** Fail packaging before creating a staging release when the real runtime is not ready. */
export async function validateDshRuntime(directory) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("DSH runtime directory must not be a link");
  const [pin, actualPin, info, lock] = await Promise.all([
    json(sourcePin),
    json(join(root, "node-runtime.json")),
    json(join(root, "runtime-build-info.json")),
    json(join(root, "package-lock.json")),
  ]);
  if (
    actualPin.binarySha256 !== pin.binarySha256 ||
    actualPin.licenseSha256 !== pin.licenseSha256 ||
    actualPin.version !== pin.version ||
    info.schemaVersion !== 1 ||
    info.dshVersion !== fixedVersion ||
    info.reviewedSourceCommit !== sourceCommit ||
    info.node.version !== pin.version ||
    info.node.binarySha256 !== pin.binarySha256 ||
    info.node.licenseSha256 !== pin.licenseSha256
  )
    throw new Error(
      "DSH portable provenance differs from the fixed runtime contract",
    );
  if (
    digest(await readFile(join(root, "package-lock.json"))) !== info.lockSha256
  )
    throw new Error("DSH portable dependency lock changed after setup");
  if (
    digest(await readFile(join(root, "node/node.exe"))) !== pin.binarySha256 ||
    digest(await readFile(join(root, "node/LICENSE"))) !== pin.licenseSha256
  )
    throw new Error("DSH portable Node or license integrity failed");
  for (const path of [
    "launcher.mjs",
    "plugin.mjs",
    "gamepilot.cordis.patch.yml",
    "package.json",
    "node/node.exe",
    "node/LICENSE",
    "licenses/Node-LICENSE.txt",
    "licenses/THIRD_PARTY_NOTICES.json",
    "node_modules/@deepseek-ai/dsh/lib/bin.js",
    "node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js",
    "node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js",
    "node_modules/@deepseek-ai/dsh-sdk-protocol/lib/index.js",
    "node_modules/@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml",
    "node_modules/@deepseek-ai/dsh/LICENSE",
  ])
    await regular(join(root, path));
  for (const name of [
    "dsh",
    "dsh-sdk-client",
    "dsh-sdk-jsonrpc-server",
    "dsh-sdk-protocol",
    "dsh-sdk-minimal",
    "dsh-agent",
    "dsh-agent-loop",
    "dsh-tools",
    "dsh-session",
    "dsh-session-persistence-jsonl",
  ]) {
    const installed = await json(
      join(root, "node_modules/@deepseek-ai", name, "package.json"),
    );
    if (
      installed.version !== fixedVersion ||
      lock.packages[`node_modules/@deepseek-ai/${name}`]?.version !==
        fixedVersion
    )
      throw new Error("DSH portable SDK/core version mismatch");
  }
  const notices = await json(join(root, "licenses/THIRD_PARTY_NOTICES.json"));
  if (
    !Array.isArray(notices) ||
    notices.length !== info.installedPackages ||
    !notices.some(
      (item) =>
        item.name === "@deepseek-ai/dsh-sdk-client" &&
        item.version === fixedVersion,
    ) ||
    !notices.some(
      (item) =>
        item.name === "@deepseek-ai/dsh-agent-loop" &&
        item.version === fixedVersion,
    )
  )
    throw new Error("DSH portable license inventory is incomplete");
  return info;
}

export async function copyDshRuntime(source, destination) {
  const info = await validateDshRuntime(source);
  const root = resolve(source);
  await cp(root, destination, {
    recursive: true,
    filter: async (path) => {
      const rel = relative(root, path);
      if (
        isAbsolute(rel) ||
        rel === ".." ||
        rel.startsWith("..\\") ||
        rel.startsWith("../")
      )
        throw new Error("DSH package path escaped runtime");
      if (!portableDshEntry(rel)) return false;
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("DSH portable runtime must not contain links");
      return true;
    },
  });
  await validateDshRuntime(destination);
  return info;
}
