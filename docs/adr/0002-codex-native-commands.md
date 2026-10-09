# ADR 0002：Codex 自己的命令交给 Codex 自己的界面

状态：提议（2026-10-06），未实施

## 背景

编程任务的底层是 Codex（ADR 0001），但 Codex 的斜杠命令不在 app-server 里，而在它的终端界面（`codex-rs/tui`）里。app-server 协议没有「列出命令」或「执行某条命令」的方法，图形界面要支持一条命令，只能对着它背后的协议方法再写一遍。

- Codex 0.157.0 有 58 个面向用户的斜杠命令，编程任务支持其中 9 个（`/undo /compact /diff /review /init /new /permissions /model /status`），另有十来个在界面别处有对应（改名、删除、继续、`@` 文件、技能、连接器……）。
- 命令每个版本都在变：0.157.0 新增了 `/goal`、`/side`、`/worktree`、`/hooks`、`/debug-config` 等，同时去掉了 `/undo`；app-server 也去掉了 `thread/rollback`。
- 照现在的做法，每一条新命令都要改代码、发版本。

目标：Codex 新增的命令，不改代码就能在编程任务里用；企业的约束对这些命令同样生效。

## 实测（2026-10-06，Codex 0.157.0，本机，假模型，不联网）

1. `codex app-server --listen ws://127.0.0.1:端口`（或 `unix://路径`）可以同时接多个客户端。客户端 A 开会话并跑完一轮，客户端 B `thread/resume` 同一个会话，之后这一轮的每一步 B 都实时收到。
2. 一轮里 Codex 要审批时，请求**同时发给所有挂在这个会话上的客户端**；B 回答之后 A 收到 `serverRequest/resolved`，命令照常执行，两边都收到 `turn/completed`。
3. 真正的 Codex 终端界面 `codex resume <会话> --remote ws://…` 连上产品起的 app-server，显示这个会话，`/status` 正常，输入 `/` 列出完整的 58 个命令；`/quit` 只是断开（「Any running work continues」）。
4. `--remote unix://路径` 同样能连；socket 文件是 0600。app-server 没配模型提供方时，终端会要求登录 OpenAI——产品起 app-server 时本来就配了自己的网关。
5. 还没跑过第一轮的空会话不能被另一个客户端 `resume`（「no rollout found」）：会话记录在第一轮开始时才落盘。
6. 当前 `configRequirements/read` 返回 `null`：产品没有给 Codex 设任何企业管控项。

## 决定

### 一、原生 Codex 终端：命令零代码

- 每个编程任务在需要时起一个常驻的 app-server，监听账号数据目录里的私有 unix socket（目录 0700、socket 0600）。产品自己的客户端和终端都连它。**不用回环 ws**：同一台电脑上任何进程都能连上并驱动 Codex。
- 编程任务的终端面板（已有的 node-pty 任务终端）里跑随附的 `codex --remote unix://… resume <会话>`，用同一个 `CODEX_HOME`。Codex 现在和以后的所有命令都原样可用，升级 Codex 就有新命令。
- 输入框兜底：`/名字` 既不是产品命令也不是项目命令时，提示「在 Codex 终端里运行 /名字」，打开终端面板并把命令输进去。

### 二、约束放在 Codex 自己那一层：requirements

企业规则写成 Codex 的 requirements，由 Codex 对任何客户端执行。这样新命令再多，也越不过规则，产品不用为每条命令判断：

| 企业规则 | requirements 项 |
|---|---|
| 允许哪些权限档位（管理台「完全访问」「自动」开关） | `allowed_sandbox_modes`、`allowed_approval_policies`、`allowed_permission_profiles` |
| 模型只走 i豆 网关 | `model_provider` / `model_providers` |
| 不把日志发给 OpenAI | `feedback.enabled = false` |
| 不开远程控制、插件市场等 | `allow_remote_control = false`、`feature_requirements` |
| 联网范围 | `network`（域名允许/拒绝） |
| 只允许管理员下发的 hooks | `allow_managed_hooks_only` |

- 下发途径：macOS 用 MDM 配置描述文件（偏好域 `com.openai.codex`，键 `requirements_toml_base64`），这台电脑上的所有 Codex 都受约束，包括嵌在 i豆 里的；服务端定时任务的沙箱镜像里写 `/etc/codex/requirements.toml`。管理台据策略生成这份配置。
- 产品启动 Codex 后读 `configRequirements/read` 和 `config/read`（带层级）：只有实际生效的 requirements 覆盖了管理台策略，原生终端才打开（读不到即视为不满足）；状态对话框列出配置来自哪一层。
- 没有 MDM 的个人或开发环境：原生终端默认关闭，管理台策略「允许 Codex 原生终端」显式打开后才有。

### 三、产品自己的图形命令是数据

`SLASH_COMMANDS` 改成随版本发布的命令目录（数据文件），每条写明：名字、说明、类型（一段提示词 / 一个 app-server 请求 / 在终端里运行 / 产品界面动作）、请求方法和参数模板（`{threadId}`、`{cwd}`、`{args}`）、进行中能不能用、是否要确认。

- 目录能调用的方法限于一份白名单（在升级门禁里审），参数按随附 Codex 生成的协议 schema（`codex app-server generate-json-schema`）校验。
- 运行时再列出动态来源：`skills/list`、项目命令（`.codex/prompts`、`.claude/commands`）、`hooks/list`、MCP 的 prompts。

### 四、升级门禁报告命令和协议的变化

`scripts/upgrade-upstream.js` 从新版本取出斜杠命令清单和 app-server 方法清单，与锁定版本比较，写进升级报告。产品在用的方法被删掉时（例如 `thread/rollback`）门禁失败。

## 前提改动（一次性的代码改动）

1. **Codex 进程的生命周期**：现在每一轮起一个 app-server，这一轮结束就停掉（`task-service.js` `stopClient`）。要改成：终端面板开着或一轮在跑时 app-server 常驻，空闲若干分钟后停。
2. **产品客户端的传输**：从 stdio 改成 unix socket 上的 WebSocket（Node 自带的 WebSocket 不支持 unix socket，需要小的握手实现或 `ws` 依赖）。
3. **审批谁先答**：产品在「完全访问」、记住的规则、MCP 自动放行这几种情况下会自动答复；终端开着时谁先答算谁的。两边都代表本人，可以接受，但产品的自动答复必须仍在 requirements 允许的范围内；收到 `serverRequest/resolved` 时撤下自己的卡片。
4. **空会话**：第一轮之前不能续，终端要在第一轮开始后才打开，或者由终端自己开第一轮。
5. **飞书写入照旧**：写飞书、发消息、删除走的是产品自己的桥和确认卡片，不是 Codex 的审批，终端绕不过去。

## 不做和风险

- 原生终端只给编程任务，工作任务不需要。
- 没有 requirements 时，终端里的 `/permissions` 能越过产品的权限档位，所以默认关闭。
- app-server 的远程连接和多客户端在 Codex 里仍标为实验性，每次升级都要跑契约测试：上面的实测要写成测试（两个客户端同一会话、审批广播、`serverRequest/resolved`、终端 `--remote` 连接）。
- Windows：unix socket 在 Windows 10 起可用，Codex 在 Windows 上的 unix 传输没有实测。
