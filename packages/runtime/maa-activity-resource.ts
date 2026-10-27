import { createHash } from "node:crypto";
import { lstat, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import contract from "../../games/arknights/engine-contract.json";
import { AtomicJsonStore } from "../../apps/desktop/main/atomic-json-store";

export const officialNavigationSource =
  "https://api.maa.plus/MaaAssistantArknights/api/resource/tasks.json";
export const officialActivitySource =
  "https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json";
export const activityCacheMaxAgeMs = 86400000;
const limit = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const recent = (at: unknown, now: number): at is number =>
  typeof at === "number" &&
  Number.isFinite(at) &&
  at <= now &&
  now - at < activityCacheMaxAgeMs;

export async function boundedOfficialJson(url: string) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw Error("官方活动资源不可用");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw Error("活动资源超过大小限制");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  const data: unknown = JSON.parse(raw);
  if (!object(data)) throw Error("活动资源格式无效");
  return { raw, data };
}
interface Manifest {
  version: 2;
  engineVersion: string;
  source: string;
  sha256: string;
  fetchedAt: number;
}
export interface ActivityNavigation {
  directory: string;
  sha256: string;
  engineVersion: string;
  fetchedAt: number;
  routes: string[];
}
export interface ActivityCatalogCache {
  version: 1;
  source: string;
  engineVersion: string;
  navigationSha256: string;
  fetchedAt: number;
  data: Record<string, unknown>;
}
export function validActivityCatalogCache(
  value: unknown,
  now: number,
  engineVersion = contract.version,
): ActivityCatalogCache | undefined {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.source !== officialActivitySource ||
    value.engineVersion !== engineVersion ||
    !recent(value.fetchedAt, now) ||
    typeof value.navigationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.navigationSha256) ||
    !object(value.data)
  )
    return;
  return value as unknown as ActivityCatalogCache;
}
export function currentActivityNavigation(
  value: ActivityNavigation | undefined,
  now: number,
  engineVersion = contract.version,
): value is ActivityNavigation {
  return (
    !!value &&
    value.engineVersion === engineVersion &&
    recent(value.fetchedAt, now) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Array.isArray(value.routes) &&
    value.routes.every((route) => typeof route === "string")
  );
}
async function verifiedDirectory(
  root: string,
  manifest: Manifest,
): Promise<ActivityNavigation | undefined> {
  const directory = join(root, "tasks-v1-" + manifest.sha256),
    resource = join(directory, "resource"),
    tasks = join(resource, "tasks"),
    file = join(tasks, "activity.json");
  for (const path of [root, directory, resource, tasks]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
  }
  for (const [path, name] of [
    [directory, "resource"],
    [resource, "tasks"],
    [tasks, "activity.json"],
  ]) {
    const entries = await readdir(path);
    if (entries.length !== 1 || entries[0] !== name) return;
  }
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > limit) return;
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    return;
  const data: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !object(data) ||
    Object.keys(data).length > 10000 ||
    Object.values(data).some((value) => !object(value))
  )
    return;
  return {
    directory,
    sha256: manifest.sha256,
    engineVersion: manifest.engineVersion,
    fetchedAt: manifest.fetchedAt,
    routes: Object.keys(data),
  };
}
/** Each lookup checks both the digest and the exact files that MaaCore will load. */
export async function readActivityNavigation(
  root: string,
  now = Date.now(),
): Promise<ActivityNavigation | undefined> {
  try {
    const path = join(root, "current.json"),
      info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 2048) return;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !object(value) ||
      value.version !== 2 ||
      value.engineVersion !== contract.version ||
      value.source !== officialNavigationSource ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !recent(value.fetchedAt, now)
    )
      return;
    return await verifiedDirectory(root, value as unknown as Manifest);
  } catch {
    return;
  }
}
export async function syncActivityNavigation(
  root: string,
  ports: {
    fetchData?: () => Promise<{ raw: string; data: unknown }>;
    now?: () => number;
    allowCached?: boolean;
  } = {},
) {
  const now = ports.now ?? Date.now;
  try {
    const { raw } = await (
      ports.fetchData ?? (() => boundedOfficialJson(officialNavigationSource))
    )();
    if (Buffer.byteLength(raw) > limit) throw Error("活动导航超过大小限制");
    const data: unknown = JSON.parse(raw);
    if (
      !object(data) ||
      Object.keys(data).length > 10000 ||
      Object.values(data).some((value) => !object(value))
    )
      throw Error("活动导航格式无效");
    const sha256 = createHash("sha256").update(raw).digest("hex"),
      directory = join(root, "tasks-v1-" + sha256);
    await mkdir(join(directory, "resource", "tasks"), { recursive: true });
    await writeFile(
      join(directory, "resource", "tasks", "activity.json"),
      raw,
      { encoding: "utf8", flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const manifest: Manifest = {
      version: 2,
      engineVersion: contract.version,
      source: officialNavigationSource,
      sha256,
      fetchedAt: now(),
    };
    // Verify the immutable candidate before replacing the previous manifest.
    if (!(await verifiedDirectory(root, manifest)))
      throw Error("活动导航摘要校验失败");
    await new AtomicJsonStore<Manifest>(join(root, "current.json")).save(
      manifest,
    );
    return await readActivityNavigation(root, now());
  } catch {
    return ports.allowCached === false
      ? undefined
      : await readActivityNavigation(root, now());
  }
}
/** Catalog authorization and native navigation must belong to the same verified snapshot. */
export async function assertOfficialActivityRoute(
  root: string | undefined,
  route: string,
  client: "Official" | "Bilibili",
  now = Date.now(),
) {
  if (!root || !/^[A-Za-z][A-Za-z0-9_@-]{0,119}$/.test(route))
    throw Error("请先在 App 同步并选择官方活动任务");
  const navigation = await readActivityNavigation(root, now);
  if (!navigation) throw Error("官方活动导航资源过期或校验失败，请先同步");
  const file = join(dirname(root), "activity-stage-cache.json"),
    info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > limit)
    throw Error("活动目录格式无效");
  const cache = validActivityCatalogCache(
    JSON.parse(await readFile(file, "utf8")),
    now,
  );
  if (!cache || cache.navigationSha256 !== navigation.sha256)
    throw Error("活动目录与导航未同步、已过期或版本不兼容，请先同步");
  const { officialActivityMiniGames } =
    await import("../../games/arknights/activity-catalog");
  if (
    !officialActivityMiniGames(
      cache.data,
      client,
      new Date(now),
      contract.version,
      new Set(navigation.routes),
    ).some((item) => item.available && item.stage === route)
  )
    throw Error("该官方活动任务当前未开放、不兼容或缺少导航");
}
