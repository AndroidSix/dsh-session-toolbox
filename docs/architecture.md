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
│  ├ SteerQueueButton conversation.input.dock：原消息引导到当前轮次           │
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

1. **帧外科手术**（§10.8-1 实测结论）：官方 v4 会话日志 = 多帧 zstd（header 一帧、事件逐帧、全帧带 XXH64 校验）。迁移只重编码 header 帧，其余帧字节不动；`scanFrames` 复刻官方扫描器语义（含 skippable 帧与截断即报错），重写产物先自 walk 再落盘。可用 `DSH_SESSION_TOOLBOX_LIVE=1` 对当前本机日志做只读校验，实际数量随本机数据变化。
2. **发布时序**（§10 MN1）：旧目录先整体退役（rename 进 `pending-purge/`），新日志在目标目录独占发布（temp+rename+fsync），再动账本——任何时刻 `findLog` 只会命中一个位置，官方「同 id 两目录=报错」的不变量永不破口。
3. **账本收敛协议**（§10 MR3/MR4）：同进程 header 缓存可能滞后，ledger 失败记 `deferredLedger`，journal 保留为重试指针；`complete()` 在新进程冷缓存下重跑账本尾巴，仍失败则继续保留（备份不删），可回滚。回滚在 commit 之后走「整体目录逆向 rename」，逐字节还原。
4. **编码自校验**（§10 MN3）：写入前用现存布局样本反推 `projectKey/encodeSegment` 是否仍成立；官方改规则 → `unknown-layout` 拒绝，而不是猜写。
5. **归档池**：工具箱入站保存 `previouslyArchived`/`previouslyPinned` 快照；原生归档从官方 archivedSessionIds 实时投影，不持久写入 TTL 账本，手动还原取消归档，手动彻底删除才将该项纳入删除日志。工具箱会话和归档项目的成员不重复展示。项目入站=归档全部会话再 delete 注册；还原= create/reuse + 逆序 attach + insertBefore + 定点 unarchive，幂等。
6. **彻底删除**（§11.1-1/TB6）：官方无硬删命令；两段式（rename 暂存 → 清 projcache/账本/清单 → 物理 rm），中断残留都在 `session-toolbox/pending-purge/` 可检。共享附件（内容寻址）第一期不动。
7. **软失败降级**（NFR3）：host/client 全部 `ctx.get(...)` 探测；缺 `webServer` 无 UI 通道但 CLI 可用；缺 `workspaceRegistry`/`sessionPersistence` 时面板显示不可用原因；浏览器侧合成粘贴被拒（官方改版）时 vault 记录仍在，仅降级为不恢复并 warn——绝不拦截官方事件。
8. **多会话项目迁移**：`workspace-journal.json` 记录项目快照和逐条迁移进度；先检查全部成员，再逐条调用迁移引擎。项目替换保留顺序、置顶、归档、分组及归档池引用；恢复期间阻止冲突写操作。只改项目名称时不迁移会话。
9. **图片输入绑定隔离**：输入绑定替换后，旧绑定的迟到通知与队列快照不能重新备份已发送图片。恢复前检查当前会话与官方附件列表，发送或删除只清理对应备份。
10. **队列引导**：通过原生 `conversation.updateQueue(id, { kind: 'steer' })` 修改原队列项的接收位置，保留消息与附件，不发送取消当前工具的指令；运行状态、可写性和连续性决定按钮是否可用。

11. **在线迁移兼容层**：`session-maintenance.mjs` 探测 DSH 的 `agentLoop.scope(id)` 清理链，以 Cordis 公开 effect 元数据的对象身份校验对应 disposer。当前 Cordis 没有公开 disposer 查询，适配器只读探测 `_disposables`，不修改集合；匹配不唯一或结构变化即拒绝。仅关闭 agent scope fiber 不能关闭持久化 writer，因此不能作为替代。完整清理后以 persistence 写句柄阻止同进程重开，并在目标发布前持有内核写锁。恢复时保护退役目录，结束后释放锁，由原生流程重新加载会话。
12. **侧栏扩展**：保留原生项目、会话与菜单，在公开 `data-row-key` / `role=tree` DOM 位置用 React portal 增加分组标题和菜单项；不重挂载或搬动原生 DOM。分组投影需保持引用稳定，避免原生 effect 反复更新。会话拖动在 capture 阶段附独立 MIME，仅接管项目标题上的跨项目放下，调用同一 `move` 预检与迁移接口；同项目行间排序仍交给原生。跨项目放下后保留原生 dragend 清理，但暂时抑制遗留排序标记的提交，等整个 DOM 事件分发结束后再解除，不能用可能早于 bubble 阶段执行的微任务解除。队列通过公开插槽同 id 装饰原生组件，仅修改引导文案与样式，保留其原有动作及禁用条件。

## 测试分层

| 套件 | 覆盖 |
|---|---|
| paths / session-log | 编码复刻 + 帧手术（含带校验和多帧 golden 夹具） |
| move | 状态机：happy、六类 fail-closed、崩溃前滚、提交后逐字节回滚、deferred 收敛 |
| trash | 双语义矩阵、幂等还原、purge、TTL/autoPurge、journal 互斥 |
| api / startup | loopback 守卫（host/origin/sec-fetch/密钥/体积/JSON）、深合并设置、端到端移动 |
| kernel | 真 cordis v4：inject/provide/effect/dispose 全生命周期 |
| client-bundle | 浏览器 globals-only vm 加载 lib/client.js，断言 __ModuleLoader__ 信封与插槽注册集 |
| client-actions / draft-vault | 原生菜单与弹窗、快照防覆盖、队列引导防重入、图片恢复与旧绑定迟到通知 |
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

`src/reply.mjs` 装饰公开 keyed Chat 的 user/steering/turn-tail 渲染项，保留 store、inject、locale，并镜像 turn-tail 的原生动作与反馈插槽。引用文本来自节点的用户文字或 closing.blocks 中的 text，不读取推理与工具输出。

通过已探测的 `inputTriggers.registerSource` 注册独立 reference codec，使用公开 `conversation.input.for(binding.ctx)` 的结构化草稿与状态存储。引用包含自描述版本、角色及原文，持久化在原生草稿中；发送由原生 serializer 转成 Markdown 引用，不截获键盘、替换发送器或停止会话。取消和替换按 occurrence 的完整范围变更，保留其他引用和附件。缺少能力时禁用引用入口。

项目菜单无公开扩展槽时，新增项挂载到原生菜单视口。独立 portal 无法参与原生 React pointer-enter/leave 祖先链，因此在 DOM 捕获层统一锚点与菜单边界，包含两者之间的短距离穿越；真实离开仍延迟关闭，卸载清理事件与计时器。菜单归属从本次点击的真实项目行取值，不从显示顺序推断。
