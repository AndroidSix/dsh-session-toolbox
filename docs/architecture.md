# 架构说明 / Architecture Notes

创建于 2026-10-17

面向维护者的模块地图；需求条目（§=《dsh-image-draft-persistence-需求》）在括号内标注。

```
┌────────────────────────── 浏览器（DSH Web 视图） ──────────────────────────┐
│ client.jsx (cordis 插件, inject:['slots'])                                  │
│  ├ KitPage          插件详情页：开关 / 迁移向导 / 回收站（FR5/FR6/MR6/TB2）  │
│  ├ 菜单项           sidebar.workspaces.session.menu.item（MR6/TB2）          │
│  ├ VaultBadge       conversation.input.dock（FR5）                           │
│  └ draft-vault.js   capture 旁观 → IndexedDB → 合成 paste 重放（FR1/FR2/FR3）│
│        │ fetch /.well-known/dsh-session-kit（loopback + 每进程随机密钥）     │
└────────┼───────────────────────────────────────────────────────────────────┘
         ▼
┌────────────────────────── 宿主（Node, cordis） ────────────────────────────┐
│ index.mjs   apply(): 能力探测（ctx.get）+ provide('sessionKit') + 路由注册   │
│ api.mjs     loopback 处理器与命令词表（与 CLI、测试共用 dispatch）           │
│ move.mjs    MoveEngine：journal 分相（backup/rewrite/commit/ledger/         │
│             projcache/index），preflight fail-closed，rollback/complete     │
│ trash.mjs   TrashEngine：官方归档/delete 组合 + 账本快照 + 两段式 purge      │
│ session-log.mjs  zstd 帧 walk（官方 scanZstdFrames 等价复刻）+ 仅重写首帧    │
│ paths.mjs        projectKey/encodeSegment 复刻 + verifyEncoders 布局自检     │
│ store.mjs        JsonDocument（withFileLock+writeFileAtomic，0600/0700）     │
│ cli.mjs          离线维护（DSH 停止时）：status/move/recover/rollback/purge  │
└────────────────────────────────────────────────────────────────────────────┘
```

## 关键决策与不变量

1. **帧外科手术**（§10.8-1 实测结论）：官方 v4 会话日志 = 多帧 zstd（header 一帧、事件逐帧、全帧带 XXH64 校验）。迁移只重编码 header 帧，其余帧字节不动；`scanFrames` 复刻官方扫描器语义（含 skippable 帧与截断即报错），重写产物先自 walk 再落盘。真实安装 18/18 日志验证通过（`DSH_SESSION_KIT_LIVE=1`）。
2. **发布时序**（§10 MN1）：旧目录先整体退役（rename 进 `pending-purge/`），新日志在目标目录独占发布（temp+rename+fsync），再动账本——任何时刻 `findLog` 只会命中一个位置，官方「同 id 两目录=报错」的不变量永不破口。
3. **账本收敛协议**（§10 MR3/MR4）：同进程 header 缓存可能滞后，ledger 失败记 `deferredLedger`，journal 保留为重试指针；`complete()` 在新进程冷缓存下重跑账本尾巴，仍失败则继续保留（备份不删），可回滚。回滚在 commit 之后走「整体目录逆向 rename」，逐字节还原。
4. **编码自校验**（§10 MN3）：写入前用现存布局样本反推 `projectKey/encodeSegment` 是否仍成立；官方改规则 → `unknown-layout` 拒绝，而不是猜写。
5. **归档/回收站双语义**（§11.1 冲突声明）：回收站只认自己入站的项（`previouslyArchived`/`previouslyPinned` 快照），用户手动归档的收藏永不误弹；项目入站=归档全部会话再 delete 注册（bootstrap 只重claim 未归档无账本会话——这就是删项目后不自动复活的依据）；还原= create/reuse + 逆序 attach + insertBefore + 定点 unarchive，幂等。
6. **彻底删除**（§11.1-1/TB6）：官方无硬删命令；两段式（rename 暂存 → 清 projcache/账本/清单 → 物理 rm），中断残留都在 `session-kit/pending-purge/` 可检。共享附件（内容寻址）第一期不动。
7. **软失败降级**（NFR3）：host/client 全部 `ctx.get(...)` 探测；缺 `webServer` 无 UI 通道但 CLI 可用；缺 `workspaceRegistry`/`sessionPersistence` 时面板显示不可用原因；浏览器侧合成粘贴被拒（官方改版）时 vault 记录仍在，仅降级为不恢复并 warn——绝不拦截官方事件。

## 测试分层

| 套件 | 覆盖 |
|---|---|
| paths / session-log | 编码复刻 + 帧手术（含带校验和多帧 golden 夹具） |
| move | 状态机：happy、六类 fail-closed、崩溃前滚、提交后逐字节回滚、deferred 收敛 |
| trash | 双语义矩阵、幂等还原、purge、TTL/autoPurge、journal 互斥 |
| api / startup | loopback 守卫（host/origin/sec-fetch/密钥/体积/JSON）、深合并设置、端到端移动 |
| kernel | 真 cordis v4：inject/provide/effect/dispose 全生命周期 |
| client-bundle | 浏览器 globals-only vm 加载 lib/client.js，断言 __ModuleLoader__ 信封与插槽注册集 |
| live-artifact | 可选（env）：对 `~/.dsh/sessions` 全部真实日志只读 walk→rewrite→re-walk |
