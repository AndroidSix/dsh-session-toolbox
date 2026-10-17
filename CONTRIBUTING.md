# 贡献指南

创建于 2026-10-17

## 项目结构

```
src/            源码（host ESM + client JSX + 浏览器 vault）
scripts/        构建脚本（esbuild 双 bundle，版本化 host 入口）
tests/          node:test 测试（不依赖 DSH 运行）
lib/            构建产物（随发布分支提交，安装端免构建）
docs/           补充文档
```

- `src/index.mjs`：宿主插件入口。能力探测全走 `ctx.get(...)` 软取；新代码不得直接依赖未探测的官方内部对象。
- `src/move.mjs` / `src/trash.mjs`：纯逻辑引擎，能力以 `capabilities`/`adapter` 注入——测试注入假实现，宿主注入真实 registry。任何迁移/删除时序改动必须同步过 `tests/move.test.mjs`、`tests/trash.test.mjs`（含崩溃注入用例）。
- `src/session-log.mjs`：zstd 帧手术与官方 `scanZstdFrames` 的等价复刻。改动后必须重新验证：`tests/session-log.test.mjs` + 对真实日志做只读 walk。
- `src/paths.mjs`：`projectKey/encodeSegment` 复刻。改官方编码适配时，`verifyEncoders` 的自校验路径必须保持 fail-closed。
- `src/draft-vault.js`：浏览器模块；只准用 DOM/事件/存储公开面，禁止触碰 React fiber 或官方内部对象图。
- `src/client.jsx`：UI 插槽组件。新插槽优先 `plugins.bundle.config` / `sidebar.workspaces.session.menu.item` / `conversation.input.dock` 这类官方声明位。

## 开发流程

```bash
npm ci
npm run build
npm test          # 或 npm run check
```

DSH 装机验证（可选，需本机 DSH）：`npm pack --ignore-scripts` 后用插件页本地安装产物 tgz，重启观察面板。

## 约定

- 修改逻辑一律「先写失败用例再改实现」；journal/时序类改动必须带崩溃注入测试。
- 中文注释克制、命名表达意图；UI 文案 zh/en 双语。
- commit message：`type: 一句话`（feat/fix/ui/test/docs/chore）。
- 发版：改 `package.json version` → `npm run build`（自动重写 `cordis.patch.yml` 与 `lib/host-vX.Y.Z.js`）→ 一并提交 → 打 `vX.Y.Z` tag → GitHub Release；CI 校验 tag↔version 一致后发布 npm（provenance，无需 token）。

## 升级适配（官方 DSH 更新后）

1. 跑 `npm run check` 全绿只是第一关；
2. 在隔离 `DSH_HOME` 验证：会话日志头帧结构、`sessions/` 目录编码、`workspace.json` 记录形状、`pluginManager.setBundleEnabled` 热替换；
3. 任一布局漂移先让预检拒绝（unknown-layout），再适配；禁止猜写。
