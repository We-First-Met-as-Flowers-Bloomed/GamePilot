import { describe, expect, it } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { liveSkills, resolveLiveSkill } from "../scripts/live/skills";

/**
 * 实机 harness 的技能表必须和 OnmyojiDaily 同步：技能改名/删掉时先在这里红，
 * 而不是等到实机跑到一半才发现 `--step` 指向一个不存在的方法。
 */
describe("live harness skill table", () => {
  it("maps every CLI name to a real OnmyojiDaily method", () => {
    for (const skill of liveSkills)
      expect(
        typeof (OnmyojiDaily.prototype as unknown as Record<string, unknown>)[
          skill.method
        ],
        `${skill.id} → ${skill.method}`,
      ).toBe("function");
  });

  it("keeps CLI names unique and resolvable", () => {
    const ids = liveSkills.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(resolveLiveSkill(id)?.id).toBe(id);
    expect(resolveLiveSkill("not-a-skill")).toBeUndefined();
  });

  it("marks the supervised-only skill so the runner can warn", () => {
    expect(resolveLiveSkill("battle-current")?.supervised).toBe(true);
    expect(resolveLiveSkill("login")?.supervised).toBeUndefined();
  });
});
