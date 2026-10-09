# GamePilot

GamePilot 是一个开发中的游戏自动化桌面项目：用自然语言交办任务，由宿主核验账号、范围和资源限制，再交给游戏执行器；结果以实际任务账本为准。

**0.15.13 · Windows x64 · 纯源码首发 · AGPL-3.0-only**

本仓库公开 Electron / React / TypeScript 应用、游戏适配、独立执行器桥接和测试。首发不附安装包、原生运行时、游戏截图、识别模板、账号配置或运行记录。第三方组件保持原许可证，见 [NOTICE](NOTICE.md) 和 [第三方说明](docs/third-party-notices.md)。

## 当前能做什么

- **明日方舟**：通过固定版本 MaaCore 和独立 .NET 桥接进程接入登录、作战、基建、公招、好友和领奖等任务；实际开放范围由技能与参数校验决定。
- **阴阳师**：通过 MaaFramework 接入登录态检查、签到、邮件、礼包、花合战及部分日常流程。游戏视觉模板未随源码发布，相关实机功能需要自行准备适配资源。
- **聊天与任务**：官方 DeepSeek Harness SDK 负责模型工具循环；宿主负责当前消息授权、计划编译、持久目标、设备互斥、结果核验和允许范围内的续跑。
- **桌面工作区**：账号与设备配置、保存日常、定时运行、任务详情、故障证据和聊天结果展示。

开发过程中已验证过受限单条玩家命令的完整链路，包括阴阳师登录、邮件领取及无可领花合战奖励时跳过。这只说明特定客户端场景曾通过；不代表所有账号、皮肤、游戏版本或完整日常均可无人值守运行。当前不承诺全自治、任意故障恢复或持续稳定性。未知提交结果不会被当成可安全重跑。

## 从源码开始

先阅读 [开发与准备指南](docs/getting-started.md)。基础环境是 Windows x64、Node.js 22.12+ 和 .NET 8 SDK；原生执行另需 Visual C++ v14 x64 运行库。

```powershell
git clone https://github.com/We-First-Met-as-Flowers-Bloomed/GamePilot.git
cd GamePilot
npm ci
npm run setup:electron
npm run typecheck
npm run build
```

以上是当前脚本入口，不是全新机器的完整游戏安装承诺。构建不自动补齐 MaaCore、OCR、DSH 或游戏模板；其中 DSH 仍要求与仓库指纹一致的独立 Node 运行时，尚无本项目提供的一键公共获取方案。缺少依赖时，相关测试会跳过或功能拒绝运行。首次源码导出的全新环境验收仍需单独完成。

只看界面可运行 `npm run preview`，浏览器预览没有桌面桥接或设备控制。完整检查使用 `npm run verify`；推荐的隔离界面检查是 `npm run smoke:goals`。普通 `npm start` / `npm run dev` 会打开真实应用，已有用户配置可能启用调度，不属于安全演练。各 smoke 的数据和执行边界见 [指南](docs/getting-started.md#验证边界)。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程、受限 preload、React 界面 |
| `packages/agent` | 模型适配、工具循环与规划协议 |
| `packages/runtime` | 隔离 worker、原生引擎与退出控制 |
| `packages/maa-bridge` | MaaCore 的 C# / .NET 进程桥 |
| `packages/protocol` | 计划、目标、账本与 IPC 类型 |
| `games` | 游戏能力、执行适配与结果判定 |
| `integrations/deepseek-harness` | 固定 SDK 运行时适配及可选 MCP 接入 |
| `tests` / `scripts` | 回归测试、开发与构建工具 |

操作方式见 [每日与聊天使用指南](docs/daily-app-guide.md)，设计见 [架构](docs/architecture.md)。贡献前阅读 [CONTRIBUTING](CONTRIBUTING.md)，安全问题见 [SECURITY](SECURITY.md)。

## 许可与项目关系

本项目原创代码采用 [GNU AGPL v3，仅此版本](LICENSE)。这一声明不重新许可第三方代码、模型、游戏素材或商标。GamePilot 不隶属于游戏发行商、模拟器厂商、Maa 项目或 DeepSeek；使用这些名称仅用于说明兼容与依赖关系。
