import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentToolError } from "../../../packages/protocol/agent";
import {
  validStartupReconciliationFact,
  type StartupReconciliationFact,
} from "../../../packages/protocol/startup-reconciliation";
import { boundedRead } from "../../../packages/agent/read-file";
import { canonical } from "../../../packages/acceptance/files";

const maxBytes = 32 * 1024;
const maxFacts = 512;
const filename = (id: string) =>
  createHash("sha256").update(id).digest("hex") + ".json";
const unavailable = () =>
  new AgentToolError(
    "STARTUP_RECONCILIATION_STORE_UNAVAILABLE",
    "纯启动对账事实无法可靠读取或保存；旧请求仍须核对。",
  );
const conflict = () =>
  new AgentToolError(
    "STARTUP_RECONCILIATION_CONFLICT",
    "同一对账事实编号已有不同内容，原事实保留。",
  );

/** Append-only evidence storage; schema validation never grants game execution. */
export class StartupReconciliationStore {
  error?: string;
  private records = new Map<string, StartupReconciliationFact>();
  private initialized = false;
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }
  private async readFact(name: string): Promise<StartupReconciliationFact> {
    const fact: unknown = JSON.parse(
      await boundedRead(join(this.directory, name), maxBytes),
    );
    if (!validStartupReconciliationFact(fact) || filename(fact.id) !== name)
      throw unavailable();
    return fact;
  }
  private async restore() {
    try {
      let names: string[];
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        names = [];
      }
      const published = names.filter((name) => name.endsWith(".json"));
      if (published.length > maxFacts) throw unavailable();
      const facts = new Map<string, StartupReconciliationFact>();
      for (const name of published) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw unavailable();
        const fact = await this.readFact(name);
        if (facts.has(fact.id)) throw unavailable();
        facts.set(fact.id, fact);
      }
      this.records = facts;
      this.initialized = true;
    } catch {
      this.error = unavailable().message;
      throw unavailable();
    }
  }
  assertHealthy(): void {
    if (this.error || !this.initialized) throw unavailable();
  }
  snapshot(): StartupReconciliationFact[] {
    this.assertHealthy();
    return structuredClone(
      [...this.records.values()].sort(
        (a, b) =>
          Date.parse(a.reconciledAt) - Date.parse(b.reconciledAt) ||
          a.id.localeCompare(b.id),
      ),
    );
  }
  forOriginal(requestId: string): StartupReconciliationFact[] {
    return this.snapshot().filter(
      (fact) => fact.candidate.originalRequestId === requestId,
    );
  }
  private async publish(fact: StartupReconciliationFact) {
    const name = filename(fact.id);
    const target = join(this.directory, name);
    const staging = target + "." + randomUUID() + ".tmp";
    await mkdir(this.directory, { recursive: true });
    try {
      const handle = await open(staging, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(fact), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // Publishing a complete inode is atomic and cannot overwrite an existing fact.
        await link(staging, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = await this.readFact(name);
        if (canonical(prior) !== canonical(fact)) throw conflict();
      }
    } finally {
      try {
        await unlink(staging);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async append(
    input: StartupReconciliationFact,
  ): Promise<StartupReconciliationFact> {
    let fact: StartupReconciliationFact;
    try {
      fact = structuredClone(input);
      if (
        !validStartupReconciliationFact(fact) ||
        Buffer.byteLength(JSON.stringify(fact), "utf8") > maxBytes
      )
        throw Error();
    } catch {
      throw new AgentToolError(
        "STARTUP_RECONCILIATION_INVALID",
        "对账事实字段或关联无效，未写入记录。",
      );
    }
    const job = this.writes.then(async () => {
      await this.load();
      this.assertHealthy();
      const prior = this.records.get(fact.id);
      if (prior) {
        if (canonical(prior) !== canonical(fact)) throw conflict();
        return structuredClone(prior);
      }
      if (this.records.size >= maxFacts) throw unavailable();
      try {
        await this.publish(fact);
      } catch (error) {
        if (
          error instanceof AgentToolError &&
          error.code === "STARTUP_RECONCILIATION_CONFLICT"
        )
          throw error;
        this.error = unavailable().message;
        throw unavailable();
      }
      this.records.set(fact.id, fact);
      return structuredClone(fact);
    });
    this.writes = job.then(
      () => {},
      () => {},
    );
    return job;
  }
  async flush(): Promise<void> {
    await this.load();
    await this.writes;
    this.assertHealthy();
  }
}
