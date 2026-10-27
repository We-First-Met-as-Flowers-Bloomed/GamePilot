/** Compatibility entry: all Arknights execution belongs to the App. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runSavedArknightsChannel } from "./shared/arknights-app.mjs";
import { assertCliOptions, selectCliLane } from "./shared/cli-target.mjs";
const args = process.argv.slice(2);
assertCliOptions(args, ["data", "profile", "lane", "request-id"], []);
const value = (key, fallback) => {
  const i = args.indexOf("--" + key);
  return i < 0 ? fallback : args[i + 1];
};
const data = value("data", join(homedir(), ".gamepilot"));
const lanes = JSON.parse(
  await readFile(join(data, "device-lanes.json"), "utf8"),
).lanes;
let lane;
if (args.includes("--lane"))
  lane = selectCliLane(lanes, value("lane"), "arknights");
else {
  const matching = lanes.filter(
    (item) =>
      item.enabled &&
      item.arknights?.enabled &&
      item.arknights.profileId === value("profile", "default"),
  );
  if (matching.length !== 1)
    throw Error("账号档案未绑定唯一已启用的方舟渠道，请在App中设置");
  lane = matching[0];
}
const result = await runSavedArknightsChannel(data, lane.id, {
  requestId: value("request-id", undefined),
  onAdmitted: (receipt) =>
    console.log(JSON.stringify({ source: "app", admitted: receipt })),
});
console.log(JSON.stringify({ source: "app", result }));
process.exitCode = result.status === "succeeded" ? 0 : 1;
