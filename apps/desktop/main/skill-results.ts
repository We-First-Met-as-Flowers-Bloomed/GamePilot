import type {
  AutomationSettings,
  DeviceLane,
  MuMuInstance,
  Plan,
  RunEvent,
} from "../../../packages/protocol";

export async function findFosterLane(
  lanes: DeviceLane[],
  config: Pick<
    AutomationSettings,
    "launchEmulator" | "managerPath" | "instance"
  >,
  address: string | undefined,
  discover: (managerPath: string) => Promise<MuMuInstance[]>,
) {
  const normalize = (path: string) => path.toLowerCase().replaceAll("\\", "/");
  const eligible = lanes.filter((lane) => lane.onmyoji.enabled);
  if (config.launchEmulator)
    return eligible.find(
      (lane) =>
        normalize(lane.managerPath) === normalize(config.managerPath) &&
        lane.instance === config.instance,
    );
  if (!address) return;
  for (const managerPath of new Set(
    eligible.map((lane) => lane.managerPath).filter(Boolean),
  )) {
    const instances = await discover(managerPath).catch(() => []);
    const instance = instances.find((item) => item.address === address);
    if (instance)
      return eligible.find(
        (lane) =>
          normalize(lane.managerPath) === normalize(managerPath) &&
          lane.instance === instance.instance,
      );
  }
}

/** Worker events may arrive before the start RPC returns its run ID. */
export class SkillResultQueue {
  private runId?: string;
  private early: RunEvent[] = [];
  private writes: Promise<void> = Promise.resolve();
  private resolveBound!: () => void;
  private bound = new Promise<void>((resolve) => {
    this.resolveBound = resolve;
  });

  constructor(
    private plan: Plan,
    private save: (event: RunEvent) => Promise<void>,
  ) {}

  accept(event: RunEvent) {
    if (
      this.plan.mode !== "live" ||
      !event.result ||
      event.type !== "log" ||
      event.gameId !== this.plan.gameId ||
      !event.skillId ||
      !this.plan.skillIds.includes(event.skillId)
    )
      return;
    if (this.runId === undefined) {
      this.early.push(event);
      return;
    }
    if (event.runId !== this.runId) return;
    this.writes = this.writes.then(() => this.save(event));
    void this.writes.catch(() => {});
  }

  bind(runId: string) {
    this.runId = runId;
    for (const event of this.early) this.accept(event);
    this.early = [];
    this.resolveBound();
  }

  async flush() {
    await this.bound;
    await this.writes;
  }

  async owns(runId: string) {
    await this.bound;
    return this.runId === runId;
  }
}
