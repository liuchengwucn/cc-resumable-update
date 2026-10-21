# cc-resumable-update

[English](README.md) | 简体中文

一个 Claude Code mod，适合关闭了自动更新、但仍想及时得知新版本的用户。

- **新版本提醒**：你所在的频道（默认 `stable`）发布更新版本时，输入框上方会出现一条横幅。启动时检查一次，之后每 6 小时检查一次。
- **更新内容摘要**：截取当前版本与新版本之间的更新日志，由 Haiku 按你的 `language` 设置所指定的语言总结。
- **一键升级**：下载支持断点续传。连接中断后只需补齐剩余部分，不必重新下载整个二进制文件。

未经你点击确认，mod 不会安装任何内容：横幅会先显示下载大小，请你确认。

## 为什么需要它

Claude Code 自带的安装器（截至 2.1.304）下载失败后会从头重新下载。在网速慢或按流量计费的网络下，临近完成时连接中断一次，之前下载的数据就全部作废。本 mod 改用 `curl -C -` 下载，用发布清单（manifest）校验结果，再调用 `claude install <版本>` 链接这个已校验的二进制文件，不再重复下载。

## 安装

在终端会话的输入框中输入：

```
/plugin install cc-resumable-update --marketplace liuchengwucn/cc-resumable-update
```

## 使用

- 有新版本时横幅会自动出现。**Upgrade** 先显示下载大小并请你确认；**What's new** 在侧边面板中打开更新日志摘要；**Skip this version** 隐藏横幅，直到下一个版本发布。
- `/check-update` 立即检查一次，并取消之前跳过的版本。

### 配置项

| 配置项 | 可选值 | 默认值 |
| --- | --- | --- |
| `channel` | `stable`、`latest` | `stable` |

## 升级流程

1. 读取 `manifest.json`（`PATH` 中有 `zstd` 时还会读取 `manifest.zst.json`），获得本平台的校验和与文件大小。
2. 下载 zstd 压缩版（约为原大小的三分之一）；没有 `zstd` 时下载未压缩的二进制文件。文件保存在安装器的 versions 目录 `$XDG_DATA_HOME/claude/versions/` 中（默认为 `~/.local/share/claude/versions/`，Windows 上为 `%USERPROFILE%\.local\share\claude\versions\`），文件名为 `.<版本>.<平台>[.zst].partial`。目录中已有未下完的文件时，会从断点继续下载；同时用一个锁防止两个 Claude Code 会话同时下载同一个版本。
3. 用发布清单校验下载文件的 SHA-256，解压后再校验一次二进制文件的 SHA-256。下载文件校验失败会被删除；已通过校验的下载文件在解压失败时会保留，重试时直接重新解压。
4. 将文件移动到该目录下的 `<版本>`（在 macOS 和 Linux 上加可执行权限），然后运行 `claude install <版本>`。安装成功后，会删除其他版本遗留的未完成文件。

通过包管理器（Homebrew、npm、WinGet）安装的用户同样会收到提醒和摘要，但不会看到 Upgrade 按钮，横幅会提示运行 `claude update`。

### 环境要求

- **macOS 和 Linux**：`curl`，以及 `sha256sum` 或 `shasum`。
- **Windows**：`curl.exe`（Windows 10 1803 及以后版本自带）和 Windows PowerShell，后者负责计算哈希和移动文件。
- **所有平台可选**：`PATH` 中的 `zstd`，可将下载量减少到约三分之一。

### 注意事项

第 4 步依赖 native 安装器的一个行为：如果 versions 目录中已有校验和正确的二进制文件，它会直接复用。这一行为没有官方文档说明。[`installer-reuse`](.github/workflows/installer-reuse.yml) workflow 每周在 Windows、macOS 和 Linux 上检查一次，每次升级时也会检查：如果 `claude install` 替换了这个文件而不是复用它，安装完成后横幅会给出提示。这种情况下升级仍会成功，只是需要下载完整的文件。

## 网络与隐私

- `downloads.claude.ai`：频道版本号、发布清单和二进制文件。
- `raw.githubusercontent.com`：公开的 Claude Code 更新日志。
- 每个新版本调用一次 Haiku，通过你自己的 Claude Code 会话发起。结果会缓存，同一对版本不会重复总结。

## 许可证

MIT
