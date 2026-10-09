import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { planWithCompatible } from "../packages/agent/openai-compatible/adapter";
import { agentToolResult } from "../packages/agent/tool-details";
import {
  publicAgentDetailJson,
  sanitizeAgentEventDetails,
} from "../packages/protocol/agent-events";

function run(startedAt?: string, finishedAt?: string) {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  snapshot.historyAvailable = true;
  snapshot.requests[0].startedAt = startedAt as string;
  snapshot.requests[0].finishedAt = finishedAt;
  const original = structuredClone(snapshot);
  const tools = createAgentTools(snapshot);
  const result = tools.call("get_run", { requestId: snapshot.requests[0].id });
  return { snapshot, original, tools, result };
}

afterEach(() => vi.unstubAllGlobals());

describe("host-owned recorded run times in Beijing", () => {
  it("converts UTC across midnight while retaining the real ISO timestamps and snapshot", () => {
    const f = run("2026-10-04T17:01:27.456Z", "2026-10-04T17:11:30Z");
    expect(f.result).toMatchObject({
      startedAt: "2026-10-04T17:01:27.456Z",
      finishedAt: "2026-10-04T17:11:30.000Z",
      recordedTime: {
        timeZone: "Asia/Shanghai",
        startedAt: "2026-10-05 01:01:27",
        finishedAt: "2026-10-05 01:11:30",
      },
      inGameCompletion: "not-verified",
    });
    expect(f.snapshot).toEqual(f.original);
    expect(f.result.recordedStatus).toBe("unknown");
  });

  it("accepts explicit offsets and crosses the calendar year without using machine timezone", () => {
    expect(run("2026-12-31T20:00:01+02:00").result.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2027-01-01 02:00:01",
    });
    expect(run("2026-10-05T01:01:27Z").result.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 09:01:27",
    });
  });

  it.each([
    undefined,
    "2026-10-05 01:01:27",
    "2026-02-30T01:01:27Z",
    "2026-10-05T24:01:27Z",
    "PRIVATE_TIMESTAMP/path",
  ])(
    "does not invent a display time from missing or invalid ISO %s",
    (invalid) => {
      const result = run(invalid, invalid).result;
      expect(result.startedAt).toBeUndefined();
      expect(result.finishedAt).toBeUndefined();
      expect(result.recordedTime).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TIMESTAMP");
    },
  );

  it("provides only whichever timestamp exists without filling its counterpart", () => {
    expect(run(undefined, "2026-10-05T01:11:30Z").result.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      finishedAt: "2026-10-05 09:11:30",
    });
    expect(run("2026-10-05T01:01:27Z").result.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 09:01:27",
    });
  });

  it("does not swap inconsistent historical start/end times or invent a duration", () => {
    const result = run("2026-10-05T02:00:00Z", "2026-10-05T01:00:00Z").result;
    expect(result.startedAt).toBe("2026-10-05T02:00:00.000Z");
    expect(result.finishedAt).toBe("2026-10-05T01:00:00.000Z");
    expect(result.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 10:00:00",
      finishedAt: "2026-10-05 09:00:00",
    });
    expect(result).not.toHaveProperty("durationMs");
    expect(result.recordedStatus).toBe("unknown");
  });

  it("keeps exact deterministic time fields in the public receipt and omits arbitrary values", () => {
    const raw = run("2026-10-05T01:01:27Z", "2026-10-05T01:11:30Z").result;
    const detail = JSON.parse(
      agentToolResult("get_run", {
        ...raw,
        recordedTime: {
          ...raw.recordedTime,
          apiKey: "PRIVATE_API_KEY",
          path: "D:/PRIVATE_PATH",
        },
      }),
    );
    expect(detail.recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 09:01:27",
      finishedAt: "2026-10-05 09:11:30",
    });
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
    expect(
      JSON.parse(
        agentToolResult("get_run", {
          ...raw,
          recordedTime: {
            timeZone: "PRIVATE_TIMEZONE",
            startedAt: "PRIVATE_TIMESTAMP",
          },
        }),
      ).recordedTime,
    ).toBeUndefined();
    expect(
      JSON.parse(
        agentToolResult("get_run", {
          ...raw,
          recordedTime: {
            timeZone: "Asia/Shanghai",
            startedAt: "2026-02-30 09:01:27",
            finishedAt: "PRIVATE_TIMESTAMP",
          },
        }),
      ).recordedTime,
    ).toBeUndefined();
    expect(
      JSON.parse(
        agentToolResult("get_run", {
          ...raw,
          recordedTime: {
            timeZone: "Asia/Shanghai",
            startedAt: "2026-10-05 01:01:27",
          },
        }),
      ).recordedTime,
    ).toBeUndefined();
  });

  it("keeps only the exact safe timezone and valid display fields through durable detail sanitization", () => {
    const recordedTime = {
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 09:01:27",
      finishedAt: "2026-10-05 09:11:30",
    };
    const details = sanitizeAgentEventDetails({
      result: JSON.stringify({
        recordedTime: { ...recordedTime, path: "D:/PRIVATE_PATH" },
      }),
    });
    expect(JSON.parse(details!.result!)).toEqual({ recordedTime });
    const unsafe = JSON.parse(
      publicAgentDetailJson({
        recordedTime: {
          timeZone: "D:/PRIVATE_PATH",
          startedAt: "PRIVATE_TIMESTAMP",
        },
        timeZone: "D:/PRIVATE_PATH",
        stage: "D:/OTHER_PATH",
      }),
    );
    expect(unsafe.recordedTime).toBeUndefined();
    expect(unsafe.timeZone).toBeUndefined();
    expect(unsafe.stage).toBeUndefined();
    expect(
      JSON.parse(
        publicAgentDetailJson({
          recordedTime: {
            timeZone: "Asia/Shanghai",
            startedAt: "2026-02-30 09:01:27",
            finishedAt: "2026-10-05 24:01:27",
          },
        }),
      ).recordedTime,
    ).toBeUndefined();
  });

  it("includes the host conversion in the actual compatible tool response while retaining six readonly tools", async () => {
    const { tools } = run("2026-10-05T01:01:27Z", "2026-10-05T01:11:30Z");
    const requests: {
      messages: { role: string; content: string }[];
      tools: unknown[];
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        const message =
          requests.length === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "get-run-time",
                    type: "function",
                    function: {
                      name: "get_run",
                      arguments: JSON.stringify({
                        requestId: "fixture:lane-a",
                      }),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: JSON.stringify({
                  kind: "answer",
                  text: "模拟响应，仅检验宿主时间进入模型请求",
                  planHash: null,
                }),
              };
        return new Response(
          JSON.stringify({
            model: "test",
            choices: [
              {
                finish_reason: requests.length === 1 ? "tool_calls" : "stop",
                message,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await planWithCompatible(tools, {
      connection: {
        baseUrl: "https://model.example/v1",
        model: "test",
        apiKey: "test-key",
      },
      prompt: "说明原任务记录时间",
      at: "2026-10-05T02:00:00Z",
    });
    const response = requests[1].messages.find((item) => item.role === "tool")!;
    expect(JSON.parse(response.content).recordedTime).toEqual({
      timeZone: "Asia/Shanghai",
      startedAt: "2026-10-05 09:01:27",
      finishedAt: "2026-10-05 09:11:30",
    });
    expect(requests[1].tools).toHaveLength(7);
    expect(requests[0].messages[0].content).toContain("recordedTime");
    expect(requests[0].messages[0].content).toContain(
      "不能截取UTC小时作为北京时间",
    );
  });
});
