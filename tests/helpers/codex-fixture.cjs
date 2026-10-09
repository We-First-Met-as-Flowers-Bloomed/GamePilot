// Protocol fixture only. No network, account credentials, or game data.
const { createInterface } = require("node:readline");
const config = JSON.parse(process.env.GP_TEST_CONFIG);
const mode = process.env.GP_TEST_MODE;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") send({ id, result: {} });
  else if (method === "config/read") {
    config.mcp_servers ??= { external: { enabled: true } };
    if (mode === "drift") config.features.shell_tool = true;
    send({ id, result: { config } });
  } else if (method === "account/read")
    send({
      id,
      result: { account: mode === "auth" ? null : { type: "chatgpt" } },
    });
  else if (method === "thread/start")
    send({ id, result: { thread: { id: "thread" }, model: "fixture-model" } });
  else if (method === "turn/start") {
    send({ id, result: { turn: { id: "turn" } } });
    send({
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "inProgress" },
      },
    });
  }
});
