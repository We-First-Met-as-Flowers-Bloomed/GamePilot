/**
 * 锚点审计执行体（子进程）：载入打包后的判据表 + 用 MaaFramework 跑真实帧。
 *
 * 两个实测约束（都是原生层的坑，改这里时别踩回去）：
 * 1) esbuild 与 onnxruntime 同进程会让原生层 0xC0000409 崩溃 —— 所以构建放在父进程
 *    scripts/anchors-audit.mjs，这里只做执行。
 * 2) 不设置 maa.Global.log_dir（设了会在本机崩），且初始化顺序必须是
 *    Resource → post_bundle → new Tasker → 绑定资源，与实机探针一致。
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const checksPath = join(root, "artifacts", "anchors-audit", "checks.mjs");
const { pages, exclusive, matrixOrder } = await import(
  `file://${checksPath.replace(/\\/g, "/")}`
);

function createOcr(resourceDir) {
  const maa = require("@maaxyz/maa-node");
  maa.Global.stdout_level = "Error";
  maa.Global.save_on_error = false;
  const resource = new maa.Resource();
  resource.inference_execution_provider = "CPU";
  let tasker;
  let ready;
  return {
    async recognize(file) {
      if (!ready) {
        ready = (async () => {
          const bundle = await resource.post_bundle(resourceDir).wait();
          if (!bundle.succeeded) throw Error("OCR resource load failed");
          tasker = new maa.Tasker();
          tasker.resource = resource;
        })();
      }
      await ready;
      const bytes = readFileSync(file);
      const job = await tasker
        .post_recognition(
          "OCR",
          { expected: [".*"], threshold: 0.7, only_rec: false },
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        )
        .wait();
      const detail = job.get();
      const texts = (detail?.nodes ?? [])
        .flatMap((id) => {
          const found = tasker.node_detail(id)?.reco?.detail;
          return found && !Array.isArray(found) ? found.filtered : [];
        })
        .filter((hit) => typeof hit.text === "string")
        .map((hit) => ({ text: hit.text, box: hit.box, score: hit.score ?? 0 }));
      tasker.clear_cache();
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        texts,
      };
    },
    close() {
      if (tasker) tasker.destroy();
      resource.destroy();
    },
  };
}

function readSidecar(file) {
  try {
    const sidecar = file.replace(/\.png$/i, ".json");
    if (!statSync(sidecar).isFile()) return {};
    return JSON.parse(readFileSync(sidecar, "utf8"));
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dump = args.includes("--dump");
const directory = args.find((value) => !value.startsWith("--"));
if (!directory) {
  console.error(
    "usage: npm run anchors:audit -- <frames-dir> [--json] (frames must be 1920x1080 PNG; optional sidecar .json with expect)",
  );
  process.exit(2);
}
const dir = resolve(root, directory);
const files = readdirSync(dir)
  .filter((name) => name.toLowerCase().endsWith(".png"))
  .sort();
if (!files.length) {
  console.error(`no PNG in frames dir: ${dir}`);
  process.exit(2);
}

const runs = [];
const ocr = createOcr(join(root, "games", "onmyoji", "resources"));
try {
  for (const name of files) {
    const file = join(dir, name);
    process.stderr.write(`[audit] OCR ${name}\n`);
    const frame = await ocr.recognize(file);
    const sidecar = readSidecar(file);
    const matched = matrixOrder.filter((id) => pages[id].run(frame));
    const failures = [];
    if (sidecar.expect) {
      if (frame.width !== 1920 || frame.height !== 1080)
        failures.push(
          `frame is ${frame.width}x${frame.height}, not 1920x1080; predicates are written against 1920 and cannot be asserted here`,
        );
      const expected = pages[sidecar.expect];
      if (!expected) failures.push(`unknown sidecar expect: ${sidecar.expect}`);
      else {
        if (!expected.run(frame))
          failures.push(`expected page not matched: ${expected.label}`);
        for (const id of exclusive[expected.id] ?? [])
          if (pages[id].run(frame))
            failures.push(`also matched exclusive page: ${pages[id].label}`);
      }
    }
    runs.push({
      file: name,
      size: `${frame.width}x${frame.height}`,
      hits: frame.texts.length,
      texts: dump
        ? frame.texts
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((hit) => `${hit.text} | ${hit.box.join(",")} | ${hit.score.toFixed(3)}`)
        : undefined,
      expect: sidecar.expect,
      note: sidecar.note,
      matched,
      failures,
    });
  }
} finally {
  ocr.close();
}

if (asJson) {
  console.log(JSON.stringify({ directory: dir, frames: runs }, null, 2));
} else {
  console.log(`anchor audit: ${dir}`);
  console.log(
    `frames ${runs.length} (predicate baseline 1920x1080, OCR score threshold 0.7)\n`,
  );
  for (const run of runs) {
    const status = !run.expect ? "matrix" : run.failures.length ? "FAIL" : "PASS";
    console.log(
      `[${status}] ${run.file}  ${run.size}  OCR ${run.hits} hits${
        run.expect ? `  expect=${pages[run.expect]?.label ?? run.expect}` : ""
      }`,
    );
    if (run.note) console.log(`         note: ${run.note}`);
    if (run.texts) for (const line of run.texts) console.log(`         ${line}`);
    if (run.matched.length)
      console.log(
        `         matched: ${run.matched.map((id) => pages[id].label).join(", ")}`,
      );
    for (const failure of run.failures) console.log(`         x ${failure}`);
  }
  const failed = runs.filter((run) => run.failures.length).length;
  console.log(
    `\ntotal: ${runs.length} frames, ${runs.filter((r) => r.expect).length} asserted, ${failed} failed`,
  );
}
if (runs.some((run) => run.failures.length)) process.exit(1);
