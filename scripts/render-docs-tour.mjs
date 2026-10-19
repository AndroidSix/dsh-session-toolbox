/** Render an offline, captioned tour from the public, sanitized documentation assets. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const media = join(root, 'docs/media');
const work = await mkdtemp(join(tmpdir(), 'dsh-docs-tour-'));
const { chromium } = await import(process.env.DOCS_PLAYWRIGHT_MODULE || 'playwright');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const scenes = [
 ['01-overview.png', '从工具箱开始', '插件顶部即可加入交流群', '侧栏 → 插件 → dsh-session-toolbox。\n图片草稿、项目管理和归档集中在这里。', '这是插件 0.1.23 的演示界面。\n所有项目、路径、会话与统计均为虚构。'],
 ['02-project-groups.png', '按分组整理项目', '创建分组，为项目选择归属', '点击「管理项目与分组」，创建分组，\n再通过各项目的选择器调整归组。', '侧栏按分组展开项目；原生搜索覆盖全部会话。\n删除分组后，项目回到「未分组」。'],
 ['03-project-path.png', '换路径，带走已有会话', '先准备好新的代码目录', '在项目管理中点击「编辑项目」，\n修改名称与已有目录，确认后保存。', '全部会话一起迁移；代码文件不会搬动。\n会话须空闲且没有排队消息。'],
 ['05-session-move.png', '单个会话切换项目', '选择目标项目，先体检再迁移', '可以从会话菜单发起，也能在工具箱\n填写会话 ID，选择目标项目并体检。', '已打开的空闲会话自动释放句柄后迁移，\n立即迁回也无需重启 DSH。'],
 ['04-archive-pool.png', '原生归档也能找到', '两种来源，集中还原', 'DSH 原生归档与工具箱归档同时展示。\n点击「还原」后检查对应项目。', '默认关闭自动清理。\n「彻底删除」需再次确认，无法撤销。'],
 ['06-queue-steering.svg', '让队列补充当前轮次', '在队列行点击「引导」', '在下一可用步骤接收排队消息；\n保留原消息与附件，当前工具继续执行。', '此页为流程示意。\n想选其他消息，可用原生队列「插话发送」。'],
 ['01-overview.png', '开始使用与反馈', '完整步骤见 docs/usage.md', '本地包可通过插件管理器热更新。\nnpm 与仓库版本可能不同，请核对版本。', 'QQ 群：1124103038\n截图反馈前，请移除账号、路径和聊天内容。'],
];
const browser = await chromium.launch({ headless: true, ...(process.env.DOCS_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.DOCS_BROWSER_EXECUTABLE_PATH } : {}) });
const cues = [], durations = scenes.map((_, index) => index === scenes.length - 1 ? 8 : 7);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
try {
 const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
 // No DSH authentication, host page or network is used by this renderer.
 await page.route('**/*', route => route.abort());
 let elapsed = 0;
 for (let index = 0; index < scenes.length; index++) {
  const [file, title, lead, body, note] = scenes[index];
  const image = await readFile(join(media, file));
  const imageUrl = `data:${file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${image.toString('base64')}`;
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH Session Toolbox 导览</title><style>
   *{box-sizing:border-box}body{margin:0;background:#eff3f9;color:#172033;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}header{height:130px;padding:38px 64px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #d9e2ef;background:#fff}.brand{font-size:30px;font-weight:700}.tag{font-size:23px;color:#536078}main{height:850px;padding:40px 56px;display:grid;grid-template-columns:590px 1fr;gap:36px}.copy{padding:26px 12px;display:flex;flex-direction:column}.step{color:#2563eb;font-size:26px;font-weight:650;letter-spacing:2px}h1{font-size:54px;line-height:1.25;margin:24px 0 22px;letter-spacing:-1px}h2{font-size:29px;font-weight:600;line-height:1.6;margin:0 0 30px}p{font-size:26px;line-height:1.9;white-space:pre-line;margin:0;color:#40506a}.note{margin-top:auto;border-left:5px solid #2563eb;background:#e5edfb;border-radius:0 12px 12px 0;padding:20px;font-size:23px;line-height:1.8}.visual{border:1px solid #d7e0ee;border-radius:22px;background:#fff;padding:18px;display:flex;justify-content:center;align-items:center;overflow:hidden;box-shadow:0 12px 38px #1e3a5f0d}.visual img{max-width:100%;max-height:100%;object-fit:contain}footer{height:100px;padding:26px 64px;display:flex;align-items:center;justify-content:space-between;font-size:22px;color:#536078}.dots{display:flex;gap:10px}.dot{width:34px;height:6px;background:#cdd8e9;border-radius:6px}.dot.active{background:#2563eb}
  </style><header><div class="brand">DSH Session Toolbox <span class="tag">v${escape(version)}</span></div><div class="tag">图文导览 · 虚构演示数据 · 无个人信息</div></header><main><div class="copy"><div class="step">${String(index + 1).padStart(2, '0')} / ${scenes.length}</div><h1>${escape(title)}</h1><h2>${escape(lead)}</h2><p>${escape(body)}</p><p class="note">${escape(note)}</p></div><div class="visual"><img src="${imageUrl}" alt="${escape(title)}"></div></main><footer><span>第三方插件 · 数据保存在本机 · 本片为图文导览</span><div class="dots">${scenes.map((_, i) => `<span class="dot ${i === index ? 'active' : ''}"></span>`).join('')}</div><span>${index + 1} / ${scenes.length}</span></footer></html>`);
  await page.locator('img').evaluate(image => image.decode());
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, `scene-${index}.png`) });
  if (index === 0) await page.screenshot({ path: join(media, 'video-poster.png') });
  cues.push({ start: elapsed, end: elapsed + durations[index], text: `${title}\n${lead}\n${body}\n${note}` });
  elapsed += durations[index];
 }
} finally { await browser.close(); }
const timestamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000`;
await writeFile(join(media, 'session-toolbox-tour.vtt'), `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join('\n')}`);
await writeFile(join(work, 'frames.txt'), scenes.map((_, index) => `file 'scene-${index}.png'\nduration ${durations[index]}\n`).join('') + `file 'scene-${scenes.length - 1}.png'\n`);
const run = promisify(execFile);
await run(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'), '-vf', 'fps=24,tpad=stop_mode=clone:stop_duration=2', '-frames:v', String(durations.reduce((sum, n) => sum + n, 0) * 24), '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', join(media, 'session-toolbox-tour.mp4')], { maxBuffer: 1024 * 1024 });
console.log(`Rendered ${scenes.length} scenes; temporary frames retained in ${work}`);
