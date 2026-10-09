import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  planReleaseRetention,
  pruneReleases,
  windowsRetentionPorts,
  type RetentionInventory,
} from "../scripts/release/prune-releases.mjs";

const root = "D:\\Desktop\\yys\\gamepilot\\release";
const path = (version: string) => `${root}\\GamePilot-${version}`;
function inventory(
  versions = ["0.14.49", "0.15.9", "0.15.10", "0.15.11"],
): RetentionInventory {
  return {
    root: { path: root, resolvedPath: root, reparsePoint: false },
    releases: versions.map((version) => ({
      path: path(version),
      resolvedPath: path(version),
      reparsePoint: false,
      treeHasReparsePoint: false,
      manifestVersion: version.replace("-native-tested", ""),
      manifestSha256: "a".repeat(64),
      manifestFilesMatch: true,
    })),
    references: { complete: true, values: [] },
  };
}

describe("release retention planning", () => {
  it("retains the latest two numeric versions, not lexicographic names", () => {
    const plan = planReleaseRetention({ releaseRoot: root }, inventory());
    expect(plan.candidates).toEqual([path("0.14.49"), path("0.15.9")]);
    expect(plan.retained.map((entry) => entry.path)).toEqual([
      path("0.15.10"),
      path("0.15.11"),
    ]);
  });
  it("retains both copies of a latest known native-tested version", () => {
    const plan = planReleaseRetention(
      { releaseRoot: root },
      inventory(["0.14.43", "0.14.44", "0.14.45", "0.14.45-native-tested"]),
    );
    expect(plan.candidates).toEqual([path("0.14.43")]);
    expect(plan.retained).toHaveLength(3);
  });
  it.each([
    `"${path("0.14.49")}\\GamePilot.exe" --autostart`,
    `${path("0.14.49")}\\resources\\app\\dist\\maa-bridge\\GamePilot.MaaBridge.exe`,
    `${path("0.14.49")}\\GamePilot.exe,0`,
    path("0.14.49").toLowerCase().replaceAll("\\", "/"),
  ])(
    "retains old releases referenced by process, Run, shortcut or working directory: %s",
    (reference) => {
      const state = inventory();
      state.references.values = [reference];
      const plan = planReleaseRetention({ releaseRoot: root }, state);
      expect(plan.candidates).toEqual([path("0.15.9")]);
    },
  );
  it("keeps explicit existing release names and never consumes unknown keeps", () => {
    expect(
      planReleaseRetention(
        { releaseRoot: root, keep: ["GamePilot-0.14.49"] },
        inventory(),
      ).candidates,
    ).toEqual([path("0.15.9")]);
    expect(() =>
      planReleaseRetention(
        { releaseRoot: root, keep: ["GamePilot-0.15.99"] },
        inventory(),
      ),
    ).toThrow();
    expect(() =>
      planReleaseRetention(
        { releaseRoot: root, keep: ["../GamePilot-0.14.49"] },
        inventory(),
      ),
    ).toThrow();
  });
  it.each([
    "D:\\",
    "D:release",
    "release",
    "D:\\other",
    "D:\\a\\..\\release",
    "D:\\safe.\\release",
    "\\\\server\\share\\release",
  ])("refuses unsafe or unknown root %s", (releaseRoot) => {
    expect(() => planReleaseRetention({ releaseRoot }, inventory())).toThrow();
  });
  it.each([
    "missing-root",
    "resolved-elsewhere",
    "root-reparse",
    "entry-reparse",
    "nested-reparse",
    "duplicate",
    "outside",
    "nested",
    "traversal",
    "unknown-name",
    "invented-suffix",
    "refs-failed",
    "refs-malformed",
    "manifest-version",
    "manifest-hash",
    "unlisted-files",
  ])("refuses incomplete or unsafe inventory: %s", (kind) => {
    const state = inventory();
    if (kind === "missing-root")
      delete (state as Partial<RetentionInventory>).root;
    if (kind === "resolved-elsewhere")
      state.root.resolvedPath = "D:\\other\\release";
    if (kind === "root-reparse") state.root.reparsePoint = true;
    if (kind === "entry-reparse") state.releases[0].reparsePoint = true;
    if (kind === "nested-reparse") state.releases[0].treeHasReparsePoint = true;
    if (kind === "duplicate")
      state.releases.push({
        ...state.releases[0],
        path: state.releases[0].path.toUpperCase(),
      });
    if (kind === "outside")
      state.releases[0].path = "D:\\other\\GamePilot-0.14.49";
    if (kind === "nested")
      state.releases[0].path = `${root}\\nested\\GamePilot-0.14.49`;
    if (kind === "traversal")
      state.releases[0].path = `${root}\\..\\release\\GamePilot-0.14.49`;
    if (kind === "unknown-name")
      state.releases[0].path = `${root}\\node_modules`;
    if (kind === "invented-suffix")
      state.releases[0].path = `${root}\\GamePilot-0.14.49-native-tested`;
    if (kind === "refs-failed") state.references.complete = false;
    if (kind === "refs-malformed")
      (state.references.values as unknown[]).push(null);
    if (kind === "manifest-version")
      state.releases[0].manifestVersion = "0.15.11";
    if (kind === "manifest-hash") state.releases[0].manifestSha256 = "";
    if (kind === "unlisted-files") state.releases[0].manifestFilesMatch = false;
    expect(() => planReleaseRetention({ releaseRoot: root }, state)).toThrow();
  });
});

describe("release pruning orchestration", () => {
  it("previews by default without invoking deletion", async () => {
    const ports = { read: vi.fn(async () => inventory()), apply: vi.fn() };
    const result = await pruneReleases({ releaseRoot: root }, ports);
    expect(result.mode).toBe("preview");
    expect(result.deleted).toEqual([]);
    expect(ports.apply).not.toHaveBeenCalled();
  });
  it("rechecks references before apply and rejects a newly active old release", async () => {
    const fresh = inventory();
    fresh.references.values = [path("0.14.49")];
    const ports = {
      read: vi
        .fn()
        .mockResolvedValueOnce(inventory())
        .mockResolvedValueOnce(fresh),
      apply: vi.fn(),
    };
    await expect(
      pruneReleases({ releaseRoot: root, apply: true }, ports),
    ).rejects.toThrow(/changed/i);
    expect(ports.apply).not.toHaveBeenCalled();
  });
  it("does not delete after failed recheck or a new symlink", async () => {
    for (const kind of ["read-failed", "symlink"]) {
      const fresh = inventory();
      fresh.releases[0].treeHasReparsePoint = true;
      const read = vi.fn().mockResolvedValueOnce(inventory());
      if (kind === "read-failed")
        read.mockRejectedValueOnce(Error("inventory failed"));
      else read.mockResolvedValueOnce(fresh);
      const ports = { read, apply: vi.fn() };
      await expect(
        pruneReleases({ releaseRoot: root, apply: true }, ports),
      ).rejects.toThrow();
      expect(ports.apply).not.toHaveBeenCalled();
    }
  });
  it("requires confirmed deletion output before reporting applied success", async () => {
    const ports = {
      read: vi.fn(async () => inventory()),
      apply: vi.fn(async () => ({ deleted: [] })),
    };
    await expect(
      pruneReleases({ releaseRoot: root, apply: true }, ports),
    ).rejects.toThrow(/verification/i);
  });
  it("rejects a changed manifest between preview and apply", async () => {
    const fresh = inventory();
    fresh.releases[0].manifestSha256 = "b".repeat(64);
    const ports = {
      read: vi
        .fn()
        .mockResolvedValueOnce(inventory())
        .mockResolvedValueOnce(fresh),
      apply: vi.fn(),
    };
    await expect(
      pruneReleases({ releaseRoot: root, apply: true }, ports),
    ).rejects.toThrow(/changed/i);
    expect(ports.apply).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")(
  "PowerShell retention error transport",
  () => {
    afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
    function failWith(stderr: string, error = Error("process failed")) {
      const spawn = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
        callback(error, "", stderr);
        return { stdin: { on() {}, end() {} } } as unknown as ReturnType<typeof childProcess.execFile>;
      });
      syncBuiltinESMExports();
      return spawn;
    }
    it("disables module and task progress in the actual bootstrap", async () => {
      const spawn = failWith("fixture failure");
      await expect(windowsRetentionPorts().read({ releaseRoot: root })).rejects.toThrow("fixture failure");
      const args = spawn.mock.calls[0][1] as string[];
      expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le"))
        .toContain("$ProgressPreference='SilentlyContinue'");
      expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 600000 });
    });
    it.each([[2, 660000], [102, 3600000]])(
      "bounds apply timeout for %i candidates at %i ms",
      async (count, timeout) => {
        const spawn = failWith("fixture failure");
        const plan = planReleaseRetention({ releaseRoot: root }, inventory(
          Array.from({ length: count + 2 }, (_, index) => `0.14.${index}`),
        ));
        expect(plan.candidates).toHaveLength(count);
        await expect(windowsRetentionPorts().apply(plan)).rejects.toThrow("fixture failure");
        expect(spawn.mock.calls[0][2]).toMatchObject({ timeout });
      },
    );
    it.each([{ killed: true }, { signal: "SIGTERM" }])(
      "reports interrupted deletion without exposing the encoded command: %j",
      async (termination) => {
        failWith("", Object.assign(Error("Command failed: powershell.exe -EncodedCommand private-bootstrap"), termination));
        const attempt = windowsRetentionPorts().read({ releaseRoot: root });
        await expect(attempt).rejects.toThrow("操作超时或被终止，需检查已完成删除");
        await expect(attempt).rejects.not.toThrow(/EncodedCommand|private-bootstrap/);
      },
    );
    it("extracts the CLIXML error after a large progress prefix", async () => {
      failWith('#< CLIXML\n<Objs>' + '<Obj S="progress">noise</Obj>'.repeat(300) +
        '<S S="Error">Stopped after 4 deletions: access &amp; reference denied_x000D__x000A_</S></Objs>');
      await expect(windowsRetentionPorts().read({ releaseRoot: root })).rejects.toThrow(
        "Stopped after 4 deletions: access & reference denied",
      );
    });
    it("preserves the error tail when stderr is plain", async () => {
      failWith("progress ".repeat(1000) + "actual failure at the end");
      await expect(windowsRetentionPorts().read({ releaseRoot: root })).rejects.toThrow("actual failure at the end");
    });
    it("preserves a truncated final CLIXML error after complete error records", async () => {
      failWith('#< CLIXML\n<Objs><S S="Error">earlier error context_x000D__x000A_</S>' +
        '<S S="Error">Stopped after 4 deletions: final access failure');
      await expect(windowsRetentionPorts().read({ releaseRoot: root })).rejects.toThrow(
        "Stopped after 4 deletions: final access failure",
      );
    });
  },
);

describe.skipIf(process.platform !== "win32")(
  "Windows literal-path removal in isolated fixtures",
  () => {
    const temporary: string[] = [];
    afterEach(async () => {
      for (const folder of temporary.splice(0)) {
        if (
          !resolve(folder).startsWith(
            resolve(tmpdir(), "gamepilot-retention-test-"),
          )
        )
          throw Error("Unexpected fixture root");
        await rm(folder, { recursive: true, force: true });
      }
    });
    async function fixture(kind = "normal") {
      const sandbox = await mkdtemp(
        join(tmpdir(), "gamepilot-retention-test-"),
      );
      temporary.push(sandbox);
      const releaseRoot = join(sandbox, "release");
      await mkdir(releaseRoot);
      for (const version of ["0.14.49", "0.15.10", "0.15.11"]) {
        const directory = join(releaseRoot, `GamePilot-${version}`);
        await mkdir(directory);
        await writeFile(join(directory, "GamePilot.exe"), "fixture-only");
        await writeFile(
          join(directory, "package-manifest.json"),
          JSON.stringify({
            version,
            files: {
              "GamePilot.exe": createHash("sha256")
                .update("fixture-only")
                .digest("hex"),
            },
          }),
        );
      }
      const execute = async (script: string, input: unknown) => {
        const override = kind.startsWith("registry-") || kind.startsWith("process-")
          ? `
function Get-CimInstance {
  [CmdletBinding()]param($ClassName,$Filter)
  if (!$fixture.kind.StartsWith('process-')) { return @() }
  if ($Filter) {
    if ($Filter -cne 'ProcessId = 731') { throw 'Unexpected PID recheck' }
    if ($fixture.kind -eq 'process-recheck-failed') { throw 'Process reference recheck failed' }
    if ($fixture.kind -eq 'process-gone') { return @() }
  }
  return [pscustomobject]@{Name='GamePilot.exe';ProcessId=731;ExecutablePath=$null;CommandLine=$null}
}
function Get-ScheduledTask { return @() }
function New-Object { return [pscustomobject]@{} }
function Test-Path { return $false }
function Get-Item {
  [CmdletBinding()]param($LiteralPath,[switch]$Force)
  if ($LiteralPath -match '^HK') {
    if ($fixture.kind -eq 'registry-local-failed') { throw 'Local Run reference access denied' }
    throw [System.Management.Automation.ItemNotFoundException]::new('Missing fixture registry key')
  }
  Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
}
function Invoke-CimMethod {
  param($Namespace,$ClassName,$MethodName,$Arguments)
  if ($fixture.kind -eq 'registry-system-failed') { return [pscustomobject]@{ReturnValue=5} }
  if ($fixture.kind -eq 'registry-system-reference') {
    if ($MethodName -eq 'EnumValues') { return [pscustomobject]@{ReturnValue=0;sNames=@('GamePilot');Types=@(1)} }
    return [pscustomobject]@{ReturnValue=0;sValue=(Join-Path $fixture.releaseRoot 'GamePilot-0.14.49\\GamePilot.exe')}
  }
  return [pscustomobject]@{ReturnValue=0;sNames=$null;Types=$null}
}
`
          : `
function Get-ReferenceValues {
  $script:referenceReads++
  if ($fixture.kind -eq 'failure') { throw 'Reference inventory failed' }
  if (($fixture.kind -eq 'late-reference' -and $script:referenceReads -ge 2) -or $script:referenceDuringTree) {
    return (Join-Path $fixture.releaseRoot 'GamePilot-0.14.49\\GamePilot.exe')
  }
  return @()
}
if ($fixture.kind -eq 'reference-during-tree') {
  $script:originalTreeCheck = (Get-Command Get-ReleaseDirectory).ScriptBlock
  function Get-ReleaseDirectory([string]$root, [string]$path) {
    $result = & $script:originalTreeCheck $root $path
    if ($script:referenceReads -ge 1) { $script:referenceDuringTree = $true }
    return $result
  }
}
`;
        const source = `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$fixture = $payload.fixture
$inputData = $fixture.input
$script:referenceReads = 0
& ([scriptblock]::Create($payload.script))
`;
        try {
          return JSON.parse(
            execFileSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(source, "utf16le").toString("base64"),
              ],
              {
                encoding: "utf8",
                input: JSON.stringify({
                  fixture: { input, kind, releaseRoot },
                  script: script.replace(
                    "# RETENTION_OPERATION",
                    override + "\n# RETENTION_OPERATION",
                  ),
                }),
                windowsHide: true,
                timeout: 15000,
                stdio: ["pipe", "pipe", "pipe"],
              },
            ).replace(/^\uFEFF/, ""),
          );
        } catch (error) {
          throw Error(String((error as { stderr?: unknown }).stderr ?? error));
        }
      };
      return {
        releaseRoot,
        ports: windowsRetentionPorts(execute),
        oldest: join(releaseRoot, "GamePilot-0.14.49"),
      };
    }
    it("previews without removal and applies only the old direct child", async () => {
      const f = await fixture();
      const preview = await pruneReleases(
        { releaseRoot: f.releaseRoot },
        f.ports,
      );
      expect(preview.plan.candidates).toEqual([f.oldest]);
      expect(await readFile(join(f.oldest, "GamePilot.exe"), "utf8")).toBe(
        "fixture-only",
      );
      const result = await pruneReleases(
        { releaseRoot: f.releaseRoot, apply: true },
        f.ports,
      );
      expect(result.deleted).toEqual([f.oldest]);
      await expect(
        readFile(join(f.oldest, "GamePilot.exe")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(
          join(f.releaseRoot, "GamePilot-0.15.11/GamePilot.exe"),
          "utf8",
        ),
      ).toBe("fixture-only");
    }, 20000);
    it.each(["failure", "late-reference", "reference-during-tree"])(
      "refuses %s in the actual apply process without deleting the fixture",
      async (kind) => {
        const f = await fixture(kind);
        await expect(
          pruneReleases({ releaseRoot: f.releaseRoot, apply: true }, f.ports),
        ).rejects.toThrow(/reference/i);
        expect(await readFile(join(f.oldest, "GamePilot.exe"), "utf8")).toBe(
          "fixture-only",
        );
      },
      20000,
    );
    it("refuses extra unlisted files rather than deleting possible user data", async () => {
      const f = await fixture();
      await writeFile(join(f.oldest, "notes.txt"), "must keep");
      await expect(
        pruneReleases({ releaseRoot: f.releaseRoot, apply: true }, f.ports),
      ).rejects.toThrow(/manifest|inventory/i);
      expect(await readFile(join(f.oldest, "notes.txt"), "utf8")).toBe(
        "must keep",
      );
    });
    it("handles empty system Run keys without mistaking enumeration for a value", async () => {
      const f = await fixture("registry-empty");
      expect(
        (await pruneReleases({ releaseRoot: f.releaseRoot }, f.ports)).plan
          .candidates,
      ).toEqual([f.oldest]);
    });
    it("skips a vanished unreadable process only after a successful PID recheck", async () => {
      const f = await fixture("process-gone");
      expect((await pruneReleases({ releaseRoot: f.releaseRoot }, f.ports)).plan.candidates)
        .toEqual([f.oldest]);
    });
    it.each(["process-present", "process-recheck-failed"])(
      "fails closed when the unreadable process is not confirmed gone: %s",
      async (kind) => {
        const f = await fixture(kind);
        await expect(pruneReleases({ releaseRoot: f.releaseRoot }, f.ports)).rejects.toThrow(/process reference/i);
        expect(await readFile(join(f.oldest, "GamePilot.exe"), "utf8")).toBe("fixture-only");
      },
    );
    it.each(["registry-local-failed", "registry-system-failed"])(
      "fails closed on %s",
      async (kind) => {
        const f = await fixture(kind);
        await expect(
          pruneReleases({ releaseRoot: f.releaseRoot }, f.ports),
        ).rejects.toThrow(/reference/i);
        expect(await readFile(join(f.oldest, "GamePilot.exe"), "utf8")).toBe(
          "fixture-only",
        );
      },
    );
    it("keeps an old package referenced only by the actual system registry view", async () => {
      const f = await fixture("registry-system-reference");
      expect(
        (await pruneReleases({ releaseRoot: f.releaseRoot }, f.ports)).plan
          .candidates,
      ).toEqual([]);
    });
    it("refuses an actual nested junction without touching its target", async () => {
      const f = await fixture();
      const target = join(f.releaseRoot, "outside-package");
      await mkdir(target);
      await writeFile(join(target, "sentinel"), "keep");
      const link = join(f.oldest, "vendor");
      await symlink(target, link, "junction");
      try {
        await expect(
          pruneReleases({ releaseRoot: f.releaseRoot, apply: true }, f.ports),
        ).rejects.toThrow(/reparse/i);
        expect(await readFile(join(target, "sentinel"), "utf8")).toBe("keep");
      } finally {
        await unlink(link);
      }
    });
  },
);
