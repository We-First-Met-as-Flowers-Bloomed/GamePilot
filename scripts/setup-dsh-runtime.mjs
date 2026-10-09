import {
  cp,
  mkdir,
  lstat,
  readFile,
  writeFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { resolve, join, relative, dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const source = join(workspace, "integrations/deepseek-harness/runtime");
const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + sep)
  );
};

/** npm ci is destructive to its own node_modules; prove isolation before invoking it. */
export async function assertIsolatedRuntimeTarget(directory, root = workspace) {
  const target = resolve(directory);
  const base = resolve(root);
  const standard = join(base, "integrations/deepseek-harness/runtime");
  if (target !== standard && !inside(join(base, "artifacts"), target))
    throw new Error(
      "Runtime target must be the owned integration runtime or a named workspace artifact",
    );
  let current = base;
  if ((await exists(base)) && (await lstat(base)).isSymbolicLink())
    throw new Error("Workspace root must not be a link");
  for (const segment of relative(base, target).split(sep)) {
    current = join(current, segment);
    if ((await exists(current)) && (await lstat(current)).isSymbolicLink())
      throw new Error("Runtime target must not traverse a link");
  }
  for (const folder of [
    target,
    join(target, "node_modules"),
    join(target, "node"),
    join(target, "licenses"),
  ])
    if ((await exists(folder)) && (await lstat(folder)).isSymbolicLink())
      throw new Error("Runtime dependencies and output must not be links");
  if (await exists(target)) {
    const actual = await realpath(target);
    if (actual.toLowerCase() !== target.toLowerCase())
      throw new Error("Runtime target resolved outside its named directory");
  }
}

export async function setupDshRuntime(options = {}) {
  const target = resolve(options.target ?? source);
  await assertIsolatedRuntimeTarget(target);
  const pin = JSON.parse(
    await readFile(join(source, "node-runtime.json"), "utf8"),
  );
  if (process.platform !== pin.platform || process.arch !== pin.arch)
    throw new Error(
      "This portable runtime pins the reviewed Windows x64 Node artifact",
    );
  const nodeSource = resolve(
    options.nodePath ??
      "D:/deepseek_harness_desktop/dsh_latest/resources/runtime/primary-runtime/dependencies/node/bin/node.exe",
  );
  const licenseSource = resolve(
    options.nodeLicense ?? join(dirname(nodeSource), "..", "LICENSE"),
  );
  const [nodeBytes, licenseBytes] = await Promise.all([
    readFile(nodeSource),
    readFile(licenseSource),
  ]);
  if (
    hash(nodeBytes) !== pin.binarySha256 ||
    hash(licenseBytes) !== pin.licenseSha256
  )
    throw new Error(
      "Node source differs from node-runtime.json; supply the reviewed archived artifact",
    );
  const version = (
    await promisify(execFile)(nodeSource, ["--version"], {
      windowsHide: true,
      timeout: 5000,
    })
  ).stdout.trim();
  if (version !== pin.version) throw new Error("Node source version mismatch");
  await mkdir(target, { recursive: true });
  if (target !== resolve(source))
    for (const name of [
      "package.json",
      "package-lock.json",
      "node-runtime.json",
      "gamepilot.cordis.patch.yml",
      "plugin.mjs",
      "launcher.mjs",
      "README.md",
    ])
      await cp(join(source, name), join(target, name));
  const nodeDirectory = join(target, "node");
  await mkdir(nodeDirectory, { recursive: true });
  await writeFile(join(nodeDirectory, "node.exe"), nodeBytes);
  await writeFile(join(nodeDirectory, "LICENSE"), licenseBytes);
  const node = join(nodeDirectory, "node.exe");
  const npm = resolve(
    options.npmPath ??
      process.env.npm_execpath ??
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  );
  await assertIsolatedRuntimeTarget(target);
  if (options.install !== false)
    await new Promise((done, reject) => {
      const child = spawn(
        node,
        [
          npm,
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
        ],
        { cwd: target, windowsHide: true, stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? done()
          : reject(new Error(`Isolated npm ci failed (${code})`)),
      );
    });
  const lockBytes = await readFile(join(target, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const licenses = join(target, "licenses");
  await mkdir(licenses, { recursive: true });
  const notices = [];
  for (const [path, pinned] of Object.entries(lock.packages)) {
    if (!path) continue;
    const directory = resolve(target, path);
    if (!inside(target, directory))
      throw new Error("Dependency path escaped runtime target");
    if (!(await exists(join(directory, "package.json")))) {
      if (pinned.optional) continue;
      throw new Error("Missing locked runtime dependency");
    }
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (manifest.version !== pinned.version)
      throw new Error("Installed runtime dependency differs from lock");
    const texts = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^(license|licence|copying|notice)([._-]|$)/i.test(entry.name)
      )
        continue;
      const bytes = await readFile(join(directory, entry.name));
      const output =
        path.replaceAll("/", "__").replaceAll("\\", "__") + "__" + entry.name;
      await writeFile(join(licenses, output), bytes);
      texts.push({ file: output, sha256: hash(bytes) });
    }
    notices.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? pinned.license ?? "see package",
      resolved: pinned.resolved,
      integrity: pinned.integrity,
      licenseFiles: texts,
    });
  }
  await writeFile(join(licenses, "Node-LICENSE.txt"), licenseBytes);
  await writeFile(
    join(licenses, "THIRD_PARTY_NOTICES.json"),
    JSON.stringify(notices, null, 2) + "\n",
  );
  const info = {
    schemaVersion: 1,
    dshVersion: "0.2.1-alpha.1",
    reviewedSourceCommit: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    lockSha256: hash(lockBytes),
    node: {
      version,
      binarySha256: hash(nodeBytes),
      licenseSha256: hash(licenseBytes),
    },
    installedPackages: notices.length,
  };
  await writeFile(
    join(target, "runtime-build-info.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  return { directory: target, ...info };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const options = {};
  const flags = {
    "--target": "target",
    "--node": "nodePath",
    "--node-license": "nodeLicense",
    "--npm": "npmPath",
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--no-install") options.install = false;
    else if (flags[args[index]] && args[index + 1])
      options[flags[args[index]]] = args[++index];
    else
      throw new Error(
        "Usage: node scripts/setup-dsh-runtime.mjs [--target <workspace artifact>] [--node <reviewed node.exe>] [--node-license <LICENSE>] [--npm <npm-cli.js>] [--no-install]",
      );
  }
  console.log(JSON.stringify(await setupDshRuntime(options), null, 2));
}
