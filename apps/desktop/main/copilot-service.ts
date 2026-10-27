import { randomUUID } from "node:crypto";
import { canonical } from "../../../packages/protocol/canonical";
import {
  validateCopilotPreparation,
  validateCopilotConfirmation,
  validateCopilotAccount,
  validateCopilotStage,
  validatePreparedCopilotPlan,
  copilotPlanHashInput,
  type PreparedCopilotPlan,
  type CopilotAccount,
  type CopilotStage,
  type FrozenCopilotJob,
} from "../../../packages/protocol/copilot";
import {
  pickCopilotJob,
  queryCopilotJobs,
  type PickedCopilotJob,
  type CopilotJobSummary,
} from "../../../games/arknights/copilot-library";
import {
  copilotPlanDigest,
  readFrozenCopilotJob,
} from "../../../games/arknights/copilot-run";
export {
  copilotPlanDigest,
  readFrozenCopilotJob,
} from "../../../games/arknights/copilot-run";
import { recordWithKeys } from "../../../packages/protocol/struct";
type Awaitable<T> = T | Promise<T>;
interface Ports<Result> {
  cacheDir: string;
  account(profileId: string): Awaitable<CopilotAccount | undefined>;
  revision(): Awaitable<string>;
  resolveStage(code: string): Awaitable<CopilotStage | undefined>;
  execute(plan: PreparedCopilotPlan): Promise<Result>;
  pick?: typeof pickCopilotJob;
  search?: typeof queryCopilotJobs;
  now?: () => number;
}
/** Search/preparation have no device ports. Execution delegates to the host coordinator. */
export class CopilotService<Result = unknown> {
  private prepared = new Map<
    string,
    { plan: PreparedCopilotPlan; submission?: Promise<Result> }
  >();
  constructor(private readonly ports: Ports<Result>) {}
  async search(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CopilotJobSummary[]> {
    const p = recordWithKeys(input, ["stage", "limit"]);
    if (
      !p ||
      typeof p.stage !== "string" ||
      p.stage.length > 64 ||
      !p.stage.trim() ||
      /[\x00-\x1f\x7f-\x9f]/.test(p.stage) ||
      !Number.isSafeInteger(p.limit) ||
      Number(p.limit) < 1 ||
      Number(p.limit) > 10
    )
      throw Error("作业搜索范围无效");
    signal?.throwIfAborted();
    const stage = validateCopilotStage(await this.ports.resolveStage(p.stage));
    return (
      await (this.ports.search ?? queryCopilotJobs)(stage.code, {
        limit: Number(p.limit),
        timeoutMs: 15000,
        signal,
      })
    ).slice(0, Number(p.limit));
  }
  async prepare(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<PreparedCopilotPlan> {
    const request = validateCopilotPreparation(input);
    signal?.throwIfAborted();
    const account = validateCopilotAccount(
      await this.ports.account(request.profileId),
    );
    if (account.profileId !== request.profileId) throw Error("账号引用不匹配");
    const stage = validateCopilotStage(
        await this.ports.resolveStage(request.stage),
      ),
      revision = await this.ports.revision();
    const picked: PickedCopilotJob = await (this.ports.pick ?? pickCopilotJob)(
      stage.code,
      this.ports.cacheDir,
      {
        stageAliases: stage.aliases,
        maxCandidates: 5,
        timeoutMs: 15000,
        signal,
      },
    );
    signal?.throwIfAborted();
    const job: FrozenCopilotJob = {
      id: picked.summary.id,
      sha256: picked.sha256,
      file: picked.file,
      stageName: picked.job.stageName,
      title: picked.summary.title,
    };
    readFrozenCopilotJob(this.ports.cacheDir, job, stage);
    const now = (this.ports.now ?? Date.now)();
    const plan = validatePreparedCopilotPlan({
      version: 1,
      preparedId: randomUUID(),
      planHash: "0".repeat(64),
      revision,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 600000).toISOString(),
      account,
      stage,
      count: request.count,
      jobs: Array.from({ length: request.count }, () => ({ ...job })),
      budget: { maxBattles: request.count, sanityPotions: 0, originite: 0 },
      skipStory: true,
      precheck: {
        status: "pending-live",
        unknown: [
          "必须在已核验账号上读取当前原生OperBox；专精和模组信息可能不可用",
        ],
      },
    });
    if (
      revision !== (await this.ports.revision()) ||
      canonical(account) !==
        canonical(await this.ports.account(account.profileId))
    )
      throw Error("准备期间配置已变化，请重新准备");
    plan.planHash = copilotPlanDigest(plan);
    if (this.prepared.size >= 256)
      throw Error("临时作业准备数量已达上限，请重启应用重新准备");
    this.prepared.set(plan.preparedId, { plan: structuredClone(plan) });
    return structuredClone(plan);
  }
  async confirm(input: unknown): Promise<Result> {
    const confirm = validateCopilotConfirmation(input),
      entry = this.prepared.get(confirm.preparedId);
    if (
      !entry ||
      confirm.planHash !== entry.plan.planHash ||
      confirm.revision !== entry.plan.revision
    )
      throw Error("准备记录不存在或确认范围不匹配");
    if (entry.submission) return entry.submission;
    entry.submission = Promise.resolve().then(async () => {
      const plan = validatePreparedCopilotPlan(entry.plan);
      const revision = await this.ports.revision(),
        account = await this.ports.account(plan.account.profileId);
      if (
        (this.ports.now ?? Date.now)() >= Date.parse(plan.expiresAt) ||
        plan.revision !== revision ||
        canonical(plan.account) !== canonical(account) ||
        copilotPlanDigest(plan) !== plan.planHash
      )
        throw Error("临时作业已过期或账号/配置修订已变化");
      for (const job of plan.jobs)
        readFrozenCopilotJob(this.ports.cacheDir, job, plan.stage);
      return this.ports.execute(structuredClone(plan));
    });
    return entry.submission;
  }
}
