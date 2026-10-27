import { recordWithKeys } from "./struct";
export interface CopilotAccount {
  profileId: string;
  expectedUid: string;
  clientType: "Official" | "Bilibili";
  revision: string;
}
export interface CopilotStage {
  id: string;
  code: string;
  aliases: string[];
}
export interface FrozenCopilotJob {
  id: number;
  sha256: string;
  file: string;
  stageName: string;
  title: string;
}
export interface PreparedCopilotPlan {
  version: 1;
  preparedId: string;
  planHash: string;
  revision: string;
  createdAt: string;
  expiresAt: string;
  account: CopilotAccount;
  stage: CopilotStage;
  count: number;
  jobs: FrozenCopilotJob[];
  budget: { maxBattles: number; sanityPotions: 0; originite: 0 };
  skipStory: true;
  precheck: { status: "pending-live"; unknown: string[] };
}
export interface CopilotPreparationInput {
  profileId: string;
  stage: string;
  count: number;
  skipStory: true;
}
export interface CopilotConfirmation {
  preparedId: string;
  planHash: string;
  revision: string;
}
export const copilotHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function text(v: unknown, max = 160): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= max &&
    !/[\x00-\x1f\x7f-\x9f]/.test(v)
  );
}
const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 3;
export function validateCopilotPreparation(
  value: unknown,
): CopilotPreparationInput {
  const p = recordWithKeys(value, ["profileId", "stage", "count", "skipStory"]);
  if (
    !p ||
    !text(p.profileId) ||
    !text(p.stage, 64) ||
    !count(p.count) ||
    p.skipStory !== true
  )
    throw Error("临时作业范围无效；只允许1至3次且当前引擎必须跳过剧情");
  return {
    profileId: p.profileId,
    stage: p.stage,
    count: p.count,
    skipStory: true,
  };
}
export function validateCopilotConfirmation(
  value: unknown,
): CopilotConfirmation {
  const p = recordWithKeys(value, ["preparedId", "planHash", "revision"]);
  if (
    !p ||
    !text(p.preparedId) ||
    !copilotHash(p.planHash) ||
    !text(p.revision, 256)
  )
    throw Error("临时作业结构化确认无效");
  return {
    preparedId: p.preparedId,
    planHash: p.planHash,
    revision: p.revision,
  };
}
export function validateCopilotAccount(value: unknown): CopilotAccount {
  const p = recordWithKeys(value, [
    "profileId",
    "expectedUid",
    "clientType",
    "revision",
  ]);
  if (
    !p ||
    !text(p.profileId) ||
    typeof p.expectedUid !== "string" ||
    !/^\d{6,12}$/.test(p.expectedUid) ||
    !["Official", "Bilibili"].includes(String(p.clientType)) ||
    !text(p.revision, 256)
  )
    throw Error("作业需要冻结的有效账号UID、客户端和配置修订");
  return { ...p } as unknown as CopilotAccount;
}
export function validateCopilotStage(value: unknown): CopilotStage {
  const p = recordWithKeys(value, ["id", "code", "aliases"]);
  if (
    !p ||
    !text(p.id, 128) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(p.id) ||
    typeof p.code !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.code) ||
    !Array.isArray(p.aliases) ||
    p.aliases.length !== 1 ||
    p.aliases[0] !== p.id
  )
    throw Error("目标关卡没有唯一的已审查映射");
  return { id: p.id, code: p.code, aliases: [...p.aliases] };
}
export function validatePreparedCopilotPlan(
  value: unknown,
): PreparedCopilotPlan {
  const p = recordWithKeys(value, [
    "version",
    "preparedId",
    "planHash",
    "revision",
    "createdAt",
    "expiresAt",
    "account",
    "stage",
    "count",
    "jobs",
    "budget",
    "skipStory",
    "precheck",
  ]);
  if (!p || p.version !== 1) throw Error("不支持的临时作业协议版本");
  validateCopilotConfirmation({
    preparedId: p.preparedId,
    planHash: p.planHash,
    revision: p.revision,
  });
  const account = validateCopilotAccount(p.account),
    stage = validateCopilotStage(p.stage);
  const start = typeof p.createdAt === "string" ? Date.parse(p.createdAt) : NaN,
    end = typeof p.expiresAt === "string" ? Date.parse(p.expiresAt) : NaN;
  const b = recordWithKeys(p.budget, [
      "maxBattles",
      "sanityPotions",
      "originite",
    ]),
    check = recordWithKeys(p.precheck, ["status", "unknown"]);
  if (
    !count(p.count) ||
    p.skipStory !== true ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 600000 ||
    !Array.isArray(p.jobs) ||
    p.jobs.length !== p.count ||
    !b ||
    b.maxBattles !== p.count ||
    b.sanityPotions !== 0 ||
    b.originite !== 0 ||
    !check ||
    check.status !== "pending-live" ||
    !Array.isArray(check.unknown) ||
    check.unknown.length > 16 ||
    check.unknown.some((x) => !text(x, 256))
  )
    throw Error("临时作业时间、次数或资源范围无效");
  const jobs = p.jobs.map((raw) => {
    const j = recordWithKeys(raw, [
      "id",
      "sha256",
      "file",
      "stageName",
      "title",
    ]);
    if (
      !j ||
      !Number.isSafeInteger(j.id) ||
      Number(j.id) < 1 ||
      !copilotHash(j.sha256) ||
      !text(j.file, 4096) ||
      !text(j.stageName, 160) ||
      typeof j.title !== "string" ||
      j.title.length > 256 ||
      /[\x00-\x1f\x7f-\x9f]/.test(j.title) ||
      j.stageName !== stage.id
    )
      throw Error("冻结作业引用无效");
    return { ...j } as unknown as FrozenCopilotJob;
  });
  return {
    ...p,
    account,
    stage,
    jobs,
    budget: { maxBattles: p.count, sanityPotions: 0, originite: 0 },
    precheck: { status: "pending-live", unknown: [...check.unknown] },
  } as PreparedCopilotPlan;
}
export function copilotPlanHashInput(
  plan: PreparedCopilotPlan,
): Omit<PreparedCopilotPlan, "planHash"> {
  const { planHash: _hash, ...input } = plan;
  return input;
}
