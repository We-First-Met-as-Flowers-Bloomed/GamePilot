import { join } from "node:path";
import { games, gamePlugins } from "../../games/registry";
import {
  registeredWorkerAdapter,
  type GameWorkerContext,
} from "../../games/plugin";
import { createArknightsWorkerAdapter } from "../../games/arknights/worker-adapter";
import { createOnmyojiWorkerAdapter } from "../../games/onmyoji/worker-adapter";
import engineContract from "../../games/arknights/engine-contract.json";
import {
  defaultArknightsConfig,
  arknightsPackage,
  validateArknightsConfig,
} from "../../games/arknights/config";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MaaCoreClient } from "./maacore";
import { isConnectionUnavailable } from "../protocol/failure";
import type { Device } from "../protocol";
let arknightsConfig = { ...defaultArknightsConfig };
const executeFile = promisify(execFile);
let connectedDevice: Device | undefined;
let navigationController: AbortController | undefined;
function coreClient() {
  return new MaaCoreClient(
    join(__dirname, "../maa-bridge/GamePilot.MaaBridge.exe"),
    join(__dirname, `../resources/maa-${engineContract.version}`),
    join(process.env.GAMEPILOT_DATA!, "maacore-logs"),
  );
}
import { validateDevice, validatePlan, type RunEvent } from "../protocol";
import { Runner } from "./runner";
import { inspectDevice } from "./device-inspection";
import { inspectArknightsDevice } from "../../games/arknights/inspect-device";
import { captureFailureImage } from "./failure-capture";
import { recognizeIncidentScreen } from "../../games/agent-recovery";
import { returnArknightsHome } from "../../games/arknights/navigation";

async function navigateArknightsHome(
  device: Device,
  config: typeof arknightsConfig,
  signal: AbortSignal,
  log: (message: string) => void,
) {
  return returnArknightsHome(device, config, signal, {
    inspect: () => readArknightsScene(device, config),
    log,
    back: async () => {
      signal.throwIfAborted();
      await executeFile(
        device.adbPath,
        ["-s", device.address, "shell", "input", "keyevent", "4"],
        { windowsHide: true, timeout: 10000, signal },
      );
      await delay(750, undefined, { signal });
    },
  });
}

async function readArknightsScene(
  device: Device,
  config: typeof arknightsConfig,
) {
  let ocr: import("./image-ocr").ImageOcr | undefined;
  try {
    return await inspectArknightsDevice(device, config, {
      capture: inspectDevice,
      wait: () => delay(500),
      recognize: async (image, roi, onlyRec) => {
        if (!ocr) {
          const { ImageOcr } = await import("./image-ocr");
          ocr = new ImageOcr(
            join(__dirname, "../resources/onmyoji"),
            process.env.GAMEPILOT_DATA!,
          );
        }
        return ocr.recognize(image, roi, onlyRec);
      },
    });
  } finally {
    ocr?.close();
  }
}

async function readCreditShop(device: Device) {
  const capture = await inspectDevice(device);
  const { ImageOcr } = await import("./image-ocr");
  const ocr = new ImageOcr(
    join(__dirname, "../resources/onmyoji"),
    process.env.GAMEPILOT_DATA!,
  );
  try {
    return { ...capture, frame: await ocr.recognize(capture.image) };
  } finally {
    ocr.close();
  }
}

type Port = {
  on(type: "message", callback: (event: { data: Request }) => void): void;
  postMessage(value: unknown): void;
};
type Request = { id: string; method: string; payload?: unknown };
const port = (process as unknown as { parentPort: Port }).parentPort;
if (!port)
  throw new Error("Worker must be launched as an Electron utility process");
const workerContext: GameWorkerContext = {
  adapters: {
    maacore: createArknightsWorkerAdapter({
      config: () => arknightsConfig,
      device: () => connectedDevice,
      disconnectEngine: async () => {
        (await engine()).disconnect();
      },
      createCore: coreClient,
      inspect: readArknightsScene,
      inspectShop: readCreditShop,
      returnHome: navigateArknightsHome,
    }),
    maaframework: createOnmyojiWorkerAdapter(engine),
  },
};
const runner = new Runner(
  games,
  (event: RunEvent) => port.postMessage({ event }),
  (id, signal, log, plan) =>
    gamePlugins.run(plan, id, workerContext, signal, log),
  (signal) =>
    captureFailureImage(process.env.GAMEPILOT_DATA!, connectedDevice, signal),
);
// Lazy import: the renderer and rehearsal still work if a native library cannot load.
let enginePromise: Promise<import("./maa").MaaEngine> | undefined;
function engine() {
  if (!enginePromise)
    enginePromise = import("./maa")
      .then(async ({ MaaEngine }) => {
        const instance = new MaaEngine((nativeWait) =>
          port.postMessage({ nativeWait }),
        );
        await instance.init(
          join(process.env.GAMEPILOT_DATA!, "engine-logs"),
          join(__dirname, "../resources/onmyoji"),
        );
        return instance;
      })
      .catch((error) => {
        enginePromise = undefined;
        throw error;
      });
  return enginePromise;
}
let deviceBusy = false;
async function deviceOperation<T>(action: () => Promise<T>): Promise<T> {
  if (deviceBusy || runner.busy)
    throw new Error("设备正在运行其他操作，请稍后重试");
  deviceBusy = true;
  try {
    return await action();
  } finally {
    deviceBusy = false;
  }
}
async function dispatch(request: Request): Promise<unknown> {
  switch (request.method) {
    case "inspect-arknights":
      return deviceOperation(async () => {
        const payload = request.payload as
          { device?: unknown; config?: unknown } | undefined;
        const device = validateDevice(payload?.device);
        const config = validateArknightsConfig(payload?.config);
        return readArknightsScene(device, config);
      });
    case "return-arknights-home":
      return deviceOperation(async () => {
        const payload = request.payload as
          { device?: unknown; config?: unknown } | undefined;
        const device = validateDevice(payload?.device),
          config = validateArknightsConfig(payload?.config);
        const events: string[] = [],
          controller = new AbortController();
        navigationController = controller;
        try {
          const capture = await navigateArknightsHome(
            device,
            config,
            controller.signal,
            (message) => events.push(message),
          );
          return { capture, events };
        } finally {
          if (navigationController === controller)
            navigationController = undefined;
        }
      });
    case "inspect-device":
      return deviceOperation(() =>
        inspectDevice(validateDevice(request.payload)),
      );
    case "arknights-config":
      return deviceOperation(async () => {
        arknightsConfig = validateArknightsConfig(request.payload);
        return null;
      });
    case "arknights-probe":
      return deviceOperation(async () => {
        const core = coreClient();
        try {
          return await core.info();
        } finally {
          await core.close();
        }
      });
    case "arknights-close":
      return deviceOperation(async () => {
        if (!connectedDevice) throw Error("请先连接设备");
        const packageName = arknightsPackage(arknightsConfig);
        await executeFile(
          connectedDevice.adbPath,
          [
            "-s",
            connectedDevice.address,
            "shell",
            "am",
            "force-stop",
            packageName,
          ],
          { windowsHide: true, timeout: 15000 },
        );
        const maa = await engine();
        await maa.connect(connectedDevice);
        for (let attempt = 0; attempt < 8; attempt++) {
          if (
            !(await maa.isAppRunning(packageName, new AbortController().signal))
          )
            return null;
          await delay(500);
        }
        throw new Error("明日方舟客户端仍在运行，未启动同实例后续游戏");
      });
    case "ping":
      return { protocol: 1 };
    case "recognize-failure-image": {
      const payload = request.payload as { image?: unknown; gameId?: unknown };
      const image =
        typeof request.payload === "string" ? request.payload : payload?.image;
      const gameId =
        typeof payload?.gameId === "string" &&
        ["arknights", "onmyoji"].includes(payload.gameId)
          ? payload.gameId
          : undefined;
      if (typeof image !== "string" || image.length > 32 * 1024 * 1024)
        throw Error("故障图片输入无效");
      const { ImageOcr } = await import("./image-ocr");
      const ocr = new ImageOcr(
        join(__dirname, "../resources/onmyoji"),
        process.env.GAMEPILOT_DATA!,
      );
      try {
        const frame = await ocr.recognize(image);
        return gameId
          ? gamePlugins.get(gameId).recovery.classify(frame)
          : recognizeIncidentScreen(frame);
      } finally {
        ocr.close();
      }
    }
    case "info":
      return (await engine()).info();
    case "discover":
      return deviceOperation(async () => {
        if (
          request.payload !== undefined &&
          typeof request.payload !== "string"
        )
          throw new Error("ADB 路径无效");
        return (await engine()).discover(request.payload as string | undefined);
      });
    case "connect":
      return deviceOperation(async () => {
        connectedDevice = undefined;
        const device = validateDevice(request.payload);
        const result = await (await engine()).connect(device);
        connectedDevice = device;
        return result;
      });
    case "capture":
      return deviceOperation(async () => (await engine()).capture());
    case "disconnect":
      return deviceOperation(async () => {
        connectedDevice = undefined;
        (await engine()).disconnect();
        return (await engine()).info();
      });
    case "start": {
      if (deviceBusy) throw new Error("设备正在运行其他操作");
      const plan = validatePlan(request.payload, games);
      gamePlugins.validate(plan, workerContext);
      const adapter = registeredWorkerAdapter(
        gamePlugins.get(plan.gameId),
        workerContext,
      );
      const { runId, finished } = runner.start(plan);
      if (plan.mode === "live" && adapter.maxRunMinutes !== undefined) {
        const timer = setTimeout(() => {
          port.postMessage({
            event: {
              runId,
              gameId: plan.gameId,
              type: "log",
              message: `已达到 ${adapter.maxRunMinutes} 分钟运行上限，正在安全停止`,
              at: new Date().toISOString(),
            },
          });
          void runner.stop();
        }, adapter.maxRunMinutes * 60_000);
        void finished.finally(() => clearTimeout(timer));
      }
      return { runId };
    }
    case "pause-after-step":
      return runner.pauseAfterStep(request.payload);
    case "stop":
      navigationController?.abort();
      await runner.stop();
      return null;
    default:
      throw new Error("未知执行请求");
  }
}
port.on("message", ({ data }) => {
  if (!data || typeof data.id !== "string" || typeof data.method !== "string")
    return;
  void dispatch(data).then(
    (result) => port.postMessage({ id: data.id, result }),
    (error) =>
      port.postMessage({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
        ...(isConnectionUnavailable(error)
          ? { errorCode: "connection-unavailable" }
          : {}),
      }),
  );
});
