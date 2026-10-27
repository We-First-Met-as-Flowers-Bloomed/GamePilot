import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  requestLocalControl,
  publicError,
} from "./agent/local-control-client.mjs";
import { selectCliLane, assertCliOptions } from "./shared/cli-target.mjs";

const args = process.argv.slice(2);
try {
  assertCliOptions(
    args,
    ["data", "lane", "job", "request-id"],
    ["due", "status"],
  );
  const value = (key, fallback) => {
    const index = args.indexOf("--" + key);
    return index < 0 ? fallback : args[index + 1];
  };
  const data = value("data", join(homedir(), ".gamepilot"));
  const modes = [
    args.includes("--due"),
    args.includes("--status"),
    args.includes("--job"),
    args.includes("--lane"),
  ].filter(Boolean);
  if (modes.length !== 1)
    throw Error("请选择 --due、--status、--job 或 --lane 中的一项");
  const requestId = value("request-id", randomUUID());
  let method,
    params = {};
  if (args.includes("--status")) method = "arknights-automation";
  else if (args.includes("--due")) method = "arknights-tick";
  else if (args.includes("--job")) {
    method = "arknights-run-job";
    params = { jobId: value("job"), requestId };
  } else {
    const lanes = JSON.parse(
      await readFile(join(data, "device-lanes.json"), "utf8"),
    );
    const lane = selectCliLane(lanes.lanes, value("lane"), "arknights");
    method = "arknights-run-channel";
    params = { laneId: lane.id, requestId };
  }
  const response = await requestLocalControl(data, method, params, {
    requestId,
    timeoutMs: 30000,
  });
  process.stdout.write(JSON.stringify(response) + "\n");
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify(publicError(error)) + "\n");
  process.exitCode = 1;
}
