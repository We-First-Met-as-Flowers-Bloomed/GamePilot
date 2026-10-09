import { describe, expect, it } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";
import { agentToolSpecs } from "../packages/agent/tool-specs";
import { createAgentTools } from "../packages/agent/tools";

const at = "2026-09-26T00:00:00.000Z";
function setup() {
  const tools = createAgentTools(createFixtureSnapshot());
  const session = new PlannerSession(tools, at);
  const input = {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at,
    lanes: [
      {
        laneId: "lane-a",
        games: [
          { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
        ],
      },
    ],
  };
  return { tools, session, input };
}
describe("planner host", () => {
  it("attaches a host-owned unknown conclusion even when the model asserts not-run", () => {
    const snapshot = createFixtureSnapshot();
    snapshot.source = "recorded";
    const session = new PlannerSession(createAgentTools(snapshot), at);
    const final = session.finish(
      JSON.stringify({
        kind: "answer",
        text: "没有完整记录，所以两个号今天都没运行。",
        planHash: null,
      }),
    );
    expect(final.historyAssessment).toMatchObject({
      dailyCompletion: "unknown",
      missingRecordMeans: "unknown",
      canInferNotRun: false,
      canAuthorizeReplay: false,
    });
    expect(final.modelText).toContain("今天都没运行");
    expect(final.canExecute).toBe(false);
    expect(final.execution).toBe("not-started");
  });
  it("distinguishes query output formatting from an unverified draft", () => {
    const { session } = setup();
    for (const planHash of [undefined, "", "null", 123]) {
      expect(() =>
        session.finish(
          JSON.stringify({ kind: "answer", text: "查询", planHash }),
        ),
      ).toThrow(expect.objectContaining({ code: "INVALID_OUTPUT" }));
    }
    expect(() =>
      session.finish(
        JSON.stringify({ kind: "draft", text: "编造", planHash: "fake" }),
      ),
    ).toThrow(expect.objectContaining({ code: "UNVERIFIED_DRAFT" }));
  });
  it("rejects array-valued statuses instead of coercing them into the enum", () => {
    const { session } = setup();
    expect(() =>
      session.finish(
        JSON.stringify({ kind: ["blocked"], text: "不支持", planHash: null }),
      ),
    ).toThrow();
  });
  it("exposes only registered tools with current game parameter schemas", () => {
    const { tools } = setup();
    const specs = agentToolSpecs(tools.call("list_capabilities"));
    expect(specs.map((s) => s.name)).toEqual([
      "list_capabilities",
      "read_skill",
      "get_environment",
      "compile_plan",
      "get_run",
      "get_incident",
    ]);
    expect(JSON.stringify(specs)).toContain('"expiringMedicine"');
    expect(specs.every((s) => s.type === "function")).toBe(true);
  });
  it("returns only the actual compiler result, never model-generated plan contents", () => {
    const { session, input } = setup();
    const result = session.call("c1", "compile_plan", input);
    expect(result.success).toBe(true);
    const draft = JSON.parse(result.contentItems[0].text);
    const final = session.finish(
      JSON.stringify({
        kind: "draft",
        text: "草稿等待检查",
        planHash: draft.planHash,
      }),
    );
    expect(final).toMatchObject({
      status: "draft",
      canExecute: false,
      draft: { planHash: draft.planHash, at },
    });
    expect(final.trace).toHaveLength(1);
    expect(() =>
      session.finish(
        JSON.stringify({ kind: "draft", text: "已完成", planHash: "forged" }),
      ),
    ).toThrow(/草稿/);
  });
  it("deduplicates identical calls and rejects call id reuse with different arguments", () => {
    const { session } = setup();
    expect(session.call("c1", "get_environment", {})).toEqual(
      session.call("c1", "get_environment", {}),
    );
    expect(session.trace).toHaveLength(1);
    expect(() => session.call("c1", "list_capabilities", {})).toThrow(/重复/);
  });
  it("clears the previous draft on a failed compilation", () => {
    const { session, input } = setup();
    const prior = JSON.parse(
      session.call("c1", "compile_plan", input).contentItems[0].text,
    );
    const bad = structuredClone(input);
    Object.assign(bad.lanes[0].games[0].parameters, { medicine: 1 });
    expect(session.call("c2", "compile_plan", bad).success).toBe(false);
    expect(() =>
      session.finish(
        JSON.stringify({
          kind: "draft",
          text: "继续",
          planHash: prior.planHash,
        }),
      ),
    ).toThrow(/草稿/);
  });
  it("rejects unknown tools and enforces the call budget", () => {
    const { session } = setup();
    expect(() => session.call("bad", "start_run", {})).toThrow(/工具/);
    for (let i = 0; i < 12; i++)
      session.call(String(i), "list_capabilities", {});
    expect(() => session.call("13", "list_capabilities", {})).toThrow(/预算/);
  });
  it("does not turn model prose or a query into verified game success", () => {
    const { session } = setup();
    expect(() => session.finish("全部完成")).toThrow();
    expect(
      session.finish(
        JSON.stringify({ kind: "answer", text: "记录未知", planHash: null }),
      ),
    ).toMatchObject({
      status: "answer",
      canExecute: false,
      execution: "not-started",
      draft: undefined,
    });
    expect(() =>
      session.finish(
        JSON.stringify({ kind: "draft", text: "编好了", planHash: null }),
      ),
    ).toThrow();
  });
  it("requires the frozen time and refuses disk snapshots in this prototype", () => {
    const { session, input } = setup();
    expect(
      session.call("c1", "compile_plan", {
        ...input,
        at: "2026-09-28T08:00:00+08:00",
      }).success,
    ).toBe(false);
    const fixture = createFixtureSnapshot();
    fixture.source = "disk";
    expect(() => new PlannerSession(createAgentTools(fixture), at)).toThrow(
      /合成/,
    );
  });
});
