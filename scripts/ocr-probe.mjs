/**
 * 离线 OCR 探针：用 App 相同的 MaaFramework OCR 资源识别一张已保存的截图，
 * 输出文本命中与坐标（可只看某个 ROI、可调阈值）。仅开发诊断用。
 *
 *   npm run ocr:probe -- <png> [阈值] [x,y,w,h]
 *
 * 排查锚点时的标准用法：技能报"读不到某元素"时，先用它在同一张帧上确认 OCR 到底
 * 读出了什么、分数多少，避免在"读不到"和"读错"之间靠猜。
 *
 * 修复记录（2026-10-15）：旧版有两处真错——`post_bundle(...).wait()` 漏了 await，
 * 且把 `job.get()` 返回的详情对象当成 node id 传给 `node_detail`（报
 * `expect string<int64_t>, got [object Object]`），实际从来没成功过。
 *
 * 两个已踩过的原生层坑（别改回去）：
 *  1) 不设置 `maa.Global.log_dir`：本机设置后 OCR 会让原生层 0xC0000409 崩溃；
 *  2) 初始化顺序必须是 Resource → post_bundle → new Tasker → 绑定资源。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const maa = require("@maaxyz/maa-node");

const imagePath = process.argv[2];
const threshold = Number(process.argv[3] ?? "0.7");
const roi = process.argv[4] ? process.argv[4].split(",").map(Number) : [];
if (!imagePath) {
  console.error(
    "用法: node scripts/ocr-probe.mjs <png路径> [阈值=0.7] [roi=x,y,w,h]",
  );
  process.exit(2);
}
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
  console.error("阈值需在 (0,1] 之间");
  process.exit(2);
}
if (roi.length !== 0 && roi.length !== 4) {
  console.error("roi 需要 4 个数字：x,y,w,h");
  process.exit(2);
}

maa.Global.stdout_level = "Error";
maa.Global.save_on_error = false;
const resource = new maa.Resource();
resource.inference_execution_provider = "CPU";
const bundle = await resource.post_bundle(
  join(process.cwd(), "games/onmyoji/resources"),
).wait();
if (!bundle.succeeded) {
  console.error("OCR 资源加载失败");
  process.exit(2);
}
const tasker = new maa.Tasker();
tasker.resource = resource;

const bytes = readFileSync(imagePath);
const job = await tasker
  .post_recognition(
    "OCR",
    { expected: [".*"], threshold, only_rec: false },
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  .wait();
const detail = job.get();
const hits = (detail?.nodes ?? [])
  .flatMap((id) => {
    const found = tasker.node_detail(id)?.reco?.detail;
    return found && !Array.isArray(found) ? found.filtered : [];
  })
  .filter((hit) => typeof hit.text === "string");
tasker.destroy();
resource.destroy();

/** 与 App `findText` 相同的判定：文本中心点落在 ROI 内。 */
const inside = (hit) =>
  roi.length !== 4 ||
  (hit.box[0] >= roi[0] &&
    hit.box[1] >= roi[1] &&
    hit.box[0] + hit.box[2] / 2 < roi[0] + roi[2] &&
    hit.box[1] + hit.box[3] / 2 < roi[1] + roi[3]);
const sorted = hits.slice().sort((a, b) => b.score - a.score);
const shown = sorted.filter(inside);
console.log(
  `${imagePath} · 阈值 ${threshold}${roi.length === 4 ? ` · ROI ${roi.join(",")}` : ""} · 命中 ${shown.length}/${hits.length} 条`,
);
for (const hit of shown)
  console.log(
    `  ${hit.text} | ${hit.box.join(",")} | ${Number(hit.score ?? 0).toFixed(3)}`,
  );
const outside = sorted.filter((hit) => !inside(hit));
if (roi.length === 4 && outside.length)
  console.log(
    `  （ROI 外还有 ${outside.length} 条，最高：${outside[0].text} | ${outside[0].box.join(",")} | ${Number(outside[0].score ?? 0).toFixed(3)}）`,
  );
