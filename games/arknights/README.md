# 明日方舟游戏包

本包将平台技能映射为官方 MAA v6.20.1 任务：login → StartUp、recruit → Recruit、friends → Mall、fight → Fight、infrastructure → Infrast、award → Award。业务参数限定在 config.ts、task-options.ts、extended-options.ts 和 copilot-options.ts，不允许 renderer 传入任意 MAA JSON。安装、资源目录和桥接使用 engine-contract.json 的固定版本与归档摘要；版本字段并不代表运行目录已安装或实机已验证。

截至 2026-09-29：官服/B服双账号六项日常已实跑，登录核验主页 UID；信用商店已分别实际购买6项/5项。完整证据见 docs/daily-without-guild-quest-2026-09-29.md 与 docs/credit-shopping-2026-09-29.md。支持最多20个档案及模拟器实例绑定，不存储账号密码。仓库、干员识别、作业和实验任务已有入口，但注册可调用不代表所有场景已经实机验收，七天无人值守稳定性仍需独立观察。

运行边界：同设备由执行协调器仲裁，每个账号通道使用独立 worker；独立 MaaCore 桥接在技能结束后销毁。每日按保存清单执行登录、公招、作战、基建、好友信用、奖励。未指定任务参数时仍沿用历史默认值：`times` 省略、`series=0`、理智药/临期药/源石均关闭、基建 `mode=20000`。参数面板可配置顺序关卡队列、每关次数、代理倍率、全队列药石预算、新增掉落目标与崩溃重启。补给按当前任务 ID 的消费回调扣除，下一关不会重置；有确认但缺少计数时放弃余药预算。临期药遵循 MAA 原生规则，可额外超过普通药预算。掉落目标跨队列累计、任意一个达到即停止；缺失累计识别时停止后续关卡。各任务链结果单独记录，不把最后一次结算伪装成累计次数。

公招支持三星/四星选择与确认、刷新、许可保留、招募时限和标签策略；资深/高级资深标签始终保留、不使用加急许可。基建支持原生三种模式、设施、无人机、心情阈值、宿舍、组合、会客室和继续训练参数；自定义模式必须有排班 JSON。信用商店支持访问、优先购买、排除、折扣、余额阈值、溢出购买及助战 OF-1；购买仍受账号总开关控制，执行后保留原有场景与余额后置核验。

方舟使用 App 内每账号独立计划，迁移默认 08:00 六项日常、20:00 登录/公招/作战/基建/领奖，时间、星期及步骤可编辑。计划默认暂停，正式启用与本次实机结果以部署回执为准。旧全局定时只用于阴阳师，不再承担方舟执行；阴阳师原 Windows 任务本轮保持。

`maa-gui-import.ts` 白名单读取 `config/gui.new.json` 的 Configurations/TaskQueue。默认使用 Default 配置；无 Default 且有多个配置时要求配置名。App 已存首关优先于 GUI 临时首关，源 IsEnable 不删除 App 日常步骤；账号匹配、凭据、脚本、连接、日期缓存不导入。自定义基建文件由调用方复制到托管目录后保存；导入先进入草稿。肉鸽通用参数、生息演算和仓库/干员识别选项已迁入高级设置，普通 Copilot 编队/槽位/循环/额外干员也有白名单导入，但不会自动加入日常或开启用药。GUI 周计划、库存总量目标、强制刷新、通用运行设置、Copilot 列表和部分主题专用策略仍未迁入，导入会给出警告。完整边界见 [MAA 能力迁入核对表](../../docs/maa-capability-migration.md)。

普通 Copilot 现支持单文件或最多 20 项列表、编队、助战、额外干员、导航/突袭和 OperBox 文件，worker 逐一检查路径并取单项/全局时限的较小值。默认不用药，只有 App 显式设置才允许；原生用药许可没有瓶数上限。AI 草稿仍只使用披露的六项日常默认参数，编译和执行都剥离设置页的三类高级组选项，防止隐藏补给、队列或养成许可进入零补给草稿，原保存配置保持不变。

能力边界：固定 v6.20.1 支持 `Award.signinevent`，保留关闭/开启独立开关。此次参数及迁移改动有单元测试与两份真实 GUI 文件的只读解析证据；升级内核、多个关卡、消耗补给和新增基建模式尚需独立实机验收，不能沿用旧版六项日常的成功记录冒充新版验证。

来源：[官方集成协议](https://docs.maa.plus/zh-cn/protocol/integration.html)、[官方回调协议](https://docs.maa.plus/zh-cn/protocol/callback-schema.html)、[v6.20.1 理智药消费回调源码](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Fight/MedicineCounterTaskPlugin.cpp)、[官方发行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/tag/v6.20.1)。第三方资源不提交在游戏源码目录。
