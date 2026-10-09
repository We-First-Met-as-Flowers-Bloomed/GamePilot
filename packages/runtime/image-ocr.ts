import "@maaxyz/maa-node";
import type { Frame, Rect } from "./device";

/** Native offline OCR. This class owns no device controller and cannot send input. Worker only. */
export class ImageOcr {
  private resource?: maa.Resource;
  private tasker?: maa.Tasker;
  constructor(
    private resourceDir: string,
    private logDir: string,
  ) {}
  async recognize(image: string, roi?: Rect, onlyRec = false): Promise<Frame> {
    if (!image.startsWith("data:image/png;base64,"))
      throw Error("核验图像必须是 PNG");
    const b = Buffer.from(
      image.slice("data:image/png;base64,".length),
      "base64",
    );
    if (
      b.length < 24 ||
      b.length > 24 * 1024 * 1024 ||
      b.readUInt32BE(0) !== 0x89504e47
    )
      throw Error("核验图像无效");
    if (!this.resource) {
      maa.Global.log_dir = this.logDir;
      maa.Global.stdout_level = "Error";
      maa.Global.save_on_error = false;
      const resource = new maa.Resource();
      resource.inference_execution_provider = "CPU";
      try {
        if (!(await resource.post_bundle(this.resourceDir).wait()).succeeded)
          throw Error("核验 OCR 资源加载失败");
        this.resource = resource;
        this.tasker = new maa.Tasker();
        this.tasker.resource = resource;
      } catch (error) {
        resource.destroy();
        this.resource = undefined;
        throw error;
      }
    }
    const t = this.tasker!;
    try {
      const result = await t
        .post_recognition(
          "OCR",
          {
            expected: [".*"],
            threshold: 0.7,
            only_rec: onlyRec,
            ...(roi ? { roi } : {}),
          },
          b.buffer.slice(
            b.byteOffset,
            b.byteOffset + b.byteLength,
          ) as ArrayBuffer,
        )
        .wait();
      const detail = result.get();
      if (!result.succeeded || !detail) throw Error("核验 OCR 未返回有效结果");
      const texts = detail.nodes
        .flatMap((id) => {
          const d = t.node_detail(id)?.reco?.detail;
          return d && !Array.isArray(d) ? d.filtered : [];
        })
        .filter((h) => typeof h.text === "string")
        .map((h) => ({ text: h.text!, box: h.box, score: h.score ?? 0 }));
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), texts };
    } finally {
      t.clear_cache();
    }
  }
  close() {
    this.tasker?.destroy();
    this.tasker = undefined;
    this.resource?.destroy();
    this.resource = undefined;
  }
}
