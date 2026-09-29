# 企业应用运行验收授权

运行节点现可通过控制服务取得**精确版本的临时运行许可**。这是独立于作者和清单审核人的权限，默认关闭。它不是正式发布许可，也不提供企业员工共享访问入口。

## 服务端决策

在应用目录配置的租户条目中，显式增加 `runtime`：

```json
{
  "authProvider": "feishu",
  "tenantId": "tenant-id",
  "appId": "cli_product_app",
  "publishers": ["author-open-id"],
  "reviewers": ["reviewer-open-id"],
  "runtime": {
    "operators": ["operator-open-id"],
    "nodeId": "internal-validation-node",
    "imageId": "sha256:<管理员构建并核验的64位镜像摘要>"
  }
}
```

省略 `runtime` 或设为 `null` 即禁用。不会给作者/审核人隐含授予运行权限；如同一人兼任，必须明确配置。配置文件依旧由 `IDOU_APPS_CONFIG_FILE` 指定，无数据库 schema 变更。尚无在线管理配置 UI；运行中测试的撤销修改使用受控测试进程，实际配置变更需要服务重启。

`POST /auth/app-runtime-token` 接受当前父登录会话和 `{appId,digest}`。仅配置的操作员、同一租户/产品身份域、未撤回版本、已通过的清单审核、`listed` 归档记录能取得许可。清单审核或目录归档都是前置条件，**不是对源码安全和远端内容的独立证明**。该角色的授权范围是本租户符合条件的应用版本。

许可使用新的 `app-runtime` audience / `apps:runtime` scope；绑定应用 ID、清单摘要、审核记录 ID、归档 ID、包摘要/大小、节点 ID、镜像 ID，最长 5 分钟且不超过父会话。不会返回源码、云盘 file token、文件夹资料或上游模型密钥。再次显式申请会撤销此父会话此前的运行许可，不影响审核/技能等其他许可；没有自动续期。

## 桌面入口

「编程任务」首页和任务内「应用版本」都有「应用运行验收」按钮，不新增一级导航。操作员不需要创建本地编程任务：打开列表 → 选择已审核且有归档记录的版本 → 核对完整清单、包哈希、节点和镜像 →「签发并导出许可」→ 选择文件夹 → 原生窗口最终确认。

列表/详情使用独立的 `app-runtime-operator` / `apps:runtime-options` 短期权限。该权限不能领取运行许可、调用模型或撤销运行令牌；浏览和刷新也不会撤销已有运行许可。接口为 `/auth/app-runtime-operator-token`、`/v1/apps/runtime-list` 和 `/v1/apps/runtime-get`。列表每页最多 10 条，仅包含符合当前权限/状态的版本元数据；详情不提供云盘位置、源码或 bearer。

原生确认明确提示最长 5 分钟、旧运行许可将被撤销、仅交给受信任节点、不正式发布。目录选择或确认取消均不签发。签发时桌面额外发送 `expectedBinding`；服务端在签发或撤销旧许可之前核对它，节点/归档/审核目标变化返回冲突，不隐含接受新目标。旧 CLI 请求可省略该字段；桌面不能省略。

许可只在 native 进程处理，并保存到所选目录下新建的 0700 私有子目录，文件 `runtime-grant.json` 为 0600；不覆盖已有文件。渲染进程只收到文件位置、到期时间和非秘密目标元数据，成功结果卡片置顶显示。输出不含父登录令牌、模型密钥或源码。节点尚未启动，仍需由受信任节点读取导出文件；没有后台上传、自动复制文件、自动调用 Docker 或正式发布。

确认绑定当前账号、页面代次、清单与最长 5 分钟快照。关闭页面、切换账号、撤回版本、策略变化或过期都会拒绝陈旧确认；同一快照不能并发签发两次。签发后页面失效或本机保存失败时，尝试通过 `/v1/apps/runtime-revoke` 撤销该新 child，并移除本次未交付的私有目录；此接口不能撤销父会话。网络故障/回执丢失时撤销可能无法确认，未知许可至多保留原有效期，旧许可可能已撤销；不自动重新签发。成功导出的用户文件不会因关闭弹窗被删除，也不进行过期后文件自动清理。

## 节点协议与生命周期

| 路由 | 行为 |
| --- | --- |
| `/v1/apps/runtime-claim` | 指定节点/镜像与随机 claim ID；首次领取成功，任何重复领取均拒绝，不因相同请求放行 |
| `/v1/apps/runtime-check` | 校验相同 claim、当前会话/角色/版本/审核/归档/节点策略，返回精确清单与截止时间 |
| `/v1/apps/runtime-stop` | 已领取者释放许可；即使版本已撤回或角色已删除也可停止 |
| `/v1/apps/runtime-revoke` | 运行 child 自我撤销（包括尚未领取的许可）；用于未交付导出的清理，不能以父或浏览令牌调用 |

所有接口只接受无浏览器 Origin 的 POST JSON，限请求 4 KiB；模型、目录、审核令牌不能调用领取/校验/停止接口。运行令牌不能调用模型或作者目录接口。服务端只保留元数据与内存会话/领取记录，不接收应用包。

节点只使用管理员配置的控制服务 HTTPS origin（本机字面 loopback 允许 HTTP），不采用许可文件提供的 URL，不跟随 HTTP 重定向。响应有大小和 5 秒请求期限限制。节点在启动容器前领取一次许可；回执丢失不重试领取、不启动容器。持有的本地包必须匹配许可里的大小和摘要，容器仍独立检查完整规范及文件哈希。

容器启动后、入口就绪前，以及每次读取文件的前后，均重新检查服务端授权。闲置时每 2 秒校验一次；失效或服务不可达即关闭网关与本次容器，不使用缓存授权或离线回退。关闭需要等 Docker 清理确认；网络超时、调度和 Docker 不可用均会增加耗时，因此不是瞬时撤销保证。已交付到浏览器的内容无法远程收回或擦除。

服务端重启会丢失会话，旧许可不再可用。领取记录不是跨副本的持久部署队列；一个父会话的单许可也不是企业总并发配额。节点 ID 是许可目标绑定，不是 mTLS/硬件节点认证。知道 bearer 和 claim 的受信任节点可重复校验，协议本身不能证明恶意节点只启动了一个容器。正式集群还需要机器身份、调度配额和可审计的发布队列。

## 显式 CLI 入口

在持有操作员短期父会话文件的进程上申请（与现有会话文件格式相同；不会复制父令牌给节点）：

```sh
node bin/app-runtime-grant.js /absolute/operator-session.json <app-id> <manifest-sha256> /absolute/private/new-grant.json
```

输出目录必须是当前用户拥有的私有、规范路径目录；许可文件按 0600 独占创建，不覆盖已有文件。日志只输出文件路径和非秘密版本元数据。申请失败可能留下空的保留文件，应检查后选新文件名；不要把空文件当作已授权。此 CLI 不负责飞书登录，不获取或修复 CLI Keychain。

管理员在节点配置以下私有文件，其中 `runtime` 沿用独立 Docker 节点配置：

```json
{
  "serverUrl": "https://control.example.internal",
  "nodeId": "internal-validation-node",
  "runtime": {
    "dockerPath": "/absolute/path/to/docker",
    "endpoint": "unix:///absolute/path/to/docker.sock",
    "imageId": "sha256:<与服务端策略相同的64位镜像摘要>"
  }
}
```

把短期许可与准确版本包交给受信任节点，启动：

```sh
node bin/app-runtime.js --authorized /absolute/node.json /absolute/application.json /absolute/grant.json
```

只输出本机短时访问地址与 `authorizedValidation:true,deployed:false`，不创建企业共享域名。既有 `--development` 入口保留为显式管理员本机诊断；它不取得任何企业授权，也不能用于对外发布。配置、包、许可均要求私有普通文件；桌面已提供许可申请/导出，但没有节点调度。

## 验证与剩余边界

`test/app-runtime-authorization.test.js` 使用真实 HTTP/SQLite 与合成已验证登录身份，验证权限/身份域/范围隔离、并发领取、重放、失效、错误包、回执丢失和启动竞态。`scripts/smoke-authorized-runtime.js` 通过实际申请 CLI 和节点 CLI，在真实 Docker 中读取页面资源，撤回或断开控制服务后确认节点退出、容器消失、URL 关闭。既有 Docker/Electron 静态运行与桌面清单审核回归单独运行。

`test/app-runtime-exports.test.js` 另验证桌面原生控制器、私有文件、失效/并发确认、保存失败撤销与旧许可保护。`scripts/smoke-runtime-desktop.js <docker绝对路径> <unix端点> <image-id>` 使用真实 Electron/HTTP/SQLite 和 Docker，确认两级取消零签发（先拒目录选择，再在应用内确认卡片上选「取消」）、实际导出可供节点使用、确认期间撤回拒绝新许可并关闭已有节点，以及 DOM/桌面数据目录未包含已知合成 bearer。签发确认由主进程发到渲染层，在应用内回答，不是系统弹窗；登录、归档和原生目录选择为测试替身，不是真实飞书验收。界面证据见 `evidence/desktop-runtime-confirmation-fixture.png`、`desktop-runtime-narrow-fixture.png`、`desktop-runtime-exported-fixture.png`。

仍需生产发布的明确确认与访问策略、真正的节点身份、独立授权的飞书云盘取包、持久调度/配额/审计、TLS 与员工登录网关、健康切换/回滚、后端与业务数据服务、真实飞书及跨机验收。本机包的独立哈希校验不等于独立获取和验证企业云盘来源。
