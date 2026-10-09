import { Gamepad2, ArrowUpRight } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import {
  builtinAgentSkills,
  gameCapabilityDescriptors,
} from "../../../../games/agent-skills";
export default function Library({ desktop }: { desktop: DesktopController }) {
  const { game, active, setSelected, setView } = desktop;
  const descriptor = gameCapabilityDescriptors().find(
    (entry) => entry.id === game.id,
  );
  return (
    <div className="page">
      <div className="eyebrow">SKILL LIBRARY</div>
      <h1>一步一步，扩展能力。</h1>
      <p className="intro">
        每个游戏拥有独立技能。接入状态不等于完整实机验证，高级能力请在看护下使用。
      </p>
      <details className="surface library-card">
        <summary>Agent 内置技能与执行规则</summary>
        <p>
          Agent
          根据这些说明调用应用工具。启用的日常、账号绑定和执行检查决定实际操作。
        </p>
        {builtinAgentSkills()
          .filter((skill) => skill.gameIds.includes(game.id))
          .map((skill) => (
            <article key={skill.id}>
              <h3>
                {skill.title} · v{skill.version}
              </h3>
              <p>{skill.description}</p>
              <small>内置 · 按需读取 · 正文不会授予额外设备权限</small>
            </article>
          ))}
        <p className="helper">
          {descriptor?.engine.id} {descriptor?.engine.version} ·
          七天稳定观察未完成
        </p>
      </details>
      <div className="section-label">
        <h3>{game.name}</h3>
        <span>{game.skills.length} 项技能</span>
      </div>
      {game.skills.map((skill) => (
        <section className="surface library-card" key={skill.id}>
          <div className="section-label">
            <h3>
              <Gamepad2 size={18} />
              {skill.title}
            </h3>
            <span className={`badge ${skill.ready ? "green" : ""}`}>
              {skill.ready ? "已接入" : "待实机适配"}
            </span>
          </div>
          <p>{skill.description}</p>
          {!!descriptor?.skills.find((entry) => entry.id === skill.id)?.effects
            .length && (
            <details>
              <summary>此步骤可能执行哪些操作</summary>
              <ul>
                {descriptor.skills
                  .find((entry) => entry.id === skill.id)!
                  .effects.map((effect) => (
                    <li key={effect.id}>{effect.label}</li>
                  ))}
              </ul>
              <p className="helper">
                附带操作按保存的开关决定；实际计划确认前会再次校验。
              </p>
            </details>
          )}
          <button
            className="text-button"
            disabled={active || !!desktop.busy}
            onClick={() => {
              setSelected((previous) =>
                previous.includes(skill.id)
                  ? previous
                  : [...previous, skill.id],
              );
              setView("workspace");
            }}
          >
            加入任务计划
            <ArrowUpRight size={14} />
          </button>
        </section>
      ))}
    </div>
  );
}
