# 开发与准备指南

本指南对应 GamePilot 0.15.13 的纯源码首发。它说明当前脚本的真实前置条件，不声称已经在任意干净机器上验证完整安装。源码不附游戏图像、原生运行时、模型文件、账号配置或私人验收记录。

## 环境

| 组件 | 当前要求 |
| --- | --- |
| 操作系统 | Windows x64；其他平台未完成桌面执行链适配 |
| 根项目 Node.js | 22.12+，用于 npm、构建和测试 |
| .NET | .NET 8 SDK；`build` 会发布 win-x64 自包含桥接进程 |
| 原生运行库 | Microsoft Visual C++ v14 x64，供 Maa 等本机组件使用 |
| 模型 runtime | 独立 DSH 0.2.1-alpha.1；其运行时 Node 另有严格固定要求 |
| 设备 | 自行安装的受支持模拟器及 ADB；首次游戏登录由用户完成 |

.NET SDK 和生成运行时的补丁版本目前未完全锁定，因此不承诺逐字节可复现构建。项目也没有附带模拟器、ADB 或 Microsoft 运行库。

## 源码与界面

```powershell
git clone https://github.com/We-First-Met-as-Flowers-Bloomed/GamePilot.git
cd GamePilot
npm ci
npm run setup:electron
npm run typecheck
npm run preview
```

`preview` 是浏览器界面预览，没有 Electron preload 和真实设备控制。`npm ci` 按根锁文件安装依赖，可能下载 Electron / Maa 平台包。网络或平台依赖不可用时应处理安装错误，不跳过校验伪装成功。

构建桌面代码：

```powershell
npm run build
```

这会生成 renderer、main、preload、worker 和 .NET 桥接进程。缺少 MaaCore 下载缓存时，构建脚本不会自动下载它，也不能据此确认游戏引擎已准备好。

## 可选的本地引擎准备

```powershell
npm run setup:ocr
npm run setup:maacore
npm run build
```

- `setup:ocr` 从固定 MaaCommonAssets 提交下载中文 PP-OCRv4 的 `det.onnx`、`rec.onnx` 和 `keys.txt`，逐项验证 SHA-256。
- `setup:maacore` 下载固定 MAA v6.17.5 Windows x64 官方发行包，校验归档哈希，再写入忽略的下载目录。它需要 Windows 自带或可用的 `curl.exe` 和 PowerShell。
- 再次构建才会将准备好的资源复制到 `dist`；MAA 公告资源补丁应用于生成副本，并留下补丁记录。

这些步骤只准备本地依赖，不安装游戏、不登录账号、不证明实际任务可执行。下载和后续再分发分别受上游条款约束。

## 游戏模板缺口

首发未包含阴阳师截图裁剪模板。执行代码在 `games/onmyoji/resources/image` 下按文件名读取兼容图像；目前没有自动生成或公开下载这些模板的安装器。

所需名称包括 `courtyard-menu-closed.png`、`courtyard-menu-toggle.png`、`courtyard-scene-back.png`、`courtyard-scene-music.png`、`courtyard-tasks.png`、`foster-confirm.png`、`foster-white-daruma.png`、`guild-entry.png`、`hana-entry.png`、`training-full.png`、`training-level-one.png`、`training-level-one-stack.png`。

用户须自行取得可合法使用的对应素材，按当前客户端画面与执行代码的匹配区域、阈值核验。随意放置同名图像不能完成适配。缺少模板时不要启用相关实机技能；合成测试通过不代表模板匹配通过。这里不提供未经验证的采集坐标或素材授权承诺。

## DSH 聊天运行时

根 `npm ci` 不会准备独立 DSH runtime。固定依赖位于 `integrations/deepseek-harness/runtime`，有独立 `package-lock.json`。SDK 的 Node 声明为 `^22.19.0 || >=24.0.0`，而本项目准备脚本进一步固定 **Windows x64 Node v24.21.0 的可执行文件和 LICENSE 哈希**，见该目录的 `node-runtime.json`。

当前准备脚本默认依赖开发环境中已安装的 DSH Node 工件。本首发没有提供能在任意新机器上取得同一工件的一键公共下载流程。仅有相同版本号并不足以通过校验。

已有与指纹完全匹配的工件时，可使用以下参数形式；尖括号内容必须换成自己取得的真实文件路径：

```powershell
npm run setup:dsh -- --node "<匹配指纹的node.exe>" --node-license "<匹配指纹的LICENSE>"
```

必要时增加 `--npm "<npm-cli.js>"` 指定 npm 入口。脚本使用独立目标执行 `npm ci --ignore-scripts`，收集许可并生成构建信息；不会把 DSH 安装进根 `node_modules`。没有匹配工件时，应停留在源码、界面和不依赖该运行时的测试阶段，不删除校验来冒充受支持安装。

准备后可运行离线真实 SDK 测试：

```powershell
npx vitest run tests/dsh-runtime.test.ts tests/dsh-protocol.test.ts tests/dsh-setup.test.ts
```

真实 SDK 测试使用本地合成模型服务；运行时未准备时部分测试会明确跳过。实际聊天另需自行配置兼容模型服务，可能产生 API 费用；API key 不应进入仓库、命令行示例或问题附件。

## 验证边界

```powershell
npm run verify
npm run smoke:goals
```

| 命令 | 验证及副作用边界 |
| --- | --- |
| `npm run verify` | 类型检查、测试、构建；包含隔离窗口测试。某些 SDK / native 测试依赖已准备工件，缺失时会 skip。不是游戏实跑证明。 |
| `npm run smoke:goals` | 隔离 Electron 窗口、合成 IPC 和独立测试 profile，不加载正式主进程或账号配置。 |
| `npm run smoke:chat` | 合成 IPC 的界面测试；会只读哈希少量已有非凭据配置，以核对其未被修改。 |
| `npm run smoke` | 隔离 profile 的桌面集成检查，会加载本机引擎。设置 `GAMEPILOT_SMOKE_ADB` 和 `GAMEPILOT_SMOKE_ADDRESS` 后还会连接设备及截图，不能一概当作无设备测试。 |
| `npm run smoke:planner` | 默认使用合成规划结果；附加模型或配置参数会改变数据来源，运行前阅读脚本。 |
| `npm run smoke:dsh-live` | 读取已配置模型及记录，调用真实模型。可能上传受限上下文并计费，不是离线 smoke。 |
| `npm start` / `npm run dev` | 正式应用入口，使用当前用户数据；已有自动化配置可能触发任务。 |

需要查看正式 App 时先理解其配置和调度行为。不要把普通启动当成隔离测试，也不要用重复执行未知请求来验证修复。

## 打包状态

`package:portable` 脚本保留在源码中，但不是本次公共发行承诺。它要求完整的 DSH、MaaCore、OCR、游戏模板及发布文档；纯源码快照可能缺少历史私有打包输入，不能假定直接成功。脚本还会按安全保留规则检查旧发行目录。公开二进制发布前，需要补齐版本匹配的许可、来源、对应源码和干净环境验证，详见 [第三方说明](third-party-notices.md)。
