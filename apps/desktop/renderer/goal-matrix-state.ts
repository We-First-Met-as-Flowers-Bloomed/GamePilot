import type { GoalRun } from "../../../packages/protocol/agent-goal";

export type MatrixTone =
  "verified" | "failed" | "unknown" | "waiting" | "excluded";
/** Original authorization defines the grid; only exactly bound host skill results prove progress. */
export function goalMatrix(goal: GoalRun) {
  const scopes =
    goal.originalReview?.scopes ?? goal.review?.scopes ?? goal.grant.scopes;
  const gameIds = [...new Set(scopes.map((scope) => scope.gameId))];
  const laneIds = [...new Set(scopes.map((scope) => scope.laneId))];
  const rows = laneIds.map((laneId) => ({
    laneId,
    cells: gameIds.map((gameId) => {
      const skillIds = scopes
        .filter((scope) => scope.laneId === laneId && scope.gameId === gameId)
        .flatMap((scope) => scope.skillIds);
      let verified = 0,
        failed = false;
      const requestIds = new Set<string>();
      for (const skillId of skillIds) {
        const matches = goal.requests.flatMap((request) => {
          if (request.laneId !== laneId) return [];
          return request.skills
            .filter(
              (skill) =>
                skill.skillId === skillId &&
                (request.gameId === gameId ||
                  (!request.gameId && skill.gameId === gameId)),
            )
            .map((skill) => ({ request, skill }));
        });
        matches.forEach(({ request }) => requestIds.add(request.requestId));
        // Repeated scopes/results or a conflicting game identity cannot establish one unique fact.
        if (
          skillIds.filter((id) => id === skillId).length !== 1 ||
          matches.length !== 1
        )
          continue;
        const { skill } = matches[0];
        if (skill.gameId && skill.gameId !== gameId) continue;
        if (
          skill.goalSatisfied === true &&
          ["succeeded", "skipped"].includes(skill.status)
        )
          verified++;
        else if (skill.goalSatisfied === false && skill.status === "failed")
          failed = true;
      }
      const waiting =
        !requestIds.size &&
        [
          "preparing",
          "running",
          "waiting",
          "recovering",
          "cancelling",
        ].includes(goal.status);
      const tone: MatrixTone = !skillIds.length
        ? "excluded"
        : failed
          ? "failed"
          : verified === skillIds.length
            ? "verified"
            : waiting
              ? "waiting"
              : "unknown";
      return {
        laneId,
        gameId,
        skillIds,
        requestIds: [...requestIds],
        total: skillIds.length,
        verified,
        tone,
      };
    }),
  }));
  return { gameIds, rows };
}
