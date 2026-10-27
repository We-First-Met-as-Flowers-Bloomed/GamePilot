export function summarizeDailyIdempotency(runs, expectedSkills) {
  const ordered = [...runs].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
  const reasons = [];
  const identities = new Set();
  const days = new Set();
  const skills = [...new Set(expectedSkills)];
  if (!skills.length) reasons.push("没有声明待验收步骤");
  if (ordered.length < 2)
    reasons.push("至少需要 2 次独立运行才能证明重复执行幂等");
  const perRun = ordered.map((run, index) => {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      reasons.push(`第 ${index + 1} 次运行时间无效`);
    } else {
      const identity = String(start);
      if (identities.has(identity))
        reasons.push(`第 ${index + 1} 次产物重复引用同一次运行`);
      identities.add(identity);
      days.add(
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
          new Date(start),
        ),
      );
    }
    const entries = new Map();
    for (const outcome of run.outcomes) {
      if (!entries.has(outcome.skill)) entries.set(outcome.skill, []);
      entries.get(outcome.skill).push(outcome);
    }
    const missing = skills.filter((skill) => !entries.has(skill));
    const failedSkills = [];
    const skippedSkills = [];
    let succeeded = 0;
    for (const skill of skills) {
      const outcomes = entries.get(skill);
      if (!outcomes) continue;
      if (outcomes.length !== 1) {
        failedSkills.push(skill);
        continue;
      }
      const outcome = outcomes[0];
      if (outcome.status === "succeeded") {
        succeeded += 1;
        continue;
      }
      const evidence = outcome.evidence;
      const prior = ordered
        .slice(0, index)
        .find((item) => item.startedAt === evidence?.runStartedAt);
      const priorOutcomes = prior?.outcomes.filter(
        (item) => item.skill === skill,
      );
      if (
        outcome.status === "skipped" &&
        evidence?.kind === "already-completed" &&
        prior &&
        Date.parse(prior.finishedAt) <= start &&
        Date.parse(prior.startedAt) < start &&
        priorOutcomes?.length === 1 &&
        priorOutcomes[0].status === "succeeded"
      ) {
        skippedSkills.push(skill);
      } else failedSkills.push(skill);
    }
    if (failedSkills.length)
      reasons.push(
        `第 ${index + 1} 次运行有 ${failedSkills.length} 步未成功（重复执行当天日常不应失败）`,
      );
    if (missing.length)
      reasons.push(`第 ${index + 1} 次运行缺少步骤：${missing.join("、")}`);
    return {
      index: index + 1,
      finishedAt: run.finishedAt,
      succeeded,
      skipped: skippedSkills.length,
      skippedSkills,
      failed: failedSkills.length,
      failedSkills,
      missing,
    };
  });
  if (days.size > 1)
    reasons.push("运行不在同一业务日（Asia/Shanghai），不能证明同日幂等");
  return {
    runs: ordered.length,
    perRun,
    idempotent: reasons.length === 0,
    reasons,
  };
}

export function toDailyRunRecord(input) {
  if (!input || typeof input !== "object") return null;
  const { startedAt, finishedAt } = input;
  if (
    typeof startedAt !== "string" ||
    typeof finishedAt !== "string" ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(finishedAt)) ||
    Date.parse(finishedAt) < Date.parse(startedAt)
  )
    return null;
  const outcomes = Array.isArray(input.outcomes)
    ? input.outcomes
        .filter(
          (item) =>
            item &&
            typeof item.skill === "string" &&
            typeof item.status === "string",
        )
        .map((item) => ({
          skill: item.skill,
          status: item.status,
          ...(item.evidence?.kind === "already-completed" &&
          typeof item.evidence.runStartedAt === "string"
            ? {
                evidence: {
                  kind: "already-completed",
                  runStartedAt: item.evidence.runStartedAt,
                },
              }
            : {}),
        }))
    : [];
  return { startedAt, finishedAt, outcomes };
}
