import type { EvaluationCase } from "./types";
import { createFixtureSnapshot } from "../fixture";
import { incidentEvaluationSnapshot } from "../../../games/agent-incident-evaluation";
export function evaluationSnapshot(test: EvaluationCase) {
  return test.diagnostic
    ? incidentEvaluationSnapshot(test.diagnostic.scenario)
    : createFixtureSnapshot();
}
export function suiteEvidence(cases: EvaluationCase[]) {
  return cases.some((c) => c.diagnostic)
    ? {
        cases,
        snapshots: cases.map((c) => ({
          id: c.id,
          snapshot: evaluationSnapshot(c),
        })),
      }
    : cases;
}
