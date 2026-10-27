import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const workspace = fileURLToPath(new URL("../", import.meta.url));
export const SETUP_PINS = Object.freeze({
  node: "v22.18.0",
  npm: "10.9.3",
  dotnet: "8.0.400",
});
export const OCR_HASHES = Object.freeze({
  "det.onnx":
    "767e663dded50813dca0abc9a49859e345e0f74a48b387661188f096a9211d74",
  "rec.onnx":
    "da4815ea386ee8083be319da8d20e70f4fdb0b6404ba0d2da7f675831e1b37fa",
  "keys.txt":
    "d917d7489d2c20d2e4cee8c17068f8ac54f6ee406a04bf5ac3b1ff5dc38e1e52",
});
export const ONMYOJI_TEMPLATES = Object.freeze([
  "courtyard-menu-closed.png",
  "courtyard-menu-toggle.png",
  "courtyard-scene-back.png",
  "courtyard-scene-music.png",
  "courtyard-tasks.png",
  "foster-confirm.png",
  "foster-white-daruma.png",
  "guild-entry.png",
  "hana-entry.png",
  "oboroguruma-entry.png",
  "oboroguruma-max.png",
  "oboroguruma-next.png",
  "training-full.png",
  "training-level-one-stack.png",
  "training-level-one.png",
]);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function parseSetupArgs(args) {
  const result = { mode: "check", scope: "all", json: false };
  const seen = new Set();
  const paths = {
    "--dsh-node": "dshNode",
    "--dsh-license": "dshLicense",
    "--dsh-runtime": "dshRuntime",
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    requireValue(!seen.has(flag), `Duplicate flag: ${flag}`);
    seen.add(flag);
    if (flag === "--check" || flag === "--install") {
      requireValue(
        !seen.has(flag === "--check" ? "--install" : "--check"),
        "Choose check or install",
      );
      result.mode = flag.slice(2);
    } else if (flag === "--public" || flag === "--private") {
      requireValue(
        !seen.has(flag === "--public" ? "--private" : "--public"),
        "Choose public or private scope",
      );
      result.scope = flag.slice(2);
    } else if (flag === "--json") result.json = true;
    else if (paths[flag]) {
      requireValue(
        args[index + 1] && !args[index + 1].startsWith("--"),
        `${flag} requires a path`,
      );
      result[paths[flag]] = args[++index];
    } else throw new Error(`Unknown setup flag: ${flag}`);
  }
  if (result.mode === "install" && result.scope === "all")
    result.scope = "public";
  requireValue(
    !(
      result.scope === "public" &&
      (result.dshNode || result.dshLicense || result.dshRuntime)
    ),
    "DSH paths require private scope",
  );
  requireValue(
    !(result.mode === "check" && (result.dshNode || result.dshLicense)),
    "DSH source paths are for installation only",
  );
  requireValue(
    !(result.mode === "install" && result.dshRuntime),
    "DSH runtime override is read-only",
  );
  return result;
}

async function runCommand(command, args, options = {}) {
  let executable = command;
  let argv = args;
  if (command === "npm") {
    const npm =
      process.env.npm_execpath ??
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    executable = process.execPath;
    argv = [npm, ...args];
  }
  const settings = {
    cwd: options.cwd ?? workspace,
    windowsHide: true,
    env: options.env ?? process.env,
  };
  if (options.inherit) {
    await new Promise((done, reject) => {
      const child = spawn(executable, argv, { ...settings, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? done() : reject(new Error(`${command} failed (${code})`)),
      );
    });
    return "";
  }
  return (
    await promisify(execFile)(executable, argv, {
      ...settings,
      timeout: options.timeout ?? 15000,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();
}

/** Read official archive bytes; never extract, patch, execute or download them. */
async function archiveEntries(archive, run, root) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:GAMEPILOT_SETUP_ARCHIVE)
$hashes = @{}
try {
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\\', '/')
    if ($name -match '\\.dll$' -or $name -eq 'resource/config.json' -or $name -eq 'resource/tasks/tasks.json') {
      if ($hashes.ContainsKey($name)) { throw 'Duplicate archive entry' }
      $stream = $entry.Open()
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $hashes[$name] = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
      finally { $stream.Dispose(); $sha.Dispose() }
    }
  }
} finally { $zip.Dispose() }
$hashes | ConvertTo-Json -Compress
`;
  return JSON.parse(
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: root,
        timeout: 180000,
        env: { ...process.env, GAMEPILOT_SETUP_ARCHIVE: archive },
      },
    ),
  );
}

async function checkNodeLock(root, options, run) {
  requireValue(
    (options.nodeVersion ?? process.version) === SETUP_PINS.node,
    `Use Node ${SETUP_PINS.node}`,
  );
  requireValue(
    (await run("npm", ["--version"], { cwd: root })) === SETUP_PINS.npm,
    `Use npm ${SETUP_PINS.npm}`,
  );
  const [manifest, lock] = await Promise.all([
    json(join(root, "package.json")),
    json(join(root, "package-lock.json")),
  ]);
  requireValue(
    lock.lockfileVersion === 3 &&
      lock.name === manifest.name &&
      lock.version === manifest.version,
    "Root npm lock metadata differs from package.json",
  );
  for (const group of ["dependencies", "devDependencies"]) {
    requireValue(
      JSON.stringify(Object.entries(manifest[group] ?? {}).sort()) ===
        JSON.stringify(
          Object.entries(lock.packages?.[""]?.[group] ?? {}).sort(),
        ),
      `Root npm lock ${group} differs from package.json`,
    );
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      requireValue(
        /^(?:@[^/]+\/)?[a-zA-Z0-9._-]+$/.test(name) &&
          /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version),
        "Root dependencies must use safe names and exact versions",
      );
      const pinned = lock.packages?.[`node_modules/${name}`];
      requireValue(
        pinned?.version === version && typeof pinned.integrity === "string",
        `Missing exact npm lock entry: ${name}`,
      );
      requireValue(
        (await json(join(root, "node_modules", name, "package.json")))
          .version === version,
        `Installed dependency differs from npm lock: ${name}; run npm ci in an owned checkout`,
      );
    }
  }
  return "Pinned Node/npm, root lock and installed direct dependencies match";
}

async function checkDotnet(root, run) {
  const pin = (await json(join(root, "global.json"))).sdk;
  requireValue(
    pin?.version === SETUP_PINS.dotnet &&
      pin.rollForward === "disable" &&
      pin.allowPrerelease === false,
    "global.json must pin .NET 8.0.400 with rollForward:disable and allowPrerelease:false",
  );
  const sdks = await run("dotnet", ["--list-sdks"], { cwd: root });
  requireValue(
    sdks
      .split(/\r?\n/)
      .some((line) => line.startsWith(`${SETUP_PINS.dotnet} [`)),
    "Install exact .NET SDK 8.0.400; another .NET 8 SDK is insufficient",
  );
  requireValue(
    (await run("dotnet", ["--version"], { cwd: root })) === SETUP_PINS.dotnet,
    "Selected .NET SDK differs from global.json",
  );
  return "Exact .NET SDK 8.0.400 is installed and selected";
}

async function checkElectron(root) {
  const manifest = await json(join(root, "package.json"));
  const expected =
    manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
  const directory = join(root, "node_modules/electron");
  requireValue(
    (await json(join(directory, "package.json"))).version === expected,
    "Electron npm package differs from root pin",
  );
  requireValue(
    (await readFile(join(directory, "path.txt"), "utf8")).trim() ===
      "electron.exe",
    "Electron executable path must be the Windows package executable",
  );
  requireValue(
    (await lstat(join(directory, "dist/electron.exe"))).isFile(),
    "Electron executable missing; run setup:electron",
  );
  requireValue(
    (await readFile(join(directory, "dist/version"), "utf8"))
      .trim()
      .replace(/^v/, "") === expected,
    "Electron extracted version differs from npm pin",
  );
  return `Electron ${expected} package and extracted runtime are present (not launched)`;
}

async function checkMaaCore(root, options, run) {
  const contract = await json(
    join(root, "games/arknights/engine-contract.json"),
  );
  requireValue(
    /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(contract.version) &&
      /^[a-f0-9]{64}$/.test(contract.archiveSha256),
    "Invalid engine contract",
  );
  const asset = `MAA-${contract.version}-win-x64.zip`;
  const directory = join(root, `artifacts/vendor/maa-${contract.version}`);
  const metadata = await json(join(directory, "gamepilot-provenance.json"));
  const origin =
    "https://github.com/MaaAssistantArknights/MaaAssistantArknights";
  const expected = {
    version: contract.version,
    asset,
    sha256: contract.archiveSha256,
    url: `${origin}/releases/download/${contract.version}/${asset}`,
    source: `${origin}/tree/${contract.version}`,
    digestSource: `${origin}/releases/expanded_assets/${contract.version}`,
    license: "AGPL-3.0",
  };
  requireValue(
    Object.entries(expected).every(([key, value]) => metadata[key] === value),
    "MaaCore provenance differs from the fixed official release",
  );
  const archive = join(root, "artifacts/vendor", asset);
  requireValue(
    (await digestFile(archive)) === contract.archiveSha256,
    "MaaCore official archive SHA-256 mismatch",
  );
  const entries = options.archiveEntries
    ? await options.archiveEntries(archive)
    : await archiveEntries(archive, run, root);
  requireValue(
    entries &&
      [
        "MaaCore.dll",
        "resource/config.json",
        "resource/tasks/tasks.json",
      ].every((name) => /^[a-f0-9]{64}$/.test(entries[name])),
    "Official archive critical files missing",
  );
  for (const [name, expectedHash] of Object.entries(entries)) {
    requireValue(
      !isAbsolute(name) &&
        !name.includes("\\") &&
        name
          .split("/")
          .every((part) => part && part !== "." && part !== "..") &&
        /^[a-f0-9]{64}$/.test(expectedHash),
      "Unsafe archive inventory entry",
    );
    requireValue(
      (await digestFile(join(directory, name))) === expectedHash,
      "Extracted MaaCore critical files differ from the verified official archive; rerun setup:maacore",
    );
  }
  return `Official archive, provenance, DLLs and config/tasks bytes match ${contract.version}; game certification remains separate`;
}

async function checkOcr(root) {
  for (const [name, expected] of Object.entries(OCR_HASHES))
    requireValue(
      (await digestFile(
        join(root, "games/onmyoji/resources/model/ocr", name),
      )) === expected,
      `OCR ${name} checksum mismatch; run setup:ocr`,
    );
  return "Three fixed OCR artifacts match the setup:ocr SHA-256 pins";
}
async function checkTemplates(root) {
  for (const name of ONMYOJI_TEMPLATES) {
    const bytes = await readFile(
      join(root, "games/onmyoji/resources/image", name),
    );
    requireValue(
      bytes.length > 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString("ascii", 12, 16) === "IHDR" &&
        bytes.readUInt32BE(16) > 0 &&
        bytes.readUInt32BE(20) > 0,
      `Invalid Onmyoji PNG template: ${name}; restore the reviewed repository asset`,
    );
  }
  return "15 reviewed game UI PNG templates present; no account/identity binding is inferred";
}
async function checkDsh(root, options) {
  const directory = options.dshRuntime
    ? resolve(options.dshRuntime)
    : join(root, "integrations/deepseek-harness/runtime");
  const pin = await json(
    join(root, "integrations/deepseek-harness/runtime/node-runtime.json"),
  );
  const info = await json(join(directory, "runtime-build-info.json"));
  const lockPath = join(directory, "package-lock.json");
  const lock = await json(lockPath);
  const manifest = await json(join(directory, "package.json"));
  const mandatory = [
    "dsh",
    "dsh-sdk-client",
    "dsh-sdk-jsonrpc-server",
    "dsh-sdk-protocol",
    "dsh-llm",
    "dsh-session",
    "dsh-session-persistence",
  ];
  requireValue(
    mandatory.every(
      (name) =>
        manifest.dependencies?.[`@deepseek-ai/${name}`] === "0.2.1-alpha.1",
    ) &&
      manifest.dependencies?.["@deepseek-ai/schemastery"] === "3.18.5-alpha.1",
    "Private DSH manifest must retain all fixed official modules",
  );
  requireValue(
    pin.platform === "win32" &&
      pin.arch === "x64" &&
      pin.version === "v24.21.0",
    "Private DSH Node pin is unsupported",
  );
  requireValue(
    info.schemaVersion === 1 &&
      info.dshVersion === "0.2.1-alpha.1" &&
      info.reviewedSourceCommit ===
        "5badb15009ae1756c3afe0ae0cef1faafc290ccc" &&
      info.lockSha256 === (await digestFile(lockPath)),
    "Private DSH build provenance/lock mismatch",
  );
  requireValue(
    info.lockSha256 ===
      (await digestFile(
        join(root, "integrations/deepseek-harness/runtime/package-lock.json"),
      )),
    "Provisioned private DSH lock differs from the reviewed repository lock",
  );
  for (const [field, file] of [
    ["binarySha256", "node.exe"],
    ["licenseSha256", "LICENSE"],
  ])
    requireValue(
      info.node?.[field] === pin[field] &&
        (await digestFile(join(directory, "node", file))) === pin[field],
      "Private DSH Node executable/license SHA-256 mismatch",
    );
  requireValue(
    info.node?.version === pin.version,
    "Private DSH Node version differs from reviewed pin",
  );
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    requireValue(
      /^(?:@[^/]+\/)?[a-zA-Z0-9._-]+$/.test(name),
      "Unsafe private dependency name",
    );
    requireValue(
      lock.packages?.[`node_modules/${name}`]?.version === version &&
        lock.packages?.[""]?.dependencies?.[name] === version &&
        (await json(join(directory, "node_modules", name, "package.json")))
          .version === version,
      "Private DSH dependency differs from fixed lock",
    );
  }
  for (const name of [
    "launcher.mjs",
    "plugin.mjs",
    "gamepilot.cordis.patch.yml",
    "licenses/THIRD_PARTY_NOTICES.json",
    "licenses/Node-LICENSE.txt",
  ])
    requireValue(
      (await lstat(join(directory, name))).isFile(),
      "Private DSH runtime/license inventory incomplete",
    );
  return "Private DSH fixed runtime, dependency lock and Node provenance present; no credentials/runtime process accessed";
}

export async function checkEnvironment(options = {}) {
  const root = resolve(options.root ?? workspace);
  const scope = options.scope ?? "all";
  requireValue(
    ["all", "public", "private"].includes(scope),
    "Unknown setup scope",
  );
  const run = options.run ?? runCommand;
  const checks = [];
  async function check(id, selected, action, remediation) {
    if (!selected) {
      checks.push({
        id,
        status: "not-checked",
        message: "Excluded by explicit scope",
        remediation,
      });
      return;
    }
    try {
      checks.push({
        id,
        status: "passed",
        message: await action(),
        remediation,
      });
    } catch (error) {
      checks.push({
        id,
        status: error.code === "ENOENT" ? "missing" : "invalid",
        message:
          error.code === "ENOENT"
            ? "Required artifact is missing"
            : error.message,
        remediation,
      });
    }
  }
  await check(
    "platform",
    true,
    async () => {
      requireValue(
        (options.platform ?? process.platform) === "win32" &&
          (options.arch ?? process.arch) === "x64",
        "Use Windows x64 for this pinned native distribution",
      );
      return "Windows x64";
    },
    "Use a Windows x64 checkout",
  );
  await check(
    "node-npm-lock",
    true,
    () => checkNodeLock(root, options, run),
    "Use pinned Node/npm, then npm ci in an owned checkout",
  );
  const publicSelected = scope !== "private";
  await check(
    "dotnet",
    publicSelected,
    () => checkDotnet(root, run),
    "Install exact .NET SDK 8.0.400",
  );
  await check(
    "electron",
    publicSelected,
    () => checkElectron(root),
    "npm run setup:electron",
  );
  await check(
    "maacore",
    publicSelected,
    () => checkMaaCore(root, options, run),
    "npm run setup:maacore",
  );
  await check("ocr", publicSelected, () => checkOcr(root), "npm run setup:ocr");
  await check(
    "onmyoji-templates",
    publicSelected,
    () => checkTemplates(root),
    "Restore reviewed repository templates; account templates require manual binding",
  );
  await check(
    "dsh-private",
    scope !== "public",
    () => checkDsh(root, options),
    "Provide reviewed private DSH artifacts, then explicit --install --private --dsh-node <file> --dsh-license <file>",
  );
  return {
    schemaVersion: 1,
    mode: "check",
    scope,
    complete: checks
      .filter((entry) => entry.status !== "not-checked")
      .every((entry) => entry.status === "passed"),
    checks,
    limits: [
      "Account identity binding, real-device execution, seven-day stability and public distribution/source compliance are separate acceptance gates.",
    ],
  };
}

async function assertOwnedTarget(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  requireValue(
    rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "Installation target escaped workspace",
  );
  let current = root;
  for (const segment of ["", ...rel.split(sep)]) {
    if (segment) current = join(current, segment);
    try {
      requireValue(
        !(await lstat(current)).isSymbolicLink(),
        "Installation target traverses a link; use an owned checkout",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function assertNoLinks(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  requireValue(
    !stat.isSymbolicLink(),
    "Installation target contains a link; use an owned checkout",
  );
  if (stat.isDirectory())
    for (const name of await readdir(path))
      await assertNoLinks(join(path, name));
}
export async function installEnvironment(options = {}) {
  const root = resolve(options.root ?? workspace);
  const scope = options.scope ?? "public";
  requireValue(
    scope === "public" || scope === "private",
    "Installation must explicitly select public or private scope",
  );
  requireValue(
    (options.platform ?? process.platform) === "win32" &&
      (options.arch ?? process.arch) === "x64",
    "Install supports Windows x64 only",
  );
  requireValue(
    (options.nodeVersion ?? process.version) === SETUP_PINS.node,
    `Use Node ${SETUP_PINS.node} before installation`,
  );
  if (scope === "private")
    requireValue(
      options.dshNode && options.dshLicense,
      "Private DSH installation requires explicit reviewed --dsh-node and --dsh-license sources",
    );
  const targets =
    scope === "public"
      ? [
          "node_modules",
          "node_modules/electron",
          "artifacts/vendor",
          "games/onmyoji/resources/model/ocr",
        ]
      : ["integrations/deepseek-harness/runtime"];
  for (const target of targets) {
    await assertOwnedTarget(root, target);
    if (target !== "node_modules") await assertNoLinks(join(root, target));
  }
  const run = options.run ?? runCommand;
  if (scope === "public") {
    for (const command of ["setup:electron", "setup:maacore", "setup:ocr"])
      await run("npm", ["run", command], { cwd: root, inherit: true });
  } else
    await run(
      process.execPath,
      [
        join(root, "scripts/setup-dsh-runtime.mjs"),
        "--node",
        resolve(options.dshNode),
        "--node-license",
        resolve(options.dshLicense),
      ],
      { cwd: root, inherit: true },
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    if (options.mode === "install") await installEnvironment(options);
    const report = await checkEnvironment(options);
    console.log(
      options.json
        ? JSON.stringify(report, null, 2)
        : report.checks
            .map(
              (entry) =>
                `${entry.status.padEnd(11)} ${entry.id}: ${entry.message}${entry.status !== "passed" && entry.status !== "not-checked" ? `; ${entry.remediation}` : ""}`,
            )
            .join("\n") + `\n${report.limits.join("\n")}`,
    );
    if (!report.complete) process.exitCode = 1;
  } catch (error) {
    console.error(`Setup refused or failed: ${error.message}`);
    process.exitCode = 1;
  }
}
