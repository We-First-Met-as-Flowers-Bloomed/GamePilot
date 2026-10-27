/** A fault run is complete only when every declared case passed exactly once. */
export function faultReportComplete(
  exitCode: number,
  expectedIds: readonly string[],
  results: readonly { id: string; status: string }[],
): boolean {
  return (
    exitCode === 0 &&
    expectedIds.length > 0 &&
    new Set(expectedIds).size === expectedIds.length &&
    results.length === expectedIds.length &&
    new Set(results.map((r) => r.id)).size === results.length &&
    results.every((r) => r.status === "passed" && expectedIds.includes(r.id))
  );
}
