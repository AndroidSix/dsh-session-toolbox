# 文档媒体与脱敏说明

这些素材用于 [首页](../../README.md) 和 [使用指南](../usage.md)，分组管理截图对应插件 0.1.41，其余既有截图及视频对应 0.1.23；DSH 为 0.2.1-rc.2。

## 素材清单

| 文件 | 内容 |
| --- | --- |
| [01-overview.png](01-overview.png) | 插件顶部、交流群入口、图片草稿与项目管理入口。 |
| [02-project-groups.png](02-project-groups.png) | 0.1.41 分组管理弹窗（未分组可排序）：左侧分组筛选、拖动与上下移动箭头、右侧项目归组，含虚构数据。 |
| [03-project-path.png](03-project-path.png) | 原生项目编辑弹窗，保存前核对新路径。 |
| [04-archive-pool.png](04-archive-pool.png) | 原生归档与工具箱归档同时显示。 |
| [05-session-move.png](05-session-move.png) | 单会话迁移的面板体检示例。 |
| [06-queue-steering.svg](06-queue-steering.svg) | 旧版队列引导流程示意；0.1.34 起使用 DSH 原生功能。 |
| [video-poster.png](video-poster.png) | 图文导览视频封面。 |
| [session-toolbox-tour.mp4](session-toolbox-tour.mp4) | 50 秒、1920 × 1080、24 fps、H.264 / yuv420p，带画面说明，无音轨。 |
| [session-toolbox-tour.vtt](session-toolbox-tour.vtt) | 与视频七个章节对应的中文说明字幕。 |

视频是截图与流程示意组成的**图文导览**，不冒充连续操作录屏或性能测试录像。

## 演示数据

- 项目：示例商城、示例文档站、示例实验室、示例服务接口、示例移动应用及示例前端组件项目。
- 分组：产品开发、学习与实验。
- 路径：`/demo/projects/shop`、`/demo/projects/docs`、`/demo/projects/lab`、`/demo/projects/shop-next` 等虚构演示路径。
- 会话标识：`session-demo-guide`、`session-demo-ui`。
- 会话标题、数量、草稿统计、归档日期同样是演示值。
- QQ 群号与链接是作者已公开的交流入口，予以保留。

`/demo/projects/…` 只是示例占位，不是使用者应直接填入的真实目录。

## 处理方式

界面图片来自实际安装的插件组件。在独立浏览器中，将插件状态响应替换为上述虚构数据；插件写请求也由浏览器拦截，只修改演示状态，不修改真实项目。未打开私人会话、发送模型请求或上传素材到第三方服务。

截图只截取明确的插件组件或弹窗边界，排除宿主账号、头像、真实侧栏、浏览器地址栏与桌面。图片中没有覆盖马赛克下的原始私人内容。PNG 未保留 EXIF、GPS 或文本元数据；视频导出移除了源元数据，没有录制麦克风、系统声音或桌面。

公开文件不包含 Cookie、凭据、插件写入密钥、真实本机绝对路径、私聊正文或未发送附件。标准文档路径 `~/.dsh/…` 与虚构 `/demo/…` 保留用于说明功能。

## 重新生成视频

已有截图通过人工检查后，视频渲染只读取本目录的固定素材，不连接 DSH。需要 Node、Playwright（及可用的 Chromium）和 FFmpeg：

```bash
node scripts/render-docs-tour.mjs
```

在仓库根目录执行。脚本默认从环境解析 `playwright`，并使用其 Chromium；如工具装在其他位置，可设置 `DOCS_PLAYWRIGHT_MODULE`（Playwright 的入口模块路径）、`DOCS_BROWSER_EXECUTABLE_PATH`（浏览器可执行文件路径）与 `FFMPEG`。这些依赖只用于文档制片，不是插件运行依赖。

渲染时浏览器网络被禁用，只读取脱敏图片与 SVG。脚本会重建 MP4、封面和 VTT，并输出本次临时帧目录；不会递归清理其他临时目录。更新素材后，请重新逐帧抽查视频和核对元数据，再公开。

- `07-quote-reply.svg`：0.1.37 多引用回复的静态操作示意，完全由本地 SVG 与虚构文本生成；不是用户会话截图，不含账号、目录、会话 ID、凭据或远程素材。现有 MP4 仍对应 0.1.23。
