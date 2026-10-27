/**
 * 勘查（survey）：按明确导航坐标操作后抓帧、打印 OCR，不执行日常技能。
 *
 * 参数与槽位先校验；采图复用 App 的显示路由与二进制 PNG 校验。
 * screencap 使用物理显示 ID，input 使用同一显示的逻辑 ID；
 * --tap 仍用 1920×1080 坐标，按实际截图尺寸缩放。
 *
 *   node scripts/game-mode/survey.mjs --lane a --label 探索页 --tap 1025,270
 *   node scripts/game-mode/survey.mjs --lane b --launch
 *
 * --lane <id|a|b|0|1>（默认 a；a/0、b/1 分别唯一匹配实例0、1）
 * --tap x,y（可重复） --label <文字> --wait <秒> --ocr <阈值>
 * --launch：已安装的阴阳师不在前台时拉起，不自动点击业务按钮。
 * 产物：artifacts/survey/<日期>/<时间>-<标签>.png 与 .txt
 */
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  addressForLane,
  parseSurveyArgs,
  selectCliDevice,
  selectCliLane,
} from "../shared/cli-target.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = join(process.env.USERPROFILE ?? "", ".gamepilot");
const options = parseSurveyArgs(process.argv.slice(2));
const lanes =
  JSON.parse(readFileSync(join(DATA, "device-lanes.json"), "utf8")).lanes ?? [];
const lane = selectCliLane(lanes, options.lane, "onmyoji");
const adbPath =
  JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8")).adbPath ??
  "adb";
const address = addressForLane(lane, "onmyoji");
const device = { adbPath, address };

// Only plain display/capture code is bundled here, with no Maa/OCR native modules.
// OCR still runs in its own child after capture.
const built = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/game-mode/survey-route.ts"],
  bundle: true,
  write: false,
  platform: "node",
  target: "node22",
  format: "esm",
});
const { captureAndroidDisplay, readAndroidDisplay, navigateSurvey } =
  await import(
    "data:text/javascript;base64," +
      Buffer.from(built.outputFiles[0].contents).toString("base64")
  );
const runRead = async (file, argv) =>
  (
    await run(file, argv, {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 24 * 1024 * 1024,
      encoding: "buffer",
    })
  ).stdout;
const adb = async (argv) =>
  (await runRead(adbPath, ["-s", address, ...argv])).toString("utf8");
const devices = (await adb(["devices"])).split(/\r?\n/).flatMap((line) => {
  const [candidate, state] = line.trim().split(/\s+/);
  return state === "device" ? [{ address: candidate }] : [];
});
selectCliDevice(devices, address);

if (options.launch) {
  const packages = await adb(["shell", "pm", "list", "packages"]);
  const pkg = packages
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, "").trim())
    .find((name) => name.startsWith("com.netease.onmyoji"));
  if (pkg) {
    let foreground;
    try {
      foreground = (await readAndroidDisplay(device, runRead))
        .foregroundPackage;
    } catch {
      // Explicit --launch can restore a missing focus. Capture/input must still
      // pass complete mapping checks after launch.
    }
    if (foreground !== pkg) {
      console.log("[survey] 拉起 " + pkg);
      await adb([
        "shell",
        "monkey",
        "-p",
        pkg,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ]);
      await new Promise((done) => setTimeout(done, 30_000));
    }
  }
}

const captured = await navigateSurvey(options.taps, options.waitMs, {
  capture: () => captureAndroidDisplay(device, runRead),
  readDisplay: () => readAndroidDisplay(device, runRead),
  input: async (argv) => {
    console.log("[survey] 导航 " + argv.slice(1).join(" "));
    await adb(argv);
  },
  wait: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
});
const day = new Date().toLocaleDateString("sv-SE");
const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const dir = join(root, "artifacts/survey", day);
mkdirSync(dir, { recursive: true });
const file = join(
  dir,
  stamp + "-" + options.label.replace(/[\\/]/g, "-") + ".png",
);
writeFileSync(file, captured.image);
console.log("[survey] 抓帧 → " + file);
try {
  const { stdout } = await run(
    process.execPath,
    [join(root, "scripts/ocr-probe.mjs"), file, options.ocr],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
  );
  writeFileSync(file.replace(/\.png$/, ".txt"), stdout);
  console.log(stdout);
} catch (error) {
  console.error(
    "[survey] OCR 失败：" + (error instanceof Error ? error.message : error),
  );
}
