<p align="center">
  <img src="docs/images/banner-zh.png" alt="Tomrade：红太阳前的猫。从想法到交付，并肩作战。不用盯着；长期需求池；看得见、撤得回；日常事务也能管。" width="820">
</p>

<p align="center">
  <a href="https://tomrade.com/zh/">官网</a> ·
  <a href="https://tomrade.com/zh/download">下载</a> ·
  <a href="#接入你的-agent">接入 Agent</a> ·
  <a href="#从源码构建">从源码构建</a> ·
  <a href="https://github.com/haoyuant/tomrade-plugins">插件</a> ·
  <a href="#支持作者">💖 支持作者</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="许可证：Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-a83c32"></a>
  <img alt="平台：macOS、Windows、Linux" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-5b4636">
  <img alt="状态：测试版" src="https://img.shields.io/badge/status-preview-d9a441">
</p>

# Tomrade

**从想法到交付，并肩作战。**

工单、终端、会话、笔记，Tomrade 无缝衔接你所需的功能，主动禀告。你，纵享丝滑。这是一个本地优先的工作区，给用 AI Agent（Claude Code、Codex 等）做东西和管理日常事务的独立开发者和小团队。

- **不用盯着。** Agent 自己认领工单、开分支、汇报进度。只有要你拍板的时候，它们才来找你。
- **长期的需求池。** 想法、工单、决定和已经做完的事，跨会话、跨 Agent 都放在一处，下一次运行从上一次停下的地方接着做。
- **不用换工具。** Agent 照旧在你自己的终端里跑。Tomrade 通过 MCP 和 git 连上它们，看板自己跟上进度。
- **看得见、撤得回。** Agent 的每一次写入都有署名，按运行归组，一键整个撤回。
- **一处管齐。** 文件和笔记、日常待办、收件箱里的反馈，都和工单放在一起，Agent 也读得到。

<p align="center">
  <a href="https://tomrade.com/zh/#films"><img src="docs/images/film-zh.jpg" alt="播放 87 秒演示片：一个想法变成串起来的工单，Agent 们排队提问，夜里自动执行，一键全部撤销。" width="820"></a><br>
  <sub>Tomrade 的一天，全部是应用里的真实画面。更多短片在 <a href="https://tomrade.com/zh/#films">tomrade.com</a>。</sub>
</p>

<p align="center">
  <img src="docs/images/board-zh.png" alt="Tomrade 看板：左侧是视图和工作流，中间是待办和进行中的工单卡片，右侧是助手面板。" width="900">
</p>

> [!NOTE]
> **测试版。** 1.0 之前 Tomrade 还在开发测试中，功能每周都在变，难免有不完善的地方。你的项目就是自己硬盘上的普通文件夹，重要的请自行备份。

## 怎么用

从一个想法到合并的 PR，就这一个循环：**聊、拆、做、合。**

1. **聊。** 用大白话说你想要什么，在电脑前或者用手机都行。它会变成看板上的一张工单。
2. **拆。** 说一句「整理一下」，助手合并重复、把大单拆成一个 PR 就能做完的工单。不满意一键撤回。
3. **做。** 点**开始**，或者在你自己的终端里把工单号报给 Agent。它自己认领、在自己的分支上干活，再把进度报回来。
4. **合。** 检查通过后，你看一眼点**合并**，或者让 Agent 自己合并。自动执行可以在夜里顺着依赖图这样做完，早上给你一份早报。

## 都有什么

- **🌙 自动执行。** 在依赖图上选好工单，设好上限（同时几张、最多花多少钱），你去睡。没你允许、检查没通过，什么都不会合并。
- **🖥️ 看板旁边的终端窗口。** 分屏跑 Claude Code、Codex 或普通 shell；每个窗格标着运行中还是需要你，退出 Tomrade 后 Agent 照样在干。基于 [herdr](https://herdr.dev)；Windows 上用 Tomrade 自带的终端后端。
- **💬 Tomrade 里的事都能问助手。** 工单、文件、笔记、设置，大白话说就行。它做的每处改动都有署名、能撤销。
- **📓 文件和笔记。** 每个项目一个文件夹：Markdown、`[[双链]]`、`#标签`、全文搜索、每日日记，带版本历史，能同步到 GitHub。
- **📱 手机上发消息。** 在 Discord、Slack、Telegram、飞书 / Lark、钉钉或企业微信里找助手，由你的电脑直连，不经过我们的服务器。
- **📥 反馈收件箱。** GitHub issue 和其他来源先进收件箱，助手分好类、拟好回复，你点确认。
- **✏️ 一句话画图。** 内置 [Archify](https://github.com/tt-a1i/archify)：架构图、流程图、时序图等，生成可交互的页面，想改接着说。
- **🧩 一切皆插件。** 存储、工具、MCP 服务、助手，每一块都能替换。用 Apache-2.0 的 SDK 写你自己的插件，或者让 Agent 在 Plugin Studio 里替你写。官方插件在 [tomrade-plugins](https://github.com/haoyuant/tomrade-plugins)。
- **🐱 还有一只猫。** 桌宠替你盯着 Agent 在干什么，状态栏里还有番茄钟。

**不只是写代码。** 每个项目都是一块看板加一个文件夹：可以连上代码仓库，也可以只装下你这一周的生活。跑腿、日记、文档，还有能定时自己跑的例行事务（每日待办、每周家务）。

**让 Agent 跑得快，又不踩到你。** 项目文件夹才是真相，SQLite 只是缓存。你锁定的字段不会被覆盖，基于过期数据的写入一律拒绝。模型自己选（DeepSeek、Anthropic、OpenAI、Gemini、Kimi、OpenRouter、任何 OpenAI 兼容接口或本地模型），也可以让你自己的 Claude Code 或 Codex 来主导。不用注册账号；匿名使用统计在设置里有独立开关，具体收集什么见[数据使用与隐私说明](docs/data-privacy.zh-CN.md)。

## 安装

免费使用，支持 macOS、Windows 和 Linux：**[tomrade.com/zh/download](https://tomrade.com/zh/download)** 或 [GitHub Releases](https://github.com/haoyuant/tomrade/releases)。

| 系统 | 安装包 | 说明 |
|---|---|---|
| macOS 12+（Apple 芯片或 Intel） | `.dmg` | 已签名并经过 Apple 公证。 |
| Windows 10 / 11，64 位 | `.exe` | 暂未签名：点 **更多信息 → 仍要运行**。开着智能应用控制的话，先看[下载页](https://tomrade.com/zh/download)的说明。另见[代码签名政策](https://tomrade.com/zh/code-signing/)。 |
| Linux，x86-64 或 arm64 | `.AppImage` | `chmod +x` 后运行；系统完全没有 FUSE 时，加 `--appimage-extract-and-run`。 |

装好后会检查更新，你同意了才安装。界面支持 English、简体中文、繁體中文、日本語、Español、Deutsch、Français 和 Русский。

## 接入你的 Agent

Tomrade 在本机运行一个 MCP 服务，地址是 `http://127.0.0.1:19090/mcp`，只监听 127.0.0.1。

**省事的办法：** 在项目里打开代码仓库，连接编程 Agent，可以选仅本机，也可以选为团队（提一个 PR）。Claude Code、Codex、Cursor、Gemini CLI、OpenCode、WorkBuddy 和 Pi 的配置它都会写好，再附上怎么认领工单、怎么同步回来的说明。细节见 [`docs/agent-connections.md`](docs/agent-connections.md)。

**手动配置**，适用于任何支持 Streamable HTTP MCP 的 Agent：

```sh
claude mcp add --transport http tomrade http://127.0.0.1:19090/mcp
```

```json
{ "mcpServers": { "tomrade": { "type": "http", "url": "http://127.0.0.1:19090/mcp" } } }
```

接上之后，你的 Agent 拿到的工具和助手一样（`list_items`、`create_item`、`claim_ticket`、`link_code`、`search_files`……），也守同一套规矩：有署名、带版本、可撤销。

## 支持作者

Tomrade 是我一个人下班后做的，免费用。现在活基本都是 Agent 在干，它们吃 Token 还是自助餐那种吃法。你的支持会变成 Token，Token 变成 PR，PR 变成下周的新版本。

- ⚡ [爱发电](https://afdian.com/a/haoyuant)
- 💖 [GitHub Sponsors](https://github.com/sponsors/haoyuant)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/tomrade)
- 支付宝 / 微信：

<p>
  <img src="docs/images/support/alipay.png" alt="支付宝收款码" height="200">
  <img src="docs/images/support/wechat.png" alt="微信赞赏码" height="200">
</p>

白嫖也完全没问题，提个 issue、跟朋友安利一句，我一样开心。

## 从源码构建

需要 Node.js（CI 用的是 26）和 pnpm 11（`corepack enable` 会用仓库锁定的版本）。

```sh
git clone https://github.com/haoyuant/tomrade.git
cd tomrade
pnpm install
pnpm dev          # 先构建后端，再启动 Vite + Electron
```

用 `pnpm dev` 跑起来的开发版有自己独立的数据，MCP 端口是 **19091**，可以和安装版同时运行。

```sh
pnpm typecheck     # 先后端，再 UI
pnpm test          # 所有包的 vitest
pnpm test:related  # 只跑和你的改动有关的测试
pnpm --filter @tomrade/desktop package   # 打安装包
```

代码在哪：`apps/desktop`（Electron 外壳）、`packages/ui`（React 渲染进程）、[`packages/*`](packages/README.md)（内核和各个插件）、[`docs/architecture.md`](docs/architecture.md)、[`docs/plugin-api.md`](docs/plugin-api.md)、[`docs/testing.md`](docs/testing.md) 和 [`CONTEXT.md`](CONTEXT.md)（领域术语，均为英文）。

## 参与贡献

欢迎提 issue 和 PR，细节见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；安全漏洞请按 [`SECURITY.md`](SECURITY.md) 私下报告。简单说：能做成插件就做成插件，所有面向用户的文案都走 `t(...)` 并写中英文，注释只写「为什么」，开 PR 前跑一遍 `pnpm typecheck` 和 `pnpm test:related`。

Tomrade 是用 Tomrade 开发的：仓库里的 Agent 配置指向维护者的需求池，你的电脑上没有它的话，Agent 照常干活。感谢[一路同行的人](https://tomrade.com/zh/thanks/)。

## 常见问题

**只给程序员用吗？** 不是。看板、助手和文件对任何项目都适用：家务、旅行、论文、日记都行。

**数据存在哪？** 每个项目一个普通文件夹，就在你的电脑上。登录账号只同步偏好设置和项目列表。

**有手机 App 吗？** 在路上了。在那之前，只要电脑上的 Tomrade 在跑，就能在聊天软件里给助手发消息。

## 许可证

[Apache License 2.0](LICENSE)：应用、所有包和插件 SDK 都一样。随便用、随便改、随便发布，商用也行；插件归你，用什么许可证都可以。唯一不授权的是 Tomrade 的名字和 logo。

<p align="center"><sub>多交付，少审批。做一只嚣张的猫。🐱</sub></p>
