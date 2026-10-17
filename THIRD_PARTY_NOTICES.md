# 第三方代码与许可声明 / Third-Party Notices

创建于 2026-10-17

## 包含方式（Vendoring）

本项目**不再分发任何第三方源码**：`src/` 全部为原创实现；构建产物 `lib/` 仅打包本项目自身代码，所有运行时依赖由宿主 DSH 提供（peerDependencies，esbuild `packages: "external"`）。

## 设计参考（未包含代码）

- [dsh-multi-router](https://github.com/AndroidSix/dsh-multi-router) — MIT（同作者）。参考其工程形态：cordis 双产物（host ESM + `__ModuleLoader__` client CJS）、版本化宿主入口与组件 id（热替换同时换 server/browser 模块代际）、loopback 管理端点信任模型、`lib/` 随发布分支提交的免构建安装策略、CI 与发布流程。未复制其任何源代码。

## 运行时依赖（不随包分发）

| 包 | 许可 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | 专有（DeepSeek 官方） | 插件生命周期容器（由 DSH 宿主提供） |
| `@deepseek-ai/dsh-home-paths` | 专有 | 解析 DSH 数据目录 |
| `@deepseek-ai/dsh-atomic-write` | 专有 | `writeFileAtomic` / `withFileLock` |
| `@deepseek-ai/schemastery` | 专有 | 插件 Config 声明 |
| `react` | MIT | 客户端 UI（由 DSH Web 宿主提供） |

上述 `@deepseek-ai/*` 包均**不打包进本项目产物**，仅在 DSH 进程内由宿主注入；安装本项目不会复制、修改或再分发官方代码。本项目对官方数据格式（会话日志 zstd 帧、`sessions/` 目录编码、`workspace.json` 记录形状）的复刻属于对文件格式的互操作实现，相关代码为原创、MIT。

## `node_modules` 构建期依赖

`esbuild`（MIT，仅 devDependency，不参与运行时）。

## 许可义务

MIT 许可要求保留版权声明与许可文本：本项目自身许可见 [LICENSE](LICENSE)；上表第三方包在各自仓库维护其许可文本，用户通过 DSH 官方安装包/正规 npm 渠道获取。
