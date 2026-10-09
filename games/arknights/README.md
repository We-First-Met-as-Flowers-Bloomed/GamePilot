# 明日方舟游戏包

本包将平台技能映射为官方 MAA v6.17.5 任务：login → StartUp、recruit → Recruit、friends → Mall、fight → Fight、infrastructure → Infrast、award → Award。业务参数限定在 config.ts，不允许 renderer 传入任意 MAA JSON。安装、资源目录和桥接使用 engine-contract.json 的固定版本与归档摘要；Award 参数能力同源校验。

截至 2026-09-29：官服/B服双账号六项日常已实跑，登录核验主页 UID；信用商店已分别实际购买6项/5项。完整证据见 docs/daily-without-guild-quest-2026-09-29.md 与 docs/credit-shopping-2026-09-29.md。支持最多20个档案及模拟器实例绑定，不存储账号密码。仓库、干员识别、作业和实验任务已有入口，但注册可调用不代表所有场景已经实机验收，七天无人值守稳定性仍需独立观察。

运行边界：同设备由执行协调器仲裁，每个账号通道使用独立worker；独立MaaCore桥接在技能结束后销毁。每日按保存清单执行登录、公招、作战、基建、好友信用、奖励。`times`省略，`series=0`，理智药、过期药和源石补充均为0。基建保持用户指定的`mode=20000`总览一键轮换；贸易站无人机和会客室动作仍可能进入设施。信用购买按账号开关执行，优先招聘许可/龙门币，其他只买折扣并排除家具零件/加急许可/碳；不承诺购买后保留300信用。

正式调度已配置08:00两个账号先方舟后阴阳师，20:00仅两个方舟账号。每个实例独立记录轮次，阴阳师集体任务和寄养不在当前每日清单中。单设备工具与双账号每日入口执行范围不同。

能力边界：v6.17.5不支持`Award.signinevent`（通用横版限时签到）。关闭时不发送该字段；开启旧配置保留供用户修正，但含Award的任务必须在执行前拒绝，不再由内核静默忽略。旧配置仅执行登录等无关步骤不受该选项影响。v6.18.0是该功能的上游最低版本说明，不代表本发行版已经支持更换内核。完整更新/回滚和逐项能力认证属于后续工作。

来源：https://docs.maa.plus/zh-cn/protocol/integration.html ，官方发行 https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/tag/v6.17.5 。第三方资源不提交在游戏源码目录。
