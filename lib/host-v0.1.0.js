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
} from "./chunk-4UQB3MPY.js";

// src/index.mjs
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

// package.json
var package_default = {
  name: "dsh-session-toolbox",
  version: "0.1.0",
  repository: {
    type: "git",
    url: "https://github.com/AndroidSix/dsh-session-toolbox.git"
  },
  description: "Draft vault, session-to-project move and a trash bin for DeepSeek Harness",
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
    node: "^22.19.0 || >=24.0.0"
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
        "@deepseek-ai/dsh-client-ui-renderer"
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
    "@deepseek-ai/dsh-atomic-write": "0.2.0-rc.2",
    "@deepseek-ai/dsh-home-paths": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "^3.18.4",
    react: "^18.2.0"
  },
  devDependencies: {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-atomic-write": "0.2.0-rc.2",
    "@deepseek-ai/dsh-home-paths": "0.2.0-rc.2",
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
  const dshHome = resolve(options.dshHome || resolveDshHome());
  const root = resolve(options.configFile || join(dshHome, "session-toolbox"));
  await mkdir(root, { recursive: true, mode: 448 });
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
  const trash = new TrashEngine({
    adapter: registryAdapter(ctx),
    sessions: () => (ctx.get("sessions")?.list() ?? []).map((session) => session.header?.id).filter((id) => typeof id === "string"),
    sessionsRoot: join(dshHome, "sessions"),
    projcacheRoot: join(dshHome, "storages", "session_projcache", "sessions"),
    kitRoot: root,
    ledger: ledgerDoc,
    vault: { dropSession: (sessionId) => manifestDoc.update((current) => ({ ...current, records: current.records.filter((record) => record.sessionId !== sessionId) })) },
    journal: () => journalCache,
    settings: () => settingsCache.trash ?? {}
  });
  const kit = {
    settings: settingsDoc,
    manifest: manifestDoc,
    journal: journalDoc,
    move,
    trash,
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
        trash: await trash.items(),
        // Bytes live in browser IndexedDB; the manifest mirrors their metadata only.
        vault: { records: manifest.records.length, bytes: manifest.records.reduce((total, record) => total + (record.size ?? 0), 0) },
        recovery: journal === null ? null : `\u672A\u5B8C\u6210\u8FC1\u79FB\uFF1A${journal.sessionId} \u2192 ${journal.toCwd}\uFF08\u5DF2\u5B8C\u6210 ${journal.done.join("/") || "\u65E0"}\uFF09`
      };
    },
    action: (input) => dispatch(kit, input)
  };
  ctx.inject?.(["webServer"], (webCtx) => {
    capabilities.webServer = true;
    webCtx.effect(() => webCtx.webServer.register({ kind: "exact", path: "/.well-known/dsh-session-toolbox", handler: apiHandler(kit) }));
  });
  ctx.provide("sessionToolbox", kit);
  ctx.effect(() => () => {
  });
  ctx.logger?.info?.("dsh-session-toolbox ready", JSON.stringify({ version: pluginVersion, capabilities }));
}
function hostCapabilities(ctx) {
  return {
    sessionLive: (sessionId) => {
      const sessions = ctx.get("sessions");
      return sessions ? sessions.list().some((session) => session.header?.id === sessionId) : false;
    },
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
      const canonicalFrom = fromCwd === void 0 ? void 0 : await realpath(fromCwd).catch(() => fromCwd);
      const source = canonicalFrom === void 0 ? void 0 : await registry.resolveByPath(canonicalFrom);
      if (source !== void 0) await source.detachSession(sessionId);
      let target = await registry.resolveByPath(toCwd);
      if (target === void 0) {
        if (!await stat(toCwd).then((s) => s.isDirectory(), () => false)) throw new Error(`target directory ${toCwd} does not exist`);
        target = await registry.create(toCwd);
      }
      await target.attachSession(sessionId);
    },
    resyncIndex: async () => {
      return ctx.get("sessionQuery") !== void 0 ? "lazy" : "unavailable";
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
    archivedSet: async () => new Set(registry().archivedSessionIds ?? []),
    pinnedSet: async () => new Set(registry().pinnedSessionIds ?? []),
    locateSession: async (sessionId) => {
      for (const entity of registry().list()) {
        const ids = entity.sessionIds ?? [];
        if (!ids.includes(sessionId)) continue;
        const at = ids.indexOf(sessionId);
        return { workspaceId: entity.id, beforeId: at + 1 < ids.length ? ids[at + 1] : null, title: null };
      }
      return { workspaceId: null, beforeId: null, title: null };
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
        beforeId: at > 0 ? order[at - 1] : null,
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
      if (beforeId !== null && entity.sessionIds?.includes(beforeId)) await entity.insertSessionBefore(sessionId, beforeId);
    },
    restoreWorkspace: async (snapshot) => {
      const rows = registry();
      let entity = rows.list().find((row) => row.path === snapshot.path);
      if (entity === void 0) {
        await mkdir(snapshot.path, { recursive: true }).catch(() => {
        });
        entity = await rows.create(snapshot.path, snapshot.title);
      }
      for (const row of [...snapshot.sessions].reverse()) await entity.attachSession(row.sessionId).catch(() => {
      });
      if (snapshot.beforeId !== null && entity.id !== snapshot.beforeId) await rows.insertBefore(entity.id, snapshot.beforeId).catch(() => {
      });
      return entity;
    },
    purgeSession: async () => ctx.get("sessionPersistence")?.delete === void 0 ? "unavailable" : "present"
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
