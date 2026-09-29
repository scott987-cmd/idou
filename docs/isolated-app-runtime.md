# 独立静态应用运行节点

当前交付是可实跑的**开发验收入口**，不是企业发布平台。运行节点不依赖妙搭或 Cloudflare，不接收模型调用，不在控制服务中执行应用。桌面现有归档预览继续独立工作；尚未添加「发布成功」按钮或共享企业访问地址。

另已接入[服务端控制的短期运行验收授权](app-runtime-authorization.md)：独立操作员、指定版本/归档/镜像/节点、一次性领取及持续在线检查。`--authorized` 使用该路径；下文 `--development` 保留为显式本机管理员诊断，不能替代企业授权。

## 已接通的路径

管理员提供不可变版本包及清单/包 SHA-256 → 独立运行节点启动固定镜像 → 容器从私有 stdin 管道接收包、独立验证完整规范和全部文件哈希 → HTTP 网关按清单请求容器中的静态字节 → 再次验证响应哈希 → 浏览器运行静态页面。

应用脚本仅在浏览器执行。容器里的受信任 worker 不执行、导入或解压应用脚本，没有安装依赖、运行构建命令或提供后端执行能力。此阶段的容器验证不能替代源码安全审查，也不能证明来源有发布授权。

入口 `bin/app-runtime.js` 与控制服务/桌面启动分离。输入是管理员放置的本地包，不会独立从飞书取包。不得把作者提供的哈希当作企业发布许可；未来需要发布服务验证作者、审核、目标受众、归档来源和当前权限，再下发有期限的版本运行许可。

## 运行与数据边界

- Docker CLI 必须是绝对路径，端点必须是显式本机 Unix socket；运行镜像仅接受完整 `sha256:` image ID。镜像缺失就失败，不拉取或回退标签。
- 启动采用非 root UID/GID 1000、只读根文件系统、无挂载/端口映射、无外部网络、无共享 IPC/PID、删除全部 capabilities、no-new-privileges、默认 seccomp。内存与 swap 总上限均为 256 MiB，CPU 0.5 核，PID 32，文件描述符 128。
- 运行后检查实际 Docker inspection 里的核心隔离策略，不只依赖请求参数。开发验收还在真实 Linux 容器读取 `/proc`/cgroup，并探测文件写入和 TEST-NET 出网失败。
- Docker 子进程仅继承固定 PATH/LANG，使用独立临时 CLI 配置；不传模型密钥、飞书授权或宿主目录。容器禁用日志驱动。包仅通过管道进入内存，不写入运行镜像。
- 包上限 15 MiB，沿用现有静态清单的文件类型/路径/数量/大小限制。stdin/stdout 使用有长度上限的 JSON frame，不把包拼入 shell 参数；读取限制为最多 16 个待处理请求，各请求 5 秒超时。
- 网关仅绑定 `127.0.0.1` 随机端口和随机 capability 路径，检查 Host/Origin，只接受 GET/HEAD；只返回清单内的、大小与哈希一致的字节。关闭或过期后，未完成读取也不能继续交付。
- 生命周期最长 5 分钟。显式关闭、超时、容器退出或协议失败都会关闭网关、拒绝待处理请求，并清理本次拥有的容器。删除前校验随机 owner 标签、镜像和精确容器 ID；不匹配则报错，不删除其他容器。Docker 不可达时不能宣称清理已确认。
- Docker daemon/CLI/固定镜像均属于管理员受信任边界；Unix socket 是高权限接口，不能暴露给生成应用。容器共享宿主内核，未作渗透测试或安全认证。
- 容器禁网不等于最终用户浏览器全通道禁网。页面使用静态 CSP，Electron 验收入口另禁跨源导航、弹窗、权限和 Node 集成；WebRTC、扩展、所有浏览器侧外传通道不在当前证明范围。正式发布需要独立安全域、浏览器策略与租户访问网关。

## 管理员开发验收

先准备可用的本机 Linux Docker daemon。构建脚本只复制四个受信任模块、Dockerfile 和最小 package.json 到一次性上下文，不发送整个工作区。

```sh
node scripts/build-app-runtime.js /absolute/path/to/docker
```

基础镜像在 Dockerfile 按官方 Node 22.22.2 Alpine 摘要固定：`node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`。基础镜像获取是显式构建/管理员步骤，不是应用启动步骤。更新基础镜像需要安全维护、重新构建并回归，当前没有自动更新或漏洞扫描声明。使用构建输出的 image ID 配置运行节点：

```json
{
  "dockerPath": "/absolute/path/to/docker",
  "endpoint": "unix:///absolute/path/to/docker.sock",
  "imageId": "sha256:<构建输出的64位十六进制摘要>"
}
```

配置与包必须是当前用户拥有的私有普通文件（POSIX 不允许组/其他用户权限），使用绝对路径，不接受符号链接。包可由既有版本候选流程生成，不把工作目录当作已校验归档。

```sh
node bin/app-runtime.js --development /absolute/runtime.json /absolute/application.json <manifest-sha256> <package-sha256>
```

输出临时 URL、容器 ID、版本摘要，明确包含 `developmentOnly:true` 与 `deployed:false`。Ctrl+C / SIGTERM 触发关闭；不自动打开浏览器或修改企业目录。URL 是本机临时访问能力，不可作为持久共享链接。

合成端到端验收（创建并清理本次容器；启动实际 Electron）：

```sh
node scripts/smoke-app-runtime.js /absolute/path/to/docker unix:///absolute/path/to/docker.sock sha256:<image-id>
```

覆盖静态资源、真实隔离、浏览器计数按钮、错误包、手动关闭、过期、容器异常、CLI 信号退出；没有真实飞书或模型调用。截图 `evidence/isolated-static-runtime-fixture.png` 是合成页面。

## 尚未完成

生产发布策略和短期节点授权、独立且有权限的云盘取包、任务队列与租户调度、源码/依赖安全审核、隔离构建及后端运行、企业登录网关/域名/TLS、原子版本切换/健康检查/回滚、业务数据服务、跨机器部署与监控。现有清单审核结论仍不是发布许可；这些缺口不能用本地 Docker 验收代替。
