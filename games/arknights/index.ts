import type { Game } from "../../packages/protocol";
export const arknights: Game = {
  id: "arknights",
  name: "明日方舟",
  subtitle: "MAA · 实机日常",
  skills: [
    {
      id: "login",
      position: "first",
      title: "启动与上号",
      description:
        "按官服或 B 服启动游戏，复用已有登录态；已绑定 UID 时，进入自己的个人名片核对双帧 UID，再确认返回主页；不符则停止后续任务，配置 UID 不代表已通过现场核验",
      ready: true,
    },
    {
      id: "recruit",
      title: "保守自动公招",
      description:
        "按账号参数选择三星/四星公招，不用加急并保留资深标签；新增选项待实机复验",
      ready: true,
    },
    {
      id: "friends",
      title: "好友与信用商店",
      description:
        "访问好友收取信用；按账号设置购买信用商品，优先招聘许可和龙门币",
      ready: true,
    },
    {
      id: "fight",
      title: "理智作战",
      description:
        "按保存的队列自动代理，共享药石和新增掉落目标预算；补给默认关闭，队列待实机复验",
      ready: true,
    },
    {
      id: "infrastructure",
      title: "基建换班与收菜",
      description:
        "按账号选择一键轮换、效率换班或自定义排班；默认一键轮换，新增模式待实机复验",
      ready: true,
    },
    {
      id: "award",
      title: "领取任务奖励",
      description: "领取每日、每周奖励；邮件领取可单独设置",
      ready: true,
    },
    {
      id: "depot",
      title: "仓库材料识别",
      description: "扫描仓库并生成材料库存识别结果；新版内核待实机复验",
      ready: true,
    },
    {
      id: "operator-box",
      title: "干员练度识别",
      description:
        "扫描干员列表并生成等级、精英化和潜能识别结果；新版内核待实机复验",
      ready: true,
    },
    {
      id: "recruit-recognition",
      title: "公招标签识别",
      description: "只计算当前公招标签组合，不刷新、不确认、不消耗许可",
      ready: true,
    },
    {
      id: "copilot",
      title: "本地作业 JSON",
      description:
        "读取 MAA 作业文件，按高级参数编队和执行；新增参数待实机认证",
      ready: true,
    },
    {
      id: "roguelike",
      title: "肉鸽单次探索（需看护）",
      description:
        "按高级参数选择主题、策略与次数；默认单次探索，新增参数待实机认证",
      ready: true,
    },
    {
      id: "reclamation",
      title: "生息演算 RA-1（需看护）",
      description:
        "按高级参数执行重启锚点；默认 RA-1 单批、不清空商店，待实机认证",
      ready: true,
    },
    {
      id: "sss-copilot",
      title: "保全派驻作业（需看护）",
      description: "执行已配置的本地保全 JSON；原生任务参数接入，待实机认证",
      ready: true,
    },
    {
      id: "paradox-copilot",
      title: "悖论模拟作业（需看护）",
      description: "执行已配置的悖论模拟作业；原生任务参数接入，待实机认证",
      ready: true,
    },
    {
      id: "switch-theme",
      title: "切换界面主题",
      description: "按高级参数切换游戏主题；原生任务参数接入，待实机认证",
      ready: true,
    },
    {
      id: "video-recognition",
      title: "录屏识别转作业（实验）",
      description:
        "读取已配置的本地战斗录屏交由 MAA 识别；待实机认证，不保证生成作业质量",
      ready: true,
    },
    {
      id: "activity-game",
      title: "活动小游戏（实验）",
      description:
        "仅执行官方活动资源目录白名单且仍开放的小游戏路线；待实机认证",
      ready: true,
    },
    {
      id: "operator-progress",
      title: "干员养成（需明确授权）",
      description:
        "按高级计划升级干员或技能并消耗材料；须先允许资源消耗，待实机认证",
      ready: true,
    },
  ],
};
