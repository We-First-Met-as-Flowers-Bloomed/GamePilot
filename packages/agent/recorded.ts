import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonical } from "../acceptance/files";
import { AgentToolError, agentDate } from "../protocol/agent";
import { validateDeviceLanes, type DeviceLanes } from "../protocol";
import { agentLaneAlias } from "../protocol/lane-alias";
import type {
  ArknightsProfiles,
  ArknightsProfile,
} from "../../games/arknights/config";
import type { ExecutionRecord } from "../protocol/execution";
import {
  taskRecordKey,
  readTaskRecord,
  type TaskRecord,
} from "../protocol/task-record";
import {
  historyPlan,
  historyStepStatus,
  historyNativeMatches,
} from "../../games/agent-history";
import { boundedRead } from "./read-file";
import { validReceipt } from "./snapshot";
import { incidentLogCodes } from "./incident";
import type { IncidentSignal, IncidentFault } from "../protocol/agent-incident";
import {
  agentTaskResult,
  agentExecutionProgress,
} from "../../games/agent-results";
import type { AgentSnapshot } from "../protocol/agent";
import { projectExecutionDetail } from "../../games/execution-detail";
import { mergeExecutionProgress } from "../../games/execution-progress";
import type { ExecutionDetail } from "../protocol/execution-detail";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pathKey = (v: string) => v.toLowerCase().replaceAll("\\", "/");
const date = (v: unknown) => agentDate(v);
const optionalDate = (v: unknown) => (v === undefined ? undefined : date(v));
async function collect(directory: string) {
  const files: { kind: string; name: string; text: string }[] = [];
  let bytes = 0;
  for (const kind of ["execution-requests", "task-runs"]) {
    const entries = await opendir(join(directory, kind));
    let count = 0;
    for await (const entry of entries) {
      if (++count > 1024) throw Error("too many records");
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
        throw Error("invalid record file");
      const text = await boundedRead(join(directory, kind, entry.name));
      bytes += Buffer.byteLength(text);
      if (bytes > 16 * 1024 * 1024) throw Error("ledger too large");
      files.push({ kind, name: entry.name, text });
    }
  }
  files.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));
  return files;
}
/** Original receipts never leave this module. No recovery or game calls. */
export async function readRecordedHistory(
  directory: string,
  lanes: DeviceLanes,
  profiles: ArknightsProfiles,
) {
  try {
    const files = await collect(directory);
    const collectedAt = Date.now();
    const requests: ExecutionRecord[] = [],
      tasks: TaskRecord[] = [];
    for (const file of files) {
      const raw = JSON.parse(file.text);
      if (file.kind === "execution-requests") {
        if (
          !raw ||
          raw.version !== 1 ||
          typeof raw.id !== "string" ||
          !/^[a-zA-Z0-9:._-]{1,160}$/.test(raw.id) ||
          !["single", "daily", "maintenance"].includes(raw.source) ||
          !["running", "succeeded", "failed", "cancelled", "unknown"].includes(
            raw.status,
          ) ||
          !raw.snapshot ||
          typeof raw.snapshot !== "object" ||
          Array.isArray(raw.snapshot) ||
          !validReceipt(raw) ||
          hash(raw.id) + ".json" !== file.name
        )
          throw Error("invalid receipt");
        date(raw.startedAt);
        optionalDate(raw.finishedAt);
        if (raw.resolution !== undefined) {
          const r = raw.resolution;
          if (
            !r ||
            r.action !== "abandoned" ||
            typeof r.note !== "string" ||
            !["unknown", "failed", "cancelled"].includes(raw.status) ||
            Date.parse(date(r.at)) < Date.parse(raw.finishedAt ?? raw.startedAt)
          )
            throw Error("invalid resolution");
        }
        requests.push(raw);
      } else {
        const task = readTaskRecord(raw);
        if (hash(taskRecordKey(task)) + ".json" !== file.name)
          throw Error("invalid task key");
        historyPlan(task.plan);
        date(task.startedAt);
        date(task.updatedAt);
        optionalDate(task.finishedAt);
        for (const s of task.steps) {
          optionalDate(s.startedAt);
          optionalDate(s.finishedAt);
        }
        tasks.push(task);
      }
    }
    requests.sort(
      (a, b) =>
        Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
        a.id.localeCompare(b.id),
    );
    const projected: ExecutionRecord[] = [],
      projectedTasks: TaskRecord[] = [];
    const incidentSignals: IncidentSignal[] = [];
    const incidentFaults: IncidentFault[] = [];
    const recordedLogins: {
      requestId: string;
      runId: string;
      observedAt: string;
    }[] = [];
    const recordedResults: NonNullable<AgentSnapshot["recordedResults"]> = [];
    const aliases = new Map<string, string>();
    let unassociatedRequests = 0;
    const incompleteRequests = new Set<string>();
    for (const raw of requests) {
      const index = lanes.lanes.findIndex((lane) => lane.id === raw.laneId);
      const lane = lanes.lanes[index];
      const historical = raw.snapshot.lane
        ? validateDeviceLanes({ version: 1, lanes: [raw.snapshot.lane] })
            .lanes[0]
        : undefined;
      const profile = profiles.profiles.find(
        (p) => p.id === lane?.arknights.profileId,
      );
      const prior = raw.snapshot.profile as ArknightsProfile | undefined;
      const hasArk =
        raw.snapshot.arknightsPlan !== undefined ||
        (raw.snapshot.plan as { gameId?: string } | undefined)?.gameId ===
          "arknights";
      if (
        !lane ||
        !historical ||
        historical.id !== lane.id ||
        historical.instance !== lane.instance ||
        pathKey(historical.managerPath) !== pathKey(lane.managerPath) ||
        (hasArk &&
          (!profile ||
            !prior ||
            historical.arknights.profileId !== profile.id ||
            prior.id !== profile.id ||
            prior.clientType !== profile.clientType ||
            prior.expectedUid !== profile.expectedUid ||
            prior.accountName !== profile.accountName))
      ) {
        unassociatedRequests++;
        continue;
      }
      const plans = Object.fromEntries(
        ["plan", "arknightsPlan", "onmyojiPlan"]
          .filter((key) => raw.snapshot[key] !== undefined)
          .map((key) => [key, historyPlan(raw.snapshot[key])]),
      );
      if (!Object.keys(plans).length) {
        unassociatedRequests++;
        continue;
      }
      const id = `request-${projected.length + 1}`,
        laneId = agentLaneAlias(index);
      aliases.set(raw.id, id);
      if (
        Date.parse(raw.startedAt) > collectedAt ||
        (raw.finishedAt && Date.parse(raw.finishedAt) > collectedAt)
      )
        incompleteRequests.add(id);
      incidentLogCodes([raw.message]).forEach((code) =>
        incidentSignals.push({ requestId: id, code, basis: "log-pattern" }),
      );
      projected.push({
        version: 1,
        id,
        source: raw.source,
        resources: [],
        fingerprint: "redacted",
        laneId,
        batchId: id,
        snapshot: { lane: { instance: lane.instance }, ...plans },
        status: raw.status,
        startedAt: date(raw.startedAt),
        finishedAt: optionalDate(raw.finishedAt),
        message: "",
        ...(raw.resolution
          ? {
              resolution: {
                action: "abandoned" as const,
                at: date(raw.resolution.at),
                note: "",
              },
            }
          : {}),
        ...(raw.startupFault ? { startupFault: { ...raw.startupFault } } : {}),
      });
      for (const task of tasks.filter((t) => t.executionId === raw.id)) {
        // Mismatched steps are omitted; get_run will mark the missing linkage unknown.
        if (
          task.laneId !== raw.laneId ||
          task.batchId !== raw.batchId ||
          task.instance !== lane.instance ||
          (task.gameId === "arknights" && task.profileId !== profile?.id) ||
          !Object.values(plans).some(
            (p) => canonical(p) === canonical(task.plan),
          ) ||
          Date.parse(task.startedAt) < Date.parse(raw.startedAt) ||
          Date.parse(task.updatedAt) < Date.parse(task.startedAt) ||
          Date.parse(task.updatedAt) > collectedAt ||
          (raw.finishedAt &&
            Date.parse(task.updatedAt) > Date.parse(raw.finishedAt))
        ) {
          incompleteRequests.add(id);
          continue;
        }
        const timeInTask = (v: string | undefined) =>
          v !== undefined &&
          Date.parse(v) >= Date.parse(task.startedAt) &&
          Date.parse(v) <= Date.parse(task.finishedAt ?? task.updatedAt);
        if (
          !historyNativeMatches(task, profile?.expectedUid) ||
          (task.finishedAt !== undefined &&
            Date.parse(task.finishedAt) > Date.parse(task.updatedAt)) ||
          (task.status === "succeeded" &&
            (!raw.finishedAt || !timeInTask(task.finishedAt))) ||
          task.steps.some(
            (s) =>
              (task.plan.mode === "live" &&
                ["succeeded", "skipped"].includes(s.status) &&
                !["adapter-return", "adapter-result"].includes(
                  s.evidence ?? "",
                )) ||
              (s.startedAt !== undefined && !timeInTask(s.startedAt)) ||
              (s.finishedAt !== undefined &&
                (!timeInTask(s.finishedAt) ||
                  (s.startedAt !== undefined &&
                    Date.parse(s.finishedAt) < Date.parse(s.startedAt)))) ||
              (["succeeded", "skipped"].includes(s.status) && !s.finishedAt),
          )
        )
          incompleteRequests.add(id);
        const runId = `task-${projectedTasks.length + 1}`;
        if (!incompleteRequests.has(id))
          recordedResults.push({
            requestId: id,
            runId,
            summary: agentTaskResult(task, prior?.stage),
          });
        const login = task.steps.find((s) => s.skillId === "login");
        if (
          task.gameId === "arknights" &&
          task.plan.mode === "live" &&
          login?.status === "succeeded" &&
          login.evidence === "adapter-result" &&
          login.result?.arknights?.completion === "native-confirmed" &&
          login.result.arknights.login?.home === true &&
          historyNativeMatches(task, profile?.expectedUid)
        ) {
          recordedLogins.push({
            requestId: id,
            runId,
            observedAt: date(login.result.arknights.login.observedAt),
          });
        }
        if (task.fault)
          incidentFaults.push({
            requestId: id,
            runId,
            skillId: task.fault.skillId,
            code: task.fault.code,
            source: task.fault.source,
            observedAt: date(task.fault.observedAt),
            captureStatus: task.fault.capture.status,
            imageSent: false,
          });
        const signal = (
          code: IncidentSignal["code"],
          skillId?: string,
          basis: IncidentSignal["basis"] = "log-pattern",
        ) =>
          incidentSignals.push({ requestId: id, runId, skillId, code, basis });
        incidentLogCodes([task.message], task.gameId).forEach((code) =>
          signal(code),
        );
        for (const step of task.steps) {
          incidentLogCodes(
            [step.message, ...step.diagnostics],
            task.gameId,
          ).forEach((code) => signal(code, step.skillId));
          if (
            historyNativeMatches(task, profile?.expectedUid) &&
            step.result?.arknights?.submission === "submitted" &&
            step.result.arknights.completion !== "native-confirmed"
          )
            signal("native-unconfirmed", step.skillId, "structured-record");
          const result = step.result;
          if (
            task.gameId === "onmyoji" &&
            step.skillId === "foster" &&
            result?.observedAt &&
            result.nextRunAt
          ) {
            try {
              const observed = Date.parse(date(result.observedAt));
              const next = Date.parse(date(result.nextRunAt));
              if (
                observed >= Date.parse(step.startedAt ?? task.startedAt) &&
                observed <= Date.parse(step.finishedAt ?? task.updatedAt) &&
                next > observed &&
                next - observed <= 6 * 3600_000
              )
                signal(
                  "foster-recheck-recorded",
                  step.skillId,
                  "structured-record",
                );
            } catch {
              /* Missing or invalid countdown cannot be promoted to evidence. */
            }
          }
        }
        projectedTasks.push({
          version: 1,
          executionId: id,
          runId,
          laneId,
          batchId: id,
          instance: lane.instance,
          gameId: task.gameId,
          plan: historyPlan(task.plan),
          startedAt: date(task.startedAt),
          updatedAt: date(task.updatedAt),
          finishedAt: optionalDate(task.finishedAt),
          status: task.status,
          message: "",
          steps: task.steps.map((s) => ({
            skillId: s.skillId,
            status: historyStepStatus(s),
            startedAt: optionalDate(s.startedAt),
            finishedAt: optionalDate(s.finishedAt),
            message: "",
            diagnostics: [],
            ...(["adapter-return", "adapter-result", "rehearsal"].includes(
              s.evidence ?? "",
            )
              ? { evidence: s.evidence }
              : {}),
          })),
        });
      }
    }
    const details = new Map<string, ExecutionDetail>();
    for (const raw of requests.filter((r) => aliases.has(r.id))) {
      const linked = tasks.filter((t) => t.executionId === raw.id);
      const detail = projectExecutionDetail(raw, linked);
      for (const game of detail.games)
        if (!game.record && linked.some((t) => t.gameId === game.plan.gameId))
          detail.warnings.push("存在不能唯一可靠关联的步骤账本");
      if (incompleteRequests.has(aliases.get(raw.id)!))
        detail.warnings.push("原记录的账号、时间或原生证据不完整");
      details.set(raw.id, detail);
    }
    const recordedProgress: NonNullable<AgentSnapshot["recordedProgress"]> = [];
    for (const [rawId, id] of aliases) {
      const laneId = projected.find((r) => r.id === id)!.laneId!;
      const progress = agentExecutionProgress(
        mergeExecutionProgress(rawId, requests, details),
        aliases,
        laneId,
      );
      if (progress) recordedProgress.push(progress);
    }
    const fingerprint = hash(canonical(files));
    if (fingerprint !== hash(canonical(await collect(directory))))
      throw Error("changed while collecting");
    return {
      requests: projected,
      tasks: projectedTasks,
      incidentSignals,
      incidentFaults,
      recordedLogins: recordedLogins.filter(
        (r) => !incompleteRequests.has(r.requestId),
      ),
      recordedResults: recordedResults.filter(
        (r) => !incompleteRequests.has(r.requestId),
      ),
      recordedProgress,
      bindings: [...aliases].map(([requestId, alias]) => ({
        requestId,
        alias,
      })),
      fingerprint,
      history: {
        unassociatedRequests,
        incompleteRequests: [...incompleteRequests],
        scope: "bounded-ledger" as const,
        identity: "not-verified" as const,
      },
    };
  } catch {
    throw new AgentToolError(
      "HISTORY_UNAVAILABLE",
      "任务账本缺失、超出读取上限、损坏或正在变化，请稍后重新查询；不能据此判断完成",
    );
  }
}
