# GamePilot 本机 CLI 与 MCP

CLI 和 MCP 连接已经运行的 GamePilot App。设备执行、结果账本、调度、身份核验和续跑准入都由该 App 的现有服务处理；这些脚本不实例化执行器，也不读取模型配置或游戏密钥。

Windows 使用随机名称的 named pipe，其他平台使用 profile 内的 Unix socket，没有 TCP 监听。默认 profile 为用户目录下的 `.gamepilot`；隔离 profile 可通过 `--profile-dir` 显式选择。App 将随机本机访问 token 写入该 profile 的 `agent-control.json`，关闭服务时只删除当前 host 的连接文件。该文件不是模型密钥，不要作为普通回执导出。Unix 文件/socket 权限为 `0600`；Windows 使用当前 profile 的文件访问权限。

先启动 App，再从项目目录运行：

```powershell
node scripts/agent/control.mjs status
node scripts/agent/control.mjs capabilities
node scripts/agent/control.mjs --profile-dir "D:\smoke-profile" status
```

0.14.37起，命令预览使用 `status.result.selectedSessionId`，并核对它确实对应同一回执的 `chatSessions[].id`。两者来自一次聊天快照；字段缺失或为空时先在App创建/选择会话，不要猜第一项，也不要自动切换。读取之后用户切换会话仍会被原执行校验拒绝。将 JSON 参数保存到本机文件：

```json
{ "sessionId": "当前会话编号", "text": "运行保存的日常" }
```

```powershell
node scripts/agent/control.mjs command-review --params-file review-input.json
```

检查宿主返回的 `summary`、`reviewId` 和 `revision` 后，显式提交确认参数：

```json
{ "sessionId": "当前会话编号", "reviewId": "宿主返回的预览编号", "revision": 1 }
```

```powershell
node scripts/agent/control.mjs command-confirm --params-file confirm-input.json --request-id local-confirm-001
```

会话编号、预览编号和版本必须来自当前宿主回执，示例文字不能直接作为实际编号。最终是否受理由宿主重新核验当前会话、原请求、配置、设备与账号证据。返回 `submitted` 只表示受理；任务是否成功须查看宿主事件与账本。模型解释、访问 token 和 MCP 工具提示都不是游戏执行结果或额外授权。

`stop` 提供 `requestId` 时只能停止当前选中会话所属的精确请求；省略 `requestId` 表示显式紧急停止全部任务，可能影响其他会话和定时任务。所有调用仍要求当前选中会话，旧会话拒绝控制。MCP 工具说明也明确这一区别。

若宿主预览的 `needsAcknowledgement:true`，必须先现场核对失败处和剩余步骤，再在确认参数中显式设置 `acknowledgePartial:true`。这是可选布尔字段，缺失或 `false` 不满足该预览的确认条件，字符串 `"true"` 也无效。它不授权重购、重跑完成项或重发未知原生提交；这些情况仍由宿主拦截。常规完整日常预览不自动附加这个字段。

| 方法              | 参数                                                           | 作用                              |
| ----------------- | -------------------------------------------------------------- | --------------------------------- |
| `status`          | `{}`                                                           | 公开会话与执行状态                |
| `capabilities`    | `{}`                                                           | 宿主当前能力                      |
| `events`          | `afterSeq`，可选 `limit`、`requestId`                          | 游标补发事件，`limit` 为 1–100    |
| `command-review`  | `sessionId`、`text`                                            | 宿主命令预览，文本最多 12000 字符 |
| `command-confirm` | `sessionId`、`reviewId`、`revision`，可选 `acknowledgePartial` | 确认已有宿主预览                  |
| `stop`            | `sessionId`，可选 `requestId`                                  | 请求宿主停止当前匹配执行          |
| `resume-review`   | `sessionId`、`requestId`                                       | 原请求剩余任务预览                |
| `resume-confirm`  | `sessionId`、`reviewId`、`revision`，可选 `acknowledgePartial` | 确认已有续跑预览                  |

每个 socket 连接只接受一个 JSON 请求。请求最多 64 KiB，公开响应最多 256 KiB，默认服务等待上限 5 秒。普通方法最多 16 个并发处理；`stop` 在宿主与 MCP 各保留独立的 4 个并发槽，普通方法占满时仍可停止。未经验证的参数、未知方法和额外字段会在进入宿主前拒绝。公开响应剔除 UID、密钥、token、凭据、路径等私密字段；宿主 handlers 应提供已经脱敏的事实摘要。

宿主参数验证、CLI 与 MCP 工具定义共同读取 `packages/protocol/local-control-schema.json`，避免确认字段或白名单出现不同版本。单独分发脚本时须同时保留该 JSON 文件和 `scripts/agent/local-control-client.mjs` 的相对目录结构；脚本要求支持 JSON import attributes 的 Node.js 22.12 或更新版本。

修改方法的请求编号在该 host 生命周期内绑定方法与参数。相同编号和相同参数只读取缓存回执，改变参数会被拒绝；普通修改方法与 `stop` 各自最多保存 1024 个请求，普通缓存满不会阻断停止。达到自身上限后应使用 App。客户端不会自动重连或重新提交。超时且 `outcomeUnknown:true`、连接中断或 `REQUEST_IN_PROGRESS` 时，先在 App 核对；显式重复同一 `--request-id` 只能查询同一 host 的缓存回执。host 重启后 transport 缓存不跨进程，宿主仍按已保存的 review/submitted 状态拒绝不确定操作重发。

MCP 使用标准 stdio JSON-RPC，支持 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call` 和取消等待通知，协商版本为 `2025-06-18`。只公布上表八个工具，工具名为 `gamepilot_` 加方法名中的连字符改下划线。MCP 取消通知仅取消等待回执；停止游戏必须显式调用匹配会话的 `gamepilot_stop`。它不提供 shell、任意文件、任意网络、通用坐标或资源购买工具。

MCP 客户端配置示例，使用实际项目绝对路径替换参数：

```json
{
  "mcpServers": {
    "gamepilot": {
      "command": "node",
      "args": ["D:/Projects/GamePilot/scripts/agent/mcp.mjs"]
    }
  }
}
```

协议依据：[MCP 生命周期与版本协商](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[工具列表与调用](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。本实现是受限工具服务器，不声明 MCP 全部可选能力，也不宣称真实游戏或外部模型已通过验收。

验证：`npm test -- tests/local-control.test.ts tests/local-control-cli.test.ts` 使用真实本机 socket 与 Node 子进程，覆盖鉴权、输入白名单、大小/超时、重复确认、未知提交、退出清理、CLI 连接错误和 MCP 生命周期/工具 schema。测试使用注入的宿主 handlers，不运行游戏。
