/**
 * Copilot 作业库：从 MAA 作业站（prts.plus / ZootPlus）按关卡自动获取作业 JSON，
 * 完成 schema 校验、本地缓存与干员练度预检，产出可直接交给
 * `taskFor("copilot", …)` 使用的本地作业文件路径。
 *
 * 安全约束：只允许通过本模块下载并校验过的作业进入执行链，
 * 不接受任意未校验 JSON（与 README “不允许 renderer 传入任意 MAA JSON” 一致）。
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 作业站 API                                                          */
/* ------------------------------------------------------------------ */

export const COPILOT_API_BASE = "https://prts.maa.plus";

export interface CopilotQueryOptions {
  /** 排序依据：评分 或 热度，默认评分 */
  orderBy?: "rating" | "views";
  /** 每页数量，默认 10，上限 50 */
  limit?: number;
  page?: number;
  /** 请求超时毫秒，默认 15000 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CopilotJobSummary {
  id: number;
  stageName: string;
  title: string;
  uploader: string;
  uploadTime: string;
  /** 好评率 0-1，新作业可能缺失 */
  likeRate?: number;
  views?: number;
  /** 列表接口内嵌的作业 JSON 字符串，可直接校验，省一次请求 */
  content?: string;
}

interface QueryResponse {
  status_code: number;
  message?: string;
  data?: unknown;
}

interface GetResponse {
  status_code: number;
  message?: string;
  data?: { content?: unknown };
}

async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw Error("作业查询超时参数无效");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal?.throwIfAborted();
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw Error(`作业站请求失败：HTTP ${response.status}`);
    if (!response.body) throw Error("作业站响应为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw Error("作业站响应超出2MiB限制");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
  }
}

/** 按关卡代码查询作业列表（按热度/评分降序）。stageName 如 "YW-4"。 */
export async function queryCopilotJobs(
  stageName: string,
  options: CopilotQueryOptions = {},
): Promise<CopilotJobSummary[]> {
  const {
    orderBy = "views",
    limit = 10,
    page = 1,
    timeoutMs = 15000,
  } = options;
  if (!stageName.trim()) throw Error("关卡代码不能为空");
  const url =
    `${COPILOT_API_BASE}/copilot/query?levelKeyword=${encodeURIComponent(stageName.trim())}` +
    `&orderBy=${orderBy}&desc=true&limit=${Math.min(Math.max(limit, 1), 50)}&page=${page}`;
  const payload = (await getJson(
    url,
    timeoutMs,
    options.signal,
  )) as QueryResponse;
  if (payload.status_code !== 200 || !payload.data)
    throw Error(`作业站查询失败：${payload.message ?? "未知错误"}`);
  const list = Array.isArray(payload.data)
    ? payload.data
    : ((payload.data as { data?: unknown[] }).data ?? []);
  return list.map((raw): CopilotJobSummary => {
    const item = raw as Record<string, unknown>;
    let title = String(item.title ?? item.name ?? "");
    if (!title && typeof item.content === "string") {
      try {
        title = String(JSON.parse(item.content)?.doc?.title ?? "");
      } catch {
        /* content 由 pickCopilotJob 的校验兜底 */
      }
    }
    return {
      id: Number(item.id),
      stageName: String(item.stage_name ?? ""),
      title,
      uploader: String(item.uploader ?? item.uploader_id ?? ""),
      uploadTime: String(item.upload_time ?? ""),
      likeRate:
        typeof item.rating_ratio === "number" ? item.rating_ratio : undefined,
      views: typeof item.views === "number" ? item.views : undefined,
      content: typeof item.content === "string" ? item.content : undefined,
    };
  });
}

/** 下载作业完整 JSON 内容。列表内嵌 content 是阉割版（无 actions），必须取完整接口。 */
export async function fetchCopilotJob(
  id: number,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Number.isInteger(id) || id <= 0) throw Error("作业 ID 无效");
  const payload = (await getJson(
    `${COPILOT_API_BASE}/copilot/get/${id}`,
    timeoutMs,
    signal,
  )) as GetResponse;
  if (payload.status_code !== 200 || payload.data?.content == null)
    throw Error(`作业下载失败：${payload.message ?? "未知错误"}`);
  const { content } = payload.data;
  if (typeof content === "string") return JSON.parse(content);
  return content;
}

/* ------------------------------------------------------------------ */
/* Schema 校验                                                         */
/* ------------------------------------------------------------------ */

export { validateCopilotJob } from "./copilot-policy";
export type {
  CopilotOperator,
  CopilotAction,
  CopilotJob,
} from "./copilot-policy";
import {
  validateCopilotJob,
  type CopilotOperator,
  type CopilotJob,
} from "./copilot-policy";

/* ------------------------------------------------------------------ */
/* 本地缓存                                                            */
/* ------------------------------------------------------------------ */

export interface CachedCopilotJob {
  schemaVersion: 1;
  sha256: string;
  id: number;
  file: string;
  stageName: string;
  title: string;
  cachedAt: string;
}

function writeAtomic(file: string, value: string) {
  const staging = `${file}.${randomUUID()}.tmp`;
  const handle = openSync(staging, "wx");
  try {
    writeFileSync(handle, value, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(staging, file);
}

function libraryDir(cacheDir: string): string {
  const dir = join(cacheDir, "copilot-library");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把校验过的作业写入缓存，返回本地文件路径。 */
export function cacheCopilotJob(
  cacheDir: string,
  summary: CopilotJobSummary,
  job: CopilotJob,
): CachedCopilotJob {
  const dir = libraryDir(cacheDir);
  if (!Number.isSafeInteger(summary.id) || summary.id <= 0)
    throw Error("作业ID无效");
  const payload = JSON.stringify(validateCopilotJob(job.raw).raw, null, 2);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const file = join(dir, `${summary.id}-${sha256}.json`);
  if (existsSync(file)) {
    if (
      createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256
    )
      throw Error("作业缓存哈希不匹配，保留现场并停止");
  } else writeAtomic(file, payload);
  const indexFile = join(dir, "index.json");
  const index = listCachedJobs(cacheDir);
  const entry: CachedCopilotJob = {
    schemaVersion: 1,
    sha256,
    id: summary.id,
    file,
    stageName: job.stageName,
    title: summary.title,
    cachedAt: new Date().toISOString(),
  };
  const next = [entry, ...index.filter((e) => e.id !== summary.id)];
  writeAtomic(indexFile, JSON.stringify(next.slice(0, 1000), null, 2));
  return entry;
}

/** 读取本地缓存的作业清单。 */
export function listCachedJobs(cacheDir: string): CachedCopilotJob[] {
  const indexFile = join(libraryDir(cacheDir), "index.json");
  if (!existsSync(indexFile)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(indexFile, "utf8"));
    if (!Array.isArray(raw) || raw.length > 1000) throw Error("索引无效");
    return raw.filter((entry): entry is CachedCopilotJob =>
      Boolean(
        entry &&
        entry.schemaVersion === 1 &&
        Number.isSafeInteger(entry.id) &&
        entry.id > 0 &&
        /^[a-f0-9]{64}$/.test(entry.sha256) &&
        entry.file ===
          join(libraryDir(cacheDir), `${entry.id}-${entry.sha256}.json`) &&
        typeof entry.stageName === "string" &&
        typeof entry.title === "string" &&
        Number.isFinite(Date.parse(entry.cachedAt)),
      ),
    );
  } catch {
    // Preserve the damaged index instead of treating it as known execution history.
    renameSync(indexFile, `${indexFile}.corrupt-${randomUUID()}`);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 干员练度预检                                                        */
/* ------------------------------------------------------------------ */

export interface OperatorBoxEntry {
  name: string;
  elite?: number;
  level?: number;
  skillLevel?: number;
  module?: number;
  owned: boolean;
}

export interface CopilotPrecheckResult {
  ok: boolean;
  /** box 中完全没有的干员/群组 */
  missing: string[];
  /** 拥有但练度不达标的干员及原因 */
  insufficient: string[];
  unknown: string[];
}

function checkOperator(
  required: CopilotOperator,
  box: Map<string, OperatorBoxEntry>,
  missing: string[],
  insufficient: string[],
  unknown: string[],
): void {
  const owned = box.get(required.name);
  if (!owned || !owned.owned) {
    missing.push(required.name);
    return;
  }
  const req = required.requirements;
  if (!req) return;
  const problems: string[] = [];
  for (const [key, label] of [
    ["elite", "精英化"],
    ["level", "等级"],
    ["skillLevel", "技能等级"],
    ["module", "模组"],
  ] as const) {
    if (
      typeof req[key] === "number" &&
      req[key]! >= 0 &&
      owned[key] === undefined
    )
      unknown.push(`${required.name}：${label}尚未核验`);
  }
  if (
    typeof req.module === "number" &&
    req.module > 0 &&
    owned.module !== undefined &&
    owned.module !== req.module
  )
    problems.push(`模组需 ${req.module}（当前 ${owned.module}）`);
  if (
    typeof req.elite === "number" &&
    req.elite >= 0 &&
    (owned.elite ?? 0) < req.elite
  )
    problems.push(`精英化需 ${req.elite}（当前 ${owned.elite ?? 0}）`);
  if (
    typeof req.level === "number" &&
    req.level >= 0 &&
    (owned.level ?? 0) < req.level
  )
    problems.push(`等级需 ${req.level}（当前 ${owned.level ?? 0}）`);
  if (
    typeof req.skillLevel === "number" &&
    req.skillLevel >= 0 &&
    (owned.skillLevel ?? 0) < req.skillLevel
  )
    problems.push(
      `技能等级需 ${req.skillLevel}（当前 ${owned.skillLevel ?? 0}）`,
    );
  if (problems.length)
    insufficient.push(`${required.name}：${problems.join("、")}`);
}

/** 用 operator-box 识别结果预检作业可行性。 */
export function precheckCopilotJob(
  job: CopilotJob,
  boxEntries: OperatorBoxEntry[],
): CopilotPrecheckResult {
  const box = new Map(boxEntries.map((e) => [e.name, e]));
  const missing: string[] = [];
  const insufficient: string[] = [];
  const unknown: string[] = [];
  for (const op of job.opers)
    checkOperator(op, box, missing, insufficient, unknown);
  for (const group of job.groups) {
    // 群组干员任选其一：只要有一个可用即满足
    const usable = group.opers.some((op) => {
      const m: string[] = [];
      const s: string[] = [];
      const u: string[] = [];
      checkOperator(op, box, m, s, u);
      return m.length === 0 && s.length === 0 && u.length === 0;
    });
    if (!usable) missing.push(`群组「${group.name}」无可用干员`);
  }
  return {
    ok:
      missing.length === 0 && insufficient.length === 0 && unknown.length === 0,
    missing,
    insufficient,
    unknown,
  };
}

/* ------------------------------------------------------------------ */
/* 自动选作业                                                          */
/* ------------------------------------------------------------------ */

export interface PickCopilotJobOptions extends CopilotQueryOptions {
  stageAliases?: string[];
  engineVersion?: string;
  /** 最多尝试的作业份数，默认 5 */
  maxCandidates?: number;
  /** 干员 box；不传则跳过练度预检，直接取评分最高者 */
  box?: OperatorBoxEntry[];
}

export interface PickedCopilotJob {
  file: string;
  summary: CopilotJobSummary;
  job: CopilotJob;
  precheck?: CopilotPrecheckResult;
  offline?: boolean;
  sha256: string;
}

/**
 * 自动选作业：按评分从高到低拉取候选，逐份下载、校验、预检，
 * 返回第一份当前 box 能抄的作业并写入本地缓存。
 * 找不到可用作业时抛出带原因的异常。
 */
export async function pickCopilotJob(
  stageName: string,
  cacheDir: string,
  options: PickCopilotJobOptions = {},
): Promise<PickedCopilotJob> {
  const {
    maxCandidates = 5,
    box,
    stageAliases = [stageName],
    engineVersion,
    ...queryOptions
  } = options;
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > 20
  )
    throw Error("候选作业数量无效");
  const policy = { stageAliases, engineVersion };
  let candidates: CopilotJobSummary[];
  try {
    candidates = await queryCopilotJobs(stageName, {
      limit: maxCandidates,
      ...queryOptions,
    });
  } catch (error) {
    queryOptions.signal?.throwIfAborted();
    for (const entry of listCachedJobs(cacheDir)) {
      try {
        const bytes = readFileSync(entry.file);
        if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
          continue;
        const job = validateCopilotJob(
          JSON.parse(bytes.toString("utf8")),
          policy,
        );
        const precheck = box ? precheckCopilotJob(job, box) : undefined;
        if (precheck && !precheck.ok) continue;
        return {
          file: entry.file,
          sha256: entry.sha256,
          job,
          precheck,
          offline: true,
          summary: {
            id: entry.id,
            stageName: entry.stageName,
            title: entry.title,
            uploader: "",
            uploadTime: "",
          },
        };
      } catch {
        queryOptions.signal?.throwIfAborted();
      }
    }
    throw error;
  }
  if (candidates.length === 0)
    throw Error(`作业站没有找到 ${stageName} 的作业`);
  const failures: string[] = [];
  for (const summary of candidates.slice(0, maxCandidates)) {
    try {
      queryOptions.signal?.throwIfAborted();
      const job = validateCopilotJob(
        await fetchCopilotJob(
          summary.id,
          queryOptions.timeoutMs,
          queryOptions.signal,
        ),
        policy,
      );
      const precheck = box ? precheckCopilotJob(job, box) : undefined;
      if (precheck && !precheck.ok) {
        failures.push(
          `#${summary.id}《${summary.title}》练度未通过：${[...precheck.missing, ...precheck.insufficient, ...precheck.unknown].join("、")}`,
        );
        continue;
      }
      const cached = cacheCopilotJob(cacheDir, summary, job);
      return {
        file: cached.file,
        sha256: cached.sha256,
        summary,
        job,
        precheck,
      };
    } catch (error) {
      queryOptions.signal?.throwIfAborted();
      failures.push(
        `#${summary.id}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw Error(
    `${stageName} 没有可抄的作业（已尝试 ${failures.length} 份）：\n${failures.join("\n")}`,
  );
}
