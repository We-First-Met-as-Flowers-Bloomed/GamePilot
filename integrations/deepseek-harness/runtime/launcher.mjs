import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";

const directory = fileURLToPath(new URL(".", import.meta.url));
let client;
let active = false;
let closing;
let eventsSubscription;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function close() {
  closing ??= (async () => {
    await client?.close();
  })();
  return closing;
}

/** SDK process runs under the bundled Node; its DSH child inherits the hidden console. */
async function handle(method, params) {
  if (method === "initialize") {
    if (client || closing) throw new Error("DSH_ALREADY_STARTED");
    client = new HarnessClient({
      profile: "sdk-minimal",
      patches: [resolve(directory, "gamepilot.cordis.patch.yml")],
      dshHome: params.home,
      processCwd: directory,
      initializeTimeoutMs: 30000,
      shutdownTimeoutMs: 2000,
      disposeEofGraceMs: 2500,
      disposeGraceMs: 1500,
      env: {
        ...process.env,
        GAMEPILOT_DSH_PLUGIN: resolve(directory, "plugin.mjs"),
        GAMEPILOT_DSH_SYSTEM_PROMPT: params.systemPrompt,
      },
    });
    try {
      const initialized = await client.initialize({
        cwd: params.cwd,
        provider: "gamepilot-compatible",
        model: params.model,
        maxTokens: 4096,
      });
      eventsSubscription = client.subscribe(
        (event) => event.method === "session.event",
      );
      void (async () => {
        try {
          for (;;) {
            const event = await eventsSubscription.next();
            send({
              notification: "session.event",
              sessionId: event.params.sessionId,
              event: event.params.event,
            });
          }
        } catch {
          /* SDK closure ends the public event subscription. */
        }
      })();
      return initialized;
    } catch (error) {
      await close();
      throw error;
    }
  }
  if (!client || closing) throw new Error("DSH_NOT_READY");
  if (method === "cancel")
    return client.request("gamepilot/session/cancel", params);
  if (method === "history")
    return client.request("gamepilot/session/history", params);
  if (method === "close") {
    await close();
    return {};
  }
  if (method !== "run") throw new Error("METHOD_NOT_ALLOWED");
  if (active) throw new Error("DSH_BUSY");
  active = true;
  const subscription = client.subscribeSessionTree(params.sessionId);
  try {
    await client.request("gamepilot/session/open", {
      sessionId: params.sessionId,
      resume: params.resume === true,
    });
    const messageId = await client.prompt(params.sessionId, [
      { type: "text", text: params.prompt },
    ]);
    let received = false;
    let finalText = "";
    let endReason;
    for (;;) {
      const notification = await subscription.next();
      if (
        notification.method === "session.event" &&
        notification.params.sessionId === params.sessionId
      ) {
        const event = notification.params.event;
        if (
          !received &&
          event?.type === "agent/inbox/spliced" &&
          event.data?.inserted?.some((message) => message.id === messageId)
        )
          received = true;
        if (!received) continue;
        if (event.type === "assistant/message")
          finalText = event.data.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        if (event.type === "turn/end") endReason = event.data.reason;
      }
      if (
        received &&
        notification.method === "session.status" &&
        notification.params.sessionId === params.sessionId &&
        notification.params.status === "idle"
      )
        break;
    }
    return { sessionId: params.sessionId, finalText, endReason };
  } finally {
    subscription.close();
    active = false;
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.length > 1024 * 1024) {
    void close().finally(() => process.exit(1));
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    void close().finally(() => process.exit(1));
    return;
  }
  void handle(request.method, request.params).then(
    (result) => {
      send({ id: request.id, result });
      if (request.method === "close") process.exit(0);
    },
    // Errors on this boundary intentionally exclude upstream stderr, request and provider details.
    () =>
      send({
        id: request.id,
        error: {
          code: "DSH_RUNTIME_FAILED",
          message: "DSH runtime control failed",
        },
      }),
  );
});
input.on("close", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
