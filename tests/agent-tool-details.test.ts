import { afterEach, expect, it, vi } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";
import { createAgentTools } from "../packages/agent/tools";
import { AgentToolError } from "../packages/protocol/agent";
import type { PlannerStreamEvent } from "../packages/protocol/agent-planner";

afterEach(() => vi.restoreAllMocks());
const at = "2026-09-26T00:00:00.000Z";
it("captures actual arguments, public output and monotonic tool duration once", () => {
  const session = new PlannerSession(
    createAgentTools(createFixtureSnapshot()),
    at,
  );
  const events: PlannerStreamEvent[] = [];
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(112.5);
  const response = session.call("call-a", "get_environment", {}, (e) =>
    events.push(e),
  );
  const started = events.find((e) => e.kind === "tool-started");
  const finished = events.find((e) => e.kind === "tool-result");
  expect(started).toMatchObject({ details: { arguments: "{}" } });
  expect(finished).toMatchObject({ details: { durationMs: 12.5 } });
  expect(
    JSON.parse((finished as { details: { result: string } }).details.result),
  ).toMatchObject({ source: "fixture", complete: true });
  expect(response.success).toBe(true);
  session.call("call-a", "get_environment", {}, (e) => events.push(e));
  expect(events).toHaveLength(2);
});
it("omits provider error prose and unrecorded duration before host invocation", () => {
  const tools = {
    call(name: string) {
      if (name === "get_environment") return { source: "fixture" };
      throw new AgentToolError("AUTH", "Bearer PRIVATE_PROVIDER_PASSWORD");
    },
  } as unknown as ReturnType<typeof createAgentTools>;
  const session = new PlannerSession(tools, at);
  const events: PlannerStreamEvent[] = [];
  session.call("call-a", "get_run", { requestId: "request-a" }, (e) =>
    events.push(e),
  );
  expect(events.find((e) => e.kind === "tool-result")).toMatchObject({
    details: { result: '{"error":{"code":"AUTH"}}' },
  });
  expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_PASSWORD");
  const blocked: PlannerStreamEvent[] = [];
  session.call("call-b", "compile_plan", { at: "2026-09-27T00:00:00Z" }, (e) =>
    blocked.push(e),
  );
  expect(blocked).toEqual([]);
});
it("uses per-tool public output fields without skill prose, paths or credentials", () => {
  const outputs: Record<string, unknown> = {
    get_environment: {
      source: "fixture",
      version: 1,
      complete: true,
      lanes: [{ id: "lane-a", enabled: true, uid: "PRIVATE_UID" }],
      notes: ["PRIVATE_NOTE"],
      path: "D:/PRIVATE_PATH",
    },
    list_capabilities: {
      version: 1,
      revision: "revision-a",
      complete: true,
      skills: {
        entries: [
          {
            id: "skill-a",
            version: 1,
            body: "PRIVATE_BODY",
            apiKey: "PRIVATE_KEY",
          },
        ],
      },
    },
    read_skill: {
      id: "skill-a",
      version: 1,
      body: "PRIVATE_BODY",
      description: "PRIVATE_PROSE",
      permissions: { canExecute: false },
    },
    compile_plan: {
      status: "blocked",
      canExecute: false,
      reasons: ["PRIVATE_PROSE"],
      lanes: [],
      password: "PRIVATE_PASSWORD",
    },
    get_run: {
      requestId: "request-a",
      recordedStatus: "failed",
      complete: false,
      inGameCompletion: "not-verified",
      tasks: [],
      notes: ["PRIVATE_PROSE"],
      token: "PRIVATE_TOKEN",
    },
    get_incident: {
      version: 1,
      source: "recorded",
      execution: "not-started",
      canExecute: false,
      run: { requestId: "request-a", recordedStatus: "failed", tasks: [] },
      signals: [{ code: "task-timeout", description: "PRIVATE_PROSE" }],
      gaps: ["PRIVATE_PROSE"],
      recoverySkills: [],
    },
  };
  const tools = {
    call: (name: string) => outputs[name],
  } as unknown as ReturnType<typeof createAgentTools>;
  const session = new PlannerSession(tools, at);
  const events: PlannerStreamEvent[] = [];
  for (const name of Object.keys(outputs))
    session.call(name, name, name === "compile_plan" ? { at } : {}, (e) =>
      events.push(e),
    );
  const results = events.filter((e) => e.kind === "tool-result");
  expect(results).toHaveLength(6);
  for (const event of results) {
    const details = (event as { details?: { result?: string } }).details;
    expect(details?.result).toBeTruthy();
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE_|Bearer|D:\//);
    expect(() => JSON.parse(details!.result!)).not.toThrow();
  }
});
