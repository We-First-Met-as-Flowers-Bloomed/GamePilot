# GamePilot

**0.18.9 · Windows x64 · AGPL-3.0-only · 公开源码**

GamePilot 是面向多游戏、多账号的日常自动化桌面应用。每个游戏账号绑定独立渠道和模拟器，任务由 App 内部调度与执行；AI 计划也要经过账号、步骤、资源预算和设备所有权校验。

## 本次更新

- 四个独立账号工作台，复杂页面按需加载。
- 明日方舟与阴阳师共用 App 持久调度，可按账号编辑时间、星期和执行步骤。
- 同一模拟器上的任务等待设备释放，独立设备可并行；未知结果保留原回执，不自动重放消费步骤。
- 方舟使用固定 MaaCore **v6.20.1** 与独立 .NET 桥接，接入日常参数、活动关卡、作业和高级任务。技能注册不等于全部玩法通过实机验收。
- 阴阳师旧脚本只转交 App，外部不再创建引擎或控制模拟器生命周期。
- 会客室结果区分入口识别、动作观测和实际结果；无法核验的项目保持未知。

## 从源码开始

固定前提：Windows x64、Node **22.18.0**、npm **10.9.3**、.NET SDK **8.0.400**。原生执行需要 Visual C++ v14 x64 运行库。

```powershell
git clone https://github.com/We-First-Met-as-Flowers-Bloomed/GamePilot.git
cd GamePilot
npm ci
npm run setup:electron
npm run setup:maacore
npm run setup:ocr
npm run typecheck
npm test -- --maxWorkers=4
npm run build
```

只看界面可运行 `npm run preview`；浏览器没有桌面桥接和设备控制。普通 `npm start` 会读取本机已有设置，已启用的内部计划可能自动执行。

本仓库沿用纯源码发布范围，包含应用、游戏适配、桥接、测试和固定依赖的准备脚本；不上传本机配置、执行记录、截图、游戏识别模板、私有 DSH 工件或便携二进制。阴阳师实机功能需自行准备兼容模板；AI 需独立配置匹配的 DSH 运行时与模型。

本次公开源码已通过本地类型、构建及回归验证；未提供的私有 DSH 检查明确跳过，不冒充真实游戏验证。当前发布凭据不包含 workflow 权限，因此本次未启用 GitHub Actions。详情见[开发准备](docs/getting-started.md)、[任务与聊天](docs/daily-app-guide.md)、[本机接口](docs/local-control.md)、[MAA 能力范围](docs/maa-capability-migration.md)。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 宿主、受限 preload、React 界面 |
| `games` | 游戏技能、配置、执行适配及结果判据 |
| `packages/protocol` | 计划、账本、IPC 与校验 |
| `packages/runtime` | 隔离 worker、引擎和退出控制 |
| `packages/maa-bridge` | MaaCore C#/.NET 桥接 |
| `packages/agent` | AI 规划与工具接口 |
| `integrations/deepseek-harness` | 固定 SDK 运行时适配 |
| `tests` / `scripts` | 回归验证及构建工具 |

`dist`、`artifacts` 和依赖缓存由 Git 忽略。运行数据保存在用户自己的 `.gamepilot` 目录。

## 许可

原创代码沿用 [AGPL-3.0-only](LICENSE)。第三方保留各自许可，见 [NOTICE](NOTICE.md) 与[第三方说明](docs/third-party-notices.md)。GamePilot 与游戏、模拟器、Maa 或 DeepSeek 的发行方无隶属关系。
