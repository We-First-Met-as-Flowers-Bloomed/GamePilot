import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateRequestId } from "../../../packages/protocol/execution";
import { validateTaskRecord } from "../../../packages/protocol/task-record";
import type {
  FailureEvidenceSummary,
  FailureImageView,
} from "../../../packages/protocol/failure-view";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import type { Plan } from "../../../packages/protocol";

/** Renderer supplies opaque record IDs only. Paths and digests always come from the local ledger. */
export class FailureEvidenceService {
  constructor(
    private directory: string,
    private executions: ExecutionCoordinator,
    private ledger: RunLedger,
  ) {}
  private records(requestId: string) {
    const request = this.executions.get(validateRequestId(requestId));
    this.ledger.assertHealthy();
    const plans = [
      request.snapshot.plan,
      request.snapshot.arknightsPlan,
      request.snapshot.onmyojiPlan,
    ] as (Plan | undefined)[];
    const lane = request.snapshot.lane as
      | { id?: string; instance?: number; arknights?: { profileId?: string } }
      | undefined;
    const profile = request.snapshot.profile as { id?: string } | undefined;
    return this.ledger
      .forExecution(request.id)
      .map(validateTaskRecord)
      .filter(
        (r) =>
          r.executionId === request.id &&
          r.laneId === request.laneId &&
          r.batchId === request.batchId &&
          plans.some(
            (p) =>
              p &&
              p.gameId === r.gameId &&
              p.mode === r.plan.mode &&
              Array.isArray(p.skillIds) &&
              JSON.stringify(p.skillIds) === JSON.stringify(r.plan.skillIds),
          ) &&
          (request.laneId
            ? lane?.id === request.laneId &&
              Number.isInteger(lane.instance) &&
              r.instance === lane.instance &&
              (r.gameId !== "arknights" ||
                (!!profile?.id &&
                  profile.id === lane.arknights?.profileId &&
                  r.profileId === profile.id))
            : r.instance === undefined && r.profileId === undefined) &&
          Date.parse(r.startedAt) >= Date.parse(request.startedAt) &&
          (!request.finishedAt ||
            Date.parse(r.updatedAt) <= Date.parse(request.finishedAt)),
      );
  }
  async list(requestId: string): Promise<FailureEvidenceSummary[]> {
    return this.records(requestId)
      .filter((r) => r.fault)
      .map((r) => ({
        runId: r.runId,
        gameId: r.gameId,
        skillId: r.fault!.skillId,
        code: r.fault!.code,
        source: r.fault!.source,
        observedAt: r.fault!.observedAt,
        captureStatus: r.fault!.capture.status,
      }));
  }
  private target(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["requestId", "runId"].includes(k))
    )
      throw Error("证据请求参数无效");
    const v = input as Record<string, unknown>,
      requestId = validateRequestId(v.requestId),
      runId = validateRequestId(v.runId);
    const matches = this.records(requestId).filter((r) => r.runId === runId);
    if (matches.length !== 1 || !matches[0].fault)
      throw Error("没有与此请求匹配的失败证据");
    return matches[0];
  }
  private async load(input: unknown) {
    const record = this.target(input),
      capture = record.fault!.capture;
    if (capture.status !== "stored") return { status: "not-captured" as const };
    const lane = record.laneId;
    if (lane !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(lane))
      throw Error("证据账号标识无效");
    let folder = resolve(this.directory);
    try {
      for (const part of [
        "",
        ...(lane ? ["lanes", lane] : []),
        "failure-evidence",
      ]) {
        folder = join(folder, part);
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw Error("证据目录无效");
      }
      const file = join(folder, capture.key),
        before = await lstat(file);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size !== capture.bytes
      )
        throw Error("证据文件已改变，拒绝读取或删除");
      const handle = await open(file, "r");
      try {
        const stat = await handle.stat();
        if (
          stat.ino !== before.ino ||
          stat.dev !== before.dev ||
          stat.size !== capture.bytes
        )
          throw Error("证据文件已改变");
        const buffer = Buffer.alloc(capture.bytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const read = await handle.read(
            buffer,
            bytes,
            buffer.length - bytes,
            bytes,
          );
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
        }
        const png = buffer.subarray(0, bytes);
        if (
          bytes !== capture.bytes ||
          createHash("sha256").update(png).digest("hex") !== capture.sha256 ||
          png.length < 24 ||
          !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
          png.readUInt32BE(16) !== capture.width ||
          png.readUInt32BE(20) !== capture.height
        )
          throw Error("证据图片校验失败，拒绝读取或删除");
        return {
          status: "available" as const,
          png,
          file,
          ino: stat.ino,
          dev: stat.dev,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing" as const };
      throw error;
    }
  }
  async read(input: unknown): Promise<FailureImageView> {
    const value = await this.load(input);
    return value.status === "available"
      ? {
          status: "available",
          image: `data:image/png;base64,${value.png.toString("base64")}`,
        }
      : value;
  }
  async remove(input: unknown): Promise<void> {
    this.target(input);
    await this.executions.inspect(["*"], async () => {
      const value = await this.load(input);
      if (value.status !== "available") return;
      const current = await lstat(value.file);
      if (
        current.isSymbolicLink() ||
        current.ino !== value.ino ||
        current.dev !== value.dev
      )
        throw Error("证据文件已改变");
      await unlink(value.file);
    });
  }
}
