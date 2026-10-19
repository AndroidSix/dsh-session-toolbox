import {
  JsonDocument,
  MoveEngine,
  TrashEngine,
  apiHandler,
  dispatch,
  guardJournal,
  guardLedger,
  guardManifest,
  guardSettings
} from "./chunk-XMUL4SUS.js";

// src/index.mjs
import { mkdir as mkdir2, realpath as realpath2, stat as stat3 } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

// src/session-maintenance.mjs
import { stat } from "node:fs/promises";
import { symbols } from "@deepseek-ai/cordis";
function sessionDisposer(agent) {
  const owner = agent?.ctx?.fiber?.parent?.fiber;
  const label = `agentLoop.scope(${agent?.id})`;
  const metadata = owner?.getEffects?.().filter((effect) => effect.label === label);
  if (metadata?.length !== 1 || typeof owner?._disposables?.[Symbol.iterator] !== "function") return void 0;
  const matches = [...owner._disposables].filter((dispose) => typeof dispose === "function" && dispose[symbols.effect] === metadata[0]);
  return matches.length === 1 ? matches[0] : void 0;
}
var fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
function createSessionMaintenance(ctx) {
  const persistence = ctx.get("sessionPersistence");
  if (typeof persistence?.open !== "function" || typeof persistence?.acquireLease !== "function") return void 0;
  return async (sessionId, operation, recovery) => {
    const sessions = ctx.get("sessions");
    const active = async () => {
      const activities = await ctx.waterfall?.("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
      if (Array.isArray(activities) && activities.length) fail("session-busy", "\u4F1A\u8BDD\u4ECD\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u540E\u518D\u8FC1\u79FB");
    };
    await active();
    const session = sessions?.get?.(sessionId);
    if (session) {
      const agent = ctx.get("agents")?.get?.(sessionId);
      const dispose = sessionDisposer(agent);
      const assertIdle = () => {
        if (!agent || agent.session !== session || typeof dispose !== "function") fail("session-loaded", "\u5F53\u524D\u5BBF\u4E3B\u672A\u63D0\u4F9B\u8BE5\u4F1A\u8BDD\u7684\u72EC\u7ACB\u91CA\u653E\u80FD\u529B\uFF0C\u6682\u65F6\u65E0\u6CD5\u5728\u7EBF\u8FC1\u79FB");
        const roots = ctx.get("agents")?.roots?.();
        if (session.header.origin === "subagent" || roots && !roots.includes(agent)) fail("session-owned", "\u5B50\u4F1A\u8BDD\u8BF7\u5728\u6240\u5C5E\u4EFB\u52A1\u7ED3\u675F\u540E\u518D\u8FC1\u79FB");
        if (agent.status !== "idle") fail("session-busy", "\u4F1A\u8BDD\u521A\u521A\u5F00\u59CB\u8FD0\u884C\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u540E\u518D\u8FC1\u79FB");
        if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) fail("session-queued", "\u4F1A\u8BDD\u8FD8\u6709\u6392\u961F\u6D88\u606F\uFF0C\u8BF7\u5148\u53D1\u9001\u6216\u79FB\u9664\u6392\u961F\u6D88\u606F\u518D\u8FC1\u79FB");
      };
      assertIdle();
      await sessions.flush(session);
      await active();
      assertIdle();
      if (sessions.get(sessionId) !== session) fail("session-changed", "\u4F1A\u8BDD\u5B9E\u4F8B\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u8BD5\u8FC1\u79FB");
      await dispose();
      if (sessions.get(sessionId) !== void 0) fail("session-loaded", "\u4F1A\u8BDD\u5C1A\u672A\u5B8C\u6210\u91CA\u653E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    let handle;
    try {
      handle = await persistence.open(sessionId, "write");
    } catch (error) {
      if (!recovery?.retired || error.name !== "SessionPersistenceNotFoundError" || !await stat(recovery.retired).then(() => true, () => false)) throw error;
    }
    const guards = /* @__PURE__ */ new Map();
    let result, failure;
    try {
      if (recovery?.retired && await stat(recovery.retired).then(() => true, () => false)) guards.set(recovery.retired, await persistence.acquireLease(sessionId, void 0, recovery.retired));
      if (sessions?.get?.(sessionId)) fail("session-loaded", "\u4F1A\u8BDD\u88AB\u5176\u4ED6\u64CD\u4F5C\u91CD\u65B0\u6253\u5F00\uFF0C\u8BF7\u91CD\u8BD5\u8FC1\u79FB");
      result = await operation({
        protectDirectory: async (path) => {
          if (!guards.has(path)) guards.set(path, await persistence.acquireLease(sessionId, void 0, path));
        }
      });
    } catch (error) {
      failure = error;
    }
    const releases = await Promise.allSettled([...guards.values()].map((guard) => guard.release()));
    try {
      await handle?.close();
    } catch (error) {
      releases.push({ status: "rejected", reason: error });
    }
    const errors = releases.filter((row) => row.status === "rejected").map((row) => row.reason);
    if (failure && !errors.length) throw failure;
    if (failure) errors.unshift(failure);
    if (errors.length) throw new AggregateError(errors, "\u4F1A\u8BDD\u8FC1\u79FB\u6216\u5199\u9501\u91CA\u653E\u5931\u8D25\uFF0C\u8BF7\u4FDD\u7559\u8FC1\u79FB\u65E5\u5FD7\u540E\u91CD\u8BD5");
    return result;
  };
}

// src/workspace.mjs
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat as stat2 } from "node:fs/promises";
import { isAbsolute } from "node:path";
var fail2 = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
function titleOf(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) fail2("bad-name", "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u4E14\u6700\u591A 80 \u4E2A\u5B57\u7B26 / Name must contain 1\u201380 characters");
  return value.trim();
}
function guardGroups(value) {
  if (value.version !== 1 || !Array.isArray(value.groups)) fail2("groups-invalid", "\u9879\u76EE\u5206\u7EC4\u6570\u636E\u683C\u5F0F\u65E0\u6548");
  const ids = /* @__PURE__ */ new Set(), members = /* @__PURE__ */ new Set();
  for (const group of value.groups) {
    if (typeof group.id !== "string" || !group.id || ids.has(group.id) || !Array.isArray(group.workspaceIds)) fail2("groups-invalid", "\u9879\u76EE\u5206\u7EC4\u6570\u636E\u683C\u5F0F\u65E0\u6548");
    titleOf(group.title);
    ids.add(group.id);
    for (const id of group.workspaceIds) {
      if (typeof id !== "string" || !id || members.has(id)) fail2("groups-invalid", "\u9879\u76EE\u5206\u7EC4\u5305\u542B\u91CD\u590D\u6216\u65E0\u6548\u9879\u76EE");
      members.add(id);
    }
  }
  return value;
}
function guardWorkspaceJournal(value) {
  if (value.version !== 1 || value.active !== null && (!value.active || typeof value.active.workspaceId !== "string" || typeof value.active.fromCwd !== "string" || typeof value.active.toCwd !== "string" || typeof value.active.title !== "string" || !Array.isArray(value.active.sessionIds) || !Array.isArray(value.active.moved))) fail2("workspace-journal-invalid", "\u9879\u76EE\u8FC1\u79FB\u65E5\u5FD7\u65E0\u6548\uFF0C\u8BF7\u4FDD\u7559\u6587\u4EF6\u5E76\u68C0\u67E5");
  return value;
}
var WorkspaceTools = class {
  constructor({ registry, move, groups, journal, ledger }) {
    Object.assign(this, { registry, move, groups, journal, ledger });
  }
  async active() {
    return (await this.journal.read()).active;
  }
  async assertIdle() {
    if (await this.active()) fail2("workspace-moving", "\u9879\u76EE\u8DEF\u5F84\u8FC1\u79FB\u5C1A\u672A\u5B8C\u6210\uFF0C\u8BF7\u5148\u7EE7\u7EED\u8FC1\u79FB / Resume the pending project move first");
  }
  row(id) {
    const row = this.registry()?.get(id);
    if (!row) fail2("workspace-unknown", "\u672A\u627E\u5230\u8BE5\u9879\u76EE / Workspace not found");
    return row;
  }
  async createGroup(title) {
    title = titleOf(title);
    const group = { id: randomUUID(), title, workspaceIds: [] };
    await this.groups.update((state) => {
      if (state.groups.some((row) => row.title === title)) fail2("group-exists", "\u5206\u7EC4\u540D\u79F0\u5DF2\u5B58\u5728 / Group name exists");
      return { ...state, groups: [...state.groups, group] };
    });
    return group;
  }
  async renameGroup(id, title) {
    title = titleOf(title);
    await this.groups.update((state) => {
      if (!state.groups.some((row) => row.id === id)) fail2("group-unknown", "\u5206\u7EC4\u4E0D\u5B58\u5728 / Group not found");
      if (state.groups.some((row) => row.id !== id && row.title === title)) fail2("group-exists", "\u5206\u7EC4\u540D\u79F0\u5DF2\u5B58\u5728 / Group name exists");
      return { ...state, groups: state.groups.map((row) => row.id === id ? { ...row, title } : row) };
    });
    return { ok: true };
  }
  async deleteGroup(id) {
    await this.groups.update((state) => ({ ...state, groups: state.groups.filter((row) => row.id !== id) }));
    return { ok: true };
  }
  async assignGroup(workspaceId, groupId) {
    this.row(workspaceId);
    await this.groups.update((state) => {
      if (groupId && !state.groups.some((row) => row.id === groupId)) fail2("group-unknown", "\u5206\u7EC4\u4E0D\u5B58\u5728 / Group not found");
      return { ...state, groups: state.groups.map((row) => ({ ...row, workspaceIds: [...row.workspaceIds.filter((id) => id !== workspaceId), ...row.id === groupId ? [workspaceId] : []] })) };
    });
    return { ok: true };
  }
  async edit({ workspaceId, path, title, createTarget = false }) {
    await this.assertIdle();
    if (await this.move.readJournal()) fail2("journal-active", "\u8BF7\u5148\u5B8C\u6210\u6216\u56DE\u6EDA\u4F1A\u8BDD\u8FC1\u79FB");
    const source = this.row(workspaceId);
    title = titleOf(title ?? source.title);
    if (typeof path !== "string" || !isAbsolute(path)) fail2("bad-path", "\u8BF7\u9009\u62E9\u7EDD\u5BF9\u8DEF\u5F84 / Choose an absolute path");
    let toCwd;
    try {
      toCwd = await realpath(path);
    } catch (error) {
      if (error.code !== "ENOENT" || !createTarget) throw error;
      await mkdir(path, { recursive: true });
      toCwd = await realpath(path);
    }
    if (!(await stat2(toCwd)).isDirectory()) fail2("bad-path", "\u76EE\u6807\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55 / Target must be a directory");
    if (toCwd === source.path) {
      await source.setTitle(title);
      return { ok: true, workspaceId };
    }
    if (this.registry().list().some((row) => row.path === toCwd)) fail2("target-occupied", "\u8BE5\u8DEF\u5F84\u5DF2\u5C5E\u4E8E\u5176\u4ED6\u9879\u76EE / Target path is occupied");
    const sessionIds = [...source.sessionIds];
    for (const sessionId of sessionIds) await this.move.preflight({ sessionId, toCwd });
    const order = this.registry().list().map((row) => row.id), at = order.indexOf(workspaceId);
    await this.journal.write({ version: 1, active: { workspaceId, fromCwd: source.path, toCwd, title, sessionIds, moved: [], targetWorkspaceId: null, beforeId: order[at + 1] ?? null, startedAt: (/* @__PURE__ */ new Date()).toISOString() } });
    return this.complete();
  }
  async complete() {
    const entry = await this.active();
    if (!entry) fail2("no-workspace-journal", "\u6CA1\u6709\u5F85\u7EE7\u7EED\u7684\u9879\u76EE\u8FC1\u79FB / No pending project move");
    const registry = this.registry();
    if (!registry) fail2("no-capability", "\u5F53\u524D DSH \u4E0D\u652F\u6301\u9879\u76EE\u7BA1\u7406");
    let target = entry.targetWorkspaceId ? registry.get(entry.targetWorkspaceId) : registry.list().find((row) => row.path === entry.toCwd);
    if (target && target.path !== entry.toCwd) fail2("target-changed", "\u76EE\u6807\u9879\u76EE\u8DEF\u5F84\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u68C0\u67E5\u8FC1\u79FB\u65E5\u5FD7");
    if (target?.sessionIds.some((id) => !entry.sessionIds.includes(id))) fail2("target-changed", "\u76EE\u6807\u9879\u76EE\u65B0\u589E\u4E86\u5176\u4ED6\u4F1A\u8BDD\uFF0C\u5DF2\u505C\u6B62\u5408\u5E76");
    if (!target) target = await registry.create(entry.toCwd, entry.title);
    entry.targetWorkspaceId = target.id;
    await this.journal.write({ version: 1, active: entry });
    const pending = await this.move.readJournal();
    if (pending) {
      if (!entry.sessionIds.includes(pending.sessionId) || pending.toCwd !== entry.toCwd) fail2("journal-conflict", "\u5B58\u5728\u5176\u4ED6\u4F1A\u8BDD\u7684\u8FC1\u79FB\u65E5\u5FD7\uFF0C\u8BF7\u5148\u68C0\u67E5");
      const result = await this.move.complete();
      if (result.deferred) fail2("ledger-deferred", result.note);
    }
    for (const sessionId of entry.sessionIds) {
      const header = (await this.move.caps.listHeaders()).find((row) => row.id === sessionId);
      if (!header) fail2("session-unknown", `\u65E0\u6CD5\u627E\u5230\u4F1A\u8BDD ${sessionId}`);
      if (header.cwd !== entry.toCwd) {
        if (header.cwd !== entry.fromCwd) fail2("session-changed", `\u4F1A\u8BDD ${sessionId} \u7684\u9879\u76EE\u5F52\u5C5E\u5DF2\u53D8\u66F4`);
        const result = await this.move.move(await this.move.preflight({ sessionId, toCwd: entry.toCwd }));
        if (result.deferred) fail2("ledger-deferred", result.note);
      }
      if (!entry.moved.includes(sessionId)) entry.moved.push(sessionId);
      await this.journal.write({ version: 1, active: entry });
    }
    if (registry.get(entry.workspaceId)?.sessionIds.length) fail2("source-changed", "\u539F\u9879\u76EE\u65B0\u589E\u6216\u4ECD\u6709\u4F1A\u8BDD\uFF0C\u8BF7\u4FDD\u7559\u4E24\u4E2A\u9879\u76EE\u5E76\u68C0\u67E5\u8FC1\u79FB\u8FDB\u5EA6");
    target = registry.get(target.id);
    await target.setTitle(entry.title);
    for (const [index, sessionId] of [...entry.sessionIds].reverse().entries()) {
      const anchor = index === 0 ? void 0 : entry.sessionIds[entry.sessionIds.length - index];
      await target.insertSessionBefore(sessionId, anchor);
    }
    await this.groups.update((state) => ({ ...state, groups: state.groups.map((row) => ({ ...row, workspaceIds: row.workspaceIds.map((id) => id === entry.workspaceId ? target.id : id) })) }));
    await this.ledger?.update((state) => ({ ...state, items: state.items.map((item) => item.kind === "session" && item.snapshot.workspaceId === entry.workspaceId && entry.sessionIds.includes(item.id2) ? { ...item, snapshot: { ...item.snapshot, workspaceId: target.id } } : item) }));
    const beforeId = registry.get(entry.beforeId)?.id;
    await registry.insertBefore(target.id, beforeId);
    if (registry.get(entry.workspaceId)) await registry.delete(entry.workspaceId);
    await this.journal.write({ version: 1, active: null });
    return { ok: true, workspaceId: target.id, moved: entry.sessionIds.length };
  }
};

// package.json
var package_default = {
  name: "dsh-session-toolbox",
  version: "0.1.25",
  repository: {
    type: "git",
    url: "https://github.com/AndroidSix/dsh-session-toolbox.git"
  },
  description: "Draft vault, workspace groups, project path migration, queue steering and archive pool for DeepSeek Harness",
  type: "module",
  main: "lib/index.js",
  bin: {
    "dsh-session-toolbox": "lib/cli.js"
  },
  exports: {
    ".": "./lib/index.js",
    "./host": "./lib/host.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  engines: {
    node: "^22.19.0 || >=24.0.0",
    dsh: "^0.2.0-rc.2 || ^0.2.1-rc.2"
  },
  files: [
    "lib",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "session-toolbox.example.json",
    "CHANGELOG.md"
  ],
  dsh: {
    bundle: {
      patch: "./cordis.patch.yml"
    },
    client: {
      inject: [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-workspace"
      ],
      platform: "web"
    }
  },
  scripts: {
    build: "node scripts/build.mjs",
    test: "node --test tests/*.test.mjs",
    check: "npm run build && npm test && node scripts/check-package.mjs",
    "check:tarball": "npm run build && node scripts/check-package.mjs --tarball",
    "pack:release": "npm run build && npm pack --ignore-scripts"
  },
  peerDependencies: {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-atomic-write": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.4",
    react: "^18.2.0",
    "react-dom": "^18.2.0"
  },
  devDependencies: {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-atomic-write": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.4",
    esbuild: "^0.25.0",
    react: "^18.2.0",
    "react-dom": "^18.2.0"
  },
  license: "MIT",
  keywords: [
    "dsh-plugin",
    "deepseek-harness",
    "draft-vault",
    "session-move",
    "trash-bin"
  ]
};

// src/index.mjs
var pluginVersion = package_default.version;
var name = "dsh-session-toolbox";
var inject = [];
var Config = z.object({
  configFile: z.string().description("Directory for session-toolbox data (defaults to <DSH_HOME>/session-toolbox)").default(""),
  dshHome: z.string().description("Override the DSH home whose sessions/ storage the tool manages (advanced)").default("")
});
function defaultKitRoot() {
  return join(resolveDshHome(), "session-toolbox");
}
async function apply(ctx, options = {}) {
  try {
    return await applyInner(ctx, options);
  } catch (error) {
    recordStartupFailure(error);
    const hint = /Cannot find package|ERR_MODULE_NOT_FOUND/.test(String(error?.message ?? error)) ? "\uFF08\u4F9D\u8D56\u7F3A\u5931\uFF1A\u8BF7\u4ECE\u63D2\u4EF6\u9875\u5378\u8F7D\u540E\u91CD\u65B0\u5B89\u88C5\uFF0C\u8BA9\u5305\u7BA1\u7406\u5668\u91CD\u65B0\u62C9\u53D6 peer \u4F9D\u8D56\uFF09" : "";
    ctx.logger?.warn?.(`session-toolbox: disabled after startup error${hint} \u2014 ${error?.message ?? error}`);
  }
}
function startupFailureLog() {
  try {
    return join(resolve(resolveDshHome()), "session-toolbox", "startup-error.log");
  } catch {
    return "";
  }
}
function recordStartupFailure(error) {
  const file = startupFailureLog();
  if (file === "") return;
  try {
    const detail = `${(/* @__PURE__ */ new Date()).toISOString()}
${error?.stack ?? String(error)}

`;
    appendFileSync(file, detail, { mode: 384 });
  } catch {
  }
}
async function applyInner(ctx, options = {}) {
  const dshHome = resolve(options.dshHome || resolveDshHome());
  const root = resolve(options.configFile || join(dshHome, "session-toolbox"));
  await mkdir2(root, { recursive: true, mode: 448 });
  const capabilities = {
    workspaceRegistry: ctx.get("workspaceRegistry") !== void 0,
    sessions: ctx.get("sessions") !== void 0,
    sessionPersistence: ctx.get("sessionPersistence") !== void 0,
    webServer: false
    // flips true when the optional webServer inject fires
  };
  const settingsDoc = new JsonDocument(root, "session-toolbox.json", { version: 1 }, guardSettings);
  const journalDoc = new JsonDocument(root, "journal.json", { version: 1, active: null }, guardJournal);
  const ledgerDoc = new JsonDocument(root, "trash.json", { version: 1, items: [] }, guardLedger);
  const manifestDoc = new JsonDocument(root, "vault-manifest.json", { version: 1, records: [] }, guardManifest);
  const groupsDoc = new JsonDocument(root, "groups.json", { version: 1, groups: [] }, guardGroups);
  const workspaceJournalDoc = new JsonDocument(root, "workspace-journal.json", { version: 1, active: null }, guardWorkspaceJournal);
  let settingsCache = await settingsDoc.read().catch(() => ({ trash: {}, draftVault: {} }));
  let journalCache = null;
  try {
    journalCache = (await journalDoc.read()).active;
  } catch (error) {
    ctx.logger?.warn?.(`session-toolbox: journal unreadable \u2014 ${error.message}`);
  }
  if (journalCache !== null) ctx.logger?.warn?.(`session-toolbox: unresolved move journal for ${journalCache.sessionId}; complete or roll it back from the panel or CLI`);
  const move = new MoveEngine({
    root,
    sessionsRoot: join(dshHome, "sessions"),
    projcacheRoot: join(dshHome, "storages", "session_projcache", "sessions"),
    journal: journalDoc,
    capabilities: hostCapabilities(ctx)
  });
  const workspace = new WorkspaceTools({ registry: () => ctx.get("workspaceRegistry"), move, groups: groupsDoc, journal: workspaceJournalDoc, ledger: ledgerDoc });
  const trash = new TrashEngine({
    adapter: registryAdapter(ctx),
    sessions: async () => {
      const ids = (ctx.get("sessions")?.list() ?? []).map((session) => session.header?.id).filter((id) => typeof id === "string");
      return (await Promise.all(ids.map(async (id) => await hostCapabilities(ctx).sessionLive(id) ? id : null))).filter(Boolean);
    },
    loaded: (id) => ctx.get("sessions")?.get?.(id) !== void 0,
    sessionsRoot: join(dshHome, "sessions"),
    projcacheRoot: join(dshHome, "storages", "session_projcache", "sessions"),
    kitRoot: root,
    ledger: ledgerDoc,
    vault: { dropSession: (sessionId) => manifestDoc.update((current) => ({ ...current, records: current.records.filter((record) => record.sessionId !== sessionId) })) },
    journal: async () => (await journalDoc.read()).active,
    settings: () => settingsCache.trash ?? {}
  });
  const listProjects = (ctx2) => {
    const registry = ctx2.get("workspaceRegistry");
    if (registry === void 0) return [];
    return registry.list().map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title ?? row.path,
      sessions: (row.sessionIds ?? []).length
    })).sort((a, b) => a.title.localeCompare(b.title));
  };
  let pendingAction = Promise.resolve();
  const kit = {
    settings: settingsDoc,
    manifest: manifestDoc,
    journal: journalDoc,
    move,
    trash,
    workspace,
    updateSettings: async (patch) => {
      const next = await settingsDoc.update((current) => deepMerge(current, patch));
      settingsCache = next;
      return next;
    },
    vaultSync: async (records) => {
      const manifest = await manifestDoc.update(() => ({
        version: 1,
        records: (Array.isArray(records) ? records : []).filter((record) => typeof record.sessionId === "string" && typeof record.attachmentId === "string").slice(-2e3).map((record) => ({
          sessionId: record.sessionId,
          attachmentId: record.attachmentId,
          name: String(record.name ?? ""),
          size: Number(record.size) || 0,
          hash: String(record.hash ?? ""),
          createdAt: Number(record.createdAt) || Date.now()
        }))
      }));
      return manifest;
    },
    state: async () => {
      const settings = await settingsDoc.read();
      settingsCache = settings;
      const journal = (await journalDoc.read().catch(() => ({ active: journalCache }))).active;
      journalCache = journal;
      const manifest = await manifestDoc.read();
      return {
        pluginVersion,
        capabilities,
        settings,
        journal,
        projects: listProjects(ctx),
        groups: (await groupsDoc.read()).groups,
        workspaceMove: await workspace.active(),
        trash: await trash.items(),
        // Bytes live in browser IndexedDB; the manifest mirrors their metadata only.
        vault: { records: manifest.records.length, bytes: manifest.records.reduce((total, record) => total + (record.size ?? 0), 0) },
        recovery: journal === null ? null : `\u672A\u5B8C\u6210\u8FC1\u79FB\uFF1A${journal.sessionId} \u2192 ${journal.toCwd}\uFF08\u5DF2\u5B8C\u6210 ${journal.done.join("/") || "\u65E0"}\uFF09`
      };
    },
    /** The project a session currently belongs to (null when unknown). */
    projectOf: async (sessionId) => {
      if (sessionId === "") return null;
      const registry = ctx.get("workspaceRegistry");
      if (registry === void 0) return null;
      for (const row of registry.list()) {
        if ((row.sessionIds ?? []).includes(sessionId)) {
          return { id: row.id, path: row.path, title: row.title ?? row.path };
        }
      }
      return null;
    },
    action: (input) => {
      const result = pendingAction.then(async () => {
        if (!["workspace.complete", "project.of", "trash.list", "vault.sync", "vault.sweep", "settings.update"].includes(input.type)) await workspace.assertIdle();
        return dispatch(kit, input);
      });
      pendingAction = result.catch(() => {
      });
      return result;
    }
  };
  ctx.inject?.(["webServer"], (webCtx) => {
    capabilities.webServer = true;
    webCtx.effect(() => webCtx.webServer.register({ kind: "exact", path: "/.well-known/dsh-session-toolbox", handler: apiHandler(kit) }));
  });
  ctx.provide("sessionToolbox", kit);
  ctx.effect(() => {
    const sweep = () => {
      void kit.action({ type: "trash.sweep" }).catch((error) => ctx.logger?.warn?.(`session-toolbox: trash sweep failed \u2014 ${error.message}`));
    };
    const timer = setInterval(sweep, 60 * 60 * 1e3);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  ctx.logger?.info?.("dsh-session-toolbox ready", JSON.stringify({ version: pluginVersion, capabilities }));
}
function hostCapabilities(ctx) {
  return {
    sessionMaintenance: createSessionMaintenance(ctx),
    /**
     * Whether a session is actively working.
     *
     * The old check asked whether `sessions.list()` contained the id, but that
     * list holds every session the host has loaded — a session that is merely
     * open (or was opened at some point) counted as live and blocked every
     * move. The official activity hook is `workspace/session-activity`: any
     * returned activity (turn, job, subagent or schedule) blocks relocation.
     */
    sessionLive: async (sessionId) => {
      const activities = await ctx.waterfall?.("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
      return Array.isArray(activities) && activities.length > 0;
    },
    sessionLoaded: (sessionId) => ctx.get("sessions")?.get?.(sessionId) !== void 0,
    listHeaders: async () => {
      const persistence = ctx.get("sessionPersistence");
      if (persistence?.list !== void 0) return (await persistence.list()).map((snapshot) => snapshot.header);
      const registry = ctx.get("workspaceRegistry");
      if (registry?.listStoredHeaders !== void 0) return await registry.listStoredHeaders();
      throw new Error("no session-persistence service in this DSH build");
    },
    /** Drop stale header entries so `attachSession` validates the NEW on-disk cwd (§10 MR4). */
    refreshHeaderCache: async () => {
      const registry = ctx.get("workspaceRegistry");
      if (typeof registry?.replaceHeaderIndex !== "function") return;
      await registry.replaceHeaderIndex(await registry.listStoredHeaders());
    },
    /** Ledger step (§10 MR2 step 2): source detach → target create → attach. */
    moveLedger: async (sessionId, fromCwd, toCwd) => {
      const registry = ctx.get("workspaceRegistry");
      if (registry === void 0) throw new Error("workspaceRegistry unavailable in this DSH build");
      const canonicalFrom = fromCwd === void 0 ? void 0 : await realpath2(fromCwd).catch(() => fromCwd);
      const source = canonicalFrom === void 0 ? void 0 : typeof registry.list === "function" ? registry.list().find((row) => row.path === canonicalFrom) : await registry.resolveByPath(canonicalFrom);
      if (source !== void 0) await source.detachSession(sessionId);
      if (toCwd === void 0) return;
      let target = await registry.resolveByPath(toCwd);
      if (target === void 0) {
        if (!await stat3(toCwd).then((s) => s.isDirectory(), () => false)) throw new Error(`target directory ${toCwd} does not exist`);
        target = await registry.create(toCwd);
      }
      await target.attachSession(sessionId);
    },
    resyncIndex: async () => {
      return ctx.get("sessionQuery") !== void 0 ? "lazy" : "unavailable";
    },
    /**
     * Re-read the session headers so the registry (and every list built from
     * it) sees the session's new location. This is the host-side half of
     * "refresh"; the client half is a refetch scoped to this one session.
     */
    refreshPlacement: async (sessionId) => {
      const registry = ctx.get("workspaceRegistry");
      if (registry === void 0) return "unavailable";
      if (typeof registry.listStoredHeaders === "function" && typeof registry.replaceHeaderIndex === "function") {
        await registry.replaceHeaderIndex(await registry.listStoredHeaders());
      }
      await ctx.get("sessionPersistence")?.refresh?.().catch?.(() => {
      });
      return registry.sessionKnown !== void 0 && sessionId !== void 0 ? await registry.sessionKnown(sessionId) ? "known" : "unknown" : "refreshed";
    }
  };
}
function registryAdapter(ctx) {
  const registry = () => {
    const value = ctx.get("workspaceRegistry");
    if (value === void 0) throw Object.assign(new Error("workspaceRegistry unavailable"), { code: "no-capability" });
    return value;
  };
  return {
    sessionKnown: async (sessionId) => {
      const rows = registry();
      return typeof rows.sessionKnown === "function" ? await rows.sessionKnown(sessionId) : false;
    },
    archivedSet: async () => new Set(ctx.get("workspaceRegistry")?.archivedSessionIds ?? []),
    pinnedSet: async () => new Set(registry().pinnedSessionIds ?? []),
    locateSession: async (sessionId) => {
      let title = null;
      try {
        title = (await ctx.get("sessionQuery")?.readTitle?.(sessionId))?.title ?? null;
      } catch {
      }
      for (const entity of registry().list()) {
        const ids = entity.sessionIds ?? [];
        if (!ids.includes(sessionId)) continue;
        const at = ids.indexOf(sessionId);
        return { workspaceId: entity.id, beforeId: at + 1 < ids.length ? ids[at + 1] : null, title };
      }
      return { workspaceId: null, beforeId: null, title };
    },
    workspaceSnapshot: async (workspaceId) => {
      const rows = registry();
      const entity = rows.get(workspaceId);
      if (entity === void 0) return void 0;
      const ids = entity.sessionIds ?? [];
      const archived = new Set(rows.archivedSessionIds ?? []);
      const pinned = new Set(rows.pinnedSessionIds ?? []);
      const order = rows.list().map((row) => row.id);
      const at = order.indexOf(entity.id);
      return {
        workspaceId: entity.id,
        path: entity.path,
        title: entity.title,
        beforeId: at + 1 < order.length ? order[at + 1] : null,
        sessions: ids.map((sessionId, index) => ({
          sessionId,
          previouslyArchived: archived.has(sessionId),
          previouslyPinned: pinned.has(sessionId),
          beforeId: index + 1 < ids.length ? ids[index + 1] : null
        }))
      };
    },
    archiveSession: (sessionId, options) => registry().archiveSession(sessionId, options),
    unarchiveSession: (sessionId) => registry().unarchiveSession(sessionId),
    pinSession: (sessionId) => registry().pinSession(sessionId),
    unpinSession: (sessionId) => registry().unpinSession(sessionId),
    deleteWorkspace: (workspaceId) => registry().delete(workspaceId),
    repairSlot: async (sessionId, workspaceId, beforeId) => {
      const entity = registry().get(workspaceId);
      if (entity === void 0) return;
      if (!entity.sessionIds?.includes(sessionId)) await entity.attachSession(sessionId);
      await entity.insertSessionBefore(sessionId, beforeId !== null && entity.sessionIds?.includes(beforeId) ? beforeId : void 0);
    },
    restoreWorkspace: async (snapshot) => {
      const rows = registry();
      let entity = rows.list().find((row) => row.path === snapshot.path);
      if (entity === void 0) {
        await mkdir2(snapshot.path, { recursive: true }).catch(() => {
        });
        entity = await rows.create(snapshot.path, snapshot.title);
      }
      for (const row of [...snapshot.sessions].reverse()) await entity.attachSession(row.sessionId);
      for (const row of [...snapshot.sessions].reverse()) {
        await entity.insertSessionBefore(row.sessionId, row.beforeId ?? void 0);
      }
      const anchor = rows.list().some((row) => row.id === snapshot.beforeId) ? snapshot.beforeId : void 0;
      if (entity.id !== anchor) await rows.insertBefore(entity.id, anchor);
      return entity;
    },
    purgeSession: async (sessionId) => {
      for (const entity of registry().list()) {
        if (entity.sessionIds?.includes(sessionId)) await entity.detachSession(sessionId);
      }
      await hostCapabilities(ctx).refreshHeaderCache();
    },
    /** Re-read headers so a restored/archived session's placement is visible. */
    refreshPlacement: async (sessionId) => hostCapabilities(ctx).refreshPlacement(sessionId)
  };
}
function deepMerge(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    next[key] = value !== null && typeof value === "object" && !Array.isArray(value) ? deepMerge(base[key] ?? {}, value) : value;
  }
  return next;
}
export {
  Config,
  apply,
  defaultKitRoot,
  hostCapabilities,
  inject,
  name,
  registryAdapter
};
//# sourceMappingURL=index.js.map
