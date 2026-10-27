import { agentObject } from "../../../../packages/protocol/agent";
import type {
  AutomationConfig,
  AutomationJob,
} from "../../../../packages/protocol/automation";
interface Ports<S extends string> {
  prefix: string;
  register(channel: string, handler: (input: unknown) => unknown): void;
  service: {
    read(): Promise<AutomationConfig<S>>;
    save(input: unknown): Promise<AutomationConfig<S>>;
    runNow(input: {
      jobId: string;
      requestId?: string;
    }): Promise<{ batchId: string }>;
  };
  validate(input: unknown): AutomationConfig<S>;
  validateJob(job: AutomationJob<S>): Promise<void>;
  busy(): boolean;
  runBusy?(): boolean;
  withConfiguring<T>(action: () => Promise<T>, purpose?: "plans"): Promise<T>;
}
export function registerGameAutomationIpc<S extends string>(p: Ports<S>) {
  p.register(`gp:${p.prefix}-automation`, () => p.service.read());
  p.register(`gp:${p.prefix}-automation-save`, async (input) => {
    if (p.busy()) throw Error("请在任务结束后修改计划");
    return p.withConfiguring(async () => {
      const config = p.validate(input);
      for (const job of config.jobs) await p.validateJob(job);
      return p.service.save(config);
    }, "plans");
  });
  p.register(`gp:${p.prefix}-job-run`, (input) => {
    if (p.runBusy ? p.runBusy() : p.busy())
      throw Error("自动任务或设置操作正在进行");
    const value = agentObject(input, ["jobId", "requestId"]);
    return p.service.runNow(value as { jobId: string; requestId?: string });
  });
}
