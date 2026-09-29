# 升级飞书 CLI 与 Codex

应用运行两个上游：飞书 CLI（`lark-cli`）和 Codex。它们都按摘要钉在 `upstreams.lock.json` 里，并被签名的发布清单绑定。本文是把它们升级到新版本的完整路径。2026-09-18 已用一次「同版本重编」端到端走通，见文末「验证记录」。

## 为什么要按这个顺序

- 运行时只执行**签名发布清单**里登记过摘要的二进制。
- 签名时，发布清单会拿沙箱镜像的构建记录，去核对它要签的锁文件：Codex 和 CLI 的版本、摘要都必须一致。
- 沙箱镜像里装着 Codex 和 CLI 的 linux 版。

所以新版本必须先**暂存**（编译或放入、计算摘要、写进工作区的锁、装到位），再用**候选模式**构建镜像，最后签名。签名之后，运行时检查和测试才会认新产物。

2026-09-18 之前，镜像构建总是拿已签名清单里的旧摘要去核对，新产物一律被拒，签名又离不开新镜像的构建记录。这是个死锁：自从引入签名发布之后，任何版本升级都走不通。`scripts/build-sandbox-image.js --candidate` 和 `scripts/upgrade-upstream.js` 就是为解开它而加的。

## 前提

- 下载任何东西（源码、npm 包、API 元数据，以及编译新版 CLI 时 Go 要补的依赖模块）之前，都要先告诉用户来源和大小，得到同意。暂存工具本身不下载。
- Go 版本：暂存时用当前工具链，版本会被写进锁里。
- Docker（本机是 colima）可用，锁文件里的沙箱基础镜像按摘要存在于本地。

## 一、暂存

### 飞书 CLI

官方发布的二进制**没有编进 authsidecar**，没有它 CLI 就无法在沙箱的凭据隔离边车后面运行。所以两个平台都从源码编译。

1. 取得官方源码 `https://github.com/larksuite/cli`，检出要升级到的 tag（`vX.Y.Z`），保持工作区干净。浅克隆就够：`git clone --depth 1 --branch vX.Y.Z …`。先在 GitHub 上核对这个 tag 指向的提交，以及签名是否有效。
2. API 目录（CLI 认识哪些接口）是构建输入，来源分两种：
   - **1.0.96 起**：目录随源码提交（`internal/registry/catalog/`），编译时嵌入并自带完整性校验，不用下载任何东西，同一个提交就决定了行为。远端元数据覆盖机制也删掉了，`LARKSUITE_CLI_REMOTE_META` 不再起作用。
   - **更早的版本**：要先在源码目录里运行 `python3 scripts/fetch_meta.py`，从 open.feishu.cn 下载 `internal/registry/meta_data.json`。它没有提交进版本库，不同时间取到的元数据编出来的 CLI 行为不同，见 1.0.78 的验证记录。
   - 编译前 `go mod download` 补齐依赖，再 `go mod verify`。依赖按 `go.sum` 和 sum.golang.org 校验。
3. 运行：
   ```sh
   node scripts/upgrade-upstream.js stage-feishu --checkout /绝对路径/larksuite-cli --version X.Y.Z
   ```
   工具会完成这些事：
   - 用同一份源码、同一份元数据，编译 darwin-arm64 和 linux-arm64，两者参数完全相同；
   - 用本机能运行的那一份探测版本号和内嵌技能；
   - 确认 linux 版是 arm64 ELF；
   - 把当前产物挪到 `resources/.upgrade-previous/`，锁也存一份副本；
   - 装上新产物，把版本、提交、构建日期、Go 版本和两个摘要写进锁；API 目录随提交的版本记 `registryCatalogManifestSha256`，靠下载元数据的旧版本记 `registryMetaSha256`；再按锁回读核对。
4. 建议再做两项核对，结果写进锁里 linux 产物的 `builtFromSource`：
   - 用空的 `GOCACHE` 独立再编一次 linux 版，摘要应当和暂存的一致（`reproducible`）；
   - 在源码目录跑上游自带的边车测试：`go test -tags authsidecar ./extension/credential/sidecar/... ./extension/transport/sidecar/... ./tests/sidecar_e2e/... ./sidecar/...`（`upstreamSidecarSuites`）。
   - 两项都要在构建候选镜像**之前**写进锁：镜像记录绑着锁的摘要，之后再改锁，签名会对不上。

### Codex

1. 用新版本全局安装 `@openai/codex`，桌面端和打包都用它。
2. 取 linux-arm64 的平台构建：`npm pack @openai/codex@X.Y.Z-linux-arm64`，解开后是 `package/vendor/aarch64-unknown-linux-musl`。
   - npm 上**没有**名为 `@openai/codex-linux-arm64` 的包，直接按这个名字取会 404。它只是主包 `optionalDependencies` 里的别名（`npm:@openai/codex@X.Y.Z-linux-arm64`），全局安装后目录名才叫 `node_modules/@openai/codex-darwin-arm64`，打包脚本按这个目录名找 darwin 那份。
   - 两个平台构建都不小。0.155.0 解压后 darwin-arm64 约 317MB、linux-arm64 约 328MB；下载前告诉用户。
3. 运行：
   ```sh
   node scripts/upgrade-upstream.js stage-codex --version X.Y.Z --commit <rust-vX.Y.Z 的提交> --linux-arm64 /绝对路径/vendor/aarch64-unknown-linux-musl \
     --darwin-integrity sha512-… --linux-arm64-integrity sha512-…
   ```
   darwin 那份默认从 PATH 上的 `codex` 找到，找法和打包脚本相同；也可以用 `--darwin-arm64` 指定。
   - 两个 `--…-integrity` 填 registry 上各自压缩包的 `dist.integrity`（`npm view @openai/codex@X.Y.Z-<平台> dist.integrity`），并先确认手里的压缩包和它一致。**换版本时必须给**：锁里的 `registrySpec`、`integrity` 按新版本重写，旧版本的出处说明（`provenance`）删掉，由你按这次的核对重新写。2026-09-26 之前工具会把旧版本的这几项原样留在新版本名下，像是替新版本核对过一样。
4. 如果 `rust-vX.Y.Z` 的 `LICENSE` 或 `NOTICE` 有变化，用新文本替换 `third_party/codex/` 下的对应文件。签名时会给它们重新计算摘要。

`node scripts/upgrade-upstream.js status` 随时可以查看锁里的版本、各产物是否与锁一致，以及当前有没有暂存中的升级。

### linux-x64（服务器用，2026-09-22 起）

服务器是 x86_64，所以锁里还有一套 linux-x64 产物：飞书 CLI 用同一提交、同一 Go、同一参数编译，只把 `GOARCH` 换成 amd64；Codex 用同一版本的 `@openai/codex@X.Y.Z-linux-x64`。

- **升级版本时，`stage-feishu` 和 `stage-codex` 只把自己那一方旧版本的 x64 产物挪开并从锁里删掉**，不会让它们挂在新版本名下，另一方的 x64 不动。暂存完 arm64 之后，在**同一次**升级里为这一方补 x64：
  ```sh
  # 升级了 Codex：只要 Codex 的 x64 包，不需要 CLI 源码，也不需要 Go
  node scripts/upgrade-upstream.js add-linux-x64 --codex /绝对路径/package/vendor/x86_64-unknown-linux-musl --codex-integrity sha512-…
  # 升级了飞书 CLI：只要 CLI 源码，不需要 Codex 包
  node scripts/upgrade-upstream.js add-linux-x64 --checkout /绝对路径/larksuite-cli
  ```
  两个参数也可以一起给（2026-09-22 第一次加 x64 就是这样，当时没有进行中的升级，它自己备份，可以单独回滚）。CLI 那一方只接受锁里已钉住的那个提交、Go 版本和 API 目录，会用空的 GOCACHE 再编一次，确认字节相同；不会改动已钉住的任何 darwin 或 arm64 产物。在进行中的升级里运行时，它不另做备份：`rollback` 用这次升级开始时的备份，把旧版本的 x64 放回去，新补的挪进 `.upgrade-rejected-…`。
  - **2026-09-26 之前这一步走不通**：`add-linux-x64` 要求两个上游一起给、只要锁里任一方还钉着 x64 就拒绝，又因为已有 `.upgrade-previous/` 拒绝在进行中的升级里运行。所以自从有了 x64，任何一方都没法真正升版本（9-22 那次能成功，是因为版本没变、也没有进行中的升级）。`test/upgrade-upstream.test.js` 用假的 Go、假的 CLI 源码和合成的 Codex 目录，把「只升 Codex」「只升 CLI」各走一遍暂存、补 x64、回滚，不下载也不编译。
- **Codex 的 x64 包下载前要征得用户同意**（0.155.0 的压缩包 142MB，解开约 371MB）。取包用 `npm pack @openai/codex@X.Y.Z-linux-x64`。`--codex-integrity` 填 registry 上的 `dist.integrity`，并先确认压缩包的 sha512 和它一致。核对过哪些东西（registry 签名、SLSA 来源），要写进锁里 `codex.vendorArtifacts.provenance`，而且要在构建镜像**之前**写，因为镜像记录绑着锁的摘要。

## 二、候选镜像与签名

```sh
node scripts/build-sandbox-image.js --candidate
IDOU_RELEASE_SIGNING_KEY_FILE=<发布签名私钥> node scripts/sign-release.js \
  --release-id 0.1.0-<日期>.<序号> --sandbox-record <上一步打印的 dist/sandbox-releases/…json 的绝对路径>
```

候选构建按工作区的锁核对产物，并把这份锁的摘要写进镜像标签和构建记录。签名之后，签名清单里的上游摘要就是这份锁的摘要，运行时的镜像标签核对因此能通过。签名私钥只通过环境变量交给签名脚本，绝不打印。

**两个平台都要构建，再用两条记录一起签名。** 先构建 x64，后构建 arm64，这样本机开发用的移动标签最后仍指向 arm64：

```sh
IDOU_SANDBOX_BUILD_COMMAND='["colima","ssh","--","env","BUILDX_NO_DEFAULT_ATTESTATIONS=1","docker"]' \
  IDOU_SANDBOX_PLATFORM=linux-x64 node scripts/build-sandbox-image.js --candidate --tag mydoubao/sandbox:<版本>-x64
node scripts/build-sandbox-image.js --candidate
node scripts/sign-release.js --release-id … --sandbox-record <arm64 记录> --sandbox-record <x64 记录>
```

- **x64 的构建那一步放进 colima 虚拟机里跑。** 原因是本机 docker 没有 buildx，只能用旧式构建器，而旧式构建器在 containerd 镜像存储下做跨架构构建，会丢掉中间镜像的平台信息，第一条 `COPY` 就报「does not provide the specified platform」（9-22 实测）。colima 虚拟机里的 docker 自带 buildx。构建前后的所有检查仍然用本机的客户端做，连的是同一个守护进程。
- **每次构建都用一个新的构建上下文目录**（`scripts/sandbox-context.js`，按 Dockerfile 的 `COPY` 行克隆出要复制的文件，放在 `$HOME` 下，构建完删掉）。BuildKit 按目录路径增量同步上下文，文件的大小和修改时间和上次一样就不重新发送；npm 包里所有文件的修改时间都是 1985-10-26，版本号从 0.155.0 变成 0.157.0 长度不变，于是 2026-09-26 在仓库目录里构建 x64 时，有 26 个文件用的是上次缓存的 0.155.0 内容，被镜像自己的逐文件校验拦下。换成每次新路径之后，同一次升级一次构建通过。旧式构建器（arm64 那一步）每次发送整个上下文，不受影响，但也一起改成用新目录。
- **构建记录里的 `classicId` 是给服务器用的镜像 ID。** 服务器的 docker 是经典镜像存储，`docker load` 进去的镜像没有仓库摘要，只能按这个 ID 固定。签名发布会把它和摘要一起批准。传到服务器之后，要核对服务器上的镜像 ID 正好等于它（见 `docs/server-deployment.md`）。

## 三、门禁（不付费）

依次运行，任何一步失败就停下，查清原因或回滚：

1. `node bin/idou.js doctor`
2. `npm run check`
   - `test/schedule-cli-read-shapes.test.js` 的「fixture 绑定钉住的 CLI」**必然失败**，这是设计好的绊线：请求形状是按旧二进制录的。
   - 其余测试必须全部通过。**桥接测试失败就是行为变了**，见验证记录。
   - 桌面冒烟（`npm run test:desktop`）核对技能中心的卡片和内置 CLI 的技能清单一一对应（除了不用的 `lark-apps`）。CLI 增减技能时不用改冒烟，但要看一眼新技能该不该出现在产品里。
3. **全部桌面冒烟**：`IDOU_SMOKE_NO_LIVE=1 node scripts/run-desktop-acceptance.js desktop runtime --docker=/opt/homebrew/bin/docker`。
   - 名字里带 `desktop` 的 30 多个冒烟，加上三个隔离运行时冒烟（需要 `--docker`，镜像会先构建）。
   - 都是合成数据，不付费，也不碰真实租户。环境变量让定时任务冒烟跳过它的付费步骤。
   - **不要不带名字跑**：那会把 `smoke-feishu-dock-live.js` 之类的真实冒烟也跑了，它会把你真实飞书里的会话标成已读。
   - 也不要只挑几个跑：1.0.96 改了 `docs +create` 的请求，只有「Agent 写飞书」那个冒烟会走到它，而它恰好不在当时的门禁清单里，结果一个建不了文档的版本装着用了约 20 分钟（21:16 装上，21:37 回退）。
4. 升级了 CLI 的，比较写入请求：`node scripts/compare-cli-write-shapes.js resources/.upgrade-previous/lark-cli/darwin-arm64/lark-cli`。它对产品实际运行的每条手工定形状的写入命令，在新旧两个二进制上各做一次 `--dry-run`，逐条比较要发的请求。写入约定按旧形状逐字核对，形状一变就会被拒。每一处 CHANGED 都要看：要么在 `cli-write-contract.js` 里重录约定，要么确认新请求被拒无害（1.0.96 上传后的使用上报就属于这种）。
5. 升级了 CLI 的，重录请求形状：`node scripts/record-cli-read-shapes.js`。它写的是固定文件名 `test/fixtures/schedule-cli-read-shapes.json`，所以新旧版本发出的请求有什么不同，就是这个文件的 git diff。然后重跑矩阵测试。
   - 如果 CLI 发出了矩阵里没登记的请求，测试会点名它；这时要评估出口判定器是否需要跟着改，不能直接改期望值。
   - fixture 只核对 darwin-arm64 的摘要。沙箱里跑的是 linux 版，它的行为靠下面第 6 步的真实运行来证明。
6. 真实租户验收（只读）：`node scripts/acceptance-wiki-pinning.js docs/evidence/wiki-pinning-cases.json`，应为 13/13。
7. 打包与打包态 smoke：`npm run package:mac`，再 `npm run test:packaged-app`。后者会用真实的 Codex 跑两次合成模型请求，是 Codex 集成边界（`app-server-jsonrpc-v2`）的实测。
8. 安装之后，**先把部署文件里钉住的沙箱镜像换成这次签名的镜像**，再做真实运行验收。
   - 部署文件（本机是 `~/.mydoubao/mydoubao.env`）里的 `IDOU_SANDBOX_IMAGE` 按摘要钉住镜像，升级流程不会动它。签名清单里的 `mydoubao/sandbox@sha256:…` 就是要换成的值。只改这一行，先留备份，不要打印整个文件。
   - 重启控制面（本机：`launchctl kickstart -k gui/$(id -u)/com.mydoubao.control-plane`），启动日志里不应再有「镜像标签 … 是 …，发布清单要求 …」。生产模式下这种不一致会让控制面起不来；开发模式只警告，所以 2026-09-18 的两次升级都漏了这一步，定时任务一直在旧镜像里跑。
   - 然后跑付费的真实运行验收：先退出桌面应用，再运行 `node scripts/acceptance-scheduled-read-live.js --paid`。两次运行都要完成、归档，报告里原样出现测试资源中的标记。
   - 用 `docker events --since 20m --until 0s --filter type=container --filter event=create --format '{{.Actor.Attributes.image}}'` 核对容器确实是新镜像建的。运行记录和控制面日志都不记镜像。
   - 每种资源都要在新镜像里真实跑过：文档、整本表格、单张工作表、整个 Base、单张数据表、会话。CLI 的输出形状一变，agent 要用的模型调用次数就跟着变，而每次运行有调用次数上限。

## 四、完成或回滚

- **完成**：提交锁文件、`release/`、fixture，以及有变化的 `third_party/`，然后按安装步骤装上新版。确认新版稳定后，把 `resources/.upgrade-previous/` 改名为 `resources/.upgrade-accepted-<上游>-<版本>-<时间>/` 留作手工回退的来源（`mv`，不删除）。它里面是二进制，不进 git。暂存工具一次只接受一个进行中的升级：两个上游都要升时，先把第一个做完、改好名，再暂存第二个，这样哪一个出问题都分得清。
- **回滚**：`node scripts/upgrade-upstream.js rollback` 会把原产物和原锁放回去，刚暂存的产物挪到 `resources/.upgrade-rejected-<时间>/`，不删除。再运行 `git checkout -- release/ third_party/ test/fixtures/` 撤销签名清单等改动。升级过 Codex 的，还要把全局 `@openai/codex` 装回原版本。

## 验证记录（2026-09-18）

用锁里记录的同一提交 `03de81c5` 和一份 9 月 16 日取得的元数据，把 lark-cli 从 1.0.78「升级」到 1.0.78：

- **暂存**：两个平台都编译成功；探测到版本 1.0.78，27 个技能都在。**两个摘要都和锁里的不同**：当前在用的二进制，是用另一份没有记录的元数据编出来的，已经无法原样复现。这也是现在把元数据摘要写进锁的原因。
- **候选镜像**：17 项检查全部通过，镜像里是新编的 CLI。旧流程在这一步必然拒绝。
- **签名**：成功（`0.1.0-20260918.17`，只作为候选，没有发布）。构建记录里的上游摘要等于工作区锁文件的摘要。
- **门禁**：doctor 正常；全量检查 1631 项里失败 2 项。
  1. 请求形状的绊线，预期之内。
  2. `test/feishu-cli-sidecar.test.js` 的「内置 CLI 经桥上传并核验一个已确认的文件」。CLI 的 SDK 收到了它解析不了的错误体。dry-run 下新旧两者计划的请求完全相同（`files/upload_all` 加 `metas/batch_query`），所以差异只发生在运行时：**元数据不同，上传流程就不同**。
- **回滚**：`rollback` 还原了两个平台的产物和锁，`status` 显示全部与锁一致，那两项测试重新通过。

结论：
- 升级链路本身可用。
- 门禁能拦下看不见的行为变化。
- 下次真正升级 CLI 时，新元数据几乎必然改变某些运行时请求。上线前要先用本机回环录制（`scripts/record-cli-read-shapes.js` 的做法）查清新的请求，再决定是改桥接和出口的放行规则，还是换一份元数据。

## 验证记录：lark-cli 1.0.78 → 1.0.96（2026-09-18，真实升级）

- **来源**：tag `v1.0.96` 指向 `cb5a3d70`，GitHub 显示签名有效，由官方 CI 发布。浅克隆约 48MB，其中 `.git` 9.6MB。Go 依赖新下载约 17MB，只有 `golang.org/x` 的五个包和 `gorilla/websocket` 升了版本，`go mod verify` 全部通过。**没有下载 API 元数据**：1.0.96 把目录提交进了源码。
- **暂存**：
  - 内嵌技能 27 → 28，新增 `lark-meeting`（视频会议），它在技能中心正常显示；
  - 用空 `GOCACHE` 重编 linux 版，摘要逐字节一致，第一次做到可复现；
  - 上游四组边车测试（`-tags authsidecar`）全部通过；
  - `authsidecar` 仍是编译标签，所以仍然要从源码编。
- **传输层变化**：请求分成「平台」和「外部」两类。平台请求照旧整条走边车；发往外部地址（预签名链接、CDN 之类）的请求，只有带凭据占位符的走边车，其余直连。沙箱里直连本来就出不去，所以只可能让某些功能失败，不会越权。
- **候选镜像** 17/17。签名 `.21`（候选）；后面改了源码，又签了 `.22`、`.23`。
- **门禁**：第一次全量检查挂了 2 项：
  1. 请求形状的绊线，预期之内。
  2. 桥接上传测试。它的最后一段断言「原始 Drive 资源命令不存在」，1.0.96 编进了接口目录，这些命令存在了，这个前提过时了。它们发出的请求和 `lark-cli api` 一样受桥的规则约束：GET 读放行，未授权的写在到达飞书前被拒。同时查出一个**早就存在的问题**：桥、沙箱出口的 CLI 路由、桌面边车这三处自己的拒绝，写成 `{"error": "..."}` 或纯文本。CLI 的 SDK 只认飞书格式，解析失败，就把拒绝理由换成了「SDK returned an invalid JSON response」。现在三处都按飞书格式回 `{code, msg}`，CLI 能打出「code 405 feishu_cli_method_denied」这样的错误。模型路由由 Codex 读，保持原样。
- **重录请求形状**（18 个命令，37 个请求）：
  - 解析 Wiki 节点从 `get_node` 换成 `node_by_token`。出口判定器里没有任何 Wiki 规则，两者都默认拒绝。
  - `sheets +cells-get` 不给工作表时，先查整本结构，再按 `sheet_name` 读。只授权单张工作表时两者都被拒：判定器要求 `sheet_id` 对上授权里固化的那张。新增了边界测试：按名字读另一张工作表必须拒绝。
  - 资源段里写给 agent 的读法，在出口上整条都走得通。
- **结果**：全量检查 1646/1646；桌面冒烟和定时任务冒烟通过，卡片数改成和内置 CLI 的技能清单比对，不再写死；真实租户 Wiki 验收 13/13。
- **安装与真实运行**：打包态冒烟通过，付费调用 0；安装 `.23` 后 doctor 显示 saas-cli 1.0.96。对两条验收任务各点一次「立即运行」，都完成并归档，下次时间和状态都没变。读回的报告各自含有自己的标记、互不串：整本 Base 列出了数据表、字段和记录；单张工作表只读了 `20RQ2y`。见 `docs/evidence/cli-1.0.96-live.txt`。上一版的产物挪到了 `resources/.upgrade-accepted-lark-cli-1.0.96-<时间>/`，没有删除。
- **更正（2026-09-18 23:40）**：这两次运行是在**旧**沙箱镜像里跑的（容器里是 lark-cli 1.0.78）。部署文件按摘要钉着旧镜像，升级没有改它，开发模式只警告。所以这条记录验证的是桌面端的 1.0.96 和控制面的新判定逻辑，没有验证容器里的 1.0.96。见下面「沙箱镜像钉子」一节。
- **装上之后发现的回归（已回退，已修复）**：lark-cli 这一轮的门禁没有跑「Agent 写飞书」的桌面冒烟，`.23` 装上后，Agent 新建飞书文档是坏的。原因是 1.0.96 的 `docs +create` 请求体多了 `extra_param: "{\"open_create_async\":true}"`，而写入约定按 1.0.78 的 `{content, format}` 逐字核对，把写入拒了（拒绝本身是对的）。发现后先把已安装的应用回退到 `.20`，再修：
  - 约定改成认 1.0.96 的形状。旧形状、`extra_param` 取别的值、多出 `parent_token`，都拒绝。
  - 异步创建：飞书可能先回一个任务号，CLI 随后轮询 `GET /open-apis/docs_ai/v1/async_tasks/<task_id>`，最多 10 分钟。边车以前是「一次写入后 key 立即作废」，轮询会被拒，文档建好了却拿不到回执。现在的规则：
    - 写入之后 key 标成「已用过」，永远不能再带着授权写；
    - 只有写入的回应里给出任务号时，才在 11 分钟、600 次以内，放行查询**这个任务号**的 GET；
    - 任务到了终态，或者回应是直接给出的结果，key 立即作废；
    - 查询别的任务号、再发一次写入，都会被拒，同时作废 key。
  - 测试：一条用真实 1.0.96 CLI 走完异步创建；一条手工构造请求验证每一条边界（三处变异都能抓到）；「Agent 写飞书」的桌面冒烟改成异步应答。
  - 为了不再漏跑，门禁第 3 步改成用现有的 `run-desktop-acceptance.js` 跑全部桌面冒烟，并新增 `scripts/compare-cli-write-shapes.js`（新旧 CLI 写入请求对比）。后者在 1.0.78 → 1.0.96 上报出两处：`docs +create`，以及上传后的使用上报 `POST /open-apis/drive/v1/lark_cli_file_event/report`。后者不在上传授权里，会被拒，CLI 能照常完成上传，今天的真实归档就是证明，所以不放行。
- **第二处回归（2026-09-22 发现，.184 修复）**：1.0.96 的 `api` 命令拒绝路径里带查询串，报 `path must not contain a query string or fragment`，同样的参数要用 `--params` 传。产品里有三处把查询写在路径里，从 9-18 起一直失败，没有测试发现：
  - 「把多维表格加进知识库」（`base-reader.js` 读数据表、字段、记录）；
  - 「把文档发到群聊」发送前读群资料（`message-delivery.js` 的 `groupMembers`）；
  - 不走登录桥时的云盘文件夹清单（`drive-files.js`）。定时报告轮换要用它，所以这次才撞上。
  - 为什么没发现：这几处的测试都用假 CLI，收到什么路径都照单全收，而且还把错误的形状写成了断言。
  - 修法：`openapi.js` 的 `cliApiGet` 把查询拆成 `--params`，所有原始读取都走它（`wiki-source-reader.js` 本来就手工拆过）。
  - 新测试 `test/feishu-cli-api-reads.test.js` 用**钉住的真二进制**、空配置目录做 `--dry-run`：新形状能通过参数检查，旧形状必须被拒。同一个文件还扫一遍源码，不许再出现把查询写进路径的原始读取。以后升级 CLI，`npm run check` 会直接跑到它。

## 验证记录：Codex 0.147.0 → 0.155.0（2026-09-18，真实升级）

- **来源**：
  - 两个平台包的完整性摘要都和 npm 仓库一致；每个包的两个仓库签名，都用 npm 公布的公钥验证有效；
  - SLSA 出处证明写明由 `openai/codex` 的 `.github/workflows/rust-release.yml` 从 `refs/tags/rust-v0.155.0`（提交 `f0a1b8f0`）在 GitHub 托管机器上构建；
  - 全局安装的 darwin 文件和签名包里的 42 个文件逐一一致；
  - 许可证和 NOTICE 没变；
  - 锁里原来记的 0.147.0 提交 `553df1c6` 是主干上的普通提交，不是发布 tag，这次改正。
- **下载**：darwin 包约 127MB，linux 包约 135MB（解压后分别约 317MB、328MB）。linux 版多了 `codex-code-mode-host` 和 `codex-resources`，沙箱镜像随之变大。
- **门禁发现的集成问题**：
  1. **计划工具默认关了**（0.152 起，#41744）：对话旁的计划面板空了，给编程 agent 的说明又要求用 `update_plan`。桌面端配置加上 `tools.update_plan.enabled = true`。
  2. **插件状态读不出来**：`codex plugin list` 文字表格的最后一列从 `PATH` 改成了 `SOURCE`，按旧表头匹配，所有已安装插件都显示成「未安装」。改成读 `plugin list --json`，0.155 起它会返回结构化结果。
  3. 发布清单测试写死了 Codex 版本号，改成和锁逐项比对。
- **核对过没变的**：
  - 默认配置下发出的工具全部被网关接受：多了 `get_goal`/`create_goal`/`update_goal`，都是普通函数工具；协作命名空间的 6 个工具不变；
  - 企业技能：`skills/extraRoots/set` 加 `skills/list` 在真实 0.155.0 上照常认出技能；
  - 权限模式：真实 app-server 全部接受；
  - 编程任务冒烟：计划、改文件的 diff、命令输出、提问卡片都正常；
  - MCP 审批冒烟、「Agent 写飞书」冒烟都通过。
- **安装与真实运行**：打包态冒烟（真实 Codex 0.155.0，两轮合成模型请求）通过；装上 `.27` 后 doctor 显示内置 Codex 0.155.0、saas-cli 1.0.96。对两条验收任务各点一次「立即运行」，沙箱里跑的就是新版 Codex 和新版 CLI，走真实模型：都完成并归档，下次时间和状态都没变，读回的报告各自带着自己的标记，互不串。见 `docs/evidence/codex-0.155-live.txt`。
- **更正（2026-09-18 23:40）**：上一句「沙箱里跑的就是新版 Codex 和新版 CLI」是错的。控制面启动日志从 `.27` 起一直警告镜像标签是 Codex 0.147.0、lark-cli 1.0.78：部署文件按摘要钉着旧镜像。这两次运行验证的是桌面端和控制面，容器里仍是旧版本。见下面「沙箱镜像钉子」一节。

## 验证记录：Codex 0.155.0 → 0.157.0，单独升级（2026-09-26）

起因是问了一句「Codex 和飞书 CLI 能不能各自单独升级」。飞书 CLI 1.0.96 仍是最新发布，所以真实走一遍的是 Codex，CLI 全程不动。

- **先查出来的两处阻塞（已修，见上文）**：
  - 补 x64 这一步要两个上游一起给，也不能在进行中的升级里跑。自 9-22 有了 x64 之后，任何一方都没法升版本。修复是 `f53622d`。
  - x64 镜像在 BuildKit 里构建时，有 26 个文件沿用了上次构建缓存里的 0.155.0 内容，被镜像自己的逐文件校验拦下。修复是 `013f7cd`，改成每次构建用新的上下文目录。
- **来源**：
  - 三个平台压缩包（macOS 133MB、linux-arm64 143MB、linux-x64 150MB）的 sha512 和 npm 仓库一致。
  - `npm audit signatures` 对这三个包和启动器包都报「仓库签名已验证、出处证明已验证」。
  - 出处证明写明构建来自 `openai/codex` 的 `rust-release.yml`，引用 `refs/tags/rust-v0.157.0`（提交 `00c972ed`），在 GitHub 托管机器上构建。
  - 装好的 macOS 目录和签名包逐一相同（42 个文件）。
  - `rust-v0.157.0` 的 LICENSE 和 NOTICE 和 0.155.0、和 `third_party/codex/` 都是同一个文件。
- **没有动全局的 codex**：新版用 `npm install --global --prefix <单独目录>` 装。暂存和打包用 `IDOU_CODEX_LAUNCHER` 指过去，门禁里把它放在 PATH 最前面，再设 `IDOU_CODEX_BIN`。普通的 `--prefix` 本地安装会把 `codex-darwin-arm64` 提升到外层目录，打包脚本就找不到它。
- **暂存**：
  - `stage-codex` 只把 Codex 的旧 x64 挪开，`add-linux-x64 --codex` 在同一次升级里补上 x64。整个过程不需要 CLI 源码，也不需要 Go。
  - 锁里 `feishu` 这一段逐字不变，CLI 的三个平台都仍与锁一致。
- **镜像与签名**：
  - 两个候选镜像都通过了全部检查：x64 是 `8ff60a73…`（classicId `5337292d…`），arm64 是 `8d2c26a2…`。
  - x64 第一次重建时，最后一项检查（容器里跑 `env | grep`）卡住 120 秒超时；手动跑只要 0.2 秒，重跑整个构建 10 秒全部通过。按偶发处理，记在这里。
  - 签名 `.221`。
- **门禁（不付费）**：
  - doctor 通过。
  - `npm run check` 2168/2168。用真 Codex 的契约测试都在 0.157.0 上跑过（MCP 审批等待、工具超时、插件市场、后台命令），没有跳过的。
  - 全部桌面冒烟加三条运行时冒烟（`--docker`）：通过 45、失败 1、到卡片为止 21、未运行 13。失败的 `smoke-runtime-desktop.js` 与 Codex 无关：9-22 起普通确认卡不再把焦点移到「取消」，这条冒烟因为要 Docker，之后没再跑过，断言过期了。改正后跑到了卡片，界面检查没有发现问题。
  - 打包态冒烟：打包进去的 Codex 0.157.0 做了 3 次合成模型请求，付费调用 0。
- **安装**：`.221` 装在本机，启动后自己续上了登录。
- **服务器（同日，用户同意后）**：
  - 服务端只加载的代码里，`.203` 到 `.221` 没有数据结构变化。部署了 `.221`，`verify-server-release.js` 通过。
  - 传上去的镜像 ID 等于 `classicId`（`5337292d…`）。部署文件只改了镜像钉子那一行，先留了备份 `mydoubao.env.before-codex-0157-221`。切换软链接后重启（又是等满 90 秒）。
  - 启动日志：定时任务开启、出口代理在监听，没有「沙箱未就绪」，也没有镜像不一致。
  - 重启那 90 秒里，本机 i豆 的网站自动刷新和定时任务通知收到 nginx 的 502；重启后头两次请求报 `feishu_cli_proxy_denied`；之后自己恢复了。
- **付费实跑**：
  - 用 `acceptance-scheduled-read-live.js --paid --run-now` 跑「验收-三种资源-09181643」。这个脚本原来从本机数据库读运行记录，控制面搬到服务器后那份库已经过期，现在改成通过应用接口读。
  - `docker events` 核实，容器是由新镜像 `5337292d…` 创建的。
  - 7 项检查全部通过：完成、报告已归档（1502 字节）、下次时间和状态不变、没有挂起、桌面通知一次、记为「立即运行」。
  - 读回报告，文档、表格、多维表格的标记都在。
  - `resources/.upgrade-previous/` 已改名为 `.upgrade-accepted-codex-0.157.0-<时间>`。

## 验证记录：沙箱镜像钉子（2026-09-18 晚，发现与处理）

- **发现**：装 `.30` 时读控制面启动日志，看到镜像标签与签名清单不一致。部署文件 `~/.mydoubao/mydoubao.env` 的 `IDOU_SANDBOX_IMAGE` 钉在 `mydoubao/sandbox@sha256:d0f29a9c…`（Codex 0.147.0、lark-cli 1.0.78）。日志显示 `.20` 时两者一致，从 `.23`/`.27` 起不一致。
- **把钉子换成签名镜像 `1550e38c…` 后的第一次真实运行**：
  - 整本 Base：完成、归档、发出桌面通知；`docker events` 核实容器是新镜像建的。
  - 单张工作表：**失败**，退出码 1。复现时跟住容器输出和 Codex 会话记录，原因是：lark-cli 1.0.96 的 `sheets +cells-get` 对 A1:Z200 输出 583KB JSON（1.0.78 很小），agent 先看了两次 `--help`，又去找 python3 和 jq（镜像里都没有），8 次模型调用用完，第 9 次被网关以 429 拒绝，Codex 重试后退出。飞书读取本身全部成功。
- **处理**：钉子先退回旧镜像（已知可用，`.27`、`.29` 的真实运行都在它上面通过），备份在 `~/.mydoubao/mydoubao.env.before-sandbox-1550e38c`。下一版修运行说明，在新镜像里把每种资源真实跑一遍，通过之后再换钉子。
  - 最初打算改用 `--format csv`，实测这个参数对 `sheets +cells-get` 不起作用（csv、table、json 三种输出一字不差，都是 633KB）。改用 `--include value` 加 `--jq`：请求只多一个 `include_styles:false`，输出 4KB。1.0.78 和 1.0.96 行为一致，所以两个镜像共用同一份说明。
  - **回退 `.31` 时，镜像钉子也要一起退回旧镜像**：`.30` 及更早版本的运行说明，正是在新 CLI 上失败的那一份。
- **结果（2026-09-19 00:30）**：装上 `.31`、钉子换成签名镜像后，五种资源各跑一次真实运行。整本 Base、单张工作表、整本表格、单张数据表一次通过。文档第一次用完了 8 次模型调用，重跑通过：测试文档里只有标题，验收提示词又要求列出单元格和记录字段，agent 以为内容不全，换了几种参数重读。每次容器都核实是新镜像，每份报告都读回核对了标记。见 `docs/evidence/sandbox-1550e38c-live.txt`。钉子保持在签名镜像上。会话这一类没有测试群，没有真实跑过。
- **没能自己验的**：真实飞书里新建文档（异步那条路径），要你在确认卡片上亲手点一次，合成测试和桌面冒烟都已覆盖。桌面端用真实模型跑一轮编程任务也没跑（付费）：新增的工具都是普通函数，网关探针已确认全部接受。
