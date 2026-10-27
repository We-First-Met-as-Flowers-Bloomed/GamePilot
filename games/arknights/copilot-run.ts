import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonical } from "../../packages/protocol/canonical";
import {
  validatePreparedCopilotPlan,
  copilotPlanHashInput,
  type PreparedCopilotPlan,
  type FrozenCopilotJob,
  type CopilotStage,
} from "../../packages/protocol/copilot";
import type { Device, SkillResult } from "../../packages/protocol";
import type { MaaCoreClient } from "../../packages/runtime/maacore";
import { checkDeviceReady } from "../../packages/runtime/device-ready";
import { TaskFaultError } from "../../packages/protocol/fault";
import { validateCopilotJob } from "./copilot-policy";
import { precheckCopilotJob, type OperatorBoxEntry } from "./copilot-library";
import { validateArknightsConfig, type ArknightsConfig } from "./config";
import {
  ArknightsTaskEvidence,
  CopilotTaskEvidence,
  validArknightsEvidence,
  type ArknightsExecutionEvidence,
  type CopilotIdentityProof,
  type CopilotVerificationEvidence,
} from "./evidence";

export function copilotPlanDigest(plan: PreparedCopilotPlan): string {
  return createHash("sha256")
    .update(canonical(copilotPlanHashInput(plan)))
    .digest("hex");
}
/** Only the fixed content-addressed cache is admissible, and linked files are refused. */
export function readFrozenCopilotJob(
  cacheDir: string,
  job: FrozenCopilotJob,
  stage: CopilotStage,
) {
  const dir = join(resolve(cacheDir), "copilot-library"),
    file = join(dir, `${job.id}-${job.sha256}.json`);
  if (
    !isAbsolute(job.file) ||
    resolve(job.file) !== file ||
    lstatSync(dir).isSymbolicLink() ||
    lstatSync(file).isSymbolicLink() ||
    !lstatSync(file).isFile() ||
    lstatSync(file).size > 2 * 1024 * 1024 ||
    realpathSync(file) !==
      join(realpathSync(dir), `${job.id}-${job.sha256}.json`)
  )
    throw Error("冻结作业路径越界或包含链接");
  const bytes = readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== job.sha256)
    throw Error("冻结作业哈希已变化");
  const parsed = validateCopilotJob(JSON.parse(bytes.toString("utf8")), {
    stageAliases: stage.aliases,
  });
  if (parsed.stageName !== job.stageName) throw Error("冻结作业关卡已变化");
  return parsed;
}
/** Pinned OperBoxInfo does not emit mastery/module fields. Unrecognized fields cannot supply them. */
export function readLiveCopilotBox(messages: string[]): OperatorBoxEntry[] {
  const tracker = new ArknightsTaskEvidence("OperBox");
  let taskId: number | undefined,
    entries: OperatorBoxEntry[] | undefined,
    invalid = false,
    complete = false;
  for (const message of messages) {
    tracker.accept(message);
    const match = /^MAA (\d+): (.+)$/s.exec(message);
    if (!match) continue;
    const code = Number(match[1]);
    try {
      const v = JSON.parse(match[2]);
      if (v.taskchain !== "OperBox") continue;
      if (code === 10001) {
        if (taskId !== undefined) invalid = true;
        taskId = v.taskid;
        continue;
      }
      if (v.taskid !== taskId) continue;
      if (code === 10002) {
        complete = true;
        continue;
      }
      if (code === 20001) invalid = true;
      if (
        code !== 20003 ||
        v.what !== "OperBoxInfo" ||
        v.details?.done !== true ||
        complete
      )
        continue;
      const own = v.details.own_opers;
      if (
        entries !== undefined ||
        !Array.isArray(own) ||
        own.length < 1 ||
        own.length > 1000
      ) {
        invalid = true;
        continue;
      }
      entries = own.map((raw) => {
        if (
          !raw ||
          typeof raw.name !== "string" ||
          !raw.name ||
          raw.name.length > 160 ||
          /[\x00-\x1f\x7f-\x9f]/.test(raw.name) ||
          raw.own !== true ||
          !Number.isSafeInteger(raw.elite) ||
          raw.elite < 0 ||
          raw.elite > 2 ||
          !Number.isSafeInteger(raw.level) ||
          raw.level < 1 ||
          raw.level > 90
        )
          throw Error("干员识别字段无效");
        return {
          name: raw.name,
          owned: true,
          elite: raw.elite,
          level: raw.level,
        };
      });
      if (new Set(entries.map((e) => e.name)).size !== entries.length)
        invalid = true;
    } catch {
      invalid = true;
    }
  }
  if (
    invalid ||
    !entries ||
    tracker.finish(true, true).completion !== "native-confirmed"
  )
    throw Error("当前原生OperBox缺少完整匹配回调，预检未知");
  return entries;
}
export interface CopilotRunOptions {
  prepared: PreparedCopilotPlan;
  cacheDir: string;
  config: ArknightsConfig;
  device: Device;
  signal: AbortSignal;
  createCore(): Pick<MaaCoreClient, "connect" | "runTask" | "close">;
  login(signal: AbortSignal): Promise<SkillResult | void>;
  log(message: string, result?: SkillResult): void;
  checkReady?: typeof checkDeviceReady;
}
export async function executeCopilotPlan(
  options: CopilotRunOptions,
): Promise<SkillResult> {
  const signal = options.signal;
  signal.throwIfAborted();
  const plan = validatePreparedCopilotPlan(options.prepared),
    config = validateArknightsConfig(options.config),
    device = { ...options.device };
  const checkPlan = (enforceExpiry = false) => {
    signal.throwIfAborted();
    if (
      (enforceExpiry && Date.now() >= Date.parse(plan.expiresAt)) ||
      Date.parse(plan.createdAt) > Date.now() ||
      copilotPlanDigest(plan) !== plan.planHash ||
      config.expectedUid !== plan.account.expectedUid ||
      config.clientType !== plan.account.clientType
    )
      throw Error("临时作业过期、哈希或账号范围不匹配");
    return plan.jobs.map((job) =>
      readFrozenCopilotJob(options.cacheDir, job, plan.stage),
    );
  };
  checkPlan(true);
  const uid = async (): Promise<CopilotIdentityProof> => {
    signal.throwIfAborted();
    const started = Date.now(),
      result = await options.login(signal);
    signal.throwIfAborted();
    const e = result?.arknights,
      proof = e?.login,
      now = Date.now();
    if (
      !validArknightsEvidence(e) ||
      e.taskType !== "StartUp" ||
      e.completion !== "native-confirmed" ||
      !proof ||
      proof.method !== "profile" ||
      proof.expectedUid !== plan.account.expectedUid ||
      proof.observedUid !== plan.account.expectedUid ||
      Date.parse(proof.observedAt) < started ||
      Date.parse(proof.observedAt) > now ||
      !proof.homeObservedAt ||
      Date.parse(proof.homeObservedAt) < Date.parse(proof.observedAt) ||
      Date.parse(proof.homeObservedAt) > now ||
      now - Date.parse(proof.homeObservedAt) > 15000
    )
      throw Error("作业缺少当前账号个人名片UID和主页核验");
    return {
      taskId: e.taskId!,
      expectedUid: proof.expectedUid,
      observedUid: proof.observedUid,
      method: "profile",
      observedAt: proof.observedAt,
      homeObservedAt: proof.homeObservedAt,
      home: true,
    };
  };
  let verification: CopilotVerificationEvidence | undefined;
  // Native settlement alone stays unknown until account and return-home proofs are persisted together.
  const record = (
    evidence: ArknightsExecutionEvidence,
    complete = false,
  ): ArknightsExecutionEvidence =>
    evidence.taskType !== "Copilot"
      ? evidence
      : {
          ...evidence,
          observedAt: new Date().toISOString(),
          completion:
            evidence.submission !== "submitted"
              ? "not-started"
              : complete
                ? "native-confirmed"
                : "unknown",
          ...(evidence.copilot && verification
            ? {
                copilot: {
                  ...evidence.copilot,
                  verification: structuredClone(verification),
                },
              }
            : {}),
        };
  const run = async (
    type: "OperBox" | "Copilot",
    params: Record<string, unknown>,
    tracker: ArknightsTaskEvidence | CopilotTaskEvidence,
    collect?: string[],
  ) => {
    let submitted = false,
      returned = false;
    const core = options.createCore();
    try {
      signal.throwIfAborted();
      await (options.checkReady ?? checkDeviceReady)(device, signal);
      signal.throwIfAborted();
      await core.connect(device.adbPath, device.address);
      signal.throwIfAborted();
      // Recheck files after asynchronous connection, immediately before submission.
      checkPlan(true);
      if (type === "Copilot") {
        if (
          !verification ||
          Date.now() < Date.parse(verification.before.homeObservedAt) ||
          Date.now() - Date.parse(verification.before.homeObservedAt) > 15000
        )
          throw Error("作业提交前账号/主页证据已过期");
        verification.submittedAt = new Date().toISOString();
      }
      submitted = true;
      // Persist conservative submission intent before awaiting the native transport.
      options.log("临时作业提交边界已记录；原生结果尚未确认", {
        arknights: record(tracker.finish(true, false)),
      });
      await core.runTask(
        type,
        params,
        signal,
        (message) => {
          tracker.accept(message);
          if (collect && collect.length < 10000) collect.push(message);
          options.log(message);
          if (/^MAA 10001: /.test(message))
            options.log("临时作业原生任务ID已记录；结果尚未确认", {
              arknights: record(tracker.finish(true, false)),
            });
        },
        config.maxRunMinutes * 60000 + 60000,
      );
      signal.throwIfAborted();
      returned = true;
      const evidence = tracker.finish(submitted, true);
      if (
        type === "Copilot" &&
        verification &&
        evidence.completion === "native-confirmed"
      )
        verification.completedAt = evidence.observedAt;
      options.log("临时作业原生证据已更新", { arknights: record(evidence) });
      return evidence;
    } catch (error) {
      options.log("临时作业提交与未知结果已保存；不自动重试", {
        arknights: record(tracker.finish(submitted, false)),
      });
      throw error;
    } finally {
      try {
        await core.close();
      } catch (error) {
        options.log("原生退出尚未确认，保留未知结果", {
          arknights: record(tracker.finish(submitted, false)),
        });
        throw error;
      }
      if (!returned && submitted)
        options.log("本次原生调用未确认完成", {
          arknights: record(tracker.finish(true, false)),
        });
    }
  };
  // Pinned StartUp includes recognized ReturnButtons and home normalization.
  // The injected existing adapter verifies profile UID and then home independently.
  await uid();
  const messages: string[] = [];
  await run(
    "OperBox",
    { enable: true },
    new ArknightsTaskEvidence("OperBox"),
    messages,
  );
  const box = readLiveCopilotBox(messages),
    jobs = checkPlan();
  for (const job of jobs) {
    const check = precheckCopilotJob(job, box);
    if (!check.ok)
      throw Error(
        `作业练度预检未知或未通过：${[...check.missing, ...check.insufficient, ...check.unknown].join("、")}`,
      );
  }
  // OperBox navigates the game. Re-establish home and UID before a battle.
  const before = await uid();
  verification = {
    planHash: plan.planHash,
    expectedUid: plan.account.expectedUid,
    before,
  };
  checkPlan(true);
  const tracker = new CopilotTaskEvidence(
    plan.planHash,
    plan.stage.id,
    plan.jobs,
  );
  const evidence: ArknightsExecutionEvidence = await run(
    "Copilot",
    {
      enable: true,
      copilot_list: plan.jobs.map((job, index) => ({
        id: index,
        filename: job.file,
        nav_name_override: plan.stage.code,
        is_raid: false,
      })),
      use_sanity_potion: false,
      formation: true,
      add_trust: false,
      ignore_requirements: false,
      support_unit_usage: 0,
    },
    tracker,
  );
  try {
    checkPlan();
    if (evidence.completion !== "native-confirmed")
      throw new TaskFaultError(
        "native-completion-missing",
        "作业结算缺少冻结条目对应的成对三星回调，结果未知；已停止且不重试",
      );
    verification.completedAt = evidence.observedAt;
    verification.after = await uid();
    const checked = record(evidence, true);
    if (!validArknightsEvidence(checked))
      throw Error("作业结算与前后账号/主页证据未形成完整关联");
    return {
      status: "succeeded",
      summary: `已核验冻结作业 ${plan.count} 次三星结算，并返回主页核对当前UID`,
      arknights: checked,
    };
  } catch (error) {
    options.log("作业后置核验未通过，保留已提交记录且不重试", {
      arknights: record(tracker.finish(true, false)),
    });
    throw error;
  }
}
