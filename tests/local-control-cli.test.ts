import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createLocalControlServer } from "../apps/desktop/main/local-control";
import {
  localControlSchemas,
  localControlMethods,
} from "../packages/protocol/local-control";

const directories: string[] = [];
const hosts: Awaited<ReturnType<typeof createLocalControlServer>>[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel))
      await rm(directory, { recursive: true, force: true });
  }
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "gp-control-cli-test-"));
  directories.push(value);
  return value;
}
async function cli(args: string[]) {
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [resolve("scripts/agent/control.mjs"), ...args],
      { windowsHide: true, timeout: 6000 },
    );
    expect(result.stderr).toBe("");
    return { code: 0, value: JSON.parse(result.stdout) };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    expect(result.stderr).toBe("");
    return { code: result.code, value: JSON.parse(result.stdout) };
  }
}
it("lets the CLI query the existing host and fails clearly when App is absent", async () => {
  const profileDir = await directory();
  const host = await createLocalControlServer({
    profileDir,
    handlers: { status: () => ({ state: "idle", canExecute: false }) },
  });
  hosts.push(host);
  expect(await cli(["--profile-dir", profileDir, "status"])).toMatchObject({
    code: 0,
    value: { ok: true, result: { state: "idle", canExecute: false } },
  });
  await host.close();
  const unavailable = await cli(["--profile-dir", profileDir, "status"]);
  expect(unavailable).toMatchObject({
    code: 1,
    value: { ok: false, error: { code: "APP_NOT_RUNNING" } },
  });
  expect(JSON.stringify(unavailable)).not.toContain(profileDir);
});
it("reuses a caller request ID without resubmitting the same host confirmation", async () => {
  const profileDir = await directory();
  let count = 0;
  const host = await createLocalControlServer({
    profileDir,
    handlers: {
      "command-confirm": () => ({ status: "submitted", count: ++count }),
    },
  });
  hosts.push(host);
  const input = join(profileDir, "params.json");
  await writeFile(
    input,
    JSON.stringify({ sessionId: "session", reviewId: "review", revision: 1 }),
  );
  const args = [
    "--profile-dir",
    profileDir,
    "--request-id",
    "stable-call",
    "--params-file",
    input,
    "command-confirm",
  ];
  expect(await cli(args)).toMatchObject({
    code: 0,
    value: { result: { count: 1 } },
  });
  expect(await cli(args)).toMatchObject({
    code: 0,
    value: { result: { count: 1 } },
  });
  expect(count).toBe(1);
});
it("defaults CLI events to cursor zero while preserving explicit parameters and the host page limit", async () => {
  const profileDir = await directory();
  const events = vi.fn((params) => ({
    version: 1,
    events: [],
    cursor: params.afterSeq,
  }));
  const host = await createLocalControlServer({
    profileDir,
    handlers: { events },
  });
  hosts.push(host);
  expect(await cli(["--profile-dir", profileDir, "events"])).toMatchObject({
    code: 0,
    value: { ok: true, result: { cursor: 0 } },
  });
  expect(events).toHaveBeenLastCalledWith({ afterSeq: 0 });
  const input = join(profileDir, "events-input.json");
  await writeFile(input, JSON.stringify({ afterSeq: 3, limit: 100 }));
  expect(
    await cli(["--profile-dir", profileDir, "events", "--params-file", input]),
  ).toMatchObject({ code: 0, value: { result: { cursor: 3 } } });
  expect(events).toHaveBeenLastCalledWith({ afterSeq: 3, limit: 100 });
  for (const params of [{}, { afterSeq: 0, limit: 101 }]) {
    await writeFile(input, JSON.stringify(params));
    expect(
      await cli([
        "--profile-dir",
        profileDir,
        "events",
        "--params-file",
        input,
      ]),
    ).toMatchObject({
      code: 1,
      value: { ok: false, error: { code: "INVALID_PARAMS" } },
    });
  }
  expect(events).toHaveBeenCalledTimes(2);
});
function mcp(profileDir: string) {
  const child = spawn(
    process.execPath,
    [resolve("scripts/agent/mcp.mjs"), "--profile-dir", profileDir],
    { windowsHide: true, stdio: "pipe" },
  );
  children.push(child);
  let buffer = "";
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      replies.get(message.id)?.(message);
      replies.delete(message.id);
    }
  });
  return {
    child,
    send(method: string, params?: unknown) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    },
    call(id: number, method: string, params?: unknown) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MCP test timeout")),
          5000,
        );
        replies.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },
  };
}
it("implements MCP initialization and advertises exactly the fixed host method schemas", async () => {
  const peer = mcp(await directory());
  expect(await peer.call(1, "tools/list")).toMatchObject({
    error: { code: -32002 },
  });
  expect(
    await peer.call(2, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  ).toMatchObject({
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
    },
  });
  peer.send("notifications/initialized");
  const response = await peer.call(3, "tools/list");
  const tools = (
    response.result as { tools: { name: string; inputSchema: unknown }[] }
  ).tools;
  expect(tools.map((tool) => tool.name)).toEqual(
    localControlMethods.map(
      (method) => `gamepilot_${method.replaceAll("-", "_")}`,
    ),
  );
  for (const [index, method] of localControlMethods.entries())
    expect(tools[index].inputSchema).toEqual(localControlSchemas[method]);
  expect(
    await peer.call(4, "tools/call", { name: "shell", arguments: {} }),
  ).toMatchObject({ error: { code: -32602 } });
});
it("routes an MCP tool call through the running host and returns only its public receipt", async () => {
  const profileDir = await directory();
  let calls = 0;
  const host = await createLocalControlServer({
    profileDir,
    handlers: {
      status: () => ({ state: "idle", calls: ++calls, apiKey: "PRIVATE" }),
    },
  });
  hosts.push(host);
  const peer = mcp(profileDir);
  await peer.call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  peer.send("notifications/initialized");
  const response = await peer.call(2, "tools/call", {
    name: "gamepilot_status",
    arguments: {},
  });
  const content = response.result as {
    content: { text: string }[];
    isError: boolean;
  };
  expect(content.isError).toBe(false);
  expect(JSON.parse(content.content[0].text)).toMatchObject({
    ok: true,
    result: { state: "idle", calls: 1 },
  });
  expect(JSON.stringify(response)).not.toContain("PRIVATE");
  expect(calls).toBe(1);
});
it("keeps MCP stop available when normal calls occupy every pending slot", async () => {
  const profileDir = await directory();
  const waiting: (() => void)[] = [];
  const status = vi.fn(
    () => new Promise<void>((resolve) => waiting.push(resolve)),
  );
  const stop = vi.fn(() => ({ status: "stop-requested" }));
  const host = await createLocalControlServer({
    profileDir,
    handlers: { status, stop },
  });
  hosts.push(host);
  const peer = mcp(profileDir);
  await peer.call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  peer.send("notifications/initialized");
  const pending = Array.from({ length: 16 }, (_, i) =>
    peer.call(i + 2, "tools/call", { name: "gamepilot_status", arguments: {} }),
  );
  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(16));
  const response = await peer.call(18, "tools/call", {
    name: "gamepilot_stop",
    arguments: { sessionId: "session" },
  });
  for (const finish of waiting) finish();
  await Promise.all(pending);
  expect(response).toMatchObject({ result: { isError: false } });
  expect(stop).toHaveBeenCalledTimes(1);
});
