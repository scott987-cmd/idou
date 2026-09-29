# 用真实飞书账号把 i豆 跑起来

这份文档只有一个目的：让你从零走到「打开应用、用飞书登录、开始干活」。
需要你在飞书开放平台做的事都集中在第 1 步，其余都由 `npm run preflight` 和 `npm start` 检查和完成。

**不想先配飞书也能用。** 部署文件里只填 `MINIMAX_CONFIG_FILE`（或者下文「对话模型换成 GLM-5.3」那几项）、其余留空，就是本机模式：
`npm start` 直接可用编程任务与工作任务，飞书文档、消息、云盘保持关闭。
需要这些业务功能时，再往同一个文件里补上下面的自建应用信息即可，不用重来。

**关于密钥的两条硬规则。** 应用密钥（App Secret）和模型密钥（MiniMax 的，或 LiteLLM 的）只写进你本机一个 0600 的文件，
不要粘贴到聊天里、不要提交进仓库。应用启动时只把它交给控制面进程，不会进入桌面端、内置 CLI 或任何日志。
`preflight` 和启动日志都不会打印这两个值。

## 1. 你需要在飞书开放平台做的事

到 [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**，然后：

**a. 注册重定向 URL。** 在「安全设置 → 重定向 URL」里，填入 `preflight` 打印给你的那一行，
本机默认是：

```text
http://127.0.0.1:3041/auth/feishu/callback
```

必须逐字一致。改了端口就要同时改 `IDOU_PUBLIC_URL` 和这里。

**b. 开通权限。** 「权限管理 → 批量开通权限」支持导入 JSON，直接用仓库里生成好的：

```bash
npm run scopes > /tmp/feishu-scopes.json   # stdout 是可导入的 JSON，stderr 是用途对照表
```

也可以直接用已生成的 [`docs/feishu-scopes.json`](feishu-scopes.json)。这是「全量目录」：
这个应用可能用到的所有权限。其中只有五项来自源码常量，其余是脚本里的字面量，
所以它**不是**控制面申请范围的投影，别把它当成不会漂移的那一份。

要拿到「这套部署下次登录真正会申请的那一份」，把部署文件传进去：

```
npm run scopes -- /绝对路径/idou.env > /tmp/feishu-scopes.json
```

这一份和控制面构造授权链接用的是同一个函数（`feishuLoginScopes`），照它去控制台开就不会少。
全量目录的用途对照如下：

| 你要用的功能 | 需要开通的能力 |
| --- | --- |
| 登录与身份（必需） | 获取用户基本信息；文档协作者权限校验（`docs:permission.member:auth`） |
| 定时任务解析知识库链接 | 查看知识库节点（`wiki:wiki:readonly`）；仅在创建任务时把 Wiki 节点固定到底层文档 token |
| 读飞书文档 | 查看云文档（`docx:document:readonly`） |
| 按关键词搜文档 | 搜索云文档（`search:docs:read`） |
| 单段文档修改 | 编辑云文档（`docx:document`） |
| 发消息 / 回复消息 | 读写消息（`im:message`）、以用户身份发送消息（`im:message.send_as_user`） |
| 选会话与群（发消息前置） | 获取群信息（`im:chat:read`）、获取群成员（`im:chat.members:read`） |
| 读会话消息 | 读取消息（`im:message:readonly`） |
| 按姓名选私聊收件人 | 搜索用户（`contact:user:search`） |
| 云盘上传与下载 | 云空间文件元数据（`drive:drive.metadata:readonly`）、上传（`drive:file:upload`）、下载（`drive:file:download`） |
| 读会话消息（以用户身份） | 以用户身份获取群组消息（`im:message.group_msg:get_as_user`）、单聊消息（`im:message.p2p_msg:get_as_user`） |
| 读写电子表格 | `sheets:spreadsheet:read`、`sheets:spreadsheet:write_only`、`sheets:spreadsheet.meta:read` |
| 读写多维表格 | `base:app:read`、`base:table:read`、`base:field:read`、`base:record:read`、`base:record:create`、`base:record:update` |
| 读日程与空闲 | `calendar:calendar:read`、`calendar:calendar.event:read`、`calendar:calendar.free_busy:read` |
| 建改日程、回复邀请 | `calendar:calendar.event:create`、`calendar:calendar.event:update`、`calendar:calendar.event:reply` |
| 读任务 | `task:task:read`、`task:tasklist:read` |
| 建改、完成任务 | `task:task:write` |
| 删除日程、删除多维表格记录（需开启 `cli.delete`，每次单独确认） | `calendar:calendar.event:delete`、`base:record:delete` |
| 知识库包读取（可选） | `space:document:retrieve`、`drive:file:download` |
| 独立 CLI 身份核验（**仅未开桥接时**） | 获取用户 employee_id（`contact:user.employee_id:readonly`） |

开了 `FEISHU_CLI_BRIDGE_ENABLED=1` 的部署永远用不到最后一项：它唯一的调用方只在未开桥接时才会被构造出来，
开了也是白开。`npm run scopes -- <部署文件>` 生成的那份会自动把它去掉。

启用 `IDOU_SCHEDULED_TASKS=1` 时，下次登录还会申请 `wiki:wiki:readonly`。它只用于创建
任务时解析 Wiki 节点，不读取正文；已有登录不会自动获得新权限，开通权限后需要重新登录一次。

只开「读飞书文档」也能用：少开的权限只会让对应动作不可用，不影响其余部分。

没有 `search:docs:read` 时，「文件与协作」里只能粘链接；开通后同一个输入框就能按标题
关键词搜索自己的飞书文档，点结果直接打开。这一项是实测补上的：搜索请求会被飞书以
99991679 拒绝并点名 `search:docs:read`，控制台里对应「搜索云文档」。

消息相关的四行也是实测补上的。只给 `im:message` 时，飞书会以 99991679 拒绝会话列表和
群搜索，并在错误里点名 `im:chat:readonly`、`im:chat`、`im:chat.group_info:readonly`、
`im:chat:read` 四选一；`im:chat:read` 同时覆盖发送前的群资料校验，所以清单里只列它一个。
控制台里没开这四项时，授权页会直接停在「当前应用权限不足」，并按中文名逐条列出来：

| 授权页上的中文名 | 标识 |
| --- | --- |
| 搜索云文档 | `search:docs:read` |
| 搜索用户 | `contact:user:search` |
| 查看群成员 | `im:chat.members:read` |
| 查看群信息 | `im:chat:read` |
| 获取单聊、群组消息 | `im:message:readonly` |

把你实际开通的那几个标识，逗号分隔写进部署配置的 `FEISHU_CLI_SCOPES`。控制台开通了
但配置里没写，等于没开；配置里写了控制台没开，授权页会直接拒绝，两边必须一致。

**权限之外还有两个开关。**

一是机器人能力。「会话列表」用的 `im/v1/chats` 接口要求应用本身具备机器人能力，即使调用用的
是用户身份。没开时飞书返回 `232025 Bot ability is not activated`，与 scope 无关。在开发者后台的
「应用能力」里添加机器人即可；只用文档、搜索、云盘时不需要它。

二是 `im/v1/messages` 的 `230027 user_unauthorized`，**原因已定位：缺两项权限**。

以用户身份读会话历史，`im:message:readonly` 并不够。飞书对这个接口按会话类型另设了两项权限，
少任何一项，对应类型的会话都会返回 `230027`：

| 控制台名称 | scope | 覆盖 |
|---|---|---|
| 以用户身份获取群组消息 | `im:message.group_msg:get_as_user` | 群聊历史 |
| 以用户身份获取单聊消息 | `im:message.p2p_msg:get_as_user` | 单聊历史 |

怎么确认的：拿一个**同租户、同接口、同一个群**但额外持有这两项权限的 CLI 身份去读，一次通过；
本应用的身份缺这两项，同一个群返回 `230027`。两边其余 IM 权限完全一致，差别只有这两项。

早先这里写过「不是 scope」，那个判断是错的：当时只核对了**已申报**的权限都拿到了授权，
没有反过来问**是否还需要别的权限**。授权页确认 `im:message:readonly` 到手，并不代表它够用。

补的办法：在开发者后台「权限管理」勾上这两项（都选**用户身份**），重新发布版本，然后让用户
重新授权一次；同时把它们加进部署配置的 `FEISHU_CLI_SCOPES`，两边少一个都会失败。
`npm run preflight` 会打印本次将要申请的完整范围，可以直接对照。只用文档、搜索、云盘时不受影响。

2026-09-13 真机复核：部署配置里带上这两项、控制台开通并重新授权之后，同一个应用身份读内部测试群 `ces` 的历史成功（30 条），不再返回 `230027`；经应用内确认卡片发出一条带文档链接和附言的群消息，飞书返回回执，并在群历史里按消息 ID 读回；再对这条消息发出一条引用回复，同样回执并读回。两张卡片都由用户本人点击确认。
不用猜：`npm run preflight` 会打印本次将要申请的完整范围，登录时如果租户少授权了哪一个，
控制面会在 stderr 直接指名，例如 `飞书未授予所需权限：docx:document`。

**c. 记下租户 key。** 「凭证与基础信息」页可以看到；也可以先随便填一个值启动，
第一次登录失败时控制面会提示租户不在允许列表，那条日志里就有真实的租户 key。

**d. 发布可用范围。** 把应用发布给至少你自己可用，否则授权页会拒绝。

## 2. 填一个部署配置文件

把仓库里的 `.idou.deployment.example.env` 复制到仓库**外面**的一个绝对路径，例如
`~/.idou/idou.env`，填好后收紧权限：

```bash
mkdir -p ~/.idou && cp .idou.deployment.example.env ~/.idou/idou.env && chmod 600 ~/.idou/idou.env
```

必填的是 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOWED_TENANTS`、`FEISHU_CLI_SCOPES`
和模型密钥。模型密钥二选一：`MINIMAX_CONFIG_FILE` 指向你现有数字人项目那个 `region: "cn"`
的配置文件绝对路径，本应用只读取其中的 `api_key`，不复制、不改写、不打印；或者用
`MINIMAX_API_KEY` 直接写密钥本身。两个都写会被拒绝。

### 对话模型换成 GLM-5.3（经本机 LiteLLM）

默认的对话模型是 MiniMax-M3，什么都不加就是它。想改用 GLM-5.3（火山方舟提供，经控制面这台机器上的
LiteLLM 代理转发），在同一个部署文件里加：

```text
IDOU_MODEL_PROVIDER=litellm
IDOU_LITELLM_BASE_URL=http://127.0.0.1:4000
IDOU_LITELLM_MODEL=volc-coding
IDOU_LITELLM_KEY_FILE=/绝对路径/litellm/.env
```

- **地址只能是本机回环。** `IDOU_LITELLM_BASE_URL` 只接受 `http://127.0.0.1:端口` 或 `http://[::1]:端口`，
  不接受 `localhost`、其他主机名、https、路径、查询或账号。不填就是 `http://127.0.0.1:4000`。
  这样密钥只可能发给这台机器上的进程。
- **模型组名。** `IDOU_LITELLM_MODEL` 是 LiteLLM 里对应 GLM-5.3 的模型组，默认 `volc-coding`。
  桌面端和 Codex 看到的始终是 `GLM-5.3`，模型组名只留在服务端。
- **密钥二选一。** `IDOU_LITELLM_KEY_FILE` 直接指向 LiteLLM 自己那份 `.env` 的绝对路径，本应用只读取
  其中的 `LITELLM_MASTER_KEY`（或者你专门为本应用建的 `IDOU_LITELLM_API_KEY`），不复制、不改写、不打印；
  也可以是只有一行密钥的文件。文件不能是符号链接、不超过 64KB，建议 `chmod 600`（`preflight` 发现别人可读会提醒）。
  或者用 `IDOU_LITELLM_API_KEY` 直接写密钥本身，写了就优先用它。
- **密钥不出服务端。** LiteLLM 的密钥只交给控制面进程，不会进入桌面端、Codex、内置 CLI、日志，
  也不会出现在 `preflight` 的输出或 `/healthz` 里。同事用 `--connect` 加入时什么都不用改：
  桌面端会从控制面的 `/healthz` 得知当前是 GLM-5.3。
- **图片与视频仍然走 MiniMax。** 换了对话模型，图片、视频（和语音）生成还是用 MiniMax 自己的密钥。
  开着 `IDOU_MEDIA_ENABLED=1` 又要生成图片视频，就把 `MINIMAX_CONFIG_FILE`（或 `MINIMAX_API_KEY`）留着；
  不留，控制面照常启动（stderr 会写明图片与视频不可用），生成图片或视频的请求会被服务端以
  `503 media_provider_not_configured` 拒绝，桌面端显示为「媒体服务暂不可用（HTTP 503）」。

`npm run preflight` 会按服务端完全相同的方式加载这些设置，指出哪一项不对（只说设置名，不回显内容），
并在不带任何密钥的前提下访问一次 LiteLLM 的 `/health/liveliness`，告诉你代理现在是否在线。
代理没起来不会挡住启动，只是对话要等它起来才能用。

写入动作默认全关。要开哪几个就写进 `FEISHU_CLI_WRITE_ACTIONS`，可选值：

```text
document.inline-replace,document.create,document.append,cli.write,message.send,message.reply,drive.upload,drive.upload-chunked
```

| 动作 | 谁用 | 能做什么 |
|---|---|---|
| `document.inline-replace` | 界面里的选区改写 | 全文唯一匹配的一处替换，写后读回核验 |
| `document.create` | Agent | 用 Markdown 新建一篇文档 |
| `document.append` | Agent | 在文档末尾追加 |
| `cli.write` | Agent | 电子表格、多维表格记录、按块改文档 |
| `message.send` / `message.reply` | 界面 | 发消息 / 回消息 |
| `drive.upload` | 界面与媒体交付 | 上传单个文件到云盘（20 MB 以内） |
| `drive.upload-chunked` | 界面与媒体交付 | 上传 20–100 MB 的文件：分片逐块核对，字节摘要对上才放行最后一步；需与 `drive.upload` 同时开启。它沿用 `drive.upload` 的能力位，改完重启控制面即可，不用重新登录 |

`cli.write` 用到电子表格和多维表格时，还要在控制台补开这几项（都选**用户身份**），
否则飞书会以 400 权限拒绝——文档相关的动作用现有 `docx:document` 就够，不受影响：

| 用途 | scope |
|---|---|
| 读写电子表格 | `sheets:spreadsheet:read`、`sheets:spreadsheet:write_only`、`sheets:spreadsheet.meta:read` |
| 读写多维表格记录 | `base:app:read`、`base:table:read`、`base:field:read`、`base:record:read`、`base:record:create`、`base:record:update` |

这几项是对照同租户内可以正常写入的 CLI 身份（`lark-cli auth status` 会打印它的完整已授权清单）
做差集得出来的，不是一次一次试出来的——飞书一次只报一个缺的，开完 `base:table:read`
它立刻改口报 `base:app:read`，靠报错逐个补会耗掉好几轮。

注意 `bitable/v1/*` 和 `base/v3/*` 是两套独立的权限族。这里走的是 `base/v3`，
只要 `base:*`；`bitable:app*` 对它不起作用，不用开。

2026-09-11 已在真实租户上跑通并独立回读核对：多维表格读 / 新增记录 / 改记录、电子表格读 / 写。

**上传到云盘还需要一份配额配置。** `drive.upload` 开了、权限也开了，上传仍然会被拒绝，
直到服务端配置了 `IDOU_DRIVE_CONFIG_FILE`：它把每个租户绑定到一个受管文件夹和一个字节上限，
保存生成的图片视频也走同一份配额。格式见 [drive-budget.md](drive-budget.md)，`npm run preflight`
会在缺这一项时直接说出来。2026-09-11 在真实租户上用收窄后的 `drive:file:upload` +
`drive:drive.metadata:readonly` 上传成功，并用另一个身份从目标文件夹读回核对。

`cli.write` 是一条通用通道：Agent 写一条普通的 lark-cli 命令，应用先用 `--dry-run`
问 CLI 这条命令到底要发什么请求，把那个请求原样给用户看，确认后签发的一次性许可
**只绑定那一个请求**（方法、路径、请求体摘要）。允许写入的范围是白名单：
新建文档、按块改文档、写电子表格、新增/更新多维表格记录。删除、改权限、
转移归属、密级标签一律不在其中，`api` 直连端点也不接受。

每个动作都要求对应的 scope 已在第 1 步开通。没写进这个列表的动作，
即使 scope 给了也一样拒绝，桌面端会在点击时直接说明未启用。

另外两个默认关闭、按需打开的开关：

| 设置 | 打开之后 |
| --- | --- |
| `IDOU_MEDIA_ENABLED=1` | 桌面端的「创作图片或视频」才可用。不开时服务端直接拒绝这条路径。每次生成都是一次真实付费调用，图片便宜，视频明显更贵。 |
| `FEISHU_SESSION_RENEWAL_ENABLED=1` | 会话在到期前 2 分钟自动续一次，不用每 15 分钟重新登录。总时长仍不超过本次飞书授权的有效期，续期失败会停在设置页并写明原因。 |

## 3. 自检并启动

```bash
export IDOU_DEPLOYMENT_FILE=~/.idou/idou.env
npm run preflight
```

它会逐项告诉你还差什么，并打印两个你需要拿去注册的值：回调地址和申请的授权范围。
全部 OK 之后：

```bash
npm start
```

控制面只监听 `127.0.0.1`，桌面端随后自动启动并指向它。
在应用里进入「设置 → 飞书账号 → 使用飞书登录」，系统浏览器会打开授权页；
授权完成后回到应用点「已完成授权，检查结果」，核对账号无误再点「确认账号并进入」。

## 3b. 团队共用一套（推荐）

应用是租户内共享的，所以**只需要一个人配置**。密钥只留在那个人机器上的部署文件里，
其他人什么都不用配，各自用自己的飞书账号登录，任务和数据按账号分开保存。

由你（管理员）跑控制面：

```bash
npm start -- --server-only
```

同租户的同事只需要一条命令，不需要部署文件、不需要应用密钥、不需要模型密钥：

```bash
npm start -- --connect https://你的控制面地址
```

同事跨机器访问时，`IDOU_PUBLIC_URL` 必须是 HTTPS 域名并在前面挂一层 TLS 反向代理：
控制面本身只监听 `127.0.0.1`，不会直接暴露到网络上。仅本机试用时用 `http://127.0.0.1:3041` 即可。
重定向 URL 要与最终对外地址一致。

想把控制面和桌面分开跑：

```bash
npm start -- --server-only          # 这台机器只跑控制面
IDOU_SERVER_URL=http://127.0.0.1:3041 npm run desktop   # 另一台跑桌面
```

## 4. 登录之后能做什么

登录成功后，「设置 → 飞书账号」用大白话写明本次登录能做什么，例如
**修改文档、发送消息、上传到云盘之前，都会先请你确认，你点了才执行。**
管理员没开的写入会写成「暂未开放」；一项都没开时写「目前只读，不会改动你的飞书内容」。
写入始终需要两层同意：应用弹出原生确认框，你确认之后控制面才签发一张绑定了目标、版本和内容摘要的一次性许可。
许可用一次即失效，改一个字都会被拒。

## 5. 出问题时先看哪里

| 现象 | 原因与处理 |
| --- | --- |
| 授权页报重定向不匹配 | 第 1 步 a 的 URL 与 `IDOU_PUBLIC_URL` 不一致 |
| 回到应用提示登录未完成 | 看控制面 stderr，它会指名缺哪个 scope 或租户不在允许列表 |
| 设置里显示「目前只读」或某项「暂未开放」 | `FEISHU_CLI_WRITE_ACTIONS` 为空或缺这一项，或对应 scope 未开通 |
| 点写入提示未启用 | 该动作不在 `FEISHU_CLI_WRITE_ACTIONS` 里 |
| 云盘上传报分片未开放 | 文件超过 20 MiB，当前桥接只支持单次上传 |
| 启动报端口被占用 | 改 `IDOU_PORT`，并同步 `IDOU_PUBLIC_URL` 和重定向 URL |
| 用 GLM-5.3 时对话报 `provider_request_failed` 或 `provider_unavailable` | 本机 LiteLLM 没起来或模型组名不对：看 `preflight` 的 `litellm` 一行，核对 `IDOU_LITELLM_MODEL` |
| 用 GLM-5.3 时生成图片视频报「媒体服务暂不可用（HTTP 503）」 | 图片与视频仍走 MiniMax 但没配它的密钥（控制面启动时 stderr 有写）：补上 `MINIMAX_CONFIG_FILE` 或 `MINIMAX_API_KEY` 后重启 |

## 6. 这套配置目前的边界

会话最长 15 分钟，到期需重新登录。两个设置会改变这条边界：
`FEISHU_SESSION_RENEWAL_ENABLED=1` 开启在线续期，但不超过本次飞书授权的有效期；
在它之上再设 `FEISHU_LONG_SESSION_DAYS=1..30`，登录会额外申请 `offline_access`
并保存刷新凭据，会话就**可以超过**飞书访问令牌的有效期，最长到设定的天数。
`offline_access` 不是控制台里的权限项，不用勾。
控制面状态在进程内存里，重启即清空，尚不是分布式生产鉴权服务。
桌面端可以用 `npm run package:mac` 在本机打出签名的 i豆.app，但那是开发证书签名、未公证的本机构建，还不是可分发的安装包。
真实 SaaS OAuth 与 API 的联调验收要等你完成上面的步骤后第一次真机跑通，
在那之前所有证据都来自合成上游。
