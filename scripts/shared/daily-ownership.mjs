import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { requestLocalControl } from "../agent/local-control-client.mjs";

/** Read-only check; no resolution, lease clearing or retry is performed here. */
export function assessDailyOwnership(response, lanes, target, persisted = []) {
  const reject = (reason) => ({ allowed: false, reason });
  if (
    !Number.isSafeInteger(target) ||
    target < 0 ||
    !Array.isArray(lanes) ||
    !Array.isArray(persisted)
  )
    return reject("设备绑定或历史记录不可核验");
  let live = [];
  if (response?.ok === true && Array.isArray(response.result?.requests))
    live = response.result.requests;
  else if (response?.ok !== false || response.error?.code !== "APP_NOT_RUNNING")
    return reject("App 状态不可确认，保留现场");
  for (const item of [...live, ...persisted]) {
    if (
      !item ||
      !["running", "succeeded", "failed", "cancelled", "unknown"].includes(
        item.status,
      )
    )
      return reject("执行历史状态无效");
    const resolved =
      item.resolution?.action === "abandoned" &&
      Number.isFinite(Date.parse(item.resolution.at));
    const blocking =
      item.status === "running" || (item.status !== "succeeded" && !resolved);
    if (!blocking) continue;
    const resource = `mumu:${win32.normalize("D:\\mumu12\\MuMu Player 12\\nx_main\\MuMuManager.exe").toLowerCase()}#${target}`;
    if (
      item.resources !== undefined &&
      (!Array.isArray(item.resources) ||
        item.resources.some((value) => typeof value !== "string"))
    )
      return reject("未终态请求的物理设备绑定无效");
    if (
      item.resources?.some(
        (value) => value === "*" || value.toLowerCase() === resource,
      )
    )
      return reject("目标物理设备仍有未终态请求；槽位改绑不会解除它");
    const lane = lanes.find((value) => value.id === item.laneId);
    if (!lane) return reject("未终态请求没有可核验的设备绑定");
    const instances = [
      lane.instance,
      ...Object.values(lane.deviceInstances ?? {}),
    ];
    if (instances.some((value) => !Number.isSafeInteger(value) || value < 0))
      return reject("未终态请求的设备绑定无效");
    if (instances.includes(target) || item.resources?.includes("*"))
      return reject(
        "目标设备仍有 active/unknown/未处置请求；不会接管或自动清除",
      );
  }
  return { allowed: true, source: response.ok ? "app" : "offline" };
}

export async function checkDailyOwnership(profileDir, target) {
  const lanes = JSON.parse(
    await readFile(join(profileDir, "device-lanes.json"), "utf8"),
  ).lanes;
  const response = await requestLocalControl(profileDir, "status").catch(
    (error) => ({ ok: false, error: { code: error.code } }),
  );
  let names;
  try {
    names = await readdir(join(profileDir, "execution-requests"));
  } catch (error) {
    if (error.code === "ENOENT") names = [];
    else throw error;
  }
  const persisted = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(
          await readFile(join(profileDir, "execution-requests", name), "utf8"),
        ),
      ),
  );
  return assessDailyOwnership(response, lanes, target, persisted);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await checkDailyOwnership(
      process.argv[3] ?? join(homedir(), ".gamepilot"),
      Number(process.argv[2]),
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.allowed ? 0 : 1;
  } catch {
    console.log(
      JSON.stringify({
        allowed: false,
        reason: "无法读取 App 状态或执行历史，保留现场",
      }),
    );
    process.exitCode = 1;
  }
}
