import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import {
  ARKNIGHTS_DAILY_SKILLS,
  validateArknightsAutomation,
} from "../../../../packages/protocol/arknights-automation";
import {
  ONMYOJI_DAILY_SKILLS,
  validateOnmyojiAutomation,
} from "../../../../packages/protocol/onmyoji-automation";
import type {
  AutomationConfig,
  AutomationJob,
} from "../../../../packages/protocol/automation";

interface AutomationState {
  available: boolean;
  loaded: boolean;
  config?: AutomationConfig;
  dirty: boolean;
  busy: boolean;
  message: string;
  error: boolean;
}
type JobPatch = Partial<Omit<AutomationJob, "id" | "laneId">>;

/** One controller per daily page: edits from different accounts share the latest draft. */
export function createGameAutomationController(
  api: DesktopAPI | undefined,
  gameId: "arknights" | "onmyoji",
) {
  const isArk = gameId === "arknights";
  const validate = isArk
    ? validateArknightsAutomation
    : validateOnmyojiAutomation;
  const read = isArk ? api?.arknightsAutomation : api?.onmyojiAutomation;
  const save = isArk
    ? (input: AutomationConfig) =>
        api!.saveArknightsAutomation!(validateArknightsAutomation(input))
    : (input: AutomationConfig) =>
        api!.saveOnmyojiAutomation!(validateOnmyojiAutomation(input));
  const run = isArk ? api?.runArknightsJob : api?.runOnmyojiJob;
  const dailySkills = isArk ? ARKNIGHTS_DAILY_SKILLS : ONMYOJI_DAILY_SKILLS;
  let state: AutomationState = {
    available: !!(
      read &&
      run &&
      (isArk ? api?.saveArknightsAutomation : api?.saveOnmyojiAutomation)
    ),
    loaded: false,
    config: undefined,
    dirty: false,
    busy: false,
    message: "",
    error: false,
  };
  let saved = "";
  const listeners = new Set<() => void>();
  function publish(patch: Partial<AutomationState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function edit(change: (config: AutomationConfig) => AutomationConfig) {
    if (!state.loaded || !state.config || state.busy) return;
    const config = change(state.config);
    publish({
      config,
      dirty: JSON.stringify(config) !== saved,
      message: "",
      error: false,
    });
  }
  function failure(error: unknown) {
    publish({
      message: error instanceof Error ? error.message : String(error),
      error: true,
    });
  }
  return {
    gameId,
    title: isArk ? "方舟" : "阴阳师",
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      if (!state.available || state.busy || state.loaded) return;
      publish({ busy: true, message: "", error: false });
      try {
        const config = validate(await read!());
        saved = JSON.stringify(config);
        publish({ config, loaded: true, dirty: false });
      } catch (error) {
        failure(error);
      } finally {
        publish({ busy: false });
      }
    },
    setEnabled(enabled: boolean) {
      edit((config) => ({ ...config, enabled }));
    },
    patchJob(laneId: string, jobId: string, patch: JobPatch) {
      edit((config) => ({
        ...config,
        jobs: config.jobs.map((job) =>
          job.id === jobId && job.laneId === laneId
            ? {
                ...job,
                ...structuredClone(patch),
                id: job.id,
                laneId: job.laneId,
              }
            : job,
        ),
      }));
    },
    addJob(laneId: string, laneName: string) {
      edit((config) => ({
        ...config,
        jobs: [
          ...config.jobs,
          {
            id: `${isArk ? "ark" : "yys"}-${crypto.randomUUID()}`,
            laneId,
            name: `${laneName.slice(0, 50)} 计划${config.jobs.filter((job) => job.laneId === laneId).length + 1}`,
            enabled: true,
            time: isArk ? "08:00" : "09:00",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            skillIds: [...dailySkills],
            catchUp: true,
          },
        ],
      }));
    },
    removeJob(laneId: string, jobId: string) {
      edit((config) => ({
        ...config,
        jobs: config.jobs.filter(
          (job) => job.id !== jobId || job.laneId !== laneId,
        ),
      }));
    },
    async save() {
      if (!state.loaded || !state.config || state.busy) return;
      let validated: AutomationConfig;
      try {
        validated = validate(state.config);
      } catch (error) {
        failure(error);
        return;
      }
      publish({ busy: true, message: "", error: false });
      try {
        const config = validate(await save(validated));
        saved = JSON.stringify(config);
        publish({ config, dirty: false, message: "自动计划已保存" });
      } catch (error) {
        failure(error);
      } finally {
        publish({ busy: false });
      }
    },
    async runNow(laneId: string, jobId: string) {
      if (!state.loaded || !state.config || state.busy) return;
      if (state.dirty) {
        publish({ message: "请先保存自动计划，再立即运行", error: true });
        return;
      }
      if (
        !state.config.jobs.some(
          (job) => job.id === jobId && job.laneId === laneId,
        )
      )
        return;
      publish({ busy: true, message: "", error: false });
      try {
        await run!({ jobId });
        publish({ message: "计划已提交，执行进度见对应账号记录" });
      } catch (error) {
        failure(error);
      } finally {
        publish({ busy: false });
      }
    },
  };
}

export function useGameAutomation(
  api: DesktopAPI | undefined,
  gameId: "arknights" | "onmyoji",
) {
  const controller = useMemo(
    () => createGameAutomationController(api, gameId),
    [api, gameId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.load();
  }, [controller]);
  return { ...state, ...controller };
}
export type GameAutomationController = ReturnType<typeof useGameAutomation>;
