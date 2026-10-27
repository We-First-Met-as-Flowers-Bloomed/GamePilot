# MAA 能力迁入核对表

核对日期：2026-10-26。依据是本工作树当前的 `games/arknights/config.ts`、`index.ts`、`task-options.ts`、`extended-options.ts`、`worker-adapter.ts`、原生桥白名单与自动计划代码，不以旧文档推断实现状态。内核固定为 `games/arknights/engine-contract.json` 中的 **v6.20.1**，发行归档 SHA-256 为 `28a6c812c184f4bd6e8a7e7448b2ffa6312d711de7d39595deac771e3e784ea8`。

这里的“有入口”“已映射”指 App 参数经过校验，能够构造对应的内核任务；不等于已在当前活动、账号、游戏资源或设备上完成实机验收。本轮新增高级能力只有代码和回归测试证据，不能据此标为实机通过。

## 范围与结论

[官方集成文档](https://docs.maa.plus/zh-cn/protocol/integration.html) 用于理解用户功能，[v6.20.1 的 Assistant.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Assistant.cpp) 的注册分支决定该版本实际可提交的类型，共 **19 个正常任务类型**。编译期开关下的 Debug 不计入用户功能。

App 已有六种日常步骤；本轮新增 typed 高级参数迁入普通作业、肉鸽、生息、保全、悖论、主题切换、录像识别、显式目标养成，以及经过官方目录授权的活动玩法调用机制。但 **MAA 所有机制尚未全部迁完**：养成材料消耗的现场核验、Custom 活动/小游戏全部专用参数、作业库和实验任务的完整预检/结果闭环、部分 GUI 工作流仍有差距。不能用“原生桥允许某个类型”代替 App 功能完成证明。

状态定义：

- **D：日常路径已有支持**，有业务编排、参数映射及回归覆盖。
- **P：有内部入口或 typed 映射**，仍存在固定参数、结果展示或实机验证缺口。
- **M：App 缺失**，没有对应的用户配置与完整执行入口。
- **L：开发或底层接口**，不是普通用户任务，不能开放任意 JSON 或任意任务名来声称迁移完成。

## 19 类任务逐项核对

| MaaCore 类型 | App 技能/入口 | 状态 | 当前能力与具体差距 |
|---|---|---|---|
| StartUp | `login` | D | 官服/B 服启动与已登录账号切换；绑定 UID 时还有 App 双帧身份核验。原生其他区服未开放；密码、验证码等人工登录不由本功能代办。 |
| CloseDown | 内部 `close` 映射 | P | 已构造客户端关闭任务，桥已允许；尚没有独立的常规技能选择入口。 |
| Fight | `fight`、App 多关卡队列 | D | 关卡、次数、代理倍率、药/石数量、临期药、掉落目标、崩溃重启、DrGrandet 有 typed 参数。官方活动目录和导航资源由 App 同步；上传数据功能固定关闭。没有材料规划求解器或自动刷出所有未通关关卡的承诺。 |
| Recruit | `recruit`、`recruit-recognition` | D | 次数、刷新、优先/保留词条、额外标签、许可保留量、3/4 星招募时长可配置；识别模式不确认。加急固定关闭，高价值标签保护不能通过任意 JSON 绕过；未开放任意高星自动确认。 |
| Infrast | `infrastructure` | D | 默认算法/自定义排班/轮换三模式；设施、无人机、心情阈值、宿舍、菲亚梅塔、跨设施组合、会客室、训练继续、排班文件及方案号有 typed 参数。排班文件有本地存在检查；未实现 GUI 式排班图形编辑器。 |
| Mall | `friends` | D | 好友信用、信用购物、优先/黑名单、折扣、满信用处理、保留信用、OF-1 信用作战与编队槽可配置。App 购物后置核验仍要求匹配当前账号与现场余额；不能由一条回调推断买到了何种数量。 |
| Award | `award` | D | 每日/每周、邮件、免费单抽、活动合成玉、开采、特殊访问和限时签到分别映射。是否有活动、版型是否受支持仍取决于游戏现场；免费单抽开关不等于授权付费抽卡。 |
| Roguelike | `roguelike` | P | 过去固定黑流单次；现在 `extendedOptions.roguelike` 支持六主题及受限模式矩阵、次数、投资、难度、开局和主题专用参数。时长与开始次数均有上限。不同主题、开局和结局尚未逐个实机验收。 |
| Reclamation | `reclamation` | P | 过去固定重启锚点 RA-1；现在支持两个有效主题、Tales 0/1、重启锚点 16/32/48、制造物品/批数、点击方式和清店开关。制造批数不是 RA 关卡循环次数；关卡循环由 App 时限终止，不能伪造 `starts_count`。 |
| Copilot | `copilot`、`copilotOptions`、作业库服务 | P | 普通作业现有独立 typed 面板，支持本地单文件/列表、循环、编队槽、指定助战、额外干员、信赖补位、忽略要求、OperBox 数据路径、导航/突袭覆盖及 App 时限。默认不用药；用户须在 App 明确开启用药，原生只有布尔许可而无瓶数预算。导航/列表使用 `copilot_list`，不伪造 `stage_navigation` 或顶层 `is_raid`；本版循环仅不导航单文件有效，其他组合拒绝。worker 逐一检查所有路径。作业库查询/下载与预检已有，但列表完整预览和新版参数尚待实机。 |
| SSSCopilot | `sss-copilot` | P | 本轮支持本地保全作业 JSON 和有界循环，文件由 worker 检查。**该版本源码明确关闭自动编队**，不能提供一个实际无效的 formation 开关；作业内的阶段、装备、策略仍由合法作业文件定义。待实机。 |
| ParadoxCopilot | `paradox-copilot` | P | 本轮支持单个本地作业，或最多 50 个带整数 id 的本地作业列表，二者互斥；每个路径由 worker 检查。原生不支持 `loop_times`，不把普通作业参数套用在悖论任务上。待实机。 |
| Depot | `depot`、识别结果收集 | P | 原生只公开 `enable`，已支持；App 另有识别时长预算。不存在可迁入的原生“最多翻页数/材料筛选”参数。库存结果与其他规划器的自动衔接尚不完整。 |
| OperBox | `operator-box`、识别/作业预检 | P | 原生只公开 `enable`，已支持；App 另有识别时长预算。不能凭参数要求内核提供其回调没有的专精或模组等级。练度预检保持已观测字段与未知字段的区别。 |
| SwitchTheme | `switch-theme` | P | 本轮支持名称候选列表；多个候选由内核随机选择，空列表按内核协议跳过。主题名称需匹配游戏列表，是否解锁、是否找到需要现场结果；不把跳过当作已切换。 |
| VideoRecognition | `video-recognition` | P | 本轮支持本地作战录像路径与 App 时限，内核读取录像并尝试生成作业；原生实现位于 Experiment，属于实验功能。录屏质量、生成文件的复核与可视编辑尚未形成完整用户闭环。 |
| OperProgress | `operator-progress` | P | 本轮提供 typed 干员计划、可选职业、精英化、技能等级和专精目标；默认不允许材料消耗且目标为空，只有用户明确勾选并配置目标后才构造任务。最多 20 个目标并限制各目标等级，不能用 OperBox 识别代替养成。原生没有逐物品数量上限；消费预览和现场结果核验仍有缺口。 |
| Custom | `activity-game`、官方活动目录授权 | P | 本轮仅把一个官方目录中的当前路线映射成固定 `task_names`；worker 还必须精确验证路线、区服、版本、期限和导航资源。路径字符合法不等于有执行授权。官方其他秘密前线、像素画、自动升潜、材料合成和活动商店等专用配置尚未全部迁入；禁止开放任意任务数组或任意 `params`。 |
| SingleStep | 无用户入口 | L | 低层单步战斗指令，面向集成调用与调试。App 应通过既有可审查的游戏操作/作业路径封装，不向 renderer 透传任意动作。 |

### Gacha 与 Debug

**Gacha 不是 v6.20.1 注册的独立任务类型**，官方集成页也没有这个类型，不能在 App 中添加一个无效的 `type: "Gacha"` 来补表。也不能通过 Custom 拼接资源任务名绕过用户没有授权的抽卡消耗。现有 Award 的活动免费单抽是另一个明确开关，不扩展为付费抽卡。

Debug 只在对应编译开关下注册，不是发行版用户能力。它和 SingleStep 不计入“可在自动计划勾选的用户机制”目标。

## 高级参数的实际契约

`games/arknights/extended-options.ts` 是 App 白名单，`ArknightsConfig.extendedOptions` 持久化它，`taskFor()` 调用 native mapper，worker 使用 `extendedArknightsRunMinutes()` 取组内预算与全局预算的较小值。所有字段拒绝未知键和错误类型，不接受 raw native JSON。

普通作业由 `games/arknights/copilot-options.ts` 单独定义，持久化为 `copilotOptions`；兼容已有 `copilotFile` 和 `copilotLoopTimes`。列表最多 20 项、额外干员最多 12 位、循环 1–99、时限 5–360 分钟。源文件/列表互斥，只有不导航的单文件支持循环；用药默认 false，GUI 导入不会自动提升用药许可。`operbox_data_path` 同样是 worker 检查存在性的本地 JSON。该面板替换旧路径/循环输入，不存在两套互相覆盖的字段。

| 组 | 本轮配置范围 | 有界约束/原生差异 |
|---|---|---|
| roguelike | theme、mode、squad、roles、coreChars、助战、难度、投资、停止条件、开局奖励、萨米密文板与坍缩范式、月度/深入调查切换、萨卡兹种子、界园常乐目标、黑流策略/动物/奖励 | `startsCount` 1–999；`investmentsCount` 0–99,999；App `difficulty` -1–99，另允许原生精确哨兵 2,147,483,647 表示最高已解锁难度；预算 5–360 分钟。次数不接受 INT_MAX 无限哨兵。 |
| reclamation | 两有效 theme、各自 mode、toolsToCraft、clearStore、incrementMode、numCraftBatches | 制造批数 1–99，预算 5–360 分钟。Fire 已关闭且不在该版本 `is_valid_theme()` 中，不能显示可运行。RA 的批数参数不控制关卡循环。 |
| sssCopilot | filename、loopTimes、maxRunMinutes | 循环 1–99；只允许本地 JSON 路径；无自动编队参数。 |
| paradoxCopilot | filename 或 list、maxRunMinutes | 最多 50 项，列表 id 为 0–2,147,483,647 的不重复整数；没有循环次数参数。 |
| switchTheme | themes | 最多 50 个不重复名称；空列表表示跳过。 |
| depot / operatorBox | enabled、maxRunMinutes | 只有 enable 进入原生；预算是 App 约束，不虚构扫描能力。 |
| videoRecognition | filename、maxRunMinutes | 本地 mp4/mkv/avi/mov/webm，拒绝网络 URL；格式白名单比内核路径接口更窄。 |
| customActivity | route、maxRunMinutes | 只构造单条路线，不接收原生任务数组；语法白名单只是第一层，执行仍需当前官方目录的精确授权和导航 hash 核验。 |
| operProgress | plans、allowMaterialConsumption、maxRunMinutes | 默认 false 和空计划；最多 20 个不重复干员/职业目标，精英化 1/2、技能 2–7、三项专精各 0–3。必须有具体升级目标；这是目标范围和时间边界，**没有逐物品数量上限**。 |

肉鸽模式矩阵来自 [v6.20.1 RoguelikeConfig.h](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Roguelike/RoguelikeConfig.h)，不是用一个整数范围猜测：

| 主题 | 允许模式 |
|---|---|
| Phantom / Mizuki | 0、1、4、6、7 |
| Sami | 0、1、4、5、6、7 |
| Sarkaz | 0、1、4、6、7、10001 |
| JieGarden | 0、1、4、6、7、20001 |
| BlackFlow | 0、1、30001、30003 |

模式 2 已移除，模式 3 未开放，均拒绝。模式 5 的检测和密文板默认值随模式处理；开局精二只允许模式 4；仅凹精二要求同时启用精二开局。开局密文板需萨米、模式 4 和生活至上分队。空密文板列表不下发，避免原生把“传入空数组”判为参数失败。

界园 20001 生成准确的 `find_playTime_target` 键。黑流 30001 显式生成 `blackflow_strategy: "baby_animal"`，避免只改 mode 后仍走原生推断的 burn 路线；30003 传入动物列表和奖励位掩码，最多两只动物、可重复，羽蛇最多一只，奖励掩码 0–4095。Phantom 的最终 Boss 停止开关原生不生效，mapper 不为它下发此项，不能承诺该保护存在。

生息模式是 Tales 0/1 与 RelaunchAnchor 16（RA-1）/32（RA-15）/48（RA-4），不能跨主题套用。[源码验证](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Reclamation/ReclamationConfig.cpp) 与 [原生任务构建](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/ReclamationTask.cpp) 是最终依据。

## App 编排与 GUI 工作流迁移

- 日常与自动计划由 App 自己拥有，保存配置和执行账本，冻结账号、步骤与参数后再提交；失败或未知不自动重放。修改/删除计划不丢旧账。普通取消不关闭未来计划，只有退出应用才调用调度服务的 `stop()`。
- 默认早晚计划仍只包含六个日常步骤，且默认总开关关闭。新增高级技能可通过明确选择扩展，不能因升级内核或导入 MAA 设置自动塞入挂机计划。无作业文件的高级计划必须在冻结/构造任务阶段失败，不能提交空路径。
- `importMaaGuiConfig()` 已迁入受支持的日常参数、自定义基建路径，以及肉鸽通用参数、生息演算、仓库/干员识别选项；普通 `Copilot` 的编队、槽位、循环和额外干员也按白名单迁入。不会因源任务 `IsEnable=false` 删除六项日常，也不会自动把高级任务加入日常。连接、凭据、任意前后置脚本、GUI 更新/定时器等不直接执行。`Gui.RuntimeSettings` 通用运行开关/时限与 GUI Copilot 列表/外部路径仍未自动迁移；GUI 助战选中模式不包含启用状态，因此保留 App 既有助战设置。导入对上述缺口明确提示；黑流动物/结局/飞行、界园常乐目标和萨米密文板策略仍需在高级参数重新确认。
- 官方活动数据和 `tasks.json` 资源由 App 同步，关卡是否开放、最低内核版本与缓存状态参与可用性判断。活动关卡导入不代表 Custom 小游戏、活动商店或所有活动附加奖励均已覆盖。
- 目前主要统计结构覆盖 Fight/Mall/Award，识别结果单独覆盖 Depot/OperBox/Recruit；肉鸽结局、投资总量、保全/悖论批处理与实验录像输出仍需各自结果页。任务链完成回调不等于获得了期望游戏收益。
- AI 草稿继续只允许六项日常和零药/石/临期药。编译与实际冻结共用 `agentArknightsConfig()`，剥离设置页的 `taskOptions`、`extendedOptions` 和 `copilotOptions`，防止隐藏临期药、关卡队列或养成许可进入未披露的 AI 请求；不改写原账号设置。手动 UI 和保存计划继续使用完整参数。
- 主机通过 `createArknightsAutomationRun` 冻结保存计划的账号、步骤、参数和晚间到期时间，接入共用 `launchLane`。普通停止覆盖读取账号、首次 claim 落盘及 runtime 排队窗口；CLI 取消等待并不等于停止已受理 App 任务，失联或取消等待保持 `outcomeUnknown=true`。方舟 CLI 以精确 batch 的持久终态汇总，欠账不拆散重放而转入 App `--due`；阴阳师仍独立采用 native 记录。主机与 CLI 回归均未操作真实游戏，App succeeded 不代替逐项收益核验。

## 需要继续完成的用户功能

1. OperProgress：补齐材料与信物消耗展示、适用干员现场核验和养成结果核验；保留明确消耗许可，不把 bounded 目标描述成物品数量预算。
2. Custom：在固定官方活动路由之外逐种提供 typed 专用选项，不能暴露原生任务数组；活动商店、像素画、秘密前线、材料合成和自动升潜分别验收。
3. Copilot 列表完整预检/预览与新版参数实机认证；SSS/悖论作业库、导入格式核验与可读预览；录像生成作业的输出接收和复核。
4. 补齐尚未导入的 GUI 通用运行设置、Copilot 列表和主题专用高级字段，以及各任务的结果展示；当前只映射参数的功能不能显示成“已完成游戏目标”。
5. 对新增主题/模式、RA 各关、保全/悖论和主题切换逐项留下本轮实机证据。没有证据的能力保持待验证标记。

## 核对源

- [v6.20.1 Assistant 注册表](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Assistant.cpp)：实际任务类型、Gacha 缺席和 Debug 编译条件。
- [肉鸽参数校验](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Roguelike/RoguelikeConfig.cpp)、[肉鸽任务 setter](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/RoguelikeTask.cpp)、[投资插件](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Roguelike/RoguelikeInvestTaskPlugin.cpp)、[黑流生命周期插件](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Roguelike/BlackFlow/BlackFlowLifecycleTaskPlugin.cpp)：主题、次数、投资、开局与策略实际读取字段。
- [保全任务](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/SSSCopilotTask.cpp)、[悖论任务](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/ParadoxCopilotTask.cpp)、[主题切换](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/SwitchThemeTask.cpp)：各自参数边界。
- [仓库](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/DepotTask.cpp)、[干员识别](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/OperBoxTask.cpp)：没有额外任务 setter，不支持伪造扫描选项。
- [录像识别](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/VideoRecognitionTask.cpp)、[干员养成](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/OperProgressTask.cpp)、[自定义任务](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.20.1/src/MaaCore/Task/Interface/CustomTask.cpp)：实验功能、尚缺用户功能和固定路由的依据。

本轮专项回归覆盖 typed 参数、队列共享补给/掉落/时限、GUI 导入、官方活动 worker 准入及 AI 目录副作用声明。`MedicineCounterTaskPlugin` 在确认后发送本次用药数量；队列同时核对确认开始/完成与数量报告，部分报告缺失时不沿用对应药品余额。源石按确认事件和原生计数器的较大值扣减，避免子任务计数器重置后重复授予额度；确认开始但未完成时耗尽剩余源石额度。临期药开关遵循原生额外用药语义，可超出普通理智药数量上限，界面有单独说明，不能把它声称为严格药品总数上限。各关共享 App 时限；当前单个原生调用仍有既有 60 秒超时宽限，不能宣称秒级硬截止。

2026-10-26 以只读方式对 `D:\maa\config\gui.new.json` 与 `D:\maa - 副本\config\gui.new.json` 执行导入，均生成四个日常参数组及肉鸽/生息/仓库/干员识别组选项，验证现有 UID、区服和 LS-6 保留；未写回原文件、账号配置或输出凭据。高级任务及新版补给队列仍未在真实游戏执行。这些是源码核对、软件测试和导入验证，不能替代实机认证。

静态审计已使用当前四份源码（config、task-options、extended-options、copilot-options）解析 helper spread、条件字段与高级委派，覆盖 18 个注册技能和内部 CloseDown 映射，逐参数保留来源与行号；未知动态键/展开、递归、可变结果或缺少必需参数的分支仍阻断。实际官方归档审计共 10,590 个 DLL/资源文件与 ZIP 字节摘要一致，无静态 gap，全部技能仍为 `pending-real-device`。本机报告为 `artifacts/maa-audit/2026-10-26/engine-audit.json`。

主机回归证据：`arknights-automation-service.test.ts`（32）、`arknights-automation-host.test.ts`（17）、`arknights-job-snapshot.test.ts`（2）、`arknights-app-forward.test.ts`（5）、`game-mode-app-results.test.ts`（6）、`daily-native-round.test.ts`（4）；另有既有 game-mode 61 项回归。原生桥 5 项离线测试含六项日常及所有奖励布尔参数的 `AsstAppendTask` 接受检查，未连接设备/启动游戏，不能据此认定高级作业现场通过。
