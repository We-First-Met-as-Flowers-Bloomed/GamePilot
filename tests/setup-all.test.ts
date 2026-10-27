import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkEnvironment,
  installEnvironment,
  parseSetupArgs,
  SETUP_PINS,
  ONMYOJI_TEMPLATES,
} from "../scripts/setup-all.mjs";

const roots: string[] = [];
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamepilot-setup-"));
  roots.push(root);
  async function put(path: string, contents: unknown) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(
      join(root, path),
      typeof contents === "string" || Buffer.isBuffer(contents)
        ? contents
        : JSON.stringify(contents),
    );
  }
  const dependencies = { electron: "44.3.0", "@maaxyz/maa-node": "5.13.0" };
  await put("package.json", {
    name: "fixture",
    version: "1.0.0",
    dependencies,
  });
  await put("package-lock.json", {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies },
      "node_modules/electron": {
        version: "44.3.0",
        integrity: "sha512-fixture",
      },
      "node_modules/@maaxyz/maa-node": {
        version: "5.13.0",
        integrity: "sha512-fixture",
      },
    },
  });
  await put("global.json", {
    sdk: { version: "8.0.400", rollForward: "disable", allowPrerelease: false },
  });
  for (const [name, version] of Object.entries(dependencies))
    await put(`node_modules/${name}/package.json`, { version });
  await put("node_modules/electron/path.txt", "electron.exe");
  await put("node_modules/electron/dist/electron.exe", "fixture electron");
  await put("node_modules/electron/dist/version", "44.3.0");
  const archive = Buffer.from("fixture official archive");
  const version = "v1.0.0";
  const sha256 = hash(archive);
  const asset = `MAA-${version}-win-x64.zip`;
  await put("games/arknights/engine-contract.json", {
    version,
    archiveSha256: sha256,
  });
  await put(`artifacts/vendor/${asset}`, archive);
  await put(`artifacts/vendor/maa-${version}/gamepilot-provenance.json`, {
    version,
    asset,
    sha256,
    url: `https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/download/${version}/${asset}`,
    source: `https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/${version}`,
    digestSource: `https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/expanded_assets/${version}`,
    license: "AGPL-3.0",
  });
  await put(`artifacts/vendor/maa-${version}/MaaCore.dll`, "official dll");
  await put(
    `artifacts/vendor/maa-${version}/resource/config.json`,
    "official config",
  );
  await put(
    `artifacts/vendor/maa-${version}/resource/tasks/tasks.json`,
    "official tasks",
  );
  await put("integrations/deepseek-harness/runtime/node-runtime.json", {
    platform: "win32",
    arch: "x64",
    version: "v24.21.0",
    binarySha256: "a".repeat(64),
    licenseSha256: "b".repeat(64),
  });
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === "dotnet" && args[0] === "--list-sdks")
      return "8.0.400 [sdk]\n8.0.401 [sdk]";
    if (command === "dotnet" && args[0] === "--version") return "8.0.400";
    if (command === "npm" && args[0] === "--version") return SETUP_PINS.npm;
    throw Error(`Unexpected command ${command}`);
  });
  const archiveEntries = vi.fn(async () => ({
    "MaaCore.dll": hash("official dll"),
    "resource/config.json": hash("official config"),
    "resource/tasks/tasks.json": hash("official tasks"),
  }));
  const options = {
    root,
    platform: "win32",
    arch: "x64",
    nodeVersion: SETUP_PINS.node,
    run,
    archiveEntries,
  };
  return { root, put, options, run, archiveEntries };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const check = (
  report: Awaited<ReturnType<typeof checkEnvironment>>,
  id: string,
) =>
  report.checks.find((entry) => entry.id === id) ?? {
    id,
    status: "not-checked",
  };

async function privateFixture() {
  const state = await fixture();
  const base = "integrations/deepseek-harness/runtime";
  const dependencies = Object.fromEntries(
    [
      "dsh",
      "dsh-sdk-client",
      "dsh-sdk-jsonrpc-server",
      "dsh-sdk-protocol",
      "dsh-llm",
      "dsh-session",
      "dsh-session-persistence",
    ].map((name) => [`@deepseek-ai/${name}`, "0.2.1-alpha.1"]),
  );
  dependencies["@deepseek-ai/schemastery"] = "3.18.5-alpha.1";
  const packages = {
    "": { dependencies },
    ...Object.fromEntries(
      Object.entries(dependencies).map(([name, version]) => [
        `node_modules/${name}`,
        { version, integrity: "sha512-fixture" },
      ]),
    ),
  };
  const lock = JSON.stringify({ lockfileVersion: 3, packages });
  const node = "synthetic test node bytes, never executed";
  const license = "synthetic test license";
  const pin = {
    platform: "win32",
    arch: "x64",
    version: "v24.21.0",
    binarySha256: hash(node),
    licenseSha256: hash(license),
  };
  await state.put(`${base}/node-runtime.json`, pin);
  await state.put(`${base}/package.json`, { dependencies });
  await state.put(`${base}/package-lock.json`, lock);
  await state.put(`${base}/node/node.exe`, node);
  await state.put(`${base}/node/LICENSE`, license);
  await state.put(`${base}/licenses/Node-LICENSE.txt`, license);
  await state.put(`${base}/licenses/THIRD_PARTY_NOTICES.json`, []);
  for (const [name, version] of Object.entries(dependencies))
    await state.put(`${base}/node_modules/${name}/package.json`, { version });
  for (const name of [
    "launcher.mjs",
    "plugin.mjs",
    "gamepilot.cordis.patch.yml",
  ])
    await state.put(`${base}/${name}`, "fixture only");
  const info = {
    schemaVersion: 1,
    dshVersion: "0.2.1-alpha.1",
    reviewedSourceCommit: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    lockSha256: hash(lock),
    node: pin,
  };
  await state.put(`${base}/runtime-build-info.json`, info);
  return { ...state, base, info };
}

describe("read-only setup and installation boundaries", () => {
  it.runIf(process.platform === "win32")(
    "compares real official ZIP entries without extracting or executing them",
    async () => {
      const { root, put, options, run } = await fixture();
      const archive = join(root, "artifacts/vendor/MAA-v1.0.0-win-x64.zip");
      await rm(archive);
      await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open($env:GAMEPILOT_TEST_ARCHIVE, 'Create'); try { foreach ($item in @(@('MaaCore.dll','official dll'),@('resource/config.json','official config'),@('resource/tasks/tasks.json','official tasks'))) { $entry=$zip.CreateEntry($item[0]); $writer=New-Object IO.StreamWriter($entry.Open()); try {$writer.Write($item[1])} finally {$writer.Dispose()} } } finally {$zip.Dispose()}",
        ],
        {
          env: { ...process.env, GAMEPILOT_TEST_ARCHIVE: archive },
          windowsHide: true,
        },
      );
      const sha256 = hash(await readFile(archive));
      await put("games/arknights/engine-contract.json", {
        version: "v1.0.0",
        archiveSha256: sha256,
      });
      const provenance = JSON.parse(
        await readFile(
          join(root, "artifacts/vendor/maa-v1.0.0/gamepilot-provenance.json"),
          "utf8",
        ),
      );
      await put("artifacts/vendor/maa-v1.0.0/gamepilot-provenance.json", {
        ...provenance,
        sha256,
      });
      const actualRun = async (
        command: string,
        args: string[],
        settings?: { cwd?: string; env?: NodeJS.ProcessEnv },
      ) =>
        command === "powershell.exe"
          ? (
              await promisify(execFile)(command, args, {
                ...settings,
                windowsHide: true,
              })
            ).stdout.trim()
          : run(command, args);
      expect(
        check(
          await checkEnvironment({
            ...options,
            archiveEntries: undefined,
            run: actualRun,
            scope: "public",
          }),
          "maacore",
        ).status,
      ).toBe("passed");
      expect((await readdir(join(root, "artifacts/vendor"))).sort()).toEqual(
        ["MAA-v1.0.0-win-x64.zip", "maa-v1.0.0"].sort(),
      );
    },
  );

  it("checks PNG structure and refuses corrupted OCR instead of accepting file existence", async () => {
    const { options, put } = await fixture();
    const png = Buffer.alloc(25);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    for (const name of ONMYOJI_TEMPLATES)
      await put(`games/onmyoji/resources/image/${name}`, png);
    await put("games/onmyoji/resources/model/ocr/det.onnx", "bad model");
    const report = await checkEnvironment({ ...options, scope: "public" });
    expect(check(report, "onmyoji-templates").status).toBe("passed");
    expect(check(report, "ocr").status).toBe("invalid");
    await put(
      `games/onmyoji/resources/image/${ONMYOJI_TEMPLATES[0]}`,
      "bad PNG",
    );
    expect(
      check(
        await checkEnvironment({ ...options, scope: "public" }),
        "onmyoji-templates",
      ).status,
    ).toBe("invalid");
  });

  it("rejects private locks that omit the mandatory official DSH modules", async () => {
    const { options, put, base, info } = await privateFixture();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: {} } },
    });
    await put(`${base}/package.json`, { dependencies: {} });
    await put(`${base}/package-lock.json`, lock);
    await put(`${base}/runtime-build-info.json`, {
      ...info,
      lockSha256: hash(lock),
    });
    expect(
      check(
        await checkEnvironment({ ...options, scope: "private" }),
        "dsh-private",
      ).status,
    ).toBe("invalid");
  });
  it("defaults to a read-only check and rejects ambiguous or unknown flags", () => {
    expect(parseSetupArgs([])).toMatchObject({ mode: "check", scope: "all" });
    expect(parseSetupArgs(["--check", "--public", "--json"])).toMatchObject({
      mode: "check",
      scope: "public",
      json: true,
    });
    expect(() => parseSetupArgs(["--check", "--install"])).toThrow();
    expect(() => parseSetupArgs(["--public", "--private"])).toThrow();
    expect(() => parseSetupArgs(["--download-everything"])).toThrow();
  });

  it("checks public prerequisites without changing files or launching a runtime", async () => {
    const { root, options, run } = await fixture();
    const before = await readFile(join(root, "package-lock.json"), "utf8");
    const report = await checkEnvironment({ ...options, scope: "public" });
    expect(check(report, "node-npm-lock").status).toBe("passed");
    expect(check(report, "dotnet").status).toBe("passed");
    expect(check(report, "electron").status).toBe("passed");
    expect(check(report, "maacore").status).toBe("passed");
    expect(check(report, "ocr").status).toBe("missing");
    expect(check(report, "onmyoji-templates").status).toBe("missing");
    expect(check(report, "dsh-private").status).toBe("not-checked");
    expect(report.complete).toBe(false);
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(
      before,
    );
    expect(await readdir(join(root, "artifacts"))).toEqual(["vendor"]);
    expect(
      run.mock.calls.every(([command]) => ["npm", "dotnet"].includes(command)),
    ).toBe(true);
  });

  it("requires the exact selected SDK rather than another installed .NET 8 SDK", async () => {
    const { options, run } = await fixture();
    run.mockImplementation(async (command, args) =>
      command === "npm"
        ? SETUP_PINS.npm
        : args[0] === "--list-sdks"
          ? "8.0.401 [sdk]"
          : "8.0.401",
    );
    expect(
      check(await checkEnvironment({ ...options, scope: "public" }), "dotnet")
        .status,
    ).toBe("invalid");
  });

  it("rejects SDK roll-forward and lock/installed dependency drift", async () => {
    const { put, options } = await fixture();
    await put("global.json", {
      sdk: { version: "8.0.400", rollForward: "latestPatch" },
    });
    await put("node_modules/electron/package.json", { version: "44.4.0" });
    const report = await checkEnvironment({ ...options, scope: "public" });
    expect(check(report, "dotnet").status).toBe("invalid");
    expect(check(report, "node-npm-lock").status).toBe("invalid");
  });

  it.each(["archive", "metadata", "extracted"])(
    "rejects MaaCore %s drift",
    async (kind) => {
      const { put, options } = await fixture();
      if (kind === "archive")
        await put("artifacts/vendor/MAA-v1.0.0-win-x64.zip", "tampered");
      if (kind === "metadata")
        await put("artifacts/vendor/maa-v1.0.0/gamepilot-provenance.json", {
          version: "v1.0.0",
          sha256: hash("fixture official archive"),
          url: "https://untrusted.invalid/maa.zip",
        });
      if (kind === "extracted")
        await put("artifacts/vendor/maa-v1.0.0/MaaCore.dll", "tampered dll");
      expect(
        check(
          await checkEnvironment({ ...options, scope: "public" }),
          "maacore",
        ).status,
      ).toBe("invalid");
    },
  );

  it("reports private DSH absence separately and never manufactures it", async () => {
    const { root, options } = await fixture();
    const report = await checkEnvironment({ ...options, scope: "private" });
    expect(report.complete).toBe(false);
    expect(check(report, "dsh-private").status).toBe("missing");
    expect(
      await readdir(join(root, "integrations/deepseek-harness/runtime")),
    ).toEqual(["node-runtime.json"]);
  });

  it("runs only explicitly selected public installers sequentially", async () => {
    const { options } = await fixture();
    const run = vi.fn(async () => "");
    await installEnvironment({ ...options, scope: "public", run });
    expect(run.mock.calls).toEqual([
      ["npm", ["run", "setup:electron"], expect.any(Object)],
      ["npm", ["run", "setup:maacore"], expect.any(Object)],
      ["npm", ["run", "setup:ocr"], expect.any(Object)],
    ]);
  });

  it("refuses a linked installation target before invoking any installer", async () => {
    const { root, options } = await fixture();
    await rm(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "shared"));
    await symlink(
      join(root, "shared"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const run = vi.fn(async () => "");
    await expect(
      installEnvironment({ ...options, scope: "public", run }),
    ).rejects.toThrow("link");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses nested linked files that an existing installer would replace", async () => {
    const { root, options } = await fixture();
    await mkdir(join(root, "games/onmyoji/resources/model/ocr"), {
      recursive: true,
    });
    await writeFile(join(root, "outside-model"), "shared data");
    await symlink(
      join(root, "outside-model"),
      join(root, "games/onmyoji/resources/model/ocr/det.onnx"),
      "file",
    );
    const run = vi.fn(async () => "");
    await expect(
      installEnvironment({ ...options, scope: "public", run }),
    ).rejects.toThrow("link");
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(join(root, "outside-model"), "utf8")).toBe(
      "shared data",
    );
  });

  it("refuses unsupported Node before any download command", async () => {
    const { options } = await fixture();
    const run = vi.fn(async () => "");
    await expect(
      installEnvironment({
        ...options,
        nodeVersion: "v21.0.0",
        scope: "public",
        run,
      }),
    ).rejects.toThrow("Node");
    expect(run).not.toHaveBeenCalled();
  });

  it("requires explicit reviewed DSH source paths before private installation", async () => {
    const { options } = await fixture();
    const run = vi.fn(async () => "");
    await expect(
      installEnvironment({ ...options, scope: "private", run }),
    ).rejects.toThrow("DSH");
    expect(run).not.toHaveBeenCalled();
  });
});
