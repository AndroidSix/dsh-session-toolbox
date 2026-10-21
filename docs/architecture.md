# 架构说明 / Architecture Notes

创建于 2026-10-17

更新于 2026-10-19，对应插件 0.1.23。用户操作步骤见 [使用指南](usage.md)，公开图片与视频的脱敏约定见 [素材说明](media/README.md)。

面向维护者的模块地图；需求条目（§=《dsh-image-draft-persistence-需求》）在括号内标注。

```
┌────────────────────────── 浏览器（DSH Web 视图） ──────────────────────────┐
│ client.jsx (cordis 插件, inject:['slots'])                                  │
│  ├ KitPage          插件详情页：交流群 / 开关 / 项目管理 / 迁移 / 归档池      │
│  ├ GroupedSidebar   sidebar.mjs：装饰原生侧栏，分组过滤与子插槽镜像         │
│  ├ GroupsDialog / WorkspaceDialog  分组管理、项目名称与路径编辑             │
│  ├ 菜单项           sidebar.workspaces.session.menu.item（MR6/TB2）          │
│  ├ VaultBadge       conversation.input.dock（FR5）                           │
│  └ draft-vault.js   capture 旁观 → IndexedDB → 合成 paste 重放（FR1/FR2/FR3）│
│        │ fetch /.well-known/dsh-session-toolbox（loopback + 每进程随机密钥）     │
└────────┼───────────────────────────────────────────────────────────────────┘
         ▼
┌────────────────────────── 宿主（Node, cordis） ────────────────────────────┐
│ index.mjs   apply(): 能力探测（ctx.get）+ provide('sessionToolbox') + 路由注册   │
│ api.mjs     loopback 处理器与命令词表（与 CLI、测试共用 dispatch）           │
│ move.mjs    MoveEngine：journal 分相（backup/rewrite/commit/ledger/         │
│             projcache/index），preflight fail-closed，rollback/complete     │
│ trash.mjs   TrashEngine：官方归档/delete 组合 + 账本快照 + 两段式 purge      │
│ workspace.mjs  分组持久化、项目编辑、多会话迁移进度与中断恢复               │
│ session-log.mjs  zstd 帧 walk（官方 scanZstdFrames 等价复刻）+ 仅重写首帧    │
│ paths.mjs        projectKey/encodeSegment 复刻 + verifyEncoders 布局自检     │
│ store.mjs        JsonDocument（withFileLock+writeFileAtomic，0600/0700）     │
│ cli.mjs          离线维护（DSH 停止时）：status/move/recover/rollback/purge  │
└────────────────────────────────────────────────────────────────────────────┘
```

## 关键决策与不变量

文件检查点由 `checkpoints.mjs` 在公开 `tools/execute` 的顶层执行边界记录，按最近的用户消息序号归属；同一消息的交叠工具共享起止快照，不同归属交叠则标记不完整。Git 仅用于枚举未被忽略的项目文件，不改索引或提交；无 Git 项目递归枚举并排除依赖、构建、环境文件。内容寻址快照与索引保存在插件数据目录，按 SHA-256 与文件模式检查外部改动；预览计划带摘要，确认时再验证。恢复先持久记录整个计划，逐文件原子替换，重试接受已经达到目标的文件，直到索引完成；聊天日志不写入。选区引用只接管同一会话正文中的非空单消息选区，缓存文字后显示复制/引用菜单，其他区域不拦截。

1. **帧外科手术**（§10.8-1 实测结论）：官方 v4 会话日志 = 多帧 zstd（header 一帧、事件逐帧、全帧带 XXH64 校验）。迁移只重编码 header 帧，其余帧字节不动；`scanFrames` 复刻官方扫描器语义（含 skippable 帧与截断即报错），重写产物先自 walk 再落盘。可用 `DSH_SESSION_TOOLBOX_LIVE=1` 对当前本机日志做只读校验，实际数量随本机数据变化。
2. **发布时序**（§10 MN1）：旧目录先整体退役（rename 进 `pending-purge/`），新日志在目标目录独占发布（temp+rename+fsync），再动账本——任何时刻 `findLog` 只会命中一个位置，官方「同 id 两目录=报错」的不变量永不破口。
3. **账本收敛协议**（§10 MR3/MR4）：同进程 header 缓存可能滞后，ledger 失败记 `deferredLedger`，journal 保留为重试指针；`complete()` 在新进程冷缓存下重跑账本尾巴，仍失败则继续保留（备份不删），可回滚。回滚在 commit 之后走「整体目录逆向 rename」，逐字节还原。
4. **编码自校验**（§10 MN3）：写入前用现存布局样本反推 `projectKey/encodeSegment` 是否仍成立；官方改规则 → `unknown-layout` 拒绝，而不是猜写。
5. **归档池**：工具箱入站保存 `previouslyArchived`/`previouslyPinned` 快照；原生归档从官方 archivedSessionIds 实时投影，不持久写入 TTL 账本，手动还原取消归档，手动彻底删除才将该项纳入删除日志。工具箱会话和归档项目的成员不重复展示。项目入站=归档全部会话再 delete 注册；还原= create/reuse + 逆序 attach + insertBefore + 定点 unarchive，幂等。
6. **彻底删除**（§11.1-1/TB6）：官方无硬删命令；两段式（rename 暂存 → 清 projcache/账本/清单 → 物理 rm），中断残留都在 `session-toolbox/pending-purge/` 可检。共享附件（内容寻址）第一期不动。
7. **软失败降级**（NFR3）：host/client 全部 `ctx.get(...)` 探测；缺 `webServer` 无 UI 通道但 CLI 可用；缺 `workspaceRegistry`/`sessionPersistence` 时面板显示不可用原因；浏览器侧合成粘贴被拒（官方改版）时 vault 记录仍在，仅降级为不恢复并 warn——绝不拦截官方事件。
8. **多会话项目迁移**：`workspace-journal.json` 记录项目快照和逐条迁移进度；先检查全部成员，再逐条调用迁移引擎。项目替换保留顺序、置顶、归档、分组及归档池引用；恢复期间阻止冲突写操作。只改项目名称时不迁移会话。
9. **图片输入绑定隔离**：输入绑定替换后，旧绑定的迟到通知与队列快照不能重新备份已发送图片。恢复前检查当前会话与官方附件列表，发送或删除只清理对应备份。
10. **原生队列**：0.1.34 起移除插件队列引导扩展；不注册快捷入口、不装饰原生队列，不修改原生文案与按钮样式。

11. **在线迁移兼容层**：`session-maintenance.mjs` 探测 DSH 的 `agentLoop.scope(id)` 清理链，以 Cordis 公开 effect 元数据的对象身份校验对应 disposer。当前 Cordis 没有公开 disposer 查询，适配器只读探测 `_disposables`，不修改集合；匹配不唯一或结构变化即拒绝。仅关闭 agent scope fiber 不能关闭持久化 writer，因此不能作为替代。完整清理后以 persistence 写句柄阻止同进程重开，并在目标发布前持有内核写锁。恢复时保护退役目录，结束后释放锁，由原生流程重新加载会话。
12. **侧栏扩展**：保留原生项目、会话与菜单，在公开 `data-row-key` / `role=tree` DOM 位置用 React portal 增加分组标题和菜单项；不重挂载或搬动原生 DOM。分组投影需保持引用稳定，避免原生 effect 反复更新。会话拖动在 capture 阶段附独立 MIME，仅接管项目标题上的跨项目放下，调用同一 `move` 预检与迁移接口；同项目行间排序仍交给原生。跨项目放下后保留原生 dragend 清理，但暂时抑制遗留排序标记的提交，等整个 DOM 事件分发结束后再解除，不能用可能早于 bubble 阶段执行的微任务解除。

## 测试分层

| 套件 | 覆盖 |
|---|---|
| paths / session-log | 编码复刻 + 帧手术（含带校验和多帧 golden 夹具） |
| move | 状态机：happy、六类 fail-closed、崩溃前滚、提交后逐字节回滚、deferred 收敛 |
| trash | 双语义矩阵、幂等还原、purge、TTL/autoPurge、journal 互斥 |
| api / startup | loopback 守卫（host/origin/sec-fetch/密钥/体积/JSON）、深合并设置、端到端移动 |
| kernel | 真 cordis v4：inject/provide/effect/dispose 全生命周期 |
| client-bundle | 浏览器 globals-only vm 加载 lib/client.js，断言 __ModuleLoader__ 信封与插槽注册集 |
| client-actions / draft-vault | 原生菜单与弹窗、快照防覆盖、图片恢复与旧绑定迟到通知 |
| workspace / sidebar / sidebar-drag | 分组层级与菜单编辑、项目路径迁移、会话拖动跨项目及原生排序隔离、归档与排序保留、崩溃进度恢复、插槽清理 |
| cli / package-check | 离线账本维护、打包门禁失败时只清理本次拥有的临时目录 |
| live-artifact | 可选（env）：对 `~/.dsh/sessions` 全部真实日志只读 walk→rewrite→re-walk |

0.1.23 检查基线为 125 项测试：默认通过 123 项，真实日志相关 2 项默认跳过。用以下命令显式启用只读检查：

```bash
DSH_SESSION_TOOLBOX_LIVE=1 npm test
```

## 设置与离线维护

设置文件为 `~/.dsh/session-toolbox/session-toolbox.json`。日常优先使用工具箱页面，手工改文件需重启 DSH：

```json
{
  "version": 1,
  "draftVault": { "enabled": true, "maxSizeBytes": 209715200, "ttlDays": 7 },
  "trash": { "ttlDays": 30, "autoPurge": false },
  "move": { "enabled": true }
}
```

宿主插件参数为 `configFile`（名称沿用现有接口，实际用于覆盖工具箱数据目录）与 `dshHome`（多实例或测试的数据根目录）。

CLI 适用于 DSH **完全退出后**的维护和救援。关闭窗口不等于退出；在线操作优先使用宿主面板以同步内存索引。

```bash
dsh-session-toolbox status
dsh-session-toolbox move --session <id> --to <绝对路径> --dry-run
dsh-session-toolbox move --session <id> --to <绝对路径>
dsh-session-toolbox recover
dsh-session-toolbox rollback
dsh-session-toolbox trash-purge --item <itemId>
```

CLI 写入 `~/.dsh/storages/workspace.json` 的离线镜像。`status` 可能含项目、路径、会话标识等本机信息，输出应先脱敏再用于反馈。

## 热更新边界

每次构建生成版本化的 host 入口和 Cordis component id，使宿主与浏览器模块随版本替换。通过 Plugin Manager 安装、更新或启停可在 HMR 可用时生效；手工覆盖安装目录不会执行这套生命周期。

| `restartReason` | 含义 |
| --- | --- |
| `no-hmr` | 当前环境没有 HMR。 |
| `package-moved` | 包被解析到其他目录。 |
| `host-module` | 模块被宿主静态引用，需下次启动加载。 |
| `unmanaged-plugin` | 插件不归 Plugin Manager 管理。 |

首次安装的客户端元数据可能保留否定缓存，宿主已启动但界面仍未出现时需要重启。0.1.23 对空闲且无排队消息的会话执行完整生命周期清理后取得迁移写锁，不要求退出 DSH。

## 引用回复与原生菜单边界（0.1.24）

0.1.29 扩展到 `assistant-step`，镜像该节点声明的 single 子插槽；助手正文与 turn-tail 用 `finalNode.seq` 关联，不能用带小数的合成 UI anchor 作为删除标识。0.1.32 起编辑直接经 session-scoped `conversation.input.for(binding.ctx)` 的 `setDraft` / `persistCurrentDraft` / `focus` 回填原生输入框；保留附件，已有语义草稿提供文字恢复入口。候选追加保留 reference occurrence 的位置和内容，不接管原生发送。

`src/messages.mjs` 只经已加载 Session 的公开 `append` 与 `sessions.flush` 操作。删除用户/已完成助手消息时，追加带独立 ID 前缀的 `user/message` 删除占位，用 `surfaceOp: { op: replace, startSeq, endSeq }` 与 `sourceEventSeqs` 精确替换单条当前模型节点；模型仅接收不含原文或附件的 `[Message deleted]` 占位；user-role 替换可在轮次之外合法提交，不伪造 turn/step 边界。原始事件不改写；surface generation 变化触发原生下一请求的新系列，避免复用旧上下文。删除状态从原生日志标记重建，刷新/热更新后仍保留；重复删除与 flush 失败重试幂等。运行/排队任务、包含 tool-call 的助手消息、已被压缩或替换的节点拒绝操作。此机制不擦除原始磁盘记录，也不保证清除其它消息里的间接引用。

`src/reply.mjs` 装饰公开 keyed Chat 的 user/steering/turn-tail 渲染项，保留 store、inject、locale，并镜像 turn-tail 的原生动作与反馈插槽。引用文本来自节点的用户文字或 closing.blocks 中的 text，不读取推理与工具输出。

通过已探测的 `inputTriggers.registerSource` 注册独立 reference codec，使用公开 `conversation.input.for(binding.ctx)` 的结构化草稿与状态存储。引用包含自描述版本、角色及原文，持久化在原生草稿中；发送由原生 serializer 转成 Markdown 引用，不截获键盘、替换发送器或停止会话。取消按 occurrence 的完整范围变更，保留其他引用和附件。引用插入前捕获原生 detect 坐标与草稿版本，经 `insertReference` 插入芯片；多条引用累加插入，取消时按 occurrenceId 精确移除对应芯片并调整后续坐标，保留其他引用及附件；旧版不含 ID 的引用使用偏移与引用值匹配。原位置已失效时追加到末尾，聚焦后光标停在新引用后方。缺少能力时禁用引用入口。

项目菜单无公开扩展槽时，新增项挂载到原生菜单视口。独立 portal 无法参与原生 React pointer-enter/leave 祖先链，因此在 DOM 捕获层统一锚点与菜单边界，包含两者之间的短距离穿越；真实离开仍延迟关闭，卸载清理事件与计时器。菜单归属从本次点击的真实项目行取值，不从显示顺序推断。


## 后续任务联想（0.1.32）

`next-tasks.mjs` 监听新增 `session/event` 的正常 `turn/end`，延迟等待轮次空闲，逐个独立调用公开 `llm.prepareCall` / `stream`。使用该 Session 最近的 `requestHeader().config` 路由和最低支持的 reasoning effort，标记独立 `purpose`，不带工具，不 append 聊天事件。canonical `deriveMessages()` 的最近 6 条用户/助手文字受 12 KB 限制，替换删除已生效的原文不会进入候选请求。输出不超过 600 token，解析文字中的单份 JSON 字符串数组，兼容说明、JSON 围栏及四种候选字段包装，最多 3 条。新消息/轮次、关闭设置、Session disposal 及 HMR 会取消旧任务；读接口只读取，不产生收费调用。

独立 `next-task-usage.json` 在调用前原子记录请求，结束时按最新 provider usage 结算累计、模型及 UTC 日统计；缓存桶与未缓存输入分开，reasoning 已包含在 output。没有完整 usage 的已发出请求列为 unreported，异常中断留下的 pending 从累计已结算次数差额计算，避免伪造精确总数。保留最近 200 次请求元数据、90 天日统计；不持久化提示词、模型回复或聊天正文。主会话的消息用量投影不会收到此辅助请求的事件。

0.1.36 起已完成候选写入独立 `next-task-candidates.json`（原子写入、0600 权限，最多 100 个会话）。启动只恢复最近 7 天、结构有效的 ready 结果，不重新调用模型；新消息、上下文删除、关闭功能或 Session disposal 失效后同步移除缓存。热更新取消未完成任务并保留已完成结果。候选缓存含候选文字，与只存用量元数据的账本分开。输入观察状态按原生 input 实例匹配，避免复用组件切换会话时暴露上一会话的草稿、误将新会话候选标为收起；收起标记仍按会话和轮次保存在窗口 sessionStorage。

0.1.38 分组管理继续使用原生 Modal 与 Button，以公开 className 设置宽度及滚动边界；独立样式仅作用于管理弹窗。左侧筛选来自同一 groups/projects 状态，右侧归组沿用 group.assign，自动保存后刷新列表与数量；删除分组后回到全部项目，项目编辑沿用已有 WorkspaceDialog。窄窗口切为单栏，路径省略不改变实际值。

### 分组排序

侧栏以 `groups.json` 的数组顺序排列分组，`group.move` 只提交被移动分组和目标前置分组的 ID，在文档锁内对最新数组执行一次移动，保留并发新增、重命名和项目归属变更。显示投影随分组重排，组内仍沿用原生项目顺序；默认「未分组」按 `ungroupedIndex` 插入数组，参与拖动和按钮排序；老文档省略该字段时沿用末尾位置。新增、删除自定义分组时同步维护此位置，未分组的成员仍由未归组项目实时推导，不保存重复成员。拖动使用独立的 `application/x-dsh-toolbox-group` 类型与捕获事件，仅在放下时保存，并支持 Alt/Option + 方向键；管理弹窗复用同一拖动控制器与 `group.move` 操作，并提供上移、下移箭头。两处都读取同一状态快照，保存后统一刷新，筛选分组不随排序切换；不占用原生项目、会话的拖动数据。

### 任务联想收尾时机与失败可见性（0.1.41）

`turn/end` 在 Agent 变为空闲之前发出，固定延迟 150 ms 后仅检查一次会静默丢弃收尾较慢的轮次。现在仅对新完成的正常轮次每 150 ms 检查空闲，最长 15 秒；定时器身份在异步检查后再次校验，新消息、会话销毁、关闭及卸载会撤销等待。空闲后仍走原来的单次模型调用与全局并发队列，不自动重试付费请求；开始调用前再校验空闲。状态提示绑定所属 turn-end seq，支持收起，不额外占用输入区。错误仅记录固定类别，不保存供应商原始错误、URL、凭据或请求正文。

### 任务联想输出格式兼容（0.1.42）

模型输出由纯文字 block 拼接，`block-end` 覆盖同块的 delta，不叠加最终全文，不读取 reasoning 或 tool block。提示词补充数组示例；解析器限制响应在 16 KB 内，优先解析完整 JSON，再处理单个 JSON 围栏或单个配对的数组/对象，正确处理字符串内的引号转义与括号。对象仅接受 `candidates`、`suggestions`、`nextTasks`、`next_tasks` 中一个字段的字符串数组。拒绝多份冲突数据、破损 JSON、对象项及无结构普通答复；`[]` 保留空候选语义。格式失败仍结算已返回的用量，不保存原始响应、不自动重试。

### 手动任务联想（0.1.43）

`nextTasks.generate` 是受本机写密钥保护的显式 POST，不在读接口或挂载时生成。回答 turn-tail 操作区在引用按钮前放置原生尺寸的星光图标，加载图标尊重减少动画设置。宿主校验所选 `turn/end` 正常完成、会话空闲、非子代理及回答仍在 canonical 消息中；以事件消息 ID 将 canonical `deriveMessages()` 限定到该轮次，避免读取后续问答及被删除的原文。手动请求共用原单并发模型队列、取消与独立用量账本，接口立即返回状态，生成中同轮合并、不同轮拒绝，不阻塞其他管理请求。

自动开关仅约束自动生成；显式手动任务带 `manual: true`，关闭自动时仍可调用和恢复其 ready 缓存。关闭开关的操作会取消当时正在等待或生成的请求。前端 `candidateView.reveal` 清除该会话的收起标记，轮次 footer 与按钮订阅同一状态；输入观察器继续轮询手动任务，已有草稿不会立刻收起主动请求的结果，用户继续输入、选择或关闭仍可收起。旧轮次没有自动付费重试。

0.1.44 起仅在自动开关由开启变为关闭时执行关闭清理；开关已关闭期间保存其他设置，不会取消新的手动任务。
