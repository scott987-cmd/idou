# i豆（idou）

**飞书用户的企业桌面 Agent。** 用你的飞书账号登录，在同一个窗口里发消息、改文档、做网站、查公司知识、写代码。默认每一步对外的动作都先问你；你一授权，它就自己做完。

*i豆 (idou) is a desktop AI agent for people who work in Feishu (Lark). It signs in with your Feishu account, works on your messages, documents, spreadsheets, Bases and Drive with your own permissions, and writes code — asking before anything leaves your machine unless you authorize a task to run on its own. The UI and most docs are in Chinese.*

介绍视频和实测数据见 [项目主页](https://scott987-cmd.github.io/idou/)。

## 能做什么

- **飞书消息**：一句话替你发出去；默认先弹确认卡，你点了才发。
- **飞书文档、电子表格、多维表格**：边看边改，改动核对后写回飞书，写前重读、写后读回。
- **本地文件**：读你电脑上的表格、文档和 PDF，把算好的结果写回原来的文件夹。
- **企业知识**：问公司制度，答案带出处；只查你此刻有权读的资料。
- **文档网站**：说需求，它写好网站并发布；谁能打开由你选。
- **定时任务**：到点自己跑，在隔离的沙箱里只读你授权的资源；报告存进你自己的云空间，也可以按你选好的写进文档、发到群里。
- **编程任务**：基于 Codex 的编程 Agent，逐文件看改动、可撤回；做完自己打开网页检查一遍。
- **图片视频、操作电脑**：说一句就生成；要进哪个应用操作，先问过你。

## 它是怎么搭起来的

```
桌面端（Electron）──会话令牌──> 控制面（Node.js 服务端）──> 飞书开放平台 / 模型服务
    │                              │
    ├─ Codex app-server（Agent 内核）  ├─ 模型网关：模型密钥只在服务端
    └─ 内置 lark-cli（飞书能力）        ├─ 飞书登录、续期、权限核验
                                       └─ 定时任务：gVisor 沙箱 + 出口代理
```

- **Codex 是上游运行时，不是分叉。** 通过 `codex app-server` 接入，Codex 升级 i豆 跟着升级（[ADR 0001](docs/adr/0001-external-upstream-runtimes.md)）。
- **飞书是一个 provider 契约。** 现在的实现是随应用分发、按摘要校验的 `lark-cli`；私有化飞书按另一个 provider 接入（[上游契约](docs/upstream-contracts.md)）。
- **权限跟着飞书走。** 索引里有一篇文档，不等于你能读它：每次查询都按你当前的飞书权限过滤，飞书文档始终是事实源。
- **密钥不下发。** 模型密钥和飞书应用密钥只在服务端；桌面只持有绑定设备的会话和短时、限定范围的 Agent 令牌。
- **对外的动作由人确认。** 写入、发送、删除、启用本机技能都弹确认卡，只有人能点；给一个任务选「完全访问」，就是授权它自己做完（生成视频除外）。

更多见 [架构](docs/architecture.md)、[控制面](docs/control-plane.md)、[编程 Agent](docs/coding-agent.md)、[定时任务](docs/scheduled-tasks.md)。

## 现在的状态

i豆 还在 1.0 之前。维护者的团队每天在飞书 SaaS 上用它：服务端跑在一台 Linux 服务器上，桌面端是 Apple 芯片的 Mac。

- 桌面端目前只打 macOS（Apple 芯片）的包，用开发证书签名、未经 Apple 公证；Linux 上可以开发和跑服务端。
- 飞书只接了 SaaS；私有化飞书的 provider 还没有写。
- 接口、配置项和数据格式在 1.0 之前可能变化，变化会写在 [CHANGELOG](CHANGELOG.md) 里。

## 从源码跑起来

需要：

- Node.js 22.16 以上（见 `.nvmrc`）。
- 内置的飞书 CLI：`lark-cli` 要带 `authsidecar` 标记从源码构建，版本、提交和摘要都钉在 `upstreams.lock.json` 里。需要 Go（锁文件里的 `goVersion`）：

  ```bash
  git clone https://github.com/larksuite/cli ../larksuite-cli
  git -C ../larksuite-cli checkout "$(node -p 'require("./upstreams.lock.json").feishu.inspectedCommit')"
  npm run bundle:feishu -- "$(cd ../larksuite-cli && pwd)"
  ```

  构建产物的 SHA-256 必须等于锁文件里的，否则拒绝放进 `resources/`。
- Codex：锁文件里的版本（`npm install -g @openai/codex@<版本>`），或者用 `IDOU_CODEX_BIN` 指向它。
- 部分测试要 PostgreSQL 16（`initdb`、`pg_ctl`，或用 `IDOU_POSTGRES_BIN` 指向它的 bin 目录）。定时任务的沙箱要 Docker 和 gVisor，只在服务端需要。

然后：

```bash
npm ci
npm run doctor                      # 核对内置 CLI 和 Codex
mkdir -p ~/.idou && printf 'MINIMAX_CONFIG_FILE=/绝对路径/mmx-config.json\n' > ~/.idou/idou.env && chmod 600 ~/.idou/idou.env
export IDOU_DEPLOYMENT_FILE=~/.idou/idou.env
npm run preflight && npm start
```

这会在本机起一个控制面并打开桌面端，编程任务和工作任务马上能用；飞书的文档、消息、云盘等功能要接上一个飞书企业自建应用，按 [用真实飞书账号把 i豆 跑起来](docs/setup-real-feishu.md) 一步步来，`npm run preflight` 会逐项指出还缺什么。对话模型默认 MiniMax-M3，也可以换成经 LiteLLM 的 GLM-5.3 或别的模型服务（[对话模型](docs/chat-models.md)）。

团队共用时只要一个人部署服务端：`npm start -- --server-only`，同事用 `npm start -- --connect <控制面地址>` 加入，各自用飞书账号登录。正式的服务器部署（多副本、PostgreSQL、定时任务沙箱）见 [服务端部署](docs/server-deployment.md)。

### 桌面端的配置

服务端的设置都在部署文件里，逐项说明见 [`.idou.deployment.example.env`](.idou.deployment.example.env)。桌面端（和命令行）另有几项覆盖，环境变量优先；需要时把 [`.idou.example.json`](.idou.example.json) 复制成启动目录下的 `.idou.json`（改名前的 `.mydoubao.json` 照样读）：

| 环境变量 | 作用 |
| --- | --- |
| `IDOU_SERVER_URL` | 连哪个控制面 |
| `IDOU_SESSION_FILE` | 开发用的短时连接文件（服务端 `--dev` 打印的路径），不是模型密钥 |
| `IDOU_CODEX_BIN` | 开发时用哪个 Codex。打包的应用只运行内置的那个，而且每个文件都要和 `upstreams.lock.json` 一致 |
| `IDOU_FEISHU_BIN` | 开发测试时换一个飞书 CLI（绝对路径）。默认是内置的；打包的应用拒绝别的 |
| `IDOU_FEISHU_PROFILE` | 内置 CLI 用哪个配置档 |
| `IDOU_FEISHU_PROVIDER` | 用哪个飞书部署（按名字，从这个版本自带的里选；现在只有默认的 `saas-cli`） |
| `IDOU_SKILL_PUBLIC_KEY_FILE` | 技能中心核验企业签名目录用的公钥 |

运行哪个程序只由环境变量决定：`.idou.json` 是从命令的启动目录读的，那可能是别人的仓库，所以其中的 `binary` 一类设置会被拒绝，而不是照做。

## 测试

```bash
npm run check          # 全部单元和集成测试，不花钱、不连真实飞书
```

- `npm run check` 第一次运行时会下载 Electron 的二进制（Electron 44 起不在 `npm ci` 时下载，而是第一次用到时才下载；并行的测试同时去下载会互相踩到，所以检查一开始就先装好）。
- `npm run check` 在源码检出里按开发模式运行：源码不要求和签名发布一致，但内置的二进制仍按 `upstreams.lock.json` 的摘要核对。发布前维护者用 `npm run check:release` 按签名核对。
- 桌面冒烟（`scripts/smoke-*-desktop.js`）启动真实的 Electron，用合成的飞书和模型；`npm run test:acceptance` 一次跑全部，需要付费模型或真实租户的几条默认跳过，并说明用哪个开关运行。
- 自动化测试和脚本可以停在确认卡片上、也可以点「取消」，但从不替人点「确认」。

## 参与

欢迎提 issue 和 PR，先读 [CONTRIBUTING](CONTRIBUTING.md)；给 AI 编程助手的仓库规则在 [AGENTS.md](AGENTS.md)。安全问题请按 [SECURITY](SECURITY.md) 私下报告，不要开公开 issue。参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 文档

| 主题 | 文档 |
| --- | --- |
| 总体 | [架构](docs/architecture.md) · [上游契约](docs/upstream-contracts.md) · [路线图](docs/roadmap.md) · [ADR 0001](docs/adr/0001-external-upstream-runtimes.md) |
| 部署与运维 | [用真实飞书账号跑起来](docs/setup-real-feishu.md) · [服务端部署](docs/server-deployment.md) · [服务端管理](docs/server-administration.md) · [扩容](docs/scaling-plan.md) · [打包与内置运行时](docs/runtime-packaging.md) · [升级上游](docs/upgrading-upstreams.md) |
| 飞书 | [登录](docs/feishu-login.md) · [CLI 单点登录桥](docs/feishu-cli-bridge.md) · [文档](docs/feishu-document-reader.md) · [电子表格](docs/feishu-sheet-reader.md) · [多维表格](docs/feishu-base.md) · [消息](docs/feishu-chat.md) · [发送](docs/feishu-delivery.md) · [源权限核验](docs/feishu-source-access.md) |
| Agent | [编程 Agent](docs/coding-agent.md) · [对照 Codex 和 Claude Code](docs/coding-task-parity.md) · [对话模型](docs/chat-models.md) · [MCP 连接](docs/mcp-connections.md) · [企业 MCP 代理](docs/enterprise-mcp-broker.md) · [企业技能](docs/enterprise-skills.md) · [浏览器](docs/browser-integration.md) · [图片视频](docs/media.md) |
| 定时任务与网站 | [定时任务](docs/scheduled-tasks.md) · [用表格做网站](docs/table-driven-sites.md) · [企业应用平台](docs/enterprise-app-platform.md) · [云盘额度](docs/drive-budget.md) |
| 企业知识 | [本机知识库](docs/local-wiki.md) · [知识节点协调](docs/wiki-coordinator.md) · [Wiki 包](docs/wiki-bundles.md) · [发布](docs/wiki-publisher.md) · [密钥托管](docs/wiki-key-custody.md) |

## 许可

Apache License 2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。随应用分发的第三方组件及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、`third_party/`。

i豆 是独立项目，与字节跳动、飞书（Lark）、豆包和 OpenAI 没有隶属、背书或赞助关系；这些名称是各自所有者的商标，这里只用来说明本软件和什么配合使用。
