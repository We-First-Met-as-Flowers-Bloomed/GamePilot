import type { GameWorkerAdapter } from "../plugin";
import type { GameDevice } from "../../packages/runtime/device";
import { executeOnmyojiSkill } from "./executor";

export function createOnmyojiWorkerAdapter(
  engine: () => Promise<GameDevice>,
): GameWorkerAdapter {
  return {
    validate: () => {},
    run: async (id, signal, log) =>
      executeOnmyojiSkill(id, await engine(), signal, log),
  };
}
