# 服务端部署

这份文档写的是一台 Linux 服务器上的完整服务端：协调副本、两个模型副本、一个执行节点，nginx 在前面，PostgreSQL 放共享状态，定时任务在 gVisor 沙箱里运行。维护者自己的服务器就是这个布局，从 2026-09-22 起一直这样运行。模板都在 `deploy/server/`，照原样装就行；文中 `idou.example.com` 换成你的域名。

只想先跑起来、不需要多副本和定时任务的，看 [用真实飞书账号把 i豆 跑起来](setup-real-feishu.md)：`npm start -- --server-only` 一条命令就是一个可用的控制面。

> **改名之前建的服务器**：产品 2026 年 9 月以前叫「我的豆包」（mydoubao）。那时建的服务器保留所有旧名字：systemd 单元 `mydoubao-*`、账号 `mydoubao`/`mydoubao_worker`、目录 `/opt/mydoubao`、`/etc/mydoubao`、`/home/mydoubao/.mydoubao`、数据库里的 `mydoubao_*` 表、沙箱网络 `mydoubao-egress`，配置里的 `MYDOUBAO_*` 照样生效。代码按库里有没有 `mydoubao_` 表、有没有那个网络来决定用哪套名字，不用迁移。在这样的机器上重装模板时，把名字改回旧的。

## 1. 机器

| 项 | 要求 |
| --- | --- |
| 系统 | Linux，x86_64 或 arm64（签名发布批准的沙箱镜像只有这两种）。维护者用的是 Debian 12 |
| 规模 | 4 核、8 GiB 内存够一个试点团队；容量怎么算见 §8 |
| 软件 | Node.js 22（官方 tarball，装前核对 SHA256）、nginx、PostgreSQL 15 以上、Docker、gVisor（`runsc`，用 gVisor 官方 apt 源，apt 按签名校验） |
| 证书 | 域名的 TLS 证书，放在 `/etc/nginx/tls/`。文档网站和管理台各要一个自己的来源（不同主机名或端口），证书要覆盖它们 |
| 对外 | 443（桌面端和登录回调），开了文档网站再加它的端口。22 只对管理员放行 |

**服务器连不上 Docker Hub 或 GitHub 时**（国内常见），镜像在能连的机器上拉好再传过去：

```
docker pull --platform linux/amd64 <镜像>
docker save <镜像> | gzip | ssh <服务器> 'gunzip | docker load'
```

## 2. 组成

| 部件 | 形态 | 位置 |
| --- | --- | --- |
| nginx | TLS 终结。80 跳转 443；443 上 `/v1/responses` 按令牌前 8 个字符一致性哈希到两个模型副本，其余转给协调副本。关掉代理缓冲，否则流式回答会被截断 | `deploy/server/nginx-idou.conf` → `/etc/nginx/sites-available/idou` |
| 协调副本 | `idou-control-plane.service`，`node bin/server.js --feishu`，监听 127.0.0.1:3041。登录、续期、定时任务的准备与收尾、文档网站、飞书代理都在这里 | `/etc/systemd/system/` |
| 模型副本 | `idou-api@.service`，实例 1、2，`--role api`，只跑模型网关和指标；端口和指标端口在 `api-N.env`（3043/9465、3044/9466） | 同上，`/etc/idou/api-N.env` |
| 执行节点 | `idou-worker@.service`，`--role worker`，从共享库的队列领定时任务，在本机沙箱里运行。独立账号，见 §11 | 同上，`/etc/idou-worker/` |
| 文档网站 | 协调副本里的另一个监听，`IDOU_SITES_PORT`（默认 3042），经 nginx 对外 | `IDOU_SITES_URL` |
| 管理台 | 自己的监听 `IDOU_ADMIN_PORT`（默认 3045）和自己的来源 `IDOU_ADMIN_URL`，必须和文档网站不同源：发布的网页是脚本，同源就能读到管理台。不设就没有管理台 | [server-administration.md](server-administration.md) |
| PostgreSQL | 只监听本机，服务账号经本地套接字按系统身份认证（peer），没有密码。会话等状态加密后才进库，密钥 `IDOU_STATE_KEY_FILE` 不进库 | `postgresql:///idou?host=/var/run/postgresql` |
| LiteLLM（可选） | 对话模型走 GLM 时用，监听 `127.0.0.1:4000` | [chat-models.md](chat-models.md) |
| Docker + gVisor | `/etc/docker/daemon.json` 登记 `runsc`；没有 `/dev/kvm` 时用默认平台 | |
| 沙箱网络 | `docker network create --internal --subnet 172.30.0.0/24 --gateway 172.30.0.1 -o com.docker.network.bridge.name=idou-egr0 idou-egress` | Docker 自己保存 |
| 沙箱防火墙 | `idou-egress-firewall.service`（开机执行）：从 `idou-egr0` 进来的包只放行出口端口，其余丢弃；IPv6 全丢 | `deploy/server/idou-egress-firewall` → `/usr/local/sbin/` |
| 沙箱镜像 | 签名发布批准的那一个，经典镜像存储上按镜像 ID 固定（`IDOU_SANDBOX_IMAGE=sha256:…`，即发布清单里的 `classicId`） | [scheduled-tasks.md](scheduled-tasks.md) |

| 路径 | 内容 | 属主与权限 |
| --- | --- | --- |
| `/opt/idou/releases/<发布号>` | 每个发布一个目录 | root，服务账号不能写 |
| `/opt/idou/app` | 指向当前发布的软链接 | root |
| `/etc/idou/idou.env` | 部署配置（飞书应用密钥、模型密钥在这里） | `root:idou` 0640，目录 0750 |
| `/etc/idou/state.key` | 共享库的封存密钥 | `idou` 0400 |
| `/home/idou/.idou` | 数据目录 | `idou`，目录 700、文件 600 |
| `/etc/idou-worker/` | 执行节点的配置和队列密钥 | `root:idou_worker` 0750 |

## 3. 常用操作

```
systemctl status idou-control-plane idou-api@1 idou-api@2 idou-worker@1
journalctl -u idou-control-plane -o cat -n 50
curl -s https://idou.example.com/healthz
```

### 发布新版本

先在构建机上走完发布流程：签名（新的发布号，永不复用）→ `npm run check:release` → 验收 → 打包。然后在仓库根目录：

```
R=<发布号>
COPYFILE_DISABLE=1 tar --no-mac-metadata -cf - src bin scripts/verify-server-release.js package.json package-lock.json release upstreams.lock.json resources/lark-cli/linux-x64 deploy/server \
  | ssh <服务器> "set -e; D=/opt/idou/releases/$R; mkdir -p \$D; tar -xf - -C \$D; cd \$D;
           npm ci --omit=dev --ignore-scripts --no-audit --no-fund; chown -R root:root \$D; chmod -R go-w \$D;
           sudo -u idou node scripts/verify-server-release.js"
```

`verify-server-release.js` 用控制面自己的办法核对这个发布：签名清单对得上磁盘上的源码，`resources/lark-cli/linux-x64` 的摘要等于清单里固定的，服务账号能执行它。不通过就不要切。

**`resources/lark-cli/linux-x64` 必须一起打包。** 它不在源码里（`.gitignore`），可控制面要用它：定时任务存报告、读回上一次的报告，都走这个内置 CLI。少了它，每次运行都在最后保存报告时失败（`Bundled lark-cli is missing for linux-x64`）。

通过后切软链接，按这个顺序重启：

```
ln -sfn $D /opt/idou/app.new && mv -T /opt/idou/app.new /opt/idou/app
systemctl restart idou-worker@1      # 等手上的运行最多 45 秒
systemctl restart idou-api@1         # 等 curl -s 127.0.0.1:3043/healthz 通了再重启下一个
systemctl restart idou-api@2         # 同上，3044
systemctl restart idou-control-plane
```

- 模型副本一次只重启一个：它停止接新连接后，nginx 把请求转给另一个，正在说的回答最多再等 45 秒。
- 协调副本最后重启。会话、续期凭据和飞书访问授权都在库里，重启后桌面端不用重新登录；进行中的登录、写入确认、MCP 连接、媒体生成会中断，由客户端重新发起。
- 改了 `deploy/server/` 里的文件，照原样装到 `/etc/systemd/system/` 或 `/etc/nginx/sites-available/`，再 `systemctl daemon-reload` 或 `nginx -t && systemctl reload nginx`。
- 部署前看一眼队列里有没有进行中的运行：`sudo -u postgres psql -d idou -At -c "select state, count(*) from idou_run_queue group by 1"`。

**回退**：软链接指回上一个发布目录，按同样顺序重启，数据不动。前提是每次数据变更都「回退安全」：新值先出一版只读，下一版才写。发布说明要求连配置一起退的（比如新版本才认识的配置项），先换回改之前备份的配置。

**服务端不一定跟着桌面升级。** 只有改到服务端加载的代码（`src/control-plane`、`bin/server.js`，以及它们用到的 `src/application`、`src/providers`）时才需要部署。反过来，某个发布如果要求先装新桌面（例如登录协议变了，旧桌面的新登录会收到 `client_update_required`），就先让大家升级桌面，再部署服务端。

**上游（`upstreams.lock.json`）变了，沙箱镜像也要换。** 在构建机上重建镜像（[upgrading-upstreams.md](upgrading-upstreams.md)），签名后传到服务器，确认镜像 ID 等于新发布里对应平台的 `classicId`，再把 `IDOU_SANDBOX_IMAGE` 改成它。

## 4. 从单机搬到服务器

控制面也可以先跑在某台 Mac 上（`npm start`），以后再搬。搬的时候：

1. 停掉原来的控制面，对 SQLite 做一次 checkpoint，两边都跑 `quick_check`。
2. 拷贝数据目录里的：`scheduled-tasks/`（含无人值守授权）、`drive/`、`drive-budget.json`、`model-usage.sqlite`、`model-preferences.json`、`sites/`、`skill-signing.pem`、`skill-public.pem`、`skill-registry.json`。
3. **数据文件里的绝对路径要改**：`drive-budget.json` 记着数据库的绝对路径，不改的话服务第一次启动就报 `EACCES … mkdir '/Users'`。拷完先 `grep -rl /Users` 查一遍。
4. **无人值守授权搬过去就只能用一份。** 飞书刷新令牌只能用一次，两边谁先刷新，另一份就作废。原来那台不要再启动定时任务；要回退，就重新授权。

## 5. 定时任务：生产隔离

部署配置里定时任务相关的几行：

```
IDOU_SCHEDULED_TASKS=1
IDOU_SCHEDULE_UNATTENDED=1
IDOU_SCHEDULED_TASKS_PORT=8444            # 出口代理的端口，和防火墙放行的一致
IDOU_SCHEDULE_BOT_NOTIFY=1
IDOU_SCHEDULE_EXECUTION=pool              # 交给执行节点（§11）
IDOU_SANDBOX_IMAGE=sha256:<classicId>
IDOU_SANDBOX_MODE=production
IDOU_SANDBOX_RUNTIME=runsc
IDOU_SANDBOX_GATEWAY=172.30.0.1           # 出口代理只监听这个地址
```

启动日志里应当有 `Scheduled tasks: on. Sandbox egress listening on 172.30.0.1:8444`，并且**没有** `the sandbox is not ready`。生产核对在每次执行前再做一遍：internal 网络、不经 host-gateway、不是 runc、镜像与锁和签名发布一致。

**只靠 internal 网络不够，这是实测的。** 容器照样能经网关地址连上宿主的 sshd 和 nginx。所以宿主防火墙是这套隔离的一部分，而生产核对看不见它。重装系统、换网桥名、改出口端口时，都要连防火墙一起改。

装好后用一个探针核对，按控制面启动容器的同一组参数（runsc、`idou-egress`、`--user` 服务账号、只读根、0700 运行目录）：容器能读写运行目录；经 TLS 访问 `egress.idou.internal:8444` 得到出口代理的 `404 not_found`；连宿主的 22、443、3041 和公网全部超时。

## 6. 桌面怎么连到服务端

桌面按这个顺序决定连哪个服务端：`IDOU_SERVER_URL` → 启动目录下的 `.idou.json` → 打包时写进去的地址（`IDOU_PACKAGE_SERVER_URL`，[runtime-packaging.md](runtime-packaging.md)）→ 上次登录的服务端。在服务端登录过一次，之后就一直连它。

- 飞书开放平台里要登记两个回调地址：登录用 `https://idou.example.com/auth/feishu/callback`；开了文档网站的访客登录，再加 `<IDOU_SITES_URL>/_auth/callback`。`npm run preflight` 会打印出来。
- 登录会回到发起它的那台电脑：授权后，服务端把浏览器重定向到发起设备在本机回环地址上临时开的端口，带着一次性密钥（[feishu-login.md](feishu-login.md)）。这个密钥在回调响应的 `Location` 头里，别为排查把响应头写进 nginx 访问日志。
- 服务端和桌面之间允许 60 秒的时钟差。服务器要开 NTP。
- 服务端重启后，桌面在运行中用本机凭据原地重新登录，账号、设备和租约都不变；续期失败（包括重启空窗里的 502）也会重连。凭据被飞书拒绝才提示重新登录。

## 7. 安全

- **控制面对网络开放。** 除了 `healthz` 和登录流程本身，所有接口都要会话；443 最好只放行已知的来源。
- **`IDOU_SITES_ALLOW` 在 nginx 后面不起作用。** 站点监听器只认 socket 上的对端地址，回环地址永远放行；经 nginx 转发的请求对端全是 127.0.0.1。要限制谁能打开文档网站，在 nginx 里写 `allow`/`deny`，或者用安全组。
- **服务器上的机密**：`idou.env`（飞书应用密钥、模型密钥）、`state.key`、LiteLLM 的密钥、`skill-signing.pem`，以及 `scheduled-tasks/unattended/`（封装密钥和刷新令牌放在一起：谁能读这个目录，谁就能在授权有效期内操作授权人的飞书账号）。
- **发布签名私钥不在服务器上，也不该放上去。**
- 执行节点之外的进程不该能用 Docker（docker 组等于 root），见 §11。

## 8. 容量、监控与备份

**容量**。以下都在部署配置里设，不设就是默认值：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `IDOU_MODEL_MAX_CONCURRENT` | 8 | 一个进程同时进行的模型请求。按模型账号自己的并发配额来定 |
| `IDOU_MODEL_MAX_CONCURRENT_PER_USER` | 等于上一项 | 一个人同时进行的模型请求（定时任务算在任务主人头上） |
| `IDOU_MODEL_REQUESTS_PER_MINUTE` | 90 | 每个会话每分钟的模型请求 |
| `IDOU_FEISHU_CLI_MAX_CONCURRENT` | 16 | 同时代办的飞书调用 |
| `IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER` | 等于上一项 | 一个人同时代办的飞书调用 |
| `IDOU_SCHEDULE_MAX_CONCURRENT` | 2 | 同时执行的定时任务（每个是一个沙箱容器，最多 1 核 1GB） |
| `IDOU_SCHEDULES_PER_USER` | 50 | 一个人最多的定时任务个数 |
| `IDOU_SCHEDULES_PER_TENANT` | 100000 | 一个企业最多的定时任务个数 |
| `IDOU_SIGNED_IN_MAX` | 200000 | 同时登录的会话。一个人最多 16 个 |
| `IDOU_FEISHU_READS_MAX_CONCURRENT` | 128 | 同时进行的飞书读取与核验。一个人最多 4 个 |
| `IDOU_FEISHU_READS_PER_MINUTE` | 30000 | 每分钟的飞书读取与核验。一个人每分钟最多 100 次（身份核验 120 次） |
| `IDOU_RENEWALS_MAX_CONCURRENT` | 128 | 同时进行的登录续期。一个人最多 4 个 |
| `IDOU_LOGINS_PER_MINUTE` | 1200 | 每分钟新发起的登录 |
| `IDOU_MCP_SESSIONS_MAX` | 1024 | 同时连着的 MCP 会话。一个会话最多 4 个，一个人最多 8 个 |
| `IDOU_MEDIA_JOBS_MAX_CONCURRENT` | 64 | 同时进行的图片、视频生成 |
| `IDOU_MEDIA_PER_HOUR` | 20 | 每小时最多生成的图片和视频（花钱的上限） |
| `IDOU_SPEECH_PER_HOUR` | 400 | 每小时最多生成的语音（同上） |

超出上限的请求立即得到 429，不排队。一个人的份额不能大于整机，配错了服务端启动时按名字报错退出。一个网关进程在 2000 路同时流式回答时正常（`scripts/load-test-control-plane.js`，不含模型供应商），再往上靠多副本（§9）。

**监控**。`IDOU_METRICS_PORT`（协调副本 9464，模型副本 9465/9466，执行节点 9467）：`127.0.0.1:<端口>/metrics`，Prometheus 文本格式，报各项上限和当前占用、因容量被拒的次数、会话数、事件循环延迟、内存和发布号。只监听本机，不经过 nginx，内容只有计数和上限。

**备份**。`bin/backup.js` 由 `idou-backup.timer` 每天 03:30 以 `idou` 身份运行（模板在 `deploy/server/`）：

- 每份备份是 `/home/idou/backups/idou-<时间>/`，目录 0700；只保留最近 14 份。
- SQLite 用 `VACUUM INTO` 做一致快照并通过 `quick_check`（只复制主文件会丢掉 WAL 里的数据，实测过）；其余文件原样复制，保留权限；`backup.json` 记着每个文件的 sha256。
- **备份和数据在同一块盘上**，防误操作和损坏，防不了盘坏。里面有机密（无人值守凭据和旁边的密钥）：要带出这台机器，先加密。
- 数据进了 PostgreSQL（§10）以后，另外用 `pg_dump` 备份数据库。

**从备份恢复**：停协调副本；把数据目录挪到旁边（`mv`，不要删）；`cp -a` 一份备份回来，删掉其中的 `backup.json`，`chown -R idou:idou`；启动。

## 9. 多副本

| 进程 | 端口 | 指标 | 接什么 |
| --- | --- | --- | --- |
| `idou-control-plane`（协调副本） | 3041 | 9464 | 除 `/v1/responses` 以外的一切 |
| `idou-api@1`、`@2`（模型副本） | 3043、3044 | 9465、9466 | 桌面端的 `/v1/responses`，按人分配 |
| `idou-worker@1`（执行节点） | — | 9467 | 从队列领定时任务，在本机沙箱里运行 |

- **会话**：签发即写进 PostgreSQL（加密），任何副本收到本副本没有的令牌都去库里读；吊销用数据库的通知广播到所有副本，几百毫秒内都不认了。每个会话的飞书访问授权和续期凭据也加密存在库里。设了 `IDOU_DATABASE_URL` 和 `IDOU_STATE_KEY_FILE` 才有这些；两项都不设，就是单进程、状态在内存里。
- **容量**：每个模型副本各按 `IDOU_MODEL_MAX_CONCURRENT` 限流。模型账号的并发配额更低时，在 `api-N.env` 里调低。一个人固定落在一个副本上。
- **执行池**：协调副本把每次运行准备好（运行目录、出口令牌、上一次的报告、模型），放进共享库的队列，由执行节点领走运行，结果回到协调副本归档、记录、通知。同一个任务同一时刻只有一次运行，由数据库保证；执行节点死了，它手上的运行判为「执行节点中断」，不会重跑；30 秒没人接手的，如实报「没有执行节点接手」。
- **回退到单进程**：nginx 换回只转协调副本的配置，停掉模型副本，配置里去掉数据库那两行，重启协调副本。先换 nginx 再停副本，桌面的模型请求就不会落空。

设计和分阶段计划在 [scaling-plan.md](scaling-plan.md)。

## 10. 持久数据进共享库、协调副本热备

`IDOU_DATA_STORE=postgres` 把定时任务、运行记录、文档网站、云盘额度账本、用量账本都放进共享库，协调副本凭租约热备（`IDOU_COORDINATOR_LEASE_SECONDS`）。不设就照旧在本机文件里。已经在跑的部署切过去要停协调副本几分钟：

1. 照常发布，另外备份数据目录、额度账本文件，和 `pg_dump`。
2. `systemctl stop idou-control-plane`。模型副本照常服务，桌面端的对话不断；登录、定时任务、文档网站这几分钟不可用。
3. 用服务本身的身份和配置搬数据（不打印配置文件）：

   ```
   sudo -u idou env HOME=/home/idou bash -c 'cd /opt/idou/app && set -a && . /etc/idou/idou.env && set +a && exec /usr/local/bin/node bin/migrate-data.js --to postgres'
   ```

   每一项说搬了几条，读回来少了任何一条就报错停下；有协调副本持有租约时拒绝运行。
4. 备份配置后加一行 `IDOU_DATA_STORE=postgres`，启动协调副本，重启模型副本。
5. 核对：日志里有 `holding the coordinator lease` 和 `tasks and their runs are kept in the shared database`；定时任务列表、运行记录、文档网站、管理台用量都和切换前一致。

**回退**：停协调副本，用同样的命令跑 `--to files` 把切换以后的改动搬回本机文件（已删的记录不会从文件里删），或者直接恢复第 1 步的备份；然后换回原配置启动。

**加一台备用机器**：那台放同样的一套（nginx、协调副本待命、模型副本、执行节点，沙箱网络和防火墙照 §5 建好）；本机协调副本开 `IDOU_EGRESS_REMOTE_LISTEN`，那台的执行节点设 `IDOU_EGRESS_UPSTREAM`；前面加负载均衡，按 `/healthz` 做健康检查；PostgreSQL 的 5432 只对那台放行。

## 11. 执行节点最小权限，只有它能用 Docker

定时任务可能被提示词注入，运行它们的进程不该拿着整个服务的钥匙；docker 组又等于 root，直接对外的进程不该在里面。所以：

- **只有执行节点能用 Docker。** 它用自己的账号 `idou_worker`（家目录 `/var/lib/idou-worker`），整台机器只有这个账号在 docker 组里；`idou` 不在。协调副本把运行交给执行池，自己不启动容器。
- **只给它用得上的配置。** `/etc/idou-worker`（`root:idou_worker` 0750）里是 `worker.env`、`worker-N.env` 和队列密钥，只有三样：数据库地址（角色 `idou_worker`）、队列密钥文件、沙箱设置。它不读 `idou.env`，也进不去 `/etc/idou`。
- **拿到不该有的就拒绝启动。** 执行节点只要拿到封存密钥、飞书应用密钥、模型密钥等任何一项，就拒绝启动，报错里只写配置名、不写值（名单是 `WORKER_WITHHELD`，有测试保证服务端读取的每个密钥类配置都在名单上）。不按生产隔离运行（`IDOU_SANDBOX_MODE=production`）也拒绝启动。
- **队列密钥**从封存密钥单向派生，拿着它推不出封存密钥：`node bin/run-queue-key.js <封存密钥文件> <输出文件>`，已存在时不覆盖。
- **数据库角色 `idou_worker`**（`deploy/server/worker-role.sql`，测试用的是同一份）：只能读写队列表里执行节点需要的那几列；读不到会话、飞书授权、定时任务、长效凭据，也读不到别的运行交回的结果；不能建表、插入、删除。表由协调副本建，执行节点启动时表还不存在就说明原因后退出，systemd 5 秒后重试。

**安装**：

1. 建账号：`useradd --system --home-dir /var/lib/idou-worker --create-home idou_worker`，`usermod -aG docker idou_worker`；确认 `idou` 不在 docker 组。
2. 建目录并生成队列密钥：

   ```
   install -d -o root -g idou_worker -m 0750 /etc/idou-worker
   node /opt/idou/app/bin/run-queue-key.js /etc/idou/state.key /etc/idou-worker/run-queue.key
   chown idou_worker:idou_worker /etc/idou-worker/run-queue.key && chmod 0400 /etc/idou-worker/run-queue.key
   ```

3. 装配置：`deploy/server/worker.env`（把镜像 ID 和 `IDOU_SANDBOX_USER` 换成实际的）和 `worker-1.env` 装进 `/etc/idou-worker/`，`root:idou_worker` 0640。
4. 协调副本以 `IDOU_SCHEDULE_EXECUTION=pool` 启动过一次（它建队列表）之后，建数据库角色：`sudo -u postgres psql -d idou -v ON_ERROR_STOP=1 -f /opt/idou/app/deploy/server/worker-role.sql`。
5. 装 systemd 单元，`systemctl daemon-reload`，`systemctl enable --now idou-worker@1`。
6. 核对：各进程 `/proc/<pid>/status` 的 `Groups` 里只有执行节点带 docker 组；执行节点的环境里只有上面那几项；投一个合成运行把队列走一遍。

**边界**：docker 组本身就等于 root，执行节点的账号一旦被攻破，仍然可以借 Docker 拿下整台机器。这一步保证的是另外三件事：模型副本和协调副本不能用 Docker；执行节点的进程环境和它能读的文件里没有这些密钥；以后执行节点放到别的机器上，那台机器上只有队列密钥和一个受限的数据库角色。

**注意引号**：这些配置文件是 bash 用 `set -a; . 文件` 读的。数据库地址里有 `&user=…`，不加引号的话 `&` 被当成「放到后台执行」，变量根本没设上。`test/deploy-server.test.js` 把每个 `deploy/server/*.env` 真的交给 bash 读一遍，逐项核对。
