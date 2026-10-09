import type { Game } from "../../../packages/protocol";

export interface GameWorkspace {
  mark: string;
  status: string;
  description: string;
  settingsKey?: "arknights";
  groups: { title: string; ids: string[] }[];
  progress: { title: string; description: string }[];
}

const workspaces: Record<string, GameWorkspace> = {
  arknights: {
    mark: "AK",
    status: "持续完善",
    settingsKey: "arknights",
    description: "日常、基建与作战，在一个工作区有序完成。",
    groups: [
      {
        title: "日常任务",
        ids: [
          "login",
          "recruit",
          "fight",
          "infrastructure",
          "friends",
          "award",
        ],
      },
      {
        title: "识别工具 · 待完整实机验收",
        ids: ["depot", "operator-box", "recruit-recognition"],
      },
      {
        title: "高级作战 · 实验功能，需看护",
        ids: ["copilot", "roguelike", "reclamation"],
      },
    ],
    progress: [
      {
        title: "基础日常",
        description:
          "已有登录、理智作战、基建、好友和奖励的实机记录；不同账号仍需按实际结果核对。",
      },
      {
        title: "新增 MAA 能力",
        description:
          "公招、识别工具、作业和高级作战已接入。核心参数通过不等于完整实机验证，高级任务请在看护下使用。",
      },
      {
        title: "继续完善",
        description:
          "识别结果展示、作业队列、独立任务顺序与更多游戏内场景验证。",
      },
    ],
  },
  onmyoji: {
    mark: "阴",
    status: "持续适配",
    description: "保留现有日常能力，逐步完善每一个庭院场景。",
    groups: [
      { title: "庭院日常", ids: ["login", "check-in", "mail", "daily-gift"] },
      { title: "阴阳寮与结界", ids: ["guild-quest", "foster", "guild-kirin"] },
      { title: "挑战与奖励", ids: ["realm-raid", "hana-claim"] },
    ],
    progress: [
      {
        title: "现有任务保留",
        description:
          "签到、邮件、礼包、阴阳寮、寄养、地域鬼王和花合战保留原执行入口。",
      },
      {
        title: "场景稳定性",
        description: "继续优化庭院卷轴、页面返回、弹窗处理与花合战领取等场景。",
      },
      {
        title: "后续配置空间",
        description:
          "为游戏专属策略和更多账号设置预留独立面板；当前自动化设置仍在全局设置中管理。",
      },
    ],
  },
};

export function gameWorkspace(game: Game): GameWorkspace {
  return (
    workspaces[game.id] ?? {
      mark: game.name.slice(0, 1),
      status: "待完善",
      description: game.subtitle,
      groups: [],
      progress: [
        {
          title: "游戏接入",
          description: "技能来自游戏注册表；专属设置和适配说明可在此扩展。",
        },
      ],
    }
  );
}

export function groupedSkills(game: Game) {
  const used = new Set<string>();
  const groups = gameWorkspace(game)
    .groups.map((group) => ({
      title: group.title,
      skills: group.ids.flatMap((id) => {
        const skill = game.skills.find((item) => item.id === id);
        if (!skill || used.has(id)) return [];
        used.add(id);
        return [skill];
      }),
    }))
    .filter((group) => group.skills.length);
  const remaining = game.skills.filter((skill) => !used.has(skill.id));
  if (remaining.length) groups.push({ title: "其他任务", skills: remaining });
  return groups;
}
