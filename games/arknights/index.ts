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
      description: "不用加急，只确认三星并保留高价值词条",
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
      description: "按现有理智代理指定关卡，不吃药、不碎石",
      ready: true,
    },
    {
      id: "infrastructure",
      title: "基建一键轮换与收菜",
      description: "使用进驻总览一键轮换，收菜并用无人机加速贸易站",
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
      description: "扫描仓库并生成材料库存识别结果",
      ready: true,
    },
    {
      id: "operator-box",
      title: "干员练度识别",
      description: "扫描干员列表并生成等级、精英化和潜能识别结果",
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
      description: "读取 MAA 作业文件自动编队和执行，不使用理智药",
      ready: true,
    },
    {
      id: "roguelike",
      title: "肉鸽单次探索（需看护）",
      description: "黑流树海单次探索，自动选练度，最终 Boss 前停止",
      ready: true,
    },
    {
      id: "reclamation",
      title: "生息演算 RA-1（需看护）",
      description: "重启锚点 RA-1 单批执行，不清空商店",
      ready: true,
    },
  ],
};
