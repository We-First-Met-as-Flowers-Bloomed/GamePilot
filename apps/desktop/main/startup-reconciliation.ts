import { createHash } from "node:crypto";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import {
  createStartupReconciliationFact,
  startupReconciliationBinding,
  startupReconciliationCandidate,
  verifyStartupReconciliationFact,
} from "../../../games/arknights/startup-reconciliation";
import { canonical } from "../../../packages/acceptance/files";
import type { StartupInspectionPermit } from "./agent-execution-policy";
import type { StartupReconciliationStore } from "./startup-reconciliation-store";

function uniqueRequest(requests: ExecutionRecord[], id: string) {
  const matches = requests.filter((request) => request.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

export function verifiedStartupFacts(
  store: StartupReconciliationStore,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
): StartupReconciliationFact[] {
  return store.snapshot().filter((fact) => {
    const old = uniqueRequest(requests, fact.candidate.originalRequestId);
    const fresh = uniqueRequest(requests, fact.freshLogin.requestId);
    return (
      !!old &&
      !!fresh &&
      verifyStartupReconciliationFact(fact, old, tasks, fresh, tasks)
    );
  });
}

/** Record new proof only after a real login completes; never edits the old request. */
export async function recordStartupReconciliations(
  store: StartupReconciliationStore,
  permit: StartupInspectionPermit,
  freshId: string,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
): Promise<StartupReconciliationFact[]> {
  store.assertHealthy();
  if (permit.verified !== true || !Array.isArray(permit.resources)) return [];
  const fresh = uniqueRequest(requests, freshId);
  if (!fresh || fresh.status !== "succeeded") return [];
  const binding = startupReconciliationBinding(fresh);
  if (!binding || !permit.resources.includes(binding.resource)) return [];
  const result: StartupReconciliationFact[] = [];
  const alreadyVerified = verifiedStartupFacts(store, requests, tasks);
  for (const old of requests) {
    if (!uniqueRequest(requests, old.id)) continue;
    const candidate = startupReconciliationCandidate(old, tasks);
    if (!candidate || canonical(candidate.binding) !== canonical(binding))
      continue;
    if (alreadyVerified.some((f) => f.candidate.originalRequestId === old.id))
      continue;
    let fact: StartupReconciliationFact;
    try {
      fact = createStartupReconciliationFact({
        id: createHash("sha256").update(`${old.id}:${fresh.id}`).digest("hex"),
        originalRequest: old,
        originalTasks: tasks,
        executorExit: {
          verified: permit.verified,
          requestId: old.id,
          resource: binding.resource,
          observedAt: permit.observedAt,
          evidenceReference: permit.evidenceReference,
        },
        freshRequest: fresh,
        freshTasks: tasks,
        evidenceReference: `startup-login:${fresh.id}`,
        now,
      });
    } catch {
      // A different lifecycle or stale observation cannot reconcile this old
      // hazard. It must not prevent an independently matching one being saved.
      continue;
    }
    // Durable write failures must remain visible; never swallow them as bad proof.
    result.push(await store.append(fact));
  }
  return result;
}
