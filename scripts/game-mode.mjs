/** Compatibility runner: every live operation belongs to the running App. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestLocalControl } from "./agent/local-control-client.mjs";
import { runSavedGameChannel } from "./shared/game-app.mjs";
import { selectCliCombos, assertCliOptions } from "./shared/cli-target.mjs";

export async function runGameMode(
  args,
  {
    read = (file) => readFileSync(file, "utf8"),
    write = writeFileSync,
    mkdir = mkdirSync,
    request = requestLocalControl,
    run = runSavedGameChannel,
    log = (value) => console.log(JSON.stringify(value)),
    root = fileURLToPath(new URL("../", import.meta.url)),
    now = new Date(),
  } = {},
) {
  assertCliOptions(
    args,
    ["data", "lane", "game", "request-id"],
    ["dry", "status", "catchup"],
  );
  const value = (key, fallback) => {
    const i = args.indexOf("--" + key);
    return i < 0 ? fallback : args[i + 1];
  };
  const data = value("data", join(homedir(), ".gamepilot")),
    onlyLane = value("lane", "all"),
    onlyGame = value("game", "all");
  if (!["all", "arknights", "onmyoji"].includes(onlyGame))
    throw Error("游戏范围无效");
  const modes = ["dry", "status", "catchup"].filter((mode) =>
    args.includes("--" + mode),
  );
  if (modes.length > 1) throw Error("请选择一种查询或到期执行模式");
  if (modes.length) {
    if (onlyLane !== "all")
      throw Error(
        "到期任务由App按账号计划选择，请在App中编辑或立即运行单个计划",
      );
    const games = onlyGame === "all" ? ["arknights", "onmyoji"] : [onlyGame];
    let ok = true;
    for (const gameId of games) {
      const response = await request(
        data,
        args.includes("--catchup") ? "game-tick" : "game-automation",
        { gameId },
      );
      log({ gameId, ...response });
      if (!response.ok) ok = false;
    }
    // Tick acknowledges admission only; it does not assert in-game success.
    return ok ? 0 : 1;
  }
  const lanes =
    JSON.parse(read(resolve(data, "device-lanes.json"))).lanes ?? [];
  const combos = selectCliCombos(lanes, onlyLane, onlyGame);
  if (!combos.length) throw Error("没有已启用的账号渠道，请在App中配置");
  if (args.includes("--request-id") && combos.length !== 1)
    throw Error("指定请求编号时请选择唯一游戏账号");
  const chains = new Map();
  const results = await Promise.allSettled(
    combos.map((combo) => {
      const lane = lanes.find((item) => item.id === combo.lane);
      const instance = lane.deviceInstances?.[combo.game] ?? lane.instance;
      const key = `${win32.normalize(lane.managerPath ?? "").toLowerCase()}#${instance}`;
      const previous = chains.get(key);
      const pending = (previous ?? Promise.resolve()).then(async (last) => {
        if (last && last.status !== "succeeded")
          throw Error("同设备的原App请求未确认完成，请在App核对后续跑");
        const receipt = await run(data, combo.lane, combo.game, {
          requestId: value("request-id", undefined),
          onAdmitted: (admitted) =>
            log({
              source: "app",
              gameId: combo.game,
              laneId: combo.lane,
              admitted,
            }),
        });
        log({ source: "app", gameId: combo.game, result: receipt });
        return { ...combo, ...receipt };
      });
      chains.set(key, pending);
      return pending;
    }),
  );
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dir = resolve(root, "artifacts/game-mode", day);
  const rows = results.map((result, index) =>
    result.status === "fulfilled"
      ? `${combos[index].lane} · ${combos[index].game} · ${result.value.batchId} · ${result.value.status} · ${result.value.message ?? ""}`
      : `${combos[index].lane} · ${combos[index].game} · 未确认 · ${result.reason?.message ?? "App请求未完成"}`,
  );
  mkdir(dir, { recursive: true });
  write(
    resolve(dir, "report.md"),
    [
      "# App 本次执行回执",
      ...rows,
      "步骤与收益请在App原始记录核对；本入口不重试、不控制模拟器。",
    ].join("\n"),
  );
  return results.every(
    (item) => item.status === "fulfilled" && item.value.status === "succeeded",
  )
    ? 0
    : 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await runGameMode(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
