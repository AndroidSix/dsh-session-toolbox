# DSH Session Kit

草稿保险箱 · 会话切换项目 · 回收站 —— 三个 DeepSeek Harness（DSH）会话管理增强，装进同一个插件。

创建于 2026-10-17 · MIT · 只作为第三方插件运行，**不修改官方安装包**。

DSH 0.2.0-rc.2 的会话有三个「官方没做」的缺口：粘贴的截图草稿只活在内存里（切会话/刷新/重启即丢）；会话与项目在创建时绑死（聊到一半发现该在别的项目里继续，只能重开）；「删除」没有后悔药（归档不是回收站，删掉的项目注册表找不回标题与顺序）。Session Kit 用运行时探测 + 官方公开服务面补齐这三块，全部数据只存本机。

```
┌────────────────────────────────────────────────────────────┐
│  DSH Web UI                                                │
│  ├ 输入区徽标：🛟 草稿备份 N ── 图片草稿已镜像到 IndexedDB │
│  ├ 会话右键：切换到其它项目… / 移入回收站                  │
│  └ 插件页：工具箱（开关、迁移向导、回收站列表）            │
├────────────────────────────────────────────────────────────┤
│  dsh-session-kit (client bundle)                            │
│        │  /.well-known/dsh-session-kit (loopback, 随机密钥) │
│  dsh-session-kit (host plugin, cordis)                      │
│    ├ draft manifest mirror  ~/.dsh/session-kit/             │
│    ├ move journal + trash ledger                            │
│    ├ 会话日志 zstd 帧手术（仅重写 header 帧）               │
│    └ 官方服务：workspaceRegistry / sessionPersistence /     │
│        sessions / webServer —— 全部 ctx.get 运行时探测      │
└────────────────────────────────────────────────────────────┘
```

## 功能

### 1. 草稿保险箱（draft-vault）

粘贴 / 拖拽 / 文件选择器进入输入框的图片，会同步镜像一份到浏览器 IndexedDB（默认 7 天、200MB，超限按最旧清理）。切换会话、刷新页面、重启 DSH 后回到该会话，文本草稿（官方本就持久化）和图片草稿一起回来，走的是官方粘贴管线重建——删除、发送行为与手动重新粘贴完全等价。

- 捕获在 capture 阶段只读旁观，从不拦截官方事件；
- 恢复是向编辑器重放一个携带合成 `clipboardData` 的 `paste` 事件，官方处理器的 `preventDefault` 即接受回执；
- 只在附件栏为空时重放，天然幂等；发送成功或手动删光后，备份随附件栏清空一并回收。

### 2. 会话切换项目（session-move）

把任意**空闲**会话（完整历史）从项目 A 迁到项目 B：会话日志头部的 `cwd`、`~/.dsh/sessions/` 的物理目录、Workspace 归属账本、投影缓存与检索索引一次收敛，迁移后会话出现在 B 里，继续对话时工具、沙箱根、AGENTS.md 都按 B 生效。

- **只重写 zstd 首帧**：DSH 的会话日志是「header 帧 + 每个事件一帧」的多帧结构，迁移仅重编码 header 帧并原样搬运其余全部帧——200MB 的日志也是秒级，且事件字节逐帧保持不变；
- **journal 崩溃安全**：备份→重写→发布→账本→缓存分步落账，任何一步被打断，重启后插件能检出并「完成」或「回滚」，回滚逐字节恢复原文件；
- **体检 fail-closed**：忙会话、归档会话、重复布局、编码规则漂移（官方升级改了目录编码）都会明确拒绝，不动任何文件；
- 已知语义：历史消息里写死的绝对路径仍指向 A（不重写过往内容）。

### 3. 回收站（trash-bin）

- **删除会话** = 官方归档 + 记账。归档保留列表位置，取消归档原位恢复——这些官方语义直接复用；回收站只认「自己放进去的」，你手动归档的收藏区永远不会被误弹出来。还原时连 pin 状态一起恢复。
- **删除项目** = 官方 delete（本就只删注册、保留全部会话日志）+ 标题/顺序快照，一键还原。
- **彻底删除**：官方没有硬删命令，插件分两段执行（先原子移入 `pending-purge/`，清缓存/清账本，再落刀），中断可检出；共享附件库（内容寻址）不动。

## 安装

要求：DSH ≥ 0.2.0-rc.2（Node 22.19+ / 24 由 DSH 自带）。

**方式一：GitHub 链接（首选）**

DSH 内：侧栏 → 插件 → 安装 → 仓库地址：

```
https://github.com/AndroidSix/dsh-session-kit.git
```

`lib/` 随发布分支提交，DSH 直接加载构建产物，无需本地构建；启用后即时生效（HMR 可用时热载，否则重启一次）。

**方式二：本地构建**

```bash
git clone https://github.com/AndroidSix/dsh-session-kit.git
cd dsh-session-kit && npm ci && npm run build
# DSH 插件页 → 本地目录 → 选择该仓库目录
```

> npm 渠道说明：npm 上 `dsh-session-kit` 名称已被一个无关旧包占用；本项目的 npm 发布暂未启用（`.github/workflows/publish.yml` 保留但改为手动触发），待确定作用域名（如 `@androidsix/…`）后再开放。GitHub 安装路径不受影响。

安装后打开 侧栏 → 插件 → Session Kit 详情 即为工具箱页面；会话行的「⋯」菜单出现「切换到其它项目…」与「移入回收站」；输入区出现 🛟 徽标。

## 数据放在哪

| 内容 | 位置 |
|---|---|
| 图片草稿字节 | 浏览器 IndexedDB（`dsh-session-kit-vault`，仅 DSH Web 视图可见） |
| 草稿清单镜像 / 设置 / 迁移 journal / 回收站账本 | `~/.dsh/session-kit/`（0600/0700，原子写 + 文件锁） |
| 会话日志与项目账本 | 官方原位置（`~/.dsh/sessions/…`、`workspace.json`），插件仅在迁移/彻底删除时按其格式改写 |

隐私：全部本机，无任何外部上传；loopback 端点仅接受 127.0.0.1/::1、校验 Host/Origin/Sec-Fetch-Site，写操作需每次 GET 下发的随机密钥（timing-safe 比对）。

## 配置

`~/.dsh/session-kit/session-kit.json`（也可在工具箱页面里改，改文件需重启 DSH）：

```jsonc
{
  "version": 1,
  "draftVault": { "enabled": true, "maxSizeBytes": 209715200, "ttlDays": 7 },
  "trash": { "ttlDays": 30, "autoPurge": false },
  "move": { "enabled": true }
}
```

宿主插件入参（`cordis.patch.yml` 的 `options`）：`configFile`（数据目录覆盖）、`dshHome`（多实例/测试环境用）。

## CLI

`dsh-session-kit` 命令面向「DSH 已停止」的离线维护与救援：

```bash
dsh-session-kit status                                   # 当前设置/journal/回收站
dsh-session-kit move --session <id> --to <绝对路径> [--create] [--dry-run]
dsh-session-kit recover                                  # 检出中断迁移并前滚，失败则回滚
dsh-session-kit rollback
dsh-session-kit trash-purge --item <itemId>
```

CLI 直写 `~/.dsh/storages/workspace.json` 的离线镜像；日常操作请优先在 DSH 面板里做（宿主内存索引同步更准确）。执行 CLI move 前请完全退出 DSH（关窗口不等于退出），完成后重启。

## 工作原理（为什么敢动官方文件）

迁移的时序设计（§10 MN1）：备份 → 生成「头已改好」的新日志并 fsync → **旧目录整体退役** → 新目录发布 → 账本 detach/create/attach → 删投影缓存（官方缓存语义：过期记录只会多一次重放，绝不产生错误值）→ 检索索引自愈。全程任何时刻 `sessions/` 下同一个会话 id 至多出现在一个项目目录里，官方扫描看不到半迁移态；`attachSession` 的「header cwd 必须等于 workspace path」校验在发布之后天然成立。

同进程内 header 缓存来不及刷新时（迁移刚完成立刻 attach 会撞上旧 cwd），账本步骤标记为 deferred、journal 保留为收敛标记——下次启动或点「完成」时冷缓存下重跑一遍即收敛。

## 开发与验证

```bash
npm ci && npm run check     # build + 58 项测试 + 包形态门禁
```

测试不需要 DSH 运行：会话日志用真实格式的**多帧带校验和 zstd** 合成夹具（`tests/fixtures/`），路径编码直接从官方 `dsh-session-persistence-jsonl` 逐字复刻并对样本自校验；`tests/kernel.test.mjs` 在**真实 cordis v4 内核**里加载插件走完整生命周期（provide/inject/effect/dispose）；`tests/draft-vault.test.mjs` 用「官方处理器契约双身」（读 `clipboardData.items`→`getAsFile`→`preventDefault`）验证合成粘贴的接受性。

## 失效模式

官方升级导致探测不到必需服务时：对应功能在面板里显示「不可用」并给出原因，其余功能与官方原生行为照常——插件不会让输入区或列表变白屏。卸载插件同样安全：已迁移的会话不依赖插件存在，回收站里未处理的项目降级为「官方归档/未注册」状态且数据无损。

## 许可与免责声明

MIT。与 DeepSeek 官方无关；不修改官方安装包，只读写 DSH 自己的用户数据目录。删除类操作请先阅读 [DISCLAIMER.md](DISCLAIMER.md)。上游设计参考与第三方代码声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢与来源

需求分析与官方实现证据整理自会话内调研（DSH 0.2.0-rc.2 安装包代码核对）。工程形态（cordis 双产物、版本化入口热替换、loopback 信任模型、发布流程）参考并致谢 [dsh-multi-router](https://github.com/AndroidSix/dsh-multi-router)，本项目与其同作者、同许可。
