import { expect, it } from "vitest";
import { faultReportComplete } from "../packages/agent/evaluation/fault-report";
import { evaluationCases } from "../packages/agent/evaluation/cases";
const expected = () =>
  evaluationCases.filter((c) => c.mode === "fault-injection").map((c) => c.id);
it("includes concurrent wrapper builds in the declared fault suite", () => {
  expect(expected()).toContain("F07");
  expect(
    faultReportComplete(
      0,
      expected(),
      expected().map((id) => ({ id, status: "passed" })),
    ),
  ).toBe(true);
});
it("rejects missing, duplicate, unknown, failed, skipped and unsuccessful process reports", () => {
  const ids = ["F01", "F02"];
  const results = ids.map((id) => ({ id, status: "passed" }));
  for (const rows of [
    results.slice(0, 1),
    [...results, results[0]],
    [...results, { id: "F99", status: "passed" }],
    [{ id: "F01", status: "failed" }, results[1]],
    [{ id: "F01", status: "pending" }, results[1]],
  ])
    expect(faultReportComplete(0, ids, rows)).toBe(false);
  expect(faultReportComplete(1, ids, results)).toBe(false);
  expect(faultReportComplete(0, [], [])).toBe(false);
});
