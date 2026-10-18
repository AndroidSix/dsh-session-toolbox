# Changelog

创建于 2026-10-17

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。版本号从 `0.1` 起；DSH 宿主接口（`workspaceRegistry` / `sessionPersistence` / `webServer` 服务面与 `~/.dsh/sessions` 布局）在 0.x 期间按 `0.2.0-rc.2` 基线验证，每次官方升级会重验并在此记录。

## 0.1.12

- **迁移/还原后自动刷新会话位置**（不重启、不影响其它会话）：宿主在 `index` 阶段重新读取会话头（`replaceHeaderIndex`）使新位置立即生效；客户端在迁移/还原完成后通过窗口事件通知面板并重新拉取状态。侧栏列表是服务端驱动的快照，因此界面会给出一句明确提示——刷新侧栏即见，而不是静默消失。
- **账本写入前校验文件真实位置**：`ledger` 阶段会读取新位置的日志并确认 `header.cwd === toCwd`，不匹配就以 `publish-missing` 失败，避免「注册表说在 B、字节还在 A」的孤立会话（此前正是这种半完成状态让一个会话从侧栏消失）。
- **迁移失败自动回滚**：`commit` 之后的阶段一旦抛错，立即按逆序回滚到底，不再留下半完成状态；仅当回滚本身也失败时才保留 journal 作为救援指针。

## 0.1.11

- **修复「切换会话到其它项目」总是报 `session … is live`**：此前的判定是「`sessions.list()` 里是否包含该会话」，但那返回的是**宿主已加载的全部会话**，只要文件打开过就算「运行中」，几乎任何会话都无法迁移。现改用官方的 `workspace/session-activity` 事件：只有出现 `{kind:'turn'}`（真正有一轮在跑，含等待审批/回答）才阻止迁移。
- **修复已发送截图仍被重复插回输入框**（0.1.10 未覆盖真实场景）：附件栏探测用的选择器 `[data-composer-bar]` 在官方 UI 中**并不存在**，真实容器是 `[data-composer-seat]`（带 `data-conversation-region="composer"`）。选择器始终落空 → 探测永远得到 0 张卡片 → 发送检测永不触发、恢复时也总认为「输入框是空的」。现已改用真实容器，并同时接受 `blob:` 与 `data:image/` 两种预览源。
- 测试桩改为模拟真实 composer 结构（此前只应答 `conversation-content`，所有探测都走兜底路径，所以测试全绿但真实场景失败）。

## 0.1.10

- **修复已发送的截图在切回会话后被重复插回输入框**。此前判断「已发送」靠附件栏从有到无的跳变：切回会话时附件栏本来就是空的，这个跳变永远不会发生，于是每次切回都把旧图重新粘贴一遍。
  现在记录**明确的「已发送」标记**（`sentAt`），恢复时跳过该标记的记录；触发点有三处——输入框挂载期间附件卡片消失、按回车发送（含快速切走）、以及恢复成功后标记 `seeded` 避免重复派发。新增回归测试：已发送的草稿在切回后不再被恢复。

## 0.1.9

- **修复右键菜单里的迁移对话框没有项目选择**：0.1.8 只给设置页的迁移表单加了项目下拉，而会话行 `⋯` → 「切换到其它项目…」打开的是 `MoveDialog`，那里仍只能手填绝对路径。现在对话框与面板一致：显示当前项目、提供项目下拉（标注会话数与「当前项目」），并可继续手填路径。

## 0.1.8

- **回收站改名并明确语义**：会话的「删除」在 DSH 里本质就是官方归档，插件只是额外记录了入池时的项目归属、列表位置与置顶状态，因此可以还原到原位。界面统一改为「归档池」：菜单项「归档到归档池」、面板标题「归档池」、列名「入池时间」，并在面板里说明它同时出现在官方归档视图中。
- **切换项目支持按名字选择**：迁移表单新增项目下拉（显示项目名与会话数），并**标出当前项目**且禁用它作为目标；选中后自动填入路径。输入会话 ID 后会显示它当前所属的项目（名称 + 路径）。宿主新增 `project.of` 动作与 `state.projects` 列表。

## 0.1.7

- **修复插件页报错 `cannot get property "locale" without inject`**：客户端 `inject` 只声明了 `slots`，却直接读取 `ctx.locale`。cordis 的 reflect 代理对未注入的服务属性访问会抛错（而非返回 undefined），因此插件页无法完成同步。现已在 `inject` 中声明 `locale`，并按官方客户端插件的方式用 `ctx.effect` 包裹字典注册。
- 客户端测试改用与 cordis reflect 一致的**严格 ctx**（未注入即抛错），该用例已验证能拦住本次回归。

## 0.1.6

- **插件启动失败不再拖垮整个应用**：`apply` 全程包裹错误隔离，任何内部异常都降级为警告并继续（此前宿主入口抛错会让 DSH 报 `entry did not activate` 而无法启动）。
- 失败详情写入 `~/.dsh/session-toolbox/startup-error.log`（含完整堆栈），便于定位；依赖缺失时额外提示"从插件页卸载后重新安装"，因为 peer 依赖必须由包管理器安装到插件自己的 `node_modules`，手工覆盖 `lib/` 会丢失它们。
- 无功能变更，纯健壮性修复。

## 0.1.5

- 文档修正：首次安装后若界面无变化，**需要完全重启 DSH**。原因是宿主侧 `dsh-client-modules` 把包元数据的"非客户端包"否定判定按 Loader specifier 缓存到重启，且扫描为逐包增量、无全量重扫路径；此时宿主半边可能已工作（`~/.dsh/session-toolbox/` 已创建），但菜单项与面板不会出现。0.1.4 中"停用再启用即可"的说法不适用于此场景。
- `0.1.4` 曾建议手工改动后停用再启用；该结论对本插件不成立，现已更正。

## 0.1.4

- 文档：新增「生效时机（需要重启吗）」一节，说明从插件页安装/启停不需要重启、四类 `restartReason` 的含义，以及手工改动安装目录后停用再启用即可生效的做法。

## 0.1.3

- 修复草稿图片反复新增：恢复草稿时派发的合成粘贴会被插件自己的捕获器再次存一份，切会话越多份数越多。现在恢复事件带内部标记、捕获器直接忽略；同时按内容哈希做同会话去重，同一张图即使重复粘贴也只保留一份（新增 2 项回归测试）。

## 0.1.2

- 修复与 DSH `0.2.1-rc.2` 的不兼容：此前把官方内部包固定为精确版本 `0.2.0-rc.2`，导致 DSH 升级 rc 后被判为不兼容。改为声明 `engines.dsh`（官方优先判定字段，见 `dsh-app-boot` 的 `unmetRequirements`）+ 区间 peer，覆盖 `0.2.0-rc.2` 至 `0.2.x`；`0.3.0` 起仍会正确判为不兼容。
- 已针对 `@deepseek-ai/dsh-home-paths` / `dsh-atomic-write` `0.2.1-rc.2`、`cordis` `4.0.5` 重跑全部测试（56 项通过）。两版 API 实测一致：`resolveDshHome` / `withFileLock` / `writeFileAtomic` 签名与导出均未变。

## 0.1.1

- 发布渠道改为 GitHub Release 触发的 npm Trusted Publishing：`publish.yml` 与参考项目 `dsh-multi-router` 对齐，显式安装 `npm@11.19.0`、由版本后缀推导 `NPM_TAG`（稳定版 `latest` / 预发布 `next`），全程 OIDC 签名，仓库不存任何 npm token。
- 版本一致性校验扩展为四重：tag ↔ `package.json` ↔ `package-lock.json` ↔ `cordis.patch.yml` 中的 `host-vX.Y.Z.js`，任一处漂移即拒绝发布。
- 本版本无功能变更，用于激活并验证 Trusted Publisher 绑定后的自动发布链路。

## 0.1.0

- 首个版本：合并交付三个能力位（需求文档 §1–§11）。
- 草稿保险箱：capture 旁观粘贴/拖拽/文件选择，图片镜像进 IndexedDB（默认 7 天 / 200MB，TTL+LRU 清理，事件可见）；切会话、刷新、重启后向官方粘贴管线重放合成 ClipboardEvent 恢复，附件栏非空即跳过（幂等），发送或清空即回收备份；宿主侧仅存清单镜像。
- 会话切换项目：分步 journal（备份→重写→发布→账本→缓存→索引），只重写 zstd 会话日志的 header 帧、事件帧逐字节搬运；崩溃后启动检出，可前滚可逐字节回滚；体检 fail-closed（忙会话/未知会话/同目标/目录不存在/布局漂移/重复布局全部拒绝并说明原因）；同进程 header 缓存未刷新时账本记为 deferred，由下次启动或 move.complete 收敛。
- 回收站：会话删除=官方归档+入站快照（含 previouslyArchived/pinned 与列表位置），还原逐状态收敛且幂等；项目删除=官方 delete（保留会话日志）+标题/顺序快照，还原走 create/attach/insertBefore/unarchive；彻底删除分两段（pending-purge 暂存→清缓存/账本→落刀）；TTL 巡检默认只提醒，autoPurge 可开。
- 宿主插件经真实 cordis v4 内核生命周期测试；UI 走官方插槽（plugins.bundle.config、sidebar.workspaces.session.menu.item、conversation.input.dock）；缺失服务在面板显示不可用，不影响官方原生行为。
- loopback 管理端点沿用 dsh-multi-router 信任模型：仅 127.0.0.1/::1、Host/Origin/Sec-Fetch-Site 校验、GET 下发每进程随机写密钥、timing-safe 比对、请求体上限。
- CLI：status / move / recover / rollback / trash-purge，面向 DSH 停止时的离线维护与中断迁移救援。
