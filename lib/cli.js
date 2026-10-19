import {
  JsonDocument,
  MoveEngine,
  TrashEngine,
  apiHandler,
  dispatch,
  guardJournal,
  guardLedger,
  guardSettings
} from "./chunk-XMUL4SUS.js";

// src/cli.mjs
import { basename, dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
var defaultKitRoot = () => join(resolveDshHome(), "session-toolbox");
var OfflineLedger = class {
  constructor(workspaceFile) {
    this.file = workspaceFile;
    this.doc = new JsonDocument(dirname(workspaceFile), basename(workspaceFile), {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: {} }
    });
  }
  async #read() {
    return this.doc.read();
  }
  async moveLedger(sessionId, fromCwd, toCwd) {
    await this.doc.update((state) => {
      const workspaces = state.tables.workspaces;
      for (const record of Object.values(workspaces)) record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
      if (toCwd !== void 0) {
        const target = Object.values(workspaces).find((record) => record.path === toCwd);
        if (target === void 0) {
          const id = crypto.randomUUID();
          workspaces[id] = { path: toCwd, title: toCwd.split(/[/\\]/).filter(Boolean).at(-1) ?? toCwd, sessionIds: [sessionId], createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
          state.global.workspaceIds.unshift(id);
        } else {
          target.sessionIds.unshift(sessionId);
          target.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
      }
      return state;
    });
  }
  async purgeSession(sessionId) {
    await this.doc.update((state) => {
      for (const record of Object.values(state.tables.workspaces)) record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
      state.global.archivedSessionIds = state.global.archivedSessionIds.filter((id) => id !== sessionId);
      state.global.pinnedSessionIds = state.global.pinnedSessionIds.filter((id) => id !== sessionId);
      return state;
    });
  }
  async deleteWorkspace(id) {
    await this.doc.update((state) => {
      delete state.tables.workspaces[id];
      state.global.workspaceIds = state.global.workspaceIds.filter((value) => value !== id);
      return state;
    });
  }
  async resyncIndex() {
    return "skipped-offline";
  }
  async listStoredHeaders() {
    const state = await this.#read();
    return Object.values(state.tables?.workspaces ?? {}).flatMap((record) => record.sessionIds.map((id) => ({ id, cwd: record.path })));
  }
};
function buildKit({ root, dshHome = resolveDshHome(), ledger = new OfflineLedger(join(dshHome, "storages", "workspace.json")), now = () => Date.now() } = {}) {
  root ??= join(dshHome, "session-toolbox");
  const settingsDoc = new JsonDocument(root, "session-toolbox.json", { version: 1 }, guardSettings);
  const journalDoc = new JsonDocument(root, "journal.json", { version: 1, active: null }, guardJournal);
  const ledgerDoc = new JsonDocument(root, "trash.json", { version: 1, items: [] }, guardLedger);
  const manifestDoc = new JsonDocument(root, "vault-manifest.json", { version: 1, records: [] });
  let lastSettings = { trash: {} };
  const move = new MoveEngine({
    root,
    sessionsRoot: join(dshHome, "sessions"),
    projcacheRoot: join(dshHome, "storages", "session_projcache", "sessions"),
    journal: journalDoc,
    capabilities: { listHeaders: () => ledger.listStoredHeaders(), moveLedger: (...args) => ledger.moveLedger(...args), resyncIndex: () => ledger.resyncIndex() },
    now
  });
  const trash = new TrashEngine({
    adapter: offlineAdapter(ledger),
    sessionsRoot: join(dshHome, "sessions"),
    projcacheRoot: join(dshHome, "storages", "session_projcache", "sessions"),
    kitRoot: root,
    ledger: ledgerDoc,
    journal: async () => (await journalDoc.read()).active,
    settings: () => lastSettings.trash ?? {},
    now
  });
  const kit = {
    move,
    trash,
    journalDoc,
    settingsDoc,
    manifestDoc,
    settings: settingsDoc,
    manifest: manifestDoc,
    updateSettings: async (patch) => {
      const next = await settingsDoc.update((current) => ({ ...current, ...patch }));
      lastSettings = next;
      return next;
    },
    state: async () => ({
      pluginVersion: "cli",
      settings: await settingsDoc.read(),
      journal: (await journalDoc.read()).active,
      trash: await trash.items()
    }),
    action: (input) => dispatch(kit, input)
  };
  return kit;
}
function offlineAdapter(ledger) {
  return {
    sessionKnown: async () => true,
    archivedSet: async () => /* @__PURE__ */ new Set(),
    pinnedSet: async () => /* @__PURE__ */ new Set(),
    locateSession: async () => ({ workspaceId: null, beforeId: null, title: null }),
    workspaceSnapshot: async () => void 0,
    archiveSession: async () => {
      throw new Error("offline trash sessions require a running DSH for archive semantics");
    },
    unarchiveSession: async () => {
    },
    pinSession: async () => {
    },
    unpinSession: async () => {
    },
    deleteWorkspace: (id) => ledger.deleteWorkspace(id),
    repairSlot: async () => {
    },
    restoreWorkspace: async () => {
    },
    purgeSession: (sessionId) => ledger.purgeSession(sessionId)
  };
}
var USAGE = `dsh-session-toolbox \u2014 \u8349\u7A3F\u4FDD\u9669\u7BB1 / \u4F1A\u8BDD\u5207\u6362\u9879\u76EE / \u56DE\u6536\u7AD9\uFF08CLI\uFF1A\u5728 DSH \u505C\u6B62\u65F6\u6267\u884C\u79BB\u7EBF\u7EF4\u62A4\uFF09

\u7528\u6CD5\uFF1A
  dsh-session-toolbox status
  dsh-session-toolbox move --session <session-\u2026> --to <\u7EDD\u5BF9\u8DEF\u5F84> [--create] [--root <kit\u76EE\u5F55>]
  dsh-session-toolbox recover            # \u5B8C\u6210(\u524D\u6EDA)\u88AB\u4E2D\u65AD\u7684\u8FC1\u79FB\uFF1B\u5148\u5C1D\u8BD5\uFF0C\u5931\u8D25\u518D\u56DE\u6EDA
  dsh-session-toolbox rollback
  dsh-session-toolbox trash-purge --item <itemId>

\u6CE8\u610F\uFF1ACLI \u76F4\u5199 <DSH_HOME>/storages/workspace.json \u4F5C\u4E3A\u79BB\u7EBF\u8D26\u672C\u955C\u50CF\uFF1B\u8FD0\u884C\u4E2D\u7684
DSH \u8BF7\u4F18\u5148\u901A\u8FC7\u63D2\u4EF6\u9762\u677F\u64CD\u4F5C\uFF08\u5BBF\u4E3B RPC \u4E0E\u5185\u5B58\u7D22\u5F15\u66F4\u51C6\uFF09\u3002\u6267\u884C move \u524D\u8BF7\u5B8C\u5168\u9000\u51FA
DSH\uFF0Cmove \u5B8C\u6210\u540E\u91CD\u542F\u4E00\u6B21\uFF0C\u5BBF\u4E3B\u4F1A\u6309\u65B0\u7684 header \u91CD\u5EFA\u7D22\u5F15\u3002`;
async function main(argv) {
  const { parseArgs } = await import("node:util");
  const { values, positionals } = parseArgs({ args: argv, options: {
    session: { type: "string" },
    to: { type: "string" },
    root: { type: "string" },
    create: { type: "boolean" },
    item: { type: "string" },
    "dry-run": { type: "boolean" }
  }, allowPositionals: true });
  const command = positionals[0];
  const kit = buildKit({ root: values.root });
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
  try {
    switch (command) {
      case "status":
        print(await kit.state());
        return 0;
      case "move": {
        if (!values.session || !values.to) throw new Error("\u9700\u8981 --session \u4E0E --to");
        if (values["dry-run"]) {
          print({ plan: await kit.move.preflight({ sessionId: values.session, toCwd: values.to, createTarget: values.create === true }) });
          return 0;
        }
        print(await kit.action({ type: "move", sessionId: values.session, toCwd: values.to, createTarget: values.create === true }));
        return 0;
      }
      case "recover": {
        try {
          print(await kit.move.complete());
        } catch (error) {
          print({ completedFailed: String(error?.message ?? error), rollback: await kit.move.rollback() });
        }
        return 0;
      }
      case "rollback":
        print(await kit.move.rollback());
        return 0;
      case "trash-purge": {
        if (!values.item) throw new Error("\u9700\u8981 --item");
        print(await kit.trash.purge(values.item));
        return 0;
      }
      default:
        process.stderr.write(`${USAGE}
`);
        return command === void 0 ? 0 : 2;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error), code: error?.code, journal: error?.journal })}
`);
    return 1;
  }
}
if (process.argv[1] !== void 0 && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
export {
  OfflineLedger,
  apiHandler,
  buildKit,
  defaultKitRoot,
  main
};
//# sourceMappingURL=cli.js.map
