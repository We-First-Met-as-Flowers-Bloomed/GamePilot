import "@maaxyz/maa-node";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { GameDevice, Frame, Rect, VisualHit } from "./device";
import type { Device, EngineInfo } from "../protocol";
import { ConnectionUnavailableError } from "../protocol/failure";
import type { NativeOperation, NativeWait } from "../protocol/native-wait";

/** Imported only by the isolated engine worker. */
export class MaaEngine implements GameDevice {
  private resource?: maa.Resource;
  private tasker?: maa.Tasker;
  private device?: Device;
  private logDir = "";
  private resourceDir = "";
  private controller?: maa.AdbController;
  private address?: string;
  private detected = new Map<string, maa.AdbDevice>();
  constructor(
    private reportNativeWait: (wait: NativeWait) => void = () => {},
  ) {}
  private async nativeWait<T>(
    operation: NativeOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    // Post before submitting: even a blocked native call is supervised by the host.
    this.reportNativeWait({ id, operation, phase: "begin" });
    try {
      return await action();
    } finally {
      this.reportNativeWait({ id, operation, phase: "end" });
    }
  }
  async init(
    logDir: string,
    resourceDir = join(process.cwd(), "games/onmyoji/resources"),
  ) {
    await mkdir(logDir, { recursive: true });
    maa.Global.log_dir = logDir;
    maa.Global.stdout_level = "Error";
    maa.Global.save_on_error = false;
    this.logDir = logDir;
    this.resourceDir = resourceDir;
  }
  info(): EngineInfo {
    return {
      version: maa.Global.version,
      connected: Boolean(this.controller?.connected),
      address: this.address,
    };
  }
  async discover(adbPath?: string): Promise<Device[]> {
    if (adbPath) await access(adbPath);
    const devices = await this.nativeWait("discovery", () =>
      maa.AdbController.find(adbPath || undefined),
    );
    this.detected.clear();
    return (devices ?? []).map((device) => {
      this.detected.set(`${device[1]}|${device[2]}`, device);
      return { name: device[0], adbPath: device[1], address: device[2] };
    });
  }
  async connect(device: Device): Promise<EngineInfo> {
    await access(device.adbPath);
    this.tasker?.destroy();
    this.tasker = undefined;
    this.controller?.destroy();
    this.controller = undefined;
    this.address = undefined;
    const found = this.detected.get(`${device.adbPath}|${device.address}`);
    const controller = new maa.AdbController(
      device.adbPath,
      device.address,
      found?.[3] ?? maa.AdbScreencapMethod.Default,
      // MuMu cold-boot MaaTouch may acknowledge input without delivering it.
      // Shell input follows Android's current display orientation reliably.
      /mumu/i.test(device.name + device.adbPath)
        ? maa.AdbInputMethod.AdbShell
        : (found?.[4] ?? maa.AdbInputMethod.Default),
      found?.[5] ?? "{}",
    );
    try {
      const job = await this.nativeWait("connection", () =>
        controller.post_connection().wait(),
      );
      if (!job.succeeded || !controller.connected)
        throw new ConnectionUnavailableError(
          "设备连接失败，请检查 MuMu 是否启动及 ADB 地址",
        );
      this.controller = controller;
      controller.screenshot_target_long_side = 1920;
      this.address = device.address;
      this.device = device;
      return this.info();
    } catch (error) {
      controller.destroy();
      throw error;
    }
  }
  private requireController() {
    if (!this.controller?.connected) throw new Error("设备未连接");
    return this.controller;
  }
  disconnect() {
    this.tasker?.destroy();
    this.tasker = undefined;
    this.controller?.destroy();
    this.controller = undefined;
    this.address = undefined;
  }
  private async recognizer() {
    if (!this.resource) {
      const r = new maa.Resource();
      r.inference_execution_provider = "CPU";
      if (
        !(
          await this.nativeWait("resource", () =>
            r.post_bundle(this.resourceDir).wait(),
          )
        ).succeeded
      ) {
        r.destroy();
        throw new Error("OCR 资源加载失败，请运行 npm run setup:ocr");
      }
      if (
        !(
          await this.nativeWait("resource", () =>
            r.post_image(join(this.resourceDir, "image")).wait(),
          )
        ).succeeded
      ) {
        r.destroy();
        throw new Error("游戏图像资源加载失败，请重新安装 GamePilot");
      }
      this.resource = r;
    }
    if (!this.tasker) {
      this.tasker = new maa.Tasker();
      this.tasker.resource = this.resource;
      this.tasker.controller = this.requireController();
    }
    return this.tasker;
  }
  async observe(
    signal: AbortSignal,
    roi?: Rect,
    onlyRec = false,
  ): Promise<Frame> {
    signal.throwIfAborted();
    const c = this.requireController(),
      t = await this.recognizer();
    signal.throwIfAborted();
    const job = await this.nativeWait("screencap", () =>
      c.post_screencap().wait(),
    );
    if (!job.succeeded || !job.get()) throw new Error("游戏截图失败");
    const img = job.get()!,
      b = Buffer.from(img);
    if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("截图编码不是 PNG");
    const width = b.readUInt32BE(16),
      height = b.readUInt32BE(20);
    if (width !== 1920 || height !== 1080)
      throw new Error(`当前适配需要 16:9 横屏，收到 ${width}×${height}`);
    signal.throwIfAborted();
    const result = await this.nativeWait("recognition", () =>
      t
        .post_recognition(
          "OCR",
          {
            expected: [".*"],
            threshold: 0.7,
            only_rec: onlyRec,
            ...(roi ? { roi } : {}),
          },
          img,
        )
        .wait(),
    );
    signal.throwIfAborted();
    const detail = result.get();
    if (!result.succeeded || !detail) throw new Error("OCR 执行失败");
    const texts = detail.nodes
      .flatMap((id) => {
        const d = t.node_detail(id)?.reco?.detail;
        return d && !Array.isArray(d) ? d.filtered : [];
      })
      .filter((h) => typeof h.text === "string")
      .map((h) => ({ text: h.text!, box: h.box, score: h.score ?? 0 }));
    await writeFile(join(this.logDir, "last-screen.png"), b);
    t.clear_cache();
    return { width, height, texts };
  }
  async matchTemplate(
    template: string,
    roi: Rect,
    threshold: number,
    signal: AbortSignal,
  ): Promise<VisualHit | null> {
    return this.matchImage(template, roi, threshold, signal, "TemplateMatch");
  }
  async matchFeatures(
    template: string,
    roi: Rect,
    signal: AbortSignal,
  ): Promise<VisualHit | null> {
    return this.matchImage(template, roi, 0.78, signal, "FeatureMatch");
  }
  private async matchImage(
    template: string,
    roi: Rect,
    threshold: number,
    signal: AbortSignal,
    algorithm: "TemplateMatch" | "FeatureMatch",
  ): Promise<VisualHit | null> {
    signal.throwIfAborted();
    if (!/^[A-Za-z0-9_-]+\.png$/.test(template))
      throw new Error("模板名称无效");
    if (
      roi.some((value) => !Number.isInteger(value)) ||
      roi[0] < 0 ||
      roi[1] < 0 ||
      roi[2] < 1 ||
      roi[3] < 1 ||
      roi[0] + roi[2] > 1920 ||
      roi[1] + roi[3] > 1080 ||
      !Number.isFinite(threshold) ||
      threshold < 0.5 ||
      threshold > 1
    )
      throw new Error("模板识别参数无效");
    const controller = this.requireController();
    await this.recognizer();
    const tasker = new maa.Tasker();
    try {
      tasker.resource = this.resource!;
      tasker.controller = controller;
      const shot = await this.nativeWait("screencap", () =>
        controller.post_screencap().wait(),
      );
      const image = shot.get();
      if (!shot.succeeded || !image) throw new Error("游戏截图失败");
      signal.throwIfAborted();
      const result = await this.nativeWait("recognition", () =>
        tasker
          .post_recognition(
            algorithm,
            {
              template: [template],
              roi,
              ...(algorithm === "FeatureMatch"
                ? { count: 10 }
                : { threshold: [threshold] }),
            },
            image,
          )
          .wait(),
      );
      signal.throwIfAborted();
      const detail = result.get();
      const recognition = detail?.nodes
        .map((id) => tasker.node_detail(id)?.reco)
        .find((value) => value?.algorithm === algorithm);
      const best =
        recognition?.detail && !Array.isArray(recognition.detail)
          ? recognition.detail.best
          : null;
      if (
        !result.succeeded ||
        !recognition?.hit ||
        !best ||
        !Number.isFinite(algorithm === "FeatureMatch" ? best.count : best.score)
      )
        return null;
      return {
        box: best.box,
        score: (algorithm === "FeatureMatch" ? best.count : best.score)!,
      };
    } finally {
      tasker.destroy();
    }
  }
  async colorSlots(
    rois: Rect[],
    lower: [number, number, number],
    upper: [number, number, number],
    minPixels: number,
    signal: AbortSignal,
  ): Promise<boolean[]> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(minPixels) || minPixels < 1)
      throw new Error("颜色像素阈值无效");
    const controller = this.requireController();
    await this.recognizer();
    const tasker = new maa.Tasker();
    try {
      tasker.resource = this.resource!;
      tasker.controller = controller;
      const shot = await this.nativeWait("screencap", () =>
        controller.post_screencap().wait(),
      );
      const image = shot.get();
      if (!shot.succeeded || !image) throw new Error("游戏截图失败");
      signal.throwIfAborted();
      const slots: boolean[] = [];
      for (const roi of rois) {
        const result = await this.nativeWait("recognition", () =>
          tasker
            .post_recognition(
              "ColorMatch",
              { roi, method: 40, lower, upper, count: minPixels },
              image,
            )
            .wait(),
        );
        signal.throwIfAborted();
        const detail = result.get();
        const recognition = detail?.nodes
          .map((id) => tasker.node_detail(id)?.reco)
          .find((value) => value?.algorithm === "ColorMatch");
        slots.push(Boolean(result.succeeded && recognition?.hit));
      }
      return slots;
    } finally {
      tasker.destroy();
    }
  }
  async click(x: number, y: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x >= 1920 ||
      y < 0 ||
      y >= 1080
    )
      throw new Error("点击位置越界");
    if (
      !(
        await this.nativeWait("input", () =>
          this.requireController()
            .post_click(Math.round(x), Math.round(y))
            .wait(),
        )
      ).succeeded
    )
      throw new Error("点击失败");
    signal.throwIfAborted();
  }
  async startApp(packageName: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new Error("应用包名无效");
    if (
      !(
        await this.nativeWait("input", () =>
          this.requireController().post_start_app(packageName).wait(),
        )
      ).succeeded
    )
      throw new Error("启动阴阳师失败");
    signal.throwIfAborted();
  }
  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      !(
        await this.nativeWait("input", () =>
          this.requireController().post_swipe(x1, y1, x2, y2, 500).wait(),
        )
      ).succeeded
    )
      throw new Error("滑动失败");
    signal.throwIfAborted();
  }
  async longPress(
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x >= 1920 ||
      y < 0 ||
      y >= 1080 ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 500 ||
      durationMs > 5000
    )
      throw new Error("长按参数无效");
    if (
      !(
        await this.nativeWait("input", () =>
          this.requireController().post_swipe(x, y, x, y, durationMs).wait(),
        )
      ).succeeded
    )
      throw new Error("长按失败");
    signal.throwIfAborted();
  }
  async packages(signal: AbortSignal) {
    this.requireController();
    const result = await promisify(execFile)(
      this.device!.adbPath,
      [
        "-s",
        this.device!.address,
        "shell",
        "pm",
        "list",
        "packages",
        "onmyoji",
      ],
      { signal, timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return result.stdout
      .split(/\r?\n/)
      .filter((s) => s.startsWith("package:"))
      .map((s) => s.slice(8).trim());
  }
  async isAppRunning(packageName: string, signal: AbortSignal) {
    this.requireController();
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new Error("应用包名无效");
    try {
      const result = await promisify(execFile)(
        this.device!.adbPath,
        ["-s", this.device!.address, "shell", "pidof", packageName],
        { signal, timeout: 10000, windowsHide: true, maxBuffer: 1024 },
      );
      return /^\d+(\s+\d+)*$/.test(result.stdout.trim());
    } catch (error) {
      signal.throwIfAborted();
      if (
        (error as { code?: number; stdout?: string }).code === 1 &&
        !(error as { stdout?: string }).stdout?.trim()
      )
        return false;
      throw error;
    }
  }
  async capture(): Promise<string> {
    if (!this.controller?.connected) throw new Error("设备未连接");
    const controller = this.controller;
    const job = await this.nativeWait("screencap", () =>
      controller.post_screencap().wait(),
    );
    if (!job.succeeded) throw new Error("截图失败，请检查设备连接");
    const image = job.get();
    if (!image || image.byteLength === 0) throw new Error("设备返回空截图");
    if (image.byteLength > 24 * 1024 * 1024)
      throw new Error("截图过大，请降低模拟器分辨率");
    // Maa's ImageData is encoded image bytes; UI receives a bounded on-demand preview.
    const bytes = Buffer.from(image);
    const mime =
      bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
}
