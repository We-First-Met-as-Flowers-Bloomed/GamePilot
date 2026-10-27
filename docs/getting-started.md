# 开发与准备指南

本指南对应 0.18.8 公开源码。固定前提为 Windows x64、Node 22.18.0、npm 10.9.3、.NET SDK 8.0.400。

```powershell
npm ci
npm run setup:electron
npm run setup:maacore
npm run setup:ocr
npm run typecheck
npm test -- --maxWorkers=4
npm run build
```

三个准备命令安装 Electron、校验固定 MaaCore v6.20.1 归档及 OCR 模型。构建生成前端和独立桥接，并清理旧版本生成的引擎副本。`npm run verify` 依次做类型检查、测试和构建。

## 识别资源

源码不包含游戏截图与识别模板。阴阳师需与当前客户端匹配的素材，名称和调用区域以 `games/onmyoji` 当前代码和 `scripts/template-guide.mjs` 只读清单为准；不要放空文件或任意同名图片代替。

`node scripts/setup-all.mjs --check --public --json` 检查完整本地前提。缺少模板会明确返回缺失；应保留原始检查结果，将个人素材准备与可获得组件/代码验证分开。

## 私有 DSH

AI 的独立运行时使用 `integrations/deepseek-harness/runtime` 中固定版本的包、Node 工件指纹与锁文件。仓库只包含适配代码和依赖声明，不包含私有工件、凭据或会话。

```powershell
npm run setup:dsh -- --node "<匹配指纹的node.exe>" --node-license "<对应LICENSE>"
node scripts/setup-all.mjs --check --private --json
```

没有提供私有工件时，其运行时测试会明确跳过，不计为通过。

## 验证边界

- `npm run preview`：浏览器预览，无设备控制。
- `npm run smoke:chat -- --a11y`：隔离 Electron/React 与合成 IPC，不运行游戏。
- `npm run smoke`：独立数据的桌面/演练链，需要相应本机依赖。
- `npm start` / `npm run dev`：普通 App，已有内部定时可能生效。

App“每日任务”页按账号保存时间、星期和步骤。原始结果、续跑与设备锁由同一宿主管理；CLI 兼容入口只提交保存的计划，不接受任意设备和步骤覆盖。准备检查、离线测试和真实游戏能力分别验收。
