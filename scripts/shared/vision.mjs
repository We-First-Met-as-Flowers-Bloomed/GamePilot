/**
 * 共享的 MaaFramework 视觉助手：直接调 OCR / TemplateMatch。
 *
 * 为什么不复用 `packages/runtime/image-ocr.ts`：那条路径经 esbuild 打包后会让原生层
 * 崩溃（2026-10-14 实测 0xC0000409）。这里是与实机探针一致的写法，两个已知约束别改回去：
 *  1) 不设置 `maa.Global.log_dir`；
 *  2) 初始化顺序：Resource → post_bundle → new Tasker → 绑定资源；
 *  3) 先把命中取出来再 `clear_cache()`，否则 node_detail 失效、永远取到 0 条。
 */
import { createRequire } from "node:module";

export function createVision(resourceDir) {
  const require = createRequire(import.meta.url);
  const maa = require("@maaxyz/maa-node");
  maa.Global.stdout_level = "Error";
  maa.Global.save_on_error = false;
  const resource = new maa.Resource();
  resource.inference_execution_provider = "CPU";
  let tasker;
  let ready;
  const hits = (job) => {
    const detail = job.get();
    return (detail?.nodes ?? [])
      .flatMap((id) => {
        const found = tasker.node_detail(id)?.reco?.detail;
        return found && !Array.isArray(found) ? found.filtered : [];
      })
      .filter((hit) => typeof hit.text === "string")
      .map((hit) => ({ text: hit.text, box: hit.box, score: hit.score ?? 0 }));
  };
  const bytesOf = (image) =>
    Buffer.from(String(image).replace(/^data:image\/png;base64,/, ""), "base64");
  const ensure = async () => {
    if (!ready)
      ready = (async () => {
        const posted = await resource.post_bundle(resourceDir).wait();
        if (!posted.succeeded) throw Error("OCR 资源加载失败");
        tasker = new maa.Tasker();
        tasker.resource = resource;
      })();
    await ready;
  };
  return {
    async recognize(image, roi, onlyRec) {
      await ensure();
      const b = bytesOf(image);
      const job = await tasker
        .post_recognition(
          "OCR",
          {
            expected: [".*"],
            threshold: 0.7,
            only_rec: Boolean(onlyRec),
            ...(roi ? { roi } : {}),
          },
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        )
        .wait();
      const found = hits(job);
      tasker.clear_cache();
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), texts: found };
    },
    async matchTemplate(image, directory, template, roi, threshold = 0.95) {
      await ensure();
      if (!(await resource.post_image(directory).wait()).succeeded)
        throw Error("图像锚点资源加载失败");
      const b = bytesOf(image);
      const job = await tasker
        .post_recognition(
          "TemplateMatch",
          { template, roi, threshold },
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        )
        .wait();
      const found = hits(job);
      tasker.clear_cache();
      return found.sort((a, b2) => b2.score - a.score)[0];
    },
    close() {
      if (tasker) tasker.destroy();
      resource.destroy();
    },
  };
}
