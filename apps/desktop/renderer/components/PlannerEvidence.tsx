import type { AgentHistoryAssessment } from "../../../../packages/protocol/agent";

export function PlannerEvidence({
  assessment,
}: {
  assessment?: AgentHistoryAssessment;
}) {
  if (!assessment) return null;
  return (
    <section className="banner warning" aria-label="宿主证据结论">
      <div>
        <strong>整套日常完成情况：待核对</strong>
        <p>
          {assessment.scope === "not-read"
            ? "本轮只读取配置，没有读取执行记录。"
            : "本轮只查询可关联的历史记录，未核验当前完整日常。"}
          缺失记录不代表未执行，单项成功也不代表整套完成；不能据此自动补跑。
        </p>
        <small>以上由程序根据证据范围生成，独立于下方 AI 说明。</small>
      </div>
    </section>
  );
}
