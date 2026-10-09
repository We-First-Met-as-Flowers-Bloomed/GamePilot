import { Tray, Menu, nativeImage } from "electron";
export class DesktopPresence {
  private tray: Tray;
  private busy = false;
  private balloon?: () => void;
  constructor(
    private actions: { show(): void; run(): void; stop(): void; quit(): void },
  ) {
    const pixels = Buffer.alloc(32 * 32 * 4);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const white =
          (x >= 8 && x < 12 && y >= 8 && y < 24) ||
          (x >= 8 && x < 24 && ((y >= 8 && y < 12) || (y >= 20 && y < 24))) ||
          (x >= 20 && x < 24 && y >= 16 && y < 24) ||
          (x >= 16 && x < 24 && y >= 16 && y < 20);
        pixels[i] = white ? 246 : 85;
        pixels[i + 1] = white ? 249 : 107;
        pixels[i + 2] = white ? 250 : 70;
        pixels[i + 3] = (x < 3 || x > 28) && (y < 3 || y > 28) ? 0 : 255;
      }
    this.tray = new Tray(
      nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }),
    );
    this.tray.on("click", actions.show);
    this.tray.on("balloon-click", actions.show);
    this.update(false, "等待任务");
  }
  update(busy: boolean, message: string) {
    this.busy = busy;
    this.tray.setToolTip(("GamePilot · " + message).slice(0, 120));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开工作台", click: this.actions.show },
        {
          label: busy ? "正在执行任务" : "执行每日任务",
          enabled: !busy,
          click: this.actions.run,
        },
        { label: "停止任务", enabled: busy, click: this.actions.stop },
        { type: "separator" },
        { label: "退出 GamePilot", click: this.actions.quit },
      ]),
    );
  }
  notify(message: string, error = false) {
    this.tray.displayBalloon({
      title: "GamePilot",
      content: message.slice(0, 240),
      iconType: error ? "error" : "info",
      respectQuietTime: true,
    });
  }
  test(): Promise<string> {
    return new Promise((resolve) => {
      if (this.balloon) {
        resolve("通知测试正在进行");
        return;
      }
      const done = (message: string) => {
        clearTimeout(timer);
        this.tray.removeListener("balloon-show", shown);
        this.balloon = undefined;
        resolve(message);
      };
      const shown = () => done("系统已接收测试通知");
      const timer = setTimeout(
        () => done("已请求测试通知；若未显示，请检查 Windows 通知设置"),
        5000,
      );
      this.balloon = () => done("应用已退出");
      this.tray.once("balloon-show", shown);
      try {
        this.notify("这是测试通知。每日任务完成或需要处理时，会在这里提醒你。");
      } catch (error) {
        done(String(error));
      }
    });
  }
  destroy() {
    this.balloon?.();
    this.tray.destroy();
  }
}
