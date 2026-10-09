import { agentBeijingTime, type AgentToolName } from "../protocol/agent";
import { publicAgentDetailJson } from "../protocol/agent-events";

type PublicObject = Record<string, unknown>;
const object = (value: unknown): PublicObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as PublicObject)
    : {};
const pick = (value: unknown, fields: readonly string[]): PublicObject => {
  const source = object(value);
  return Object.fromEntries(
    fields
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
};
const items = (value: unknown) => (Array.isArray(value) ? value : []);
const count = (value: unknown) =>
  Array.isArray(value) ? value.length : undefined;
const parameters = (value: unknown) =>
  pick(value, ["stage", "mail", "medicine", "stone", "expiringMedicine"]);
const permissions = (value: unknown) =>
  pick(value, ["canExecute", "deviceControl", "externalLoading"]);
const inputGames = (value: unknown) =>
  items(value).map((raw) => {
    const game = object(raw);
    return {
      ...pick(game, ["gameId", "skillIds"]),
      ...(game.parameters === undefined
        ? {}
        : { parameters: parameters(game.parameters) }),
    };
  });

/** Inspect only registered argument fields; arbitrary model prose never enters receipts. */
export function agentToolArguments(
  name: AgentToolName,
  value: unknown,
): string {
  const input = object(value);
  let summary: unknown = {};
  if (name === "read_skill")
    summary = pick(input, ["skillId", "catalogRevision"]);
  if (name === "get_run") summary = pick(input, ["requestId"]);
  if (name === "get_incident")
    summary = pick(input, ["requestId", "environmentRevision"]);
  if (name === "compile_plan")
    summary = {
      ...pick(input, ["catalogRevision", "environmentRevision", "at"]),
      lanes: items(input.lanes).map((raw) => ({
        ...pick(raw, ["laneId"]),
        games: inputGames(object(raw).games),
      })),
    };
  return publicAgentDetailJson(summary);
}

const skill = (raw: unknown) => ({
  ...pick(raw, [
    "id",
    "version",
    "gameIds",
    "bodyByteLength",
    "catalogRevision",
    "directoryRevision",
  ]),
  permissions: permissions(object(raw).permissions),
});
const run = (raw: unknown) => {
  const value = object(raw);
  const recordedTime = object(value.recordedTime);
  const times: PublicObject = {};
  if (recordedTime.timeZone === "Asia/Shanghai") {
    for (const field of ["startedAt", "finishedAt"] as const) {
      const expected = agentBeijingTime(value[field]);
      if (expected && recordedTime[field] === expected) times[field] = expected;
    }
  }
  return {
    ...pick(value, [
      "requestId",
      "laneId",
      "requestSource",
      "recordedStatus",
      "recordedConclusion",
      "startedAt",
      "finishedAt",
      "complete",
      "inGameCompletion",
    ]),
    ...(Object.keys(times).length
      ? { recordedTime: { timeZone: "Asia/Shanghai", ...times } }
      : {}),
    warningCount: count(value.warnings),
    taskCount: count(value.tasks),
    ...(value.resolution === undefined
      ? {}
      : { resolution: pick(value.resolution, ["action", "at"]) }),
    ...(value.recordedProgress === undefined
      ? {}
      : {
          recordedProgress: pick(value.recordedProgress, [
            "rootId",
            "latestId",
            "outcome",
            "wholePlanComplete",
          ]),
        }),
    tasks: items(value.tasks).map((rawTask) => {
      const task = object(rawTask);
      return {
        ...pick(task, [
          "runId",
          "gameId",
          "gameDay",
          "finishedGameDay",
          "mode",
          "status",
        ]),
        ...(task.recordedLogin === undefined
          ? {}
          : {
              recordedLogin: pick(task.recordedLogin, [
                "status",
                "observedAt",
                "currentIdentity",
              ]),
            }),
        steps: items(task.steps).map((step) =>
          pick(step, ["skillId", "status"]),
        ),
      };
    }),
  };
};

/** Each of the six tools has a public structural projection, never a raw response dump. */
export function agentToolResult(name: AgentToolName, raw: unknown): string {
  const value = object(raw);
  if (value.error)
    return publicAgentDetailJson({ error: pick(value.error, ["code"]) });
  let summary: PublicObject;
  switch (name) {
    case "list_capabilities": {
      const directory = object(value.skills);
      summary = {
        ...pick(value, ["version", "revision", "complete", "compilerVersion"]),
        gameCount: count(value.games),
        games: items(value.games).map((game) =>
          pick(game, ["gameId", "id", "version"]),
        ),
        skills: {
          ...pick(directory, ["version", "revision", "complete"]),
          skillCount: count(directory.entries),
          entries: items(directory.entries).map(skill),
        },
      };
      break;
    }
    case "read_skill":
      summary = skill(value);
      break;
    case "get_environment":
      summary = {
        ...pick(value, [
          "version",
          "revision",
          "source",
          "capturedAt",
          "complete",
          "historyAvailable",
        ]),
        ...(value.historyAssessment === undefined
          ? {}
          : {
              historyAssessment: pick(value.historyAssessment, [
                "scope",
                "dailyCompletion",
                "missingRecordMeans",
                "canInferNotRun",
                "canAuthorizeReplay",
              ]),
            }),
        lanes: items(value.lanes).map((rawLane) => {
          const lane = object(rawLane);
          return {
            ...pick(lane, [
              "id",
              "instance",
              "enabled",
              "recordedRequestCount",
            ]),
            games: ["arknights", "onmyoji"]
              .filter((id) => object(lane.games)[id] !== undefined)
              .map((gameId) => ({
                gameId,
                ...pick(object(lane.games)[gameId], ["enabled"]),
              })),
          };
        }),
      };
      break;
    case "compile_plan":
      summary = {
        ...pick(value, [
          "status",
          "canExecute",
          "catalogRevision",
          "environmentRevision",
          "compilerVersion",
          "skillRevision",
          "at",
          "planHash",
        ]),
        reasonCount: count(value.reasons),
        lanes: items(value.lanes).map((rawLane) => ({
          ...pick(rawLane, ["laneId", "instance"]),
          games: items(object(rawLane).games).map((rawGame) => {
            const game = object(rawGame);
            return {
              ...pick(game.plan, ["gameId", "id", "skillIds", "mode"]),
              parameters: parameters(game.parameters),
              ...pick(game, ["excluded"]),
            };
          }),
        })),
      };
      break;
    case "get_run":
      summary = run(value);
      break;
    case "get_incident":
      summary = {
        ...pick(value, [
          "version",
          "environmentRevision",
          "bundleHash",
          "capturedAt",
          "source",
          "omittedSignals",
          "recoverySkills",
          "canExecute",
          "execution",
        ]),
        run: run(value.run),
        gapCount: count(value.gaps),
        signals: items(value.signals).map((signal) =>
          pick(signal, [
            "requestId",
            "runId",
            "skillId",
            "code",
            "basis",
            "evidenceId",
          ]),
        ),
        faults: items(value.faults).map((fault) =>
          pick(fault, [
            "requestId",
            "runId",
            "skillId",
            "code",
            "source",
            "observedAt",
            "captureStatus",
            "imageSent",
            "evidenceId",
          ]),
        ),
      };
      break;
  }
  return publicAgentDetailJson({ summaryOnly: true, ...summary });
}
