import { build } from "esbuild";
import { readFile, writeFile, mkdir, open, stat } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { requestLocalControl } from "./agent/local-control-client.mjs";

// One-time, explicit migration. Future edits belong to the App's validated settings UI.
const args = process.argv.slice(2),
  arg = (key) => {
    const i = args.indexOf("--" + key);
    return i < 0 ? undefined : args[i + 1];
  };
const profileDir = arg("profile-dir"),
  mappingFile = arg("sources"),
  apply = args.includes("--apply");
if (
  !profileDir ||
  !mappingFile ||
  args.some(
    (v, i) =>
      v.startsWith("--") &&
      !["--profile-dir", "--sources", "--apply"].includes(v),
  )
)
  throw Error(
    "Usage: --profile-dir <directory> --sources <profile-to-gui-path JSON> [--apply]",
  );
const root = resolve(profileDir),
  sources = JSON.parse(await readFile(mappingFile, "utf8"));
const bundle = await build({
  stdin: {
    contents: `
export {migrateAccountChannels} from './apps/desktop/main/channel-migration';
export {validateArknightsProfiles} from './games/arknights/config';
export {importMaaGuiConfig} from './games/arknights/maa-gui-import';
export {validateAutomation} from './packages/protocol';
export {defaultArknightsAutomation} from './packages/protocol/arknights-automation';
export {AtomicJsonStore} from './apps/desktop/main/atomic-json-store';
export {ArknightsAutomationStore} from './apps/desktop/main/arknights-automation';
`,
    resolveDir: resolve("."),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const originals = new Map(),
  load = async (name) => {
    const bytes = await readFile(join(root, name));
    originals.set(name, bytes);
    return JSON.parse(bytes.toString("utf8"));
  };
const lanes = api.migrateAccountChannels(await load("device-lanes.json"));
const profiles = api.validateArknightsProfiles(await load("arknights.json"));
const automation = api.validateAutomation(await load("automation.json"));
const warnings = [];
for (const [profileId, path] of Object.entries(sources)) {
  const current = profiles.profiles.find((p) => p.id === profileId);
  if (
    !current ||
    typeof path !== "string" ||
    !lanes.lanes.some(
      (l) => l.arknights.enabled && l.arknights.profileId === profileId,
    )
  )
    throw Error("Source does not bind to a saved Arknights channel");
  if ((await stat(path)).size > 2 * 1024 * 1024)
    throw Error("MAA source exceeds limit");
  const { id, name, ...base } = current;
  const gui = JSON.parse(await readFile(path, "utf8"));
  // Importing an external GUI must not replace the App's effective staffing
  // policy. In particular, absent options mean the existing in-game presets.
  for (const configuration of Object.values(gui.Configurations ?? {}))
    if (Array.isArray(configuration?.TaskQueue))
      configuration.TaskQueue = configuration.TaskQueue.filter(
        (task) => task?.TaskType !== "Infrast",
      );
  const imported = api.importMaaGuiConfig(gui, base);
  if (imported.customInfrastructureFile)
    throw Error(
      "Import custom infrastructure through App first so its JSON is stored internally",
    );
  Object.assign(current, { ...imported.config, id, name });
  if (
    current.expectedUid !== base.expectedUid ||
    current.clientType !== base.clientType
  )
    throw Error("Account binding changed");
  warnings.push(
    {
      profileId,
      message:
        "保留 App 当前基建策略；外部基建参数未迁入，如需切换请在 App 明确修改。",
    },
    ...imported.warnings.map((message) => ({ profileId, message })),
  );
}
const validated = api.validateArknightsProfiles(profiles);
for (const lane of lanes.lanes)
  lane.managerPath = win32.normalize(lane.managerPath);
const ark = lanes.lanes.filter((l) => l.enabled && l.arknights.enabled);
if (ark.length !== 2 || ark.some((l) => l.onmyoji.enabled))
  throw Error("Migration expects exactly two independent Arknights channels");
automation.managerPath = ark[0].managerPath;
automation.instance = ark[0].instance;
automation.launchEmulator = true;
automation.closeToTray = true;
automation.notifyResults = true;
automation.secondScheduleEnabled = false; // Arknights no longer uses the legacy global scheduler.
const config = api.defaultArknightsAutomation(lanes.lanes);
config.enabled = false;
const now = new Date(),
  date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const runs = config.jobs
  .filter((job) => job.weekdays.includes(now.getDay()))
  .flatMap((job) => {
    const due = new Date(now);
    const [hour, minute] = job.time.split(":").map(Number);
    due.setHours(hour, minute, 0, 0);
    return due <= now
      ? [
          {
            requestId: `ark-auto-${job.id}-${date}`,
            jobId: job.id,
            laneId: job.laneId,
            date,
            dueAt: due.toISOString(),
            source: "scheduled",
            status: "skipped",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            message:
              "迁移前时段不自动重放；此记录不是游戏成功，迁移后可核对再手动运行",
          },
        ]
      : [];
  });
const updates = new Map([
  ["device-lanes.json", lanes],
  ["arknights.json", validated],
  ["automation.json", api.validateAutomation(automation)],
  ["arknights-automation.json", { version: 1, config, runs }],
]);
const preview = {
  version: 1,
  profileDir: root,
  applied: false,
  internalSchedulingEnabled: false,
  channels: lanes.lanes.map((l) => ({
    id: l.id,
    instance: l.instance,
    game: l.arknights.enabled ? "arknights" : "onmyoji",
  })),
  jobs: config.jobs.map(({ id, laneId, time, skillIds }) => ({
    id,
    laneId,
    time,
    skillIds,
  })),
  skippedPastPeriods: runs.length,
  warnings,
};
if (!apply) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}
const lock = await open(join(root, ".arknights-internal-migration.lock"), "wx");
try {
  try {
    const running = await requestLocalControl(
      root,
      "status",
      {},
      { timeoutMs: 1500 },
    );
    if (running.ok) throw Error("Close App before migrating settings");
  } catch (error) {
    if (
      !["APP_NOT_RUNNING", "CONNECTION_FAILED", "TIMEOUT"].includes(error.code)
    )
      throw error;
  }
  try {
    await stat(join(root, "arknights-automation.json"));
    throw Error(
      "Internal plan already exists; use App settings rather than overwriting it",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const backup = join(
    root,
    "migration-backups",
    `arknights-internal-${now.toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(backup, { recursive: true });
  for (const [name, bytes] of originals) {
    if (!Buffer.from(await readFile(join(root, name))).equals(bytes))
      throw Error("Settings changed since preview");
    await writeFile(join(backup, name), bytes, { flag: "wx" });
  }
  for (const [name, value] of updates) {
    if (name === "arknights-automation.json") {
      const store = new api.ArknightsAutomationStore(join(root, name));
      await store.save(value);
      if (JSON.stringify(await store.read()) !== JSON.stringify(value))
        throw Error("Internal automation readback mismatch");
    } else await new api.AtomicJsonStore(join(root, name)).save(value);
  }
  const report = {
    ...preview,
    applied: true,
    backup,
    originalSha256: Object.fromEntries(
      [...originals].map(([name, bytes]) => [
        name,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    ),
  };
  await writeFile(
    join(backup, "migration.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await lock.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(join(root, ".arknights-internal-migration.lock"));
}
