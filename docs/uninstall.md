# 卸载 i豆（macOS）

卸载分两部分：服务端上的东西，和这台电脑上的东西。

## 1. 先处理服务端上的东西

这些不在你的电脑上，删掉应用也不会消失。趁应用还在，先在里面处理：

- **定时任务**：在「定时任务」里删掉不再需要的任务。
- **无人值守授权**：如果开过，在「定时任务」页面上方撤销。撤销不会取消飞书那边对本应用的授权，那一步要去飞书「设置 → 应用授权」里做。
- **发布的网站**：在「文档网站」里下线你发布的网站。
- 最后在应用里退出账号。

## 2. 再处理这台电脑上的东西

用仓库里的脚本（先只列出，不动手）：

```bash
node scripts/uninstall-mac.js
```

确认列出的内容后，真正执行（先退出 i豆，⌘Q）：

```bash
node scripts/uninstall-mac.js --apply
```

- 文件夹都**移到废纸篓**，不直接删除；清空废纸篓之前都能放回。
- 钥匙串项「i豆 Safe Storage」（2026 年 9 月以前的安装是「我的豆包 Safe Storage」）会被**删除**。删掉以后，应用加密保存的内容（设备身份、登录凭据、知识库副本）就再也读不出来了，放回废纸篓里的文件也一样。
- 系统给它的隐私权限（辅助功能、屏幕录制、自动化）会被重置。
- **任务文件夹**（`~/i豆`，或 `~/我的豆包`）里是你放进去的文件和产出的结果，默认保留。要一起移到废纸篓，加 `--task-folders`。

### 没有仓库时手动卸载

1. 退出 i豆（⌘Q），把 `/应用程序/i豆.app` 拖到废纸篓。
2. 把下面这些（有的话）拖到废纸篓：
   - `~/Library/Application Support/i豆`：账号、对话记录、Codex 的完整记录、知识库副本、内嵌飞书的登录、设备身份。
   - `~/.idou`：本机设置、会话租约、命令行工具的数据。
   - `~/Library/Caches`、`~/Library/HTTPStorages`、`~/Library/Saved Application State` 里名字带 `i豆` 或 `io.github.scott987-cmd.idou` 的项，以及 `~/Library/Preferences/io.github.scott987-cmd.idou.plist`。
   - 2026 年 9 月以前的安装，名字是 `我的豆包`、`~/.mydoubao` 和 `com.mydoubao.desktop`。
3. 打开「钥匙串访问」，删除「i豆 Safe Storage」（或「我的豆包 Safe Storage」）。
4. 重置隐私权限：

```bash
tccutil reset All io.github.scott987-cmd.idou
```

### 代码仓库里留下的回退点

编程任务会在你的 git 仓库里保存回退点。它们不是分支，平时看不到。要清掉，在对应仓库里运行：

```bash
git for-each-ref --format='%(refname)' refs/idou/checkpoints refs/mydoubao/checkpoints
```

确认列出的都是这些回退点后，逐个用 `git update-ref -d <上面列出的名字>` 删除。
