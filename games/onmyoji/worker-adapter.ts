import type { GameWorkerAdapter } from "../plugin";
import type { GameDevice } from "../../packages/runtime/device";
import {
  executeOnmyojiSkill,
  type OnmyojiExecutionIdentityContext,
} from "./executor";
import {
  validateOnmyojiConfig,
  type OnmyojiRuntimeConfig,
} from "../../packages/protocol/onmyoji-identity";

export interface OnmyojiWorkerIdentityPorts {
  config(): OnmyojiRuntimeConfig;
  connectedDevice: OnmyojiExecutionIdentityContext["connectedDevice"];
  appProcessRunning?: OnmyojiExecutionIdentityContext["appProcessRunning"];
  now?: OnmyojiExecutionIdentityContext["now"];
  wait?: OnmyojiExecutionIdentityContext["wait"];
}

export function createOnmyojiWorkerAdapter(
  engine: () => Promise<GameDevice>,
  ports?: OnmyojiWorkerIdentityPorts,
): GameWorkerAdapter {
  let admittedConfig: OnmyojiRuntimeConfig | undefined;
  return {
    validate: () => {
      admittedConfig = validateOnmyojiConfig(ports?.config() ?? {});
    },
    run: async (id, signal, log) => {
      const config = validateOnmyojiConfig(
        admittedConfig ?? ports?.config() ?? {},
      );
      return executeOnmyojiSkill(id, await engine(), signal, log, {
        config,
        connectedDevice: ports?.connectedDevice ?? (() => undefined),
        appProcessRunning: ports?.appProcessRunning,
        now: ports?.now,
        wait: ports?.wait,
      });
    },
  };
}
