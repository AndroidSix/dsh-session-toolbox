# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。版本号从 `0.1` 起；DSH 宿主接口（`workspaceRegistry` / `sessionPersistence` / `webServer` 服务面与 `~/.dsh/sessions` 布局）在 0.x 期间按 `0.2.0-rc.2` 基线验证，每次官方升级会重验并在此记录。

## 0.1.0

- 首个版本：合并交付三个能力位（需求文档 §1–§11）。
- 草稿保险箱：capture 旁观粘贴/拖拽/文件选择，图片镜像进 IndexedDB（默认 7 天 / 200MB，TTL+LRU 清理，事件可见）；切会话、刷新、重启后向官方粘贴管线重放合成 ClipboardEvent 恢复，附件栏非空即跳过（幂等），发送或清空即回收备份；宿主侧仅存清单镜像。
- 会话切换项目：分步 journal（备份→重写→发布→账本→缓存→索引），只重写 zstd 会话日志的 header 帧、事件帧逐字节搬运；崩溃后启动检出，可前滚可逐字节回滚；体检 fail-closed（忙会话/未知会话/同目标/目录不存在/布局漂移/重复布局全部拒绝并说明原因）；同进程 header 缓存未刷新时账本记为 deferred，由下次启动或 move.complete 收敛。
- 回收站：会话删除=官方归档+入站快照（含 previouslyArchived/pinned 与列表位置），还原逐状态收敛且幂等；项目删除=官方 delete（保留会话日志）+标题/顺序快照，还原走 create/attach/insertBefore/unarchive；彻底删除分两段（pending-purge 暂存→清缓存/账本→落刀）；TTL 巡检默认只提醒，autoPurge 可开。
- 宿主插件经真实 cordis v4 内核生命周期测试；UI 走官方插槽（plugins.bundle.config、sidebar.workspaces.session.menu.item、conversation.input.dock）；缺失服务在面板显示不可用，不影响官方原生行为。
- loopback 管理端点沿用 dsh-multi-router 信任模型：仅 127.0.0.1/::1、Host/Origin/Sec-Fetch-Site 校验、GET 下发每进程随机写密钥、timing-safe 比对、请求体上限。
- CLI：status / move / recover / rollback / trash-purge，面向 DSH 停止时的离线维护与中断迁移救援。
