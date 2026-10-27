import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheCopilotJob,
  listCachedJobs,
  pickCopilotJob,
  precheckCopilotJob,
  validateCopilotJob,
  type CopilotJobSummary,
} from "../games/arknights/copilot-library";

const sampleRaw = {
  stage_name: "go-8",
  minimum_required: "v6.7.0",
  opers: [
    {
      name: "重岳",
      skill: 3,
      skill_usage: 2,
      skill_times: 5,
      requirements: { elite: 2, level: 60, skill_level: 10 },
    },
  ],
  groups: [
    {
      name: "任意群奶",
      opers: [
        { name: "夜莺", skill: 3, skill_usage: 2 },
        { name: "白面鸮", skill: 2, skill_usage: 2 },
      ],
    },
  ],
  actions: [
    { type: "Deploy", name: "重岳", location: [5, 5], direction: "Right" },
    { type: "SpeedUp" },
    { type: "SkillDaemon" },
  ],
};

const summary: CopilotJobSummary = {
  id: 1001,
  stageName: "go-8",
  title: "低练度作业",
  uploader: "tester",
  uploadTime: "2026-10-01T00:00:00Z",
};

describe("validateCopilotJob", () => {
  it("accepts empty documentation while rejecting unsupported or contradictory requirements", () => {
    expect(
      validateCopilotJob({ ...sampleRaw, doc: { title: "", details: "" } }).raw
        .doc,
    ).toEqual({ title: "", details: "" });
    for (const requirements of [
      { potential: 1 },
      { module_level: 1 },
      { elite: 0 },
    ])
      expect(() =>
        validateCopilotJob({
          ...sampleRaw,
          opers: [{ name: "重岳", skill: 3, requirements }],
        }),
      ).toThrow();
    expect(
      validateCopilotJob({ ...sampleRaw, opers: [{ name: "重岳", skill: 3 }] })
        .opers[0].requirements?.elite,
    ).toBe(2);
  });
  it("接受合法作业并保留原始 JSON", () => {
    const job = validateCopilotJob(sampleRaw);
    expect(job.stageName).toBe("go-8");
    expect(job.opers[0].requirements?.elite).toBe(2);
    expect(job.groups[0].opers).toHaveLength(2);
    expect(job.actions[0]).toMatchObject({
      type: "Deploy",
      name: "重岳",
      location: [5, 5],
    });
    expect(job.raw).toBe(sampleRaw);
  });

  it("拒绝缺少 stage_name / actions 的作业", () => {
    expect(() => validateCopilotJob({})).toThrow("stage_name");
    expect(() =>
      validateCopilotJob({ stage_name: "go-8", minimum_required: "v6.7.0" }),
    ).toThrow("actions");
  });

  it("拒绝缺字段的部署操作与未知操作类型", () => {
    expect(() =>
      validateCopilotJob({
        ...sampleRaw,
        actions: [{ type: "Deploy", name: "重岳" }],
      }),
    ).toThrow("部署操作必须包含");
    expect(() =>
      validateCopilotJob({
        ...sampleRaw,
        actions: [{ type: "Fly" }],
      }),
    ).toThrow("未知操作类型");
  });
});

describe("precheckCopilotJob", () => {
  const job = validateCopilotJob(sampleRaw);
  it("练度达标且群组有人可用时通过", () => {
    const result = precheckCopilotJob(job, [
      { name: "重岳", elite: 2, level: 90, skillLevel: 10, owned: true },
      { name: "白面鸮", elite: 1, owned: true },
    ]);
    expect(result.ok).toBe(true);
  });

  it("干员缺失或练度不足时给出原因", () => {
    const result = precheckCopilotJob(job, [
      { name: "重岳", elite: 1, level: 30, skillLevel: 7, owned: true },
    ]);
    expect(result.ok).toBe(false);
    expect(result.insufficient.join()).toContain("精英化需 2");
    expect(result.missing.join()).toContain("任意群奶");
  });
});

describe("缓存", () => {
  it("写入作业文件并维护索引", () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    const job = validateCopilotJob(sampleRaw);
    const entry = cacheCopilotJob(dir, summary, job);
    expect(entry.file.endsWith(`1001-${entry.sha256}.json`)).toBe(true);
    expect(JSON.parse(readFileSync(entry.file, "utf8")).stage_name).toBe(
      "go-8",
    );
    const list = listCachedJobs(dir);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("低练度作业");
  });
});

describe("pickCopilotJob", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(jobIds: number[], raw: unknown = sampleRaw) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/copilot/query")) {
          expect(url).toContain("levelKeyword=go-8");
          return Response.json({
            status_code: 200,
            data: {
              data: jobIds.map((id) => ({
                ...summary,
                id,
                content: JSON.stringify(raw),
              })),
            },
          });
        }
        const id = Number(url.split("/").pop());
        return Response.json({
          status_code: 200,
          data: { content: JSON.stringify(raw) },
        });
      }),
    );
  }

  it("下载评分最高的作业并缓存", async () => {
    stubFetch([1001, 1002]);
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    const picked = await pickCopilotJob("go-8", dir);
    expect(picked.summary.id).toBe(1001);
    expect(picked.file).toContain(`1001-${picked.sha256}.json`);
    expect(listCachedJobs(dir)).toHaveLength(1);
  });

  it("练度不足时自动跳下一份", async () => {
    stubFetch([1001, 1002]);
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    // 第一份（1001）会预检失败，第二份同样内容但提供满足条件的 box 太绕，
    // 这里用同一份作业 + 不满足的 box，验证会尝试两份后报出两份失败原因。
    await expect(pickCopilotJob("go-8", dir, { box: [] })).rejects.toThrow(
      "没有可抄的作业",
    );
    // 满足条件时应选中第一份
    const box = [
      { name: "重岳", elite: 2, level: 90, skillLevel: 10, owned: true },
      { name: "夜莺", elite: 2, owned: true },
    ];
    const picked = await pickCopilotJob("go-8", dir, { box });
    expect(picked.summary.id).toBe(1001);
    expect(picked.precheck?.ok).toBe(true);
  });

  it("作业站查不到作业时抛错", async () => {
    stubFetch([]);
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    await expect(pickCopilotJob("go-8", dir)).rejects.toThrow(
      "没有找到 go-8 的作业",
    );
  });

  it("rejects a downloaded job for a different stage", async () => {
    stubFetch([1001], { ...sampleRaw, stage_name: "another-stage" });
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    await expect(pickCopilotJob("go-8", dir)).rejects.toThrow("关卡");
    expect(listCachedJobs(dir)).toEqual([]);
  });

  it("accepts a uniquely resolved stage alias", async () => {
    stubFetch([1001], { ...sampleRaw, stage_name: "act52side_04" });
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    const picked = await pickCopilotJob("go-8", dir, {
      stageAliases: ["go-8", "act52side_04"],
    });
    expect(picked.job.stageName).toBe("act52side_04");
  });

  it("selects the second candidate when only its formation is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/copilot/query"))
          return Response.json({
            status_code: 200,
            data: { data: [1001, 1002].map((id) => ({ ...summary, id })) },
          });
        const raw = url.endsWith("1001")
          ? sampleRaw
          : { ...sampleRaw, opers: [], groups: [] };
        return Response.json({
          status_code: 200,
          data: { content: JSON.stringify(raw) },
        });
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    expect((await pickCopilotJob("go-8", dir, { box: [] })).summary.id).toBe(
      1002,
    );
  });

  it("uses a revalidated immutable cached job when the network is offline", async () => {
    stubFetch([1001]);
    const dir = mkdtempSync(join(tmpdir(), "copilot-"));
    const online = await pickCopilotJob("go-8", dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const offline = await pickCopilotJob("go-8", dir);
    expect(offline.file).toBe(online.file);
    expect(offline.offline).toBe(true);
    writeFileSync(
      online.file,
      JSON.stringify({ ...sampleRaw, stage_name: "another-stage" }),
    );
    await expect(pickCopilotJob("go-8", dir)).rejects.toThrow();
  });
});

describe("Copilot execution contract", () => {
  it("rejects a minimum version newer than the pinned engine", () => {
    expect(() =>
      validateCopilotJob({ ...sampleRaw, minimum_required: "v99.0.0" }),
    ).toThrow("版本");
  });
  it.each([
    { type: "SpeedUp", costs: "50" },
    { type: "SpeedUp", pre_delay: -100 },
    {
      type: "Deploy",
      name: "重岳",
      location: [5, Number.NaN],
      direction: "Right",
    },
    { type: "SetUnitLocation", name: "装置" },
    { type: "Swipe" },
  ])("rejects malformed actual native action payload %j", (action) => {
    expect(() =>
      validateCopilotJob({ ...sampleRaw, actions: [action] }),
    ).toThrow();
  });
  it("keeps the upstream signed cost delta semantics", () => {
    expect(
      validateCopilotJob({
        ...sampleRaw,
        actions: [{ type: "SpeedUp", cost_changes: -5 }],
      }).raw.actions,
    ).toEqual([{ type: "SpeedUp", cost_changes: -5 }]);
  });
  it("does not pass a module requirement when operator-box cannot report modules", () => {
    const job = validateCopilotJob({
      ...sampleRaw,
      groups: [],
      opers: [{ name: "重岳", requirements: { module: 1 } }],
    });
    const result = precheckCopilotJob(job, [{ name: "重岳", owned: true }]);
    expect(result.ok).toBe(false);
    expect(result.unknown.join()).toContain("模组");
  });
});
