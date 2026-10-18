# Changelog

创建于 2026-10-17

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。版本号从 `0.1` 起；DSH 宿主接口（`workspaceRegistry` / `sessionPersistence` / `webServer` 服务面与 `~/.dsh/sessions` 布局）在 0.x 期间按 `0.2.0-rc.2` 基线验证，每次官方升级会重验并在此记录。

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
