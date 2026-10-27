import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { writeFile } from "node:fs/promises";
import { AgentToolError } from "../packages/protocol/agent";
import { ChatCommandService } from "../apps/desktop/main/chat-commands";

const hosts: { close(): Promise<void> }[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel))
      await rm(directory, { recursive: true, force: true });
  }
});
async function host(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  options: { requestTimeoutMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "gp-local-control-test-"));
  directories.push(directory);
  const api = await import("../apps/desktop/main/local-control").catch(
    () => undefined,
  );
  expect(api?.createLocalControlServer).toBeTypeOf("function");
  const server = await api!.createLocalControlServer({
    profileDir: directory,
    handlers,
    ...options,
  });
  hosts.push(server);
  return { ...server, directory };
}
async function request(
  file: string,
  body: Record<string, unknown>,
  wire?: (token: string) => string,
) {
  const connection = JSON.parse(await readFile(file, "utf8"));
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(connection.pipe);
    let response = "";
    socket.on("connect", () =>
      socket.write(
        wire
          ? wire(connection.token)
          : JSON.stringify({ token: connection.token, ...body }) + "\n",
      ),
    );
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("error", reject);
    socket.once("close", () => reject(new Error("test transport closed")));
    socket.on("end", () => {
      socket.destroy();
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("test transport timeout"));
    });
  });
}
it("serves host facts on a real local socket and strips private output fields", async () => {
  const server = await host({
    status: () => ({
      ready: true,
      uid: "123456789",
      apiKey: "PRIVATE",
      path: "C:\\private",
      nested: { label: "设备A", expectedUid: "987654321" },
    }),
  });
  const value = await request(server.connectionFile, {
    id: "status-a",
    method: "status",
    params: {},
  });
  expect(value).toEqual({
    id: "status-a",
    ok: true,
    result: { ready: true, nested: { label: "设备A" } },
  });
  expect(JSON.stringify(value)).not.toContain("PRIVATE");
  const discovery = JSON.parse(await readFile(server.connectionFile, "utf8"));
  expect(discovery).toMatchObject({
    version: 1,
    token: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(discovery).not.toHaveProperty("port");
});
it("authenticates and validates the fixed method schema before entering host handlers", async () => {
  const status = vi.fn(() => ({ ready: true }));
  const server = await host({ status });
  expect(
    await request(server.connectionFile, {
      id: "wrong",
      token: "wrong",
      method: "status",
      params: {},
    }),
  ).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
  expect(
    await request(server.connectionFile, {
      id: "unknown",
      method: "shell",
      params: {},
    }),
  ).toMatchObject({ ok: false, error: { code: "METHOD_FORBIDDEN" } });
  expect(
    await request(server.connectionFile, {
      id: "args",
      method: "status",
      params: { executable: "PRIVATE" },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  expect(status).not.toHaveBeenCalled();
});
it("accepts an explicit record disposition only with a written reason", async () => {
  // 2026-10-15（P5a）：处置是**显式**动作——必须带依据；参数不合规时不得进入宿主处理器。
  const resolveExecution = vi.fn((params: Record<string, unknown>) => ({
    requestId: params.requestId,
  }));
  const server = await host({ "resolve-execution": resolveExecution });
  expect(
    await request(server.connectionFile, {
      id: "ok",
      method: "resolve-execution",
      params: { requestId: "req-1:lane-a", note: "现场帧确认未生效，判定为未执行" },
    }),
  ).toMatchObject({ ok: true });
  expect(resolveExecution).toHaveBeenCalledTimes(1);
  // 没有依据 / 依据太短 / 多余字段 / 非法编号：全部在进入处理器之前拒绝。
  for (const params of [
    { requestId: "req-2:lane-a" },
    { requestId: "req-2:lane-a", note: "ok" },
    { requestId: "req-2:lane-a", note: "现场核对后判定未生效", extra: 1 },
    { requestId: "req 2", note: "现场核对后判定未生效" },
  ]) {
    expect(
      await request(server.connectionFile, {
        id: "bad",
        method: "resolve-execution",
        params,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  }
  expect(resolveExecution).toHaveBeenCalledTimes(1);
});
it("deduplicates a submitted confirmation across reconnect and rejects changed request IDs", async () => {
  const confirm = vi.fn(() => ({
    status: "submitted",
    receipt: { requestIds: ["host-owned"] },
  }));
  const server = await host({ "command-confirm": confirm });
  const body = {
    id: "confirm-one",
    method: "command-confirm",
    params: { sessionId: "session", reviewId: "review", revision: 2 },
  };
  const first = await request(server.connectionFile, body);
  expect(first).toMatchObject({ ok: true, result: { status: "submitted" } });
  expect(await request(server.connectionFile, body)).toEqual(first);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(
    await request(server.connectionFile, {
      ...body,
      params: { ...body.params, revision: 3 },
    }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_ID_CONFLICT" } });
});
it("reports same-day preview refusal as a definite rejection without suggesting unknown execution", async () => {
  const prepare = vi.fn(async () => {
    throw new AgentToolError("SAME_DAY_EXECUTION", "今日业务已有完成记录");
  });
  const launch = vi.fn();
  const save = vi.fn();
  const commands = new ChatCommandService({
    validateSession: async () => {},
    prepare,
    launch,
    save,
  });
  const server = await host({
    "command-review": (params) => commands.review(params as never),
  });
  const body = {
    id: "daily-already-complete",
    method: "command-review",
    params: { sessionId: "session", text: "运行保存的日常" },
  };
  const response = await request(server.connectionFile, body);
  expect(response).toMatchObject({
    ok: false,
    error: { code: "SAME_DAY_EXECUTION" },
  });
  expect(response.error).not.toHaveProperty("outcomeUnknown");
  expect(await request(server.connectionFile, body)).toEqual(response);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
it("keeps confirmation and untyped handler failures uncertain even when their code resembles a preview refusal", async () => {
  const server = await host({
    "command-confirm": () => {
      throw new AgentToolError("SAME_DAY_EXECUTION", "refusal");
    },
    "command-review": () => {
      throw Object.assign(new Error("unexpected"), {
        code: "SAME_DAY_EXECUTION",
      });
    },
  });
  for (const method of ["command-confirm", "command-review"]) {
    const params =
      method === "command-confirm"
        ? { sessionId: "session", reviewId: "review", revision: 1 }
        : { sessionId: "session", text: "运行保存的日常" };
    expect(
      await request(server.connectionFile, {
        id: `uncertain-${method}`,
        method,
        params,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SAME_DAY_EXECUTION", outcomeUnknown: true },
    });
  }
});
it("bounds partial and oversized frames and returns explicit unavailable capabilities", async () => {
  const server = await host({}, { requestTimeoutMs: 30 });
  expect(await request(server.connectionFile, {}, () => "{")).toMatchObject({
    ok: false,
    error: { code: "TIMEOUT" },
  });
  expect(
    await request(server.connectionFile, {}, () => "x".repeat(65537)),
  ).toMatchObject({ ok: false, error: { code: "FRAME_TOO_LARGE" } });
  expect(
    await request(server.connectionFile, {
      id: "available",
      method: "status",
      params: {},
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_AVAILABLE" } });
});
it("does not replay a timed-out confirmation while its host outcome is still unknown", async () => {
  let finish!: (value: unknown) => void;
  const confirm = vi.fn(() => new Promise((resolve) => (finish = resolve)));
  const server = await host(
    { "resume-confirm": confirm },
    { requestTimeoutMs: 30 },
  );
  const body = {
    id: "pending",
    method: "resume-confirm",
    params: { sessionId: "session", reviewId: "review", revision: 1 },
  };
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: false,
    error: { code: "TIMEOUT", outcomeUnknown: true },
  });
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: false,
    error: { code: "REQUEST_IN_PROGRESS", outcomeUnknown: true },
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  finish({ status: "submitted" });
  await vi.waitFor(async () =>
    expect(await request(server.connectionFile, body)).toMatchObject({
      ok: true,
      result: { status: "submitted" },
    }),
  );
});
it("cleans only its own discovery file on host shutdown", async () => {
  const server = await host();
  await server.close();
  await expect(readFile(server.connectionFile, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("rejects prototype property names as extra parameters", async () => {
  const status = vi.fn(() => ({ ready: true }));
  const server = await host({ status });
  for (const key of ["constructor", "toString", "__proto__"]) {
    const params = JSON.parse(`{"${key}":"PRIVATE"}`);
    expect(
      await request(server.connectionFile, {
        id: `prototype-${key}`,
        method: "status",
        params,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  }
  expect(status).not.toHaveBeenCalled();
});
it("accepts the same dotted request identifiers as the existing execution service", async () => {
  const review = vi.fn(() => ({ status: "review" }));
  const server = await host({ "resume-review": review });
  expect(
    await request(server.connectionFile, {
      id: "resume-preview",
      method: "resume-review",
      params: {
        sessionId: "session",
        requestId: "scheduled.daily.2026-10-04:lane-a",
      },
    }),
  ).toMatchObject({ ok: true });
  expect(review).toHaveBeenCalledTimes(1);
});
it("preserves a replaced discovery file when an older host closes", async () => {
  const server = await host();
  await writeFile(
    server.connectionFile,
    JSON.stringify({ version: 1, hostId: "different-host" }),
  );
  await server.close();
  expect(JSON.parse(await readFile(server.connectionFile, "utf8")).hostId).toBe(
    "different-host",
  );
});
it("bounds a completed confirmation receipt without turning an unknown outcome into a safe retry", async () => {
  const confirm = vi.fn(() => ({ summary: "x".repeat(270000) }));
  const server = await host({ "command-confirm": confirm });
  const body = {
    id: "large-confirm",
    method: "command-confirm",
    params: { sessionId: "session", reviewId: "review", revision: 1 },
  };
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: false,
    error: { code: "RESPONSE_TOO_LARGE", outcomeUnknown: true },
  });
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: false,
    error: { code: "RESPONSE_TOO_LARGE", outcomeUnknown: true },
  });
  expect(confirm).toHaveBeenCalledTimes(1);
});
it("passes only explicit boolean partial acknowledgements to confirmation handlers", async () => {
  const confirm = vi.fn((params: Record<string, unknown>) => ({
    acknowledged: params.acknowledgePartial,
  }));
  const server = await host({
    "command-confirm": confirm,
    "resume-confirm": confirm,
  });
  for (const method of ["command-confirm", "resume-confirm"]) {
    const params = {
      sessionId: "session",
      reviewId: "review",
      revision: 1,
      acknowledgePartial: true,
    };
    expect(
      await request(server.connectionFile, {
        id: `${method}-ack`,
        method,
        params,
      }),
    ).toMatchObject({ ok: true, result: { acknowledged: true } });
    expect(
      await request(server.connectionFile, {
        id: `${method}-bad-ack`,
        method,
        params: { ...params, acknowledgePartial: "true" },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  }
  expect(confirm).toHaveBeenCalledTimes(2);
});
it("keeps stop available while all normal host handler slots are waiting", async () => {
  const status = vi.fn(() => new Promise(() => {}));
  const stop = vi.fn(() => ({ status: "stop-requested" }));
  const server = await host({ status, stop });
  const waiting = Array.from({ length: 16 }, (_, i) =>
    request(server.connectionFile, {
      id: `normal-${i}`,
      method: "status",
      params: {},
    }).catch(() => undefined),
  );
  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(16));
  const response = await request(server.connectionFile, {
    id: "priority-stop",
    method: "stop",
    params: { sessionId: "session" },
  });
  await server.close();
  await Promise.all(waiting);
  expect(response).toMatchObject({
    ok: true,
    result: { status: "stop-requested" },
  });
  expect(stop).toHaveBeenCalledTimes(1);
});
it("bounds stop independently and preserves deduplication across normal and stop IDs", async () => {
  const finishers: ((value: unknown) => void)[] = [];
  const stop = vi.fn(() => new Promise((resolve) => finishers.push(resolve)));
  const review = vi.fn(() => ({ status: "review" }));
  const server = await host({ stop, "command-review": review });
  const body = {
    id: "stop-0",
    method: "stop",
    params: { sessionId: "session" },
  };
  const pending = Array.from({ length: 4 }, (_, i) =>
    request(server.connectionFile, { ...body, id: `stop-${i}` }),
  );
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(4));
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: false,
    error: { code: "REQUEST_IN_PROGRESS", outcomeUnknown: true },
  });
  expect(
    await request(server.connectionFile, { ...body, id: "stop-extra" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_BUDGET" } });
  expect(
    await request(server.connectionFile, {
      id: body.id,
      method: "command-review",
      params: { sessionId: "session", text: "运行保存的日常" },
    }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_ID_CONFLICT" } });
  for (const finish of finishers) finish({ status: "stop-requested" });
  await Promise.all(pending);
  expect(await request(server.connectionFile, body)).toMatchObject({
    ok: true,
    result: { status: "stop-requested" },
  });
  expect(stop).toHaveBeenCalledTimes(4);
  expect(review).not.toHaveBeenCalled();
});
