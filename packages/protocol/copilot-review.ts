import {
  copilotHash,
  validatePreparedCopilotPlan,
  type CopilotConfirmation,
} from "./copilot";
import { recordWithKeys } from "./struct";

export interface CopilotReview extends CopilotConfirmation {
  version: 1;
  laneName: string;
  uidTail: string;
  clientType: "Official" | "Bilibili";
  stage: string;
  count: number;
  expiresAt: string;
  jobs: { id: number; title: string; sha256: string }[];
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" &&
  (empty || value.trim().length > 0) &&
  value.length <= max &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
/** A persisted review is display-only; expiry and ownership are checked again on execution. */
export function validateCopilotReview(value: unknown): CopilotReview {
  const p = recordWithKeys(value, [
    "version",
    "preparedId",
    "planHash",
    "revision",
    "laneName",
    "uidTail",
    "clientType",
    "stage",
    "count",
    "expiresAt",
    "jobs",
  ]);
  if (
    !p ||
    p.version !== 1 ||
    !uuid(p.preparedId) ||
    !copilotHash(p.planHash) ||
    !copilotHash(p.revision) ||
    !text(p.laneName, 160) ||
    typeof p.uidTail !== "string" ||
    !/^\d{4}$/.test(p.uidTail) ||
    (p.clientType !== "Official" && p.clientType !== "Bilibili") ||
    typeof p.stage !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.stage) ||
    !Number.isSafeInteger(p.count) ||
    Number(p.count) < 1 ||
    Number(p.count) > 3 ||
    !date(p.expiresAt) ||
    !Array.isArray(p.jobs) ||
    p.jobs.length !== p.count
  )
    throw Error("临时作业审查记录无效");
  const jobs = Array.from(p.jobs, (raw) => {
    const j = recordWithKeys(raw, ["id", "title", "sha256"]);
    if (
      !j ||
      !Number.isSafeInteger(j.id) ||
      Number(j.id) < 1 ||
      !text(j.title, 256, true) ||
      !copilotHash(j.sha256)
    )
      throw Error("临时作业审查条目无效");
    return { id: Number(j.id), title: j.title, sha256: j.sha256 };
  });
  return {
    version: 1,
    preparedId: p.preparedId,
    planHash: p.planHash,
    revision: p.revision,
    laneName: p.laneName,
    uidTail: p.uidTail,
    clientType: p.clientType,
    stage: p.stage,
    count: Number(p.count),
    expiresAt: p.expiresAt,
    jobs,
  };
}
export function isCopilotReview(value: unknown): value is CopilotReview {
  try {
    validateCopilotReview(value);
    return true;
  } catch {
    return false;
  }
}
/** Host projection exposes only reviewed confirmation fields, never UID or cache paths. */
export function copilotReviewFromPlan(
  value: unknown,
  laneName: string,
): CopilotReview {
  const plan = validatePreparedCopilotPlan(value);
  return validateCopilotReview({
    version: 1,
    preparedId: plan.preparedId,
    planHash: plan.planHash,
    revision: plan.revision,
    laneName,
    uidTail: plan.account.expectedUid.slice(-4),
    clientType: plan.account.clientType,
    stage: plan.stage.code,
    count: plan.count,
    expiresAt: plan.expiresAt,
    jobs: plan.jobs.map((j) => ({
      id: j.id,
      title: j.title,
      sha256: j.sha256,
    })),
  });
}
