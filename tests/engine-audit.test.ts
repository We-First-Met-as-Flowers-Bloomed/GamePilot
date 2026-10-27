import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditEngine,
  planEngineRollback,
  parseEngineArgs,
} from "../scripts/engine-audit.mjs";

const roots: string[] = [];
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function crc(bytes: Buffer) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name),
      data = Buffer.from(text),
      h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc(data), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(h, n, data);
    central.push(ch, n);
    offset += h.length + n.length + data.length;
  }
  const cd = Buffer.concat(central),
    e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, e]);
}
async function fixture(version = "v6.19.0-beta.2") {
  const root = await mkdtemp(join(tmpdir(), "gamepilot-engine-audit-"));
  roots.push(root);
  const put = async (path: string, data: unknown) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(
      join(root, path),
      typeof data === "string" || Buffer.isBuffer(data)
        ? data
        : JSON.stringify(data),
    );
  };
  const files = {
    "MaaCore.dll": "official DLL",
    "dependency.dll": "dependency",
    "resource/config.json": "{}",
    "resource/tasks/tasks.json": '{"StartUp":{}}',
    "resource/template/home.png": "fixture resource",
  };
  const archive = zip(files),
    asset = `MAA-${version}-win-x64.zip`,
    bundle = `artifacts/vendor/maa-${version}`;
  const contract = {
    version,
    archiveSha256: sha(archive),
    awardOptions: {
      award: { supported: true },
      signinevent: {
        supported: false,
        minVersion: "v6.18.0",
        configKey: "signInEvent",
      },
    },
  };
  await put("games/arknights/engine-contract.json", contract);
  await put(
    "games/arknights/index.ts",
    'export const game={skills:[{id:"login"},{id:"award"}]};',
  );
  await put(
    "games/arknights/config.ts",
    'export function taskFor(id){switch(id){case "login":return {type:"StartUp",params:{client_type:"Official",start_game_enabled:true}};case "award":return {type:"Award",params:{award:true,mail:false,recruit:false,orundum:false,mining:false,specialaccess:false}};}}',
  );
  await put(`artifacts/vendor/${asset}`, archive);
  const origin =
    "https://github.com/MaaAssistantArknights/MaaAssistantArknights";
  await put(`${bundle}/gamepilot-provenance.json`, {
    version,
    asset,
    sha256: sha(archive),
    url: `${origin}/releases/download/${version}/${asset}`,
    source: `${origin}/tree/${version}`,
    digestSource: `${origin}/releases/expanded_assets/${version}`,
    license: "AGPL-3.0",
  });
  for (const [name, data] of Object.entries(files))
    await put(`${bundle}/${name}`, data);
  return {
    root,
    put,
    bundle: join(root, bundle),
    contractFile: join(root, "games/arknights/engine-contract.json"),
    archive: join(root, `artifacts/vendor/${asset}`),
  };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("fixed local engine audit", () => {
  it("checks ZIP provenance and all native/resource bytes but never upgrades certification by version", async () => {
    const { root } = await fixture();
    const report = await auditEngine({ root });
    expect(report.status).toBe("ready-for-review");
    expect(report.files).toHaveLength(5);
    expect(
      report.skills.every((s) => s.certification === "pending-real-device"),
    ).toBe(true);
    expect(report.skills.find((s) => s.id === "login")?.params).toEqual([
      "client_type",
      "start_game_enabled",
    ]);
    expect(
      report.awardOptions.find((o) => o.key === "signinevent"),
    ).toMatchObject({ supported: false, certification: "unsupported" });
  });
  it("blocks modified resource, untracked binary and forged archive", async () => {
    const { root, put } = await fixture();
    await put(
      "artifacts/vendor/maa-v6.19.0-beta.2/resource/template/home.png",
      "altered",
    );
    await put("artifacts/vendor/maa-v6.19.0-beta.2/extra.dll", "not upstream");
    const report = await auditEngine({ root });
    expect(report.status).toBe("blocked");
    expect(report.gaps.join(" ")).toContain("home.png");
    expect(report.gaps.join(" ")).toContain("extra.dll");
    await put(
      "artifacts/vendor/MAA-v6.19.0-beta.2-win-x64.zip",
      "wrong archive",
    );
    expect((await auditEngine({ root })).gaps.join(" ")).toMatch(
      /archive SHA-256/i,
    );
  });
  it("blocks unsupported Award options and missing safety parameters rather than trusting declarations", async () => {
    const { root, put, contractFile } = await fixture();
    const contract = JSON.parse(await readFile(contractFile, "utf8"));
    contract.awardOptions.signinevent.supported = true;
    await put("games/arknights/engine-contract.json", contract);
    await put(
      "games/arknights/config.ts",
      'export function taskFor(id){switch(id){case "login":return {type:"StartUp",params:{client_type:"Official"}};case "award":return {type:"Award",params:{award:true}};}}',
    );
    const report = await auditEngine({ root });
    expect(report.status).toBe("blocked");
    expect(report.gaps.join(" ")).toContain("start_game_enabled");
    expect(report.gaps.join(" ")).toContain("signinevent");
  });
  it("rejects linked bundle traversal and only emits an immutable rollback comparison plan", async () => {
    const current = await fixture(),
      target = await fixture("v6.18.0");
    const before = await readFile(join(current.bundle, "MaaCore.dll"));
    const plan = await planEngineRollback({
      root: current.root,
      targetBundle: target.bundle,
      targetArchive: target.archive,
      targetContract: target.contractFile,
    });
    expect(plan.status).toBe("ready-for-review");
    expect(plan.action).toBe("manual-engine-switch");
    expect(plan.automaticOverwrite).toBe(false);
    expect(plan.target.version).toBe("v6.18.0");
    expect(await readFile(join(current.bundle, "MaaCore.dll"))).toEqual(before);
    await symlink(target.bundle, join(current.root, "linked"), "junction");
    const linked = await auditEngine({
      root: current.root,
      bundle: join(current.root, "linked"),
    });
    expect(linked.status).toBe("blocked");
    expect(linked.skills.map((s) => s.id)).toEqual(["login", "award"]);
  });
  it("requires the entire explicit rollback target, with no apply option", () => {
    expect(() =>
      parseEngineArgs(["--rollback", "--target-bundle", "x"]),
    ).toThrow(/target-archive/);
    expect(() => parseEngineArgs(["--apply"])).toThrow();
    expect(parseEngineArgs(["--check"])).toMatchObject({ mode: "check" });
  });
  it("blocks dynamic native parameter spreads instead of treating them as fully inventoried", async () => {
    const { root, put } = await fixture();
    await put(
      "games/arknights/config.ts",
      'export function taskFor(id){switch(id){case "login":return {type:"StartUp",params:{client_type:"Official",start_game_enabled:true,...externalParams}};case "award":return {type:"Award",params:{award:true,mail:false,recruit:false,orundum:false,mining:false,specialaccess:false}};}}',
    );
    const report = await auditEngine({ root });
    expect(report.status).toBe("blocked");
    expect(report.gaps.join(" ")).toMatch(/dynamic.*spread/i);
  });

  it("resolves imported typed helper spreads and records their source without executing fixture code", async () => {
    const { root, put } = await fixture();
    await put(
      "games/arknights/index.ts",
      'export const game={skills:[{id:"recruit"},{id:"award"}]};',
    );
    await put(
      "games/arknights/config.ts",
      `
      import { nativeRecruitOptions } from "./task-options";
      throw Error("audit must never execute fixture code");
      export function taskFor(id, input) { switch (id) {
        case "recruit": return {type:"Recruit",params:{expedite:false,...nativeRecruitOptions(input)}};
        case "award": return {type:"Award",params:{award:true,mail:false,recruit:false,orundum:false,mining:false,specialaccess:false}};
      }}
    `,
    );
    await put(
      "games/arknights/task-options.ts",
      `
      export function nativeRecruitOptions(options) {
        return { refresh:options.refresh, select:[3], confirm:[3], times:options.times,
          ... (options.custom ? {preserve_tags:["资深干员"]} : {}) };
      }
    `,
    );
    const report = await auditEngine({ root });
    expect(report.gaps).toEqual([]);
    const recruit = report.skills.find((s) => s.id === "recruit")!;
    expect(recruit.params).toEqual(
      expect.arrayContaining(["refresh", "times", "preserve_tags"]),
    );
    expect(recruit.parameterExpressions.refresh).toBe("options.refresh");
    expect(recruit.parameterSources.refresh).toEqual([
      expect.objectContaining({
        source: "games/arknights/task-options.ts",
        line: 3,
      }),
    ]);
    expect(recruit.certification).toBe("pending-real-device");
  });

  it("inventories all current registered skills through extended delegation and typed helpers", async () => {
    const { root, put, contractFile } = await fixture();
    for (const file of [
      "config.ts",
      "task-options.ts",
      "extended-options.ts",
      "copilot-options.ts",
      "index.ts",
    ])
      await put(
        `games/arknights/${file}`,
        await readFile(
          new URL(`../games/arknights/${file}`, import.meta.url),
          "utf8",
        ),
      );
    const contract = JSON.parse(await readFile(contractFile, "utf8"));
    contract.awardOptions.signinevent.supported = true;
    await put("games/arknights/engine-contract.json", contract);
    const report = await auditEngine({ root });
    expect(report.gaps).toEqual([]);
    expect(report.status).toBe("ready-for-review");
    expect(report.skills).toHaveLength(19); // 18 registered skills plus the internal CloseDown mapping.
    expect(
      report.skills.find((s) => s.id === "operator-progress"),
    ).toMatchObject({
      type: "OperProgress",
      source: "games/arknights/extended-options.ts",
      certification: "pending-real-device",
      parameterStatus: "static-adapter-reviewed",
    });
    expect(report.skills.find((s) => s.id === "roguelike")?.params).toContain(
      "find_playTime_target",
    );
    expect(
      report.skills.find((s) => s.id === "infrastructure")?.params,
    ).toContain("plan_index");
    expect(
      report.skills.every(
        (s) => s.line > 0 && s.certification === "pending-real-device",
      ),
    ).toBe(true);
  });

  it.each([
    "export function nativeRecruitOptions(options){return {...options};}",
    "export function nativeRecruitOptions(options){return {[options.key]:true};}",
    "export function nativeRecruitOptions(options){return nativeRecruitOptions(options);}",
    "export function nativeRecruitOptions(options){return options.safe?{refresh:false,select:[3],confirm:[3],times:4}:{};}",
    "export function nativeRecruitOptions(options){let result={refresh:false,select:[3],confirm:[3],times:4};result=options;return result;}",
    "export function nativeRecruitOptions(options){const result={refresh:false,select:[3],confirm:[3],times:4};result[options.key]=true;return result;}",
    "export function shared(){return {refresh:false,select:[3],confirm:[3],times:4};} export function nativeRecruitOptions(options){function shared(){return options;}return shared();}",
  ])(
    "keeps unresolved or incomplete helper contracts blocked: %s",
    async (helper) => {
      const { root, put } = await fixture();
      await put(
        "games/arknights/index.ts",
        'export const game={skills:[{id:"recruit"}]};',
      );
      await put(
        "games/arknights/config.ts",
        `import {nativeRecruitOptions} from "./task-options";
      export function taskFor(id, input){switch(id){case "recruit":return {type:"Recruit",params:{expedite:false,...nativeRecruitOptions(input)}};}}
    `,
      );
      await put("games/arknights/task-options.ts", helper);
      const report = await auditEngine({ root });
      expect(report.status).toBe("blocked");
      expect(
        report.skills.find((s) => s.id === "recruit")?.parameterStatus,
      ).toBe("blocked");
      expect(report.gaps.length).toBeGreaterThan(0);
    },
  );
});
