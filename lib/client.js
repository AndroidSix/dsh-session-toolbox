window.__ModuleLoader__.load({ id: "dsh-session-toolbox", factory: (require) => { var module = { exports: {} };
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  KitPage: () => KitPage,
  MoveDialog: () => MoveDialog,
  MoveSessionMenuItem: () => MoveSessionMenuItem,
  NS: () => NS,
  TrashSessionMenuItem: () => TrashSessionMenuItem,
  VaultBadge: () => VaultBadge,
  apply: () => apply,
  callHost: () => callHost,
  inject: () => inject,
  loadState: () => loadState,
  name: () => name,
  sessionKey: () => sessionKey
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// package.json
var package_default = {
  name: "dsh-session-toolbox",
  version: "0.1.10",
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
    "@deepseek-ai/dsh-atomic-write": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.2 || ^0.2.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.4",
    react: "^18.2.0"
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

// src/draft-vault.js
var DB_NAME = "dsh-session-toolbox-vault";
var STORE = "blobs";
var IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
var SEED_MARKER = Symbol.for("dsh-session-toolbox.seed");
var MAX_FILE_BYTES = 10 * 1024 * 1024;
var DEFAULT_LIMITS = Object.freeze({ enabled: true, maxSizeBytes: 200 * 1024 * 1024, ttlDays: 7 });
function isImageFile(file) {
  return file !== void 0 && IMAGE_TYPES.includes(file.type) && file.size > 0 && file.size <= MAX_FILE_BYTES;
}
async function contentHash(file) {
  if (globalThis.crypto?.subtle !== void 0) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
    }
  }
  return `weak:${file.size}:${file.name}:${file.lastModified}`;
}
function openDb() {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}
function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("vault storage request failed"));
  });
}
function storeOp(database, mode, run) {
  return new Promise((resolve, reject) => {
    let outcome;
    const transaction = database.transaction(STORE, mode);
    transaction.onabort = () => reject(transaction.error ?? new Error("vault transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("vault transaction failed"));
    try {
      outcome = run(transaction.objectStore(STORE));
    } catch (error) {
      reject(error);
      return;
    }
    Promise.resolve(outcome).then(resolve, reject);
  });
}
function emitter() {
  const listeners = /* @__PURE__ */ new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, /* @__PURE__ */ new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, detail) {
      for (const fn of [...listeners.get(event) ?? []]) {
        try {
          fn(detail);
        } catch {
        }
      }
    }
  };
}
function fakeClipboardData(files) {
  const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
  return { items, files, length: files.length, types: ["Files"], getData: () => "", setData: () => false, clearData: () => {
  } };
}
async function blobToFile(record) {
  if (record.blob instanceof File) return record.blob;
  const blob = record.blob instanceof Blob ? record.blob : new Blob([record.blob ?? new Uint8Array()], { type: record.type });
  return new File([blob], record.name ?? "", { type: record.type, lastModified: record.createdAt });
}
function createVault(options = {}) {
  const log = options.log ?? (() => {
  });
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const bus = emitter();
  let dbPromise = null;
  let limits = { ...DEFAULT_LIMITS };
  let lastNotice = "";
  let started = false;
  let teardown = null;
  let hostKey = "";
  const db = () => dbPromise ??= openDb();
  function notice(message) {
    lastNotice = message;
    bus.emit("notice", message);
    try {
      globalThis.window?.dispatchEvent?.(new CustomEvent("dsh-session-toolbox-notice", { detail: message }));
    } catch {
    }
  }
  function changed() {
    bus.emit("change");
  }
  const allRecords = async () => {
    const database = await db();
    return await storeOp(database, "readonly", (store2) => done(store2.getAll()));
  };
  const putRecord = async (record) => {
    const database = await db();
    await storeOp(database, "readwrite", (store2) => done(store2.put(record)));
  };
  const dropRecord = async (key) => {
    const database = await db();
    await storeOp(database, "readwrite", (store2) => done(store2.delete(key)));
  };
  async function syncHost() {
    const endpoint = options.endpoint ?? "/.well-known/dsh-session-toolbox";
    try {
      if (hostKey === "") {
        const probe = await fetchImpl(endpoint, { cache: "no-store" });
        hostKey = (await probe.json()).key ?? "";
      }
      const records = (await allRecords()).slice(-500).map(({ key, sessionId, attachmentId, name: name2, size, hash, seeded, createdAt, sentAt }) => ({ key, sessionId, attachmentId, name: name2, size, hash, seeded, createdAt, sentAt: sentAt ?? 0 }));
      await fetchImpl(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-session-toolbox-key": hostKey },
        body: JSON.stringify({ type: "vault.sync", records })
      });
    } catch {
    }
  }
  async function sweep() {
    const records = await allRecords();
    const ttlMs = limits.ttlDays * 24 * 60 * 60 * 1e3;
    const keep = [];
    const remove = [];
    for (const record of records) (now() - (record.createdAt ?? 0) > ttlMs ? remove : keep).push(record);
    keep.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    let bytes = keep.reduce((total, record) => total + (record.size ?? 0), 0);
    while (bytes > limits.maxSizeBytes && keep.length > 0) {
      const oldest = keep.shift();
      bytes -= oldest.size ?? 0;
      remove.push(oldest);
    }
    for (const record of remove) await dropRecord(record.key);
    if (remove.length > 0) notice(`\u8349\u7A3F\u4FDD\u9669\u7BB1\u5DF2\u6E05\u7406 ${remove.length} \u9879\uFF08\u8D85\u671F/\u8D85\u5BB9\u91CF\uFF09`);
    changed();
    return { removed: remove.length, kept: keep.length, bytes };
  }
  async function intake(sessionId, files) {
    if (!limits.enabled || sessionId === void 0 || sessionId === "") return;
    const existing = (await allRecords()).filter((record) => record.sessionId === sessionId);
    const seen = new Set(existing.map((record) => record.hash));
    let added = 0;
    for (const item of files) {
      if (!isImageFile(item)) continue;
      const hash = await contentHash(item);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const id = globalThis.crypto?.randomUUID?.() ?? `id-${now()}-${Math.random().toString(36).slice(2)}`;
      const record = {
        key: `${sessionId}__${id}`,
        sessionId,
        attachmentId: id,
        name: item.name || "",
        type: item.type,
        size: item.size,
        hash,
        createdAt: now(),
        sentAt: 0,
        seeded: false
      };
      record.blob = item;
      await putRecord(record);
      added += 1;
    }
    if (added > 0) notice(`\u5DF2\u5907\u4EFD ${added} \u5F20\u8349\u7A3F\u56FE\u7247\uFF08\u4F1A\u8BDD ${sessionId.slice(-6)}\uFF09`);
    void syncHost();
  }
  const readImages = (event) => [...event.clipboardData?.files ?? event.dataTransfer?.files ?? []].filter(isImageFile);
  const fileInputImages = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "file" || target.files === null) return [];
    return [...target.files].filter(isImageFile);
  };
  function currentSession() {
    return document.querySelector?.("[data-conversation-session]")?.getAttribute?.("data-conversation-session") ?? "";
  }
  function composerRoot() {
    return document.querySelector?.('[data-conversation-session] [contenteditable="true"]') ?? void 0;
  }
  function attachmentRail(editor) {
    const bar = editor?.closest?.('[data-composer-bar], [data-conversation-region="composer"]') ?? editor?.parentElement?.parentElement?.parentElement;
    if (bar?.querySelectorAll === void 0) return void 0;
    return [...bar.querySelectorAll("img")].filter((img) => img.getAttribute?.("src")?.startsWith("blob:"));
  }
  async function seedSession(sessionId = currentSession()) {
    if (sessionId === void 0 || sessionId === "" || !limits.enabled) return false;
    const editor = composerRoot();
    if (editor === void 0) return false;
    const rail = attachmentRail(editor);
    if (rail === void 0) return false;
    if (rail.length > 0) return true;
    const pending = (await allRecords()).filter((record) => record.sessionId === sessionId && !record.sentAt);
    if (pending.length === 0) return true;
    const files = [];
    for (const record of pending) {
      try {
        files.push(await blobToFile(record));
      } catch {
        await dropRecord(record.key);
      }
    }
    if (files.length === 0) {
      changed();
      return false;
    }
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: fakeClipboardData(files) });
    try {
      Object.defineProperty(event, SEED_MARKER, { value: true });
    } catch {
    }
    try {
      editor.focus?.();
    } catch {
    }
    editor.dispatchEvent(event);
    const accepted = event.defaultPrevented === true;
    if (accepted) notice(`\u5DF2\u6062\u590D ${files.length} \u5F20\u8349\u7A3F\u56FE\u7247\uFF08\u4F1A\u8BDD ${sessionId.slice(-6)}\uFF09`);
    else log("warn", "synthetic paste was not accepted; vault stays idle for this session");
    if (accepted) for (const record of pending) await putRecord({ ...record, seeded: true });
    changed();
    return accepted;
  }
  async function retireSession(sessionId, reason) {
    let retired = 0;
    for (const record of await allRecords()) {
      if (record.sessionId !== sessionId || record.sentAt) continue;
      await putRecord({ ...record, sentAt: now() });
      retired += 1;
    }
    if (retired > 0) {
      notice(reason === "sent" ? `\u672C\u4F1A\u8BDD\u8349\u7A3F\u5DF2\u968F\u6D88\u606F\u53D1\u9001\uFF0C${retired} \u5F20\u5907\u4EFD\u4E0D\u518D\u6062\u590D` : `\u672C\u4F1A\u8BDD\u8349\u7A3F\u5DF2\u6E05\u7A7A\uFF0C${retired} \u5F20\u5907\u4EFD\u4E0D\u518D\u6062\u590D`);
      void syncHost();
    }
    changed();
    return retired;
  }
  function watchSession(sessionId, editor) {
    let rail = attachmentRail(editor)?.length ?? 0;
    const scope = editor.closest?.("[data-conversation-content]") ?? editor;
    const check = async () => {
      const next = attachmentRail(editor)?.length ?? rail;
      if (next === rail) return;
      if (rail > 0 && next === 0 && scope?.isConnected === true) {
        await retireSession(sessionId, "sent");
      }
      rail = next;
      changed();
    };
    if (typeof MutationObserver !== "function") return () => {
    };
    const observer = new MutationObserver(() => void check());
    observer.observe(scope, { subtree: true, childList: true });
    const onKeyDown = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const target = event.target;
      if (target?.closest?.("[data-conversation-session]") === null || target?.closest?.("[data-conversation-session]") === void 0) return;
      if ((attachmentRail(editor)?.length ?? 0) > 0) void retireSession(sessionId, "sent");
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }
  function watchMounts() {
    let boundSession = "", dispose = () => {
    };
    const sync = async () => {
      const sessionId = currentSession();
      const editor = composerRoot();
      if (sessionId === "" || editor === void 0) return;
      if (sessionId === boundSession && editor.isConnected !== false) return;
      boundSession = sessionId;
      dispose();
      dispose = watchSession(sessionId, editor);
      setTimeout(() => void seedSession(sessionId).catch((error) => log("warn", `vault seed failed: ${error.message}`)), 120);
      void sweep().catch(() => {
      });
    };
    const interval = setInterval(() => void sync(), 5e3);
    if (typeof MutationObserver !== "function") return () => clearInterval(interval);
    const observer = new MutationObserver(() => void sync());
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-conversation-session"] });
    return () => {
      observer.disconnect();
      clearInterval(interval);
      dispose();
    };
  }
  return {
    on: bus.on,
    off: bus.off,
    get lastNotice() {
      return lastNotice;
    },
    currentSession,
    records: allRecords,
    countFor: async (sessionId) => {
      const records = await allRecords();
      return sessionId === void 0 || sessionId === "" ? records.length : records.filter((record) => record.sessionId === sessionId).length;
    },
    start: async ({ limits: override } = {}) => {
      if (started || typeof document === "undefined") return false;
      started = true;
      if (override !== void 0) limits = { ...limits, ...override };
      else {
        try {
          const res = await fetchImpl(`${options.endpoint ?? "/.well-known/dsh-session-toolbox"}`, { cache: "no-store" });
          const next = await res.json();
          limits = { ...limits, ...next.settings?.draftVault ?? {} };
        } catch {
        }
      }
      const capture = (event) => {
        if (event[SEED_MARKER] === true) return;
        void intake(currentSession(), readImages(event)).catch(() => {
        });
      };
      document.addEventListener("paste", capture, true);
      document.addEventListener("drop", capture, true);
      document.addEventListener("change", (event) => void intake(currentSession(), fileInputImages(event)).catch(() => {
      }), true);
      teardown = watchMounts();
      void sweep().catch(() => {
      });
      log("info", "draft vault started");
      return true;
    },
    stop: () => {
      if (started) {
        started = false;
        teardown?.();
        teardown = null;
      }
    },
    setLimits: (next) => {
      limits = { ...limits, ...next };
      if (limits.enabled === false) void (async () => {
        for (const record of await allRecords()) await dropRecord(record.key);
        notice("\u8349\u7A3F\u4FDD\u9669\u7BB1\u5DF2\u505C\u7528\uFF0C\u5B58\u91CF\u5DF2\u6E05\u7A7A");
      })();
    },
    sweep,
    seedSession,
    /** Retire a session's unsent drafts (called when its images were sent). */
    retire: async (sessionId = currentSession(), reason = "sent") => retireSession(sessionId, reason),
    intake,
    watchMounts
  };
}

// src/client.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var pluginVersion = package_default.version;
var name = "dsh-session-toolbox-client";
var inject = ["slots", "locale"];
var NS = "dsh-session-toolbox";
var ENDPOINT = `/.well-known/${NS}`;
var vault;
var directoryPicker;
var store = { state: null, error: "", listeners: /* @__PURE__ */ new Set() };
async function readResponse(res) {
  let next;
  try {
    next = JSON.parse(await res.text());
  } catch {
    throw new Error(`\u63D2\u4EF6\u540E\u53F0\u672A\u5C31\u7EEA\uFF08HTTP ${res.status}\uFF09\uFF1B\u5B89\u88C5\u6216\u91CD\u542F\u671F\u95F4\u4F1A\u81EA\u52A8\u91CD\u8BD5`);
  }
  if (next === null || typeof next !== "object" || Array.isArray(next)) throw new Error("\u63D2\u4EF6\u540E\u53F0\u8FD4\u56DE\u4E86\u65E0\u6548\u6570\u636E");
  if (!res.ok) throw new Error(next.error ?? `\u64CD\u4F5C\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
  return next;
}
var sessionKey = "";
async function loadState() {
  try {
    const next = await readResponse(await fetch(ENDPOINT, { cache: "no-store" }));
    store.state = next;
    store.error = "";
    sessionKey = next.key ?? sessionKey;
  } catch (error) {
    store.error = error.message;
  }
  for (const listener of store.listeners) listener();
  return store.state;
}
async function callHost(input) {
  if (!sessionKey) await loadState();
  const res = await readResponse(await fetch(ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-session-toolbox-key": sessionKey },
    body: JSON.stringify(input)
  }));
  sessionKey = res.key ?? sessionKey;
  for (const listener of store.listeners) listener();
  return res;
}
function apply(ctx) {
  directoryPicker = ctx.get?.("directoryPicker");
  const vaultInstance = vault ??= createVault({
    endpoint: ENDPOINT,
    log: (level, message) => {
      try {
        (level === "error" ? console.warn : console.log)(`[${NS}]`, message);
      } catch {
      }
    }
  });
  void loadState();
  const timer = setInterval(() => void loadState(), 3e4);
  ctx.effect?.(() => () => clearInterval(timer));
  vaultInstance.on("change", () => void loadState());
  void vaultInstance.start();
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { "menu.move": "\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE\u2026", "menu.trash": "\u5F52\u6863\u5230\u5F52\u6863\u6C60" },
    en: { "menu.move": "Move to another project\u2026", "menu.trash": "Archive" }
  }), "session-toolbox: dictionaries");
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: NS }, KitPage));
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-toolbox-move", order: 500, locale: NS }, MoveSessionMenuItem));
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-toolbox-trash", order: 600, locale: NS }, TrashSessionMenuItem));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "session-toolbox-vault-badge", order: 5, locale: NS }, VaultBadge));
}
function useKit() {
  const [, bump] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    const listener = () => bump((n) => n + 1);
    store.listeners.add(listener);
    void loadState();
    return () => store.listeners.delete(listener);
  }, []);
  return store;
}
var styles = `
.sk{--sk-accent:var(--dsw-alias-state-active-primary,#3a71db);--sk-border:var(--dsw-alias-border-l2,#444);--sk-bg:var(--dsw-alias-bg-layer-1,#202020);--sk-card:var(--dsw-alias-bg-module-platform,#282828);--sk-text:var(--dsw-alias-label-primary,#f4f4f4);--sk-muted:var(--dsw-alias-label-secondary,#b0b0b0);color:var(--sk-text);font:inherit;font-size:14px;line-height:1.6;max-width:1120px}
.sk *{box-sizing:border-box}.sk h2,.sk h3,.sk p{margin:0}.sk h2{font-size:22px}.sk h3{font-size:16px}.sk .muted,.sk small{color:var(--sk-muted)}
.sk .box{border:1px solid var(--sk-border);border-radius:12px;padding:18px 20px;background:var(--sk-card);display:flex;flex-direction:column;gap:14px}
.sk .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sk .stack{display:flex;flex-direction:column;gap:16px}
.sk button,.sk input,.sk select{font:inherit;color:inherit;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-bg);min-height:36px;padding:7px 12px}
.sk button{cursor:pointer}.sk button:hover{background:var(--sk-card)}.sk button:disabled{opacity:.45;cursor:default}
.sk button.primary{background:var(--sk-accent);color:#fff;border-color:transparent}
.sk table{width:100%;border-collapse:collapse;font-size:13px}.sk th,.sk td{border-bottom:1px solid var(--sk-border);padding:8px;text-align:left}.sk th{color:var(--sk-muted);font-weight:500}
.sk .error{color:var(--dsw-alias-state-error-primary,#ef9393)}.sk .good{color:var(--dsw-alias-state-success-primary,#77ca9d)}
.sk .pill{border:1px solid var(--sk-border);border-radius:100px;padding:2px 10px;font-size:12px;background:var(--sk-bg);display:inline-block}
.sk .mono{font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.sk dialog{color:var(--sk-text);background:var(--sk-bg);border:1px solid var(--sk-border);border-radius:14px;width:min(560px,calc(100vw - 32px));padding:0}
.sk dialog::backdrop{background:#0007}.sk .modal-head{padding:16px 20px;border-bottom:1px solid var(--sk-border);display:flex;justify-content:space-between;align-items:center}
.sk .modal-body{padding:20px;display:flex;flex-direction:column;gap:14px}
.sk input.grow{flex:1;min-width:0}
`;
function KitPage() {
  const { state, error } = useKit();
  const [busy, setBusy2] = (0, import_react.useState)(false);
  const [feedback, setFeedback] = (0, import_react.useState)("");
  const say = (message) => {
    setFeedback(message);
    setTimeout(() => setFeedback(""), 8e3);
  };
  const act = async (input, ok) => {
    setBusy2(true);
    try {
      const result = await callHost(input);
      if (ok) say(ok);
      await loadState();
      setBusy2(false);
      return result;
    } catch (err) {
      say(`\u5931\u8D25\uFF1A${err.message}`);
      setBusy2(false);
      throw err;
    }
  };
  const settings = state?.settings;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "\u4F1A\u8BDD\u5DE5\u5177\u7BB1" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      "\u8349\u7A3F\u4FDD\u9669\u7BB1 \xB7 \u4F1A\u8BDD\u5207\u6362\u9879\u76EE \xB7 \u5F52\u6863\u6C60 \u2014 v",
      pluginVersion,
      "\u3002\u6570\u636E\u4EC5\u5B58\u672C\u673A\uFF08\u6D4F\u89C8\u5668 IndexedDB + ~/.dsh/session-toolbox/\uFF09\u3002"
    ] }),
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "error", children: [
      "\u540E\u53F0\u8FDE\u63A5\u5931\u8D25\uFF1A",
      error
    ] }) : null,
    feedback ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "good", children: feedback }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "box", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u8349\u7A3F\u4FDD\u9669\u7BB1\uFF08\u56FE\u7247\u8349\u7A3F\u6301\u4E45\u5316\uFF09" }),
      settings ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: settings.draftVault?.enabled !== false,
                disabled: busy,
                onChange: (e) => void act({ type: "settings.update", patch: { draftVault: { ...settings.draftVault, enabled: e.target.checked } } }, e.target.checked ? "\u5DF2\u542F\u7528\u8349\u7A3F\u4FDD\u9669\u7BB1" : "\u5DF2\u505C\u7528\u8349\u7A3F\u4FDD\u9669\u7BB1\uFF08\u6D4F\u89C8\u5668\u4FA7\u5373\u65F6\u751F\u6548\uFF09").catch(() => {
                })
              }
            ),
            " \u542F\u7528"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "pill", children: [
            "\u5BB9\u91CF ",
            Math.round((settings.draftVault?.maxSizeBytes ?? 0) / 1048576),
            " MB"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "pill", children: [
            "\u4FDD\u7559 ",
            settings.draftVault?.ttlDays ?? 7,
            " \u5929"
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "muted", children: [
          "\u6E05\u5355\uFF1A\u5DF2\u5907\u4EFD ",
          state?.vault?.records ?? 0,
          " \u9879 \xB7 \u7EA6 ",
          fmtBytes(state?.vault?.bytes ?? 0),
          "\uFF08\u56FE\u7247\u5B57\u8282\u5728 IndexedDB\uFF0C\u8D85\u51FA\u4E0A\u9650\u6309\u6700\u65E7\u6E05\u7406\uFF0C\u4E8B\u4EF6\u4F1A\u663E\u793A\u5728\u8FD9\u91CC\uFF09"
        ] }) }),
        state?.vault?.notice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: state.vault.notice }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "vault.sweep" }, "\u5DF2\u6309 TTL/\u5BB9\u91CF\u6E05\u7406").catch(() => {
        }), children: "\u7ACB\u5373\u6574\u7406" }) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\u7B49\u5F85\u540E\u53F0\u6570\u636E\u2026" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MoveSection, { act, busy, say, state }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TrashSection, { act, busy, say, state })
  ] });
}
function MoveSection({ act, busy, say, state }) {
  const [sessionId, setSessionId] = (0, import_react.useState)("");
  const [toCwd, setToCwd] = (0, import_react.useState)("");
  const [createTarget, setCreateTarget] = (0, import_react.useState)(false);
  const [plan, setPlan] = (0, import_react.useState)(null);
  const journal = state?.journal;
  const projects = state?.projects ?? [];
  const [fromProject, setFromProject] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (!sessionId) {
      setFromProject(null);
      return;
    }
    let alive = true;
    void callHost({ type: "project.of", sessionId }).then((result) => {
      if (alive) setFromProject(result?.project ?? null);
    }).catch(() => {
      if (alive) setFromProject(null);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);
  const pick = async () => {
    try {
      const result = await directoryPicker?.pick?.();
      const value = result?.ok ? result.value : void 0;
      if (typeof value === "string" && value) setToCwd(value);
      else say("\u5F53\u524D DSH \u672A\u63D0\u4F9B\u76EE\u5F55\u9009\u62E9\u5668\uFF08\u6216\u5DF2\u53D6\u6D88\uFF09\uFF0C\u8BF7\u624B\u52A8\u8F93\u5165\u7EDD\u5BF9\u8DEF\u5F84");
    } catch (error) {
      say(`\u76EE\u5F55\u9009\u62E9\u5931\u8D25\uFF1A${error.message}`);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "box", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u4F1A\u8BDD\u5207\u6362\u9879\u76EE" }),
    journal && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "error", children: [
      "\u5B58\u5728\u672A\u5B8C\u6210\u7684\u8FC1\u79FB\uFF1A",
      journal.sessionId,
      " \u2192 ",
      journal.toCwd,
      "\uFF08\u5DF2\u5B8C\u6210 ",
      journal.done?.join("/") || "\u65E0",
      "\uFF09\u3002",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "move.complete" }, "\u8FC1\u79FB\u5DF2\u524D\u6EDA\u5B8C\u6210").catch(() => {
      }), children: "\u5B8C\u6210" }),
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "move.rollback" }, "\u8FC1\u79FB\u5DF2\u56DE\u6EDA").catch(() => {
      }), children: "\u56DE\u6EDA" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "grow mono", placeholder: "session-\u2026\uFF08\u6216\u4ECE\u4F1A\u8BDD\u53F3\u952E\u83DC\u5355\u53D1\u8D77\uFF09", value: sessionId, onChange: (e) => {
        setSessionId(e.target.value);
        setPlan(null);
      } }),
      projects.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          className: "grow",
          value: projects.some((p) => p.path === toCwd) ? toCwd : "",
          onChange: (e) => {
            setToCwd(e.target.value);
            setPlan(null);
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u9009\u62E9\u76EE\u6807\u9879\u76EE\u2026" }),
            projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: project.path, disabled: fromProject?.path === project.path, children: [
              project.title,
              "\uFF08",
              project.sessions,
              " \u4E2A\u4F1A\u8BDD\uFF09",
              fromProject?.path === project.path ? " \u2014 \u5F53\u524D\u9879\u76EE" : ""
            ] }, project.id))
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "grow mono", placeholder: "\u76EE\u6807\u9879\u76EE\u7EDD\u5BF9\u8DEF\u5F84", value: toCwd, onChange: (e) => {
        setToCwd(e.target.value);
        setPlan(null);
      } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: () => void pick(), disabled: busy, children: "\u6D4F\u89C8\u2026" })
    ] }),
    sessionId && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      "\u5F53\u524D\u9879\u76EE\uFF1A",
      fromProject === null ? "\uFF08\u672A\u627E\u5230\u8BE5\u4F1A\u8BDD\uFF0C\u6216\u5B83\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u9879\u76EE\uFF09" : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: fromProject.title }),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "mono", children: fromProject.path })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: createTarget, onChange: (e) => setCreateTarget(e.target.checked) }),
      " \u76EE\u6807\u4E0D\u5B58\u5728\u65F6\u521B\u5EFA"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy || !sessionId || !toCwd, onClick: () => {
        setBusy(true);
        setPlan(null);
        void callHost({ type: "preflight", sessionId, toCwd, createTarget }).then((result) => setPlan(result)).catch((error) => say(`\u4F53\u68C0\u5931\u8D25\uFF1A${error.message}`)).finally(() => setBusy(false));
      }, children: "\u4F53\u68C0" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "primary", disabled: busy || plan?.toProject === void 0, onClick: () => void act({ type: "move", sessionId, toCwd, createTarget }, "\u8FC1\u79FB\u5B8C\u6210\uFF1B\u5176\u5B83\u7A97\u53E3\u8BF7\u91CD\u5F00\u8BE5\u4F1A\u8BDD").catch(() => {
      }), children: "\u8FC1\u79FB" })
    ] }),
    plan?.toProject && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "mono muted", style: { whiteSpace: "pre-wrap" }, children: JSON.stringify({ \u4ECE: plan.fromCwd, \u5230: plan.toCwd, \u539F\u76EE\u5F55: plan.fromProject, \u65B0\u76EE\u5F55: plan.toProject, \u65E5\u5FD7\u6587\u4EF6: plan.logName }, null, 2) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\u53EA\u6539 DSH \u5185\u90E8\u5F52\u5C5E\u4E0E\u4F1A\u8BDD\u5934\uFF1B\u5386\u53F2\u4E0D\u53D8\uFF0C\u65E7\u6D88\u606F\u4E2D\u7684\u7EDD\u5BF9\u8DEF\u5F84\u4ECD\u6307\u5411\u539F\u9879\u76EE\uFF08\u5DF2\u77E5\u8BED\u4E49\uFF09\u3002\u8FC1\u79FB\u524D\u8BF7\u5173\u95ED\u8BE5\u4F1A\u8BDD\u3002" })
  ] });
}
function TrashSection({ act, busy, say, state }) {
  const items = state?.trash ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "box", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u5F52\u6863\u6C60" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      "DSH \u6CA1\u6709\u72EC\u7ACB\u7684\u300C\u5220\u9664\u4F1A\u8BDD\u300D\u2014\u2014\u4F1A\u8BDD\u53EA\u80FD",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u5F52\u6863" }),
      "\u3002\u8FD9\u91CC\u5C31\u662F\u5B98\u65B9\u7684\u5F52\u6863\u6C60\uFF1A\u5165\u6C60\u7684\u4F1A\u8BDD\u4ECD\u7136\u662F\u5B98\u65B9\u5F52\u6863\u72B6\u6001\uFF08\u4FA7\u680F\u7684\u5F52\u6863\u89C6\u56FE\u91CC\u540C\u6837\u80FD\u770B\u5230\uFF09\uFF0C\u672C\u63D2\u4EF6\u989D\u5916\u8BB0\u5F55\u4E86\u5B83\u5165\u6C60\u65F6\u7684",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u9879\u76EE\u5F52\u5C5E\u3001\u5217\u8868\u4F4D\u7F6E\u4E0E\u7F6E\u9876\u72B6\u6001" }),
      "\uFF0C\u56E0\u6B64\u53EF\u4EE5\u4E00\u952E\u8FD8\u539F\u5230\u539F\u4F4D\u3002 \u5F52\u6863\u9879\u76EE\u5219\u4FDD\u7559\u5168\u90E8\u4F1A\u8BDD\u65E5\u5FD7\uFF0C\u53EA\u79FB\u9664\u9879\u76EE\u6CE8\u518C\u8868\u9879\u3002\u5F7B\u5E95\u5220\u9664\u4F1A\u5148\u79FB\u5165\u6682\u5B58\u76EE\u5F55\u518D\u6E05\u7406\uFF0C\u4E2D\u65AD\u53EF\u7528 CLI \u68C0\u51FA\u3002"
    ] }),
    items.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\uFF08\u7A7A\uFF09" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "\u7C7B\u578B" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "\u5BF9\u8C61" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "\u6807\u9898 / \u8DEF\u5F84" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: "\u5165\u6C60\u65F6\u95F4" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {})
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: item.kind === "session" ? "\u4F1A\u8BDD" : "\u9879\u76EE" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "mono", children: shortId(item.targetId) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "mono", children: item.kind === "session" ? item.snapshot.title || "\uFF08\u65E0\u6807\u9898\uFF09" : item.snapshot.path }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: new Date(item.trashedAt).toLocaleString("zh-CN", { hour12: false }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "trash.restore", itemId: item.itemId }, "\u5DF2\u8FD8\u539F\u5230\u539F\u4F4D").catch(() => {
          }), children: "\u8FD8\u539F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "trash.purge", itemId: item.itemId }, "\u5DF2\u5F7B\u5E95\u5220\u9664").catch(() => {
          }), children: "\u5F7B\u5E95\u5220\u9664" })
        ] })
      ] }, item.itemId)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "muted", children: [
        "\u4FDD\u7559 ",
        state?.settings?.trash?.ttlDays ?? 30,
        " \u5929\uFF1B\u5230\u671F\u81EA\u52A8\u79FB\u51FA",
        state?.settings?.trash?.autoPurge ? "\uFF08\u5DF2\u5F00\uFF09" : "\uFF08\u672A\u5F00\uFF0C\u4EC5\u63D0\u9192\uFF09",
        "\u3002"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "settings.update", patch: { trash: { ...state?.settings?.trash, autoPurge: !state?.settings?.trash?.autoPurge } } }, "\u7B56\u7565\u5DF2\u66F4\u65B0").catch(() => {
      }), children: "\u5207\u6362\u81EA\u52A8\u6E05\u7406" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "trash.sweep" }, "\u5DF2\u6309 TTL \u5DE1\u68C0").catch(() => {
      }), children: "\u5DE1\u68C0\u5230\u671F\u9879" })
    ] })
  ] });
}
var shortId = (id) => String(id).length > 18 ? `${String(id).slice(0, 8)}\u2026${String(id).slice(-6)}` : String(id);
var fmtBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
function MoveSessionMenuItem({ sessionId, t }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { role: "menuitem", onClick: () => setOpen(true), style: menuItemStyle, children: t ? t("menu.move") : "\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE\u2026" }),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MoveDialog, { sessionId, close: () => setOpen(false) }) : null
  ] });
}
function TrashSessionMenuItem({ sessionId, t }) {
  const [confirm, setConfirm] = (0, import_react.useState)(false);
  const [busy, setBusy2] = (0, import_react.useState)(false);
  if (confirm) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { role: "menuitem", disabled: busy, style: menuItemStyle, onClick: async () => {
      setBusy2(true);
      try {
        await callHost({ type: "trash.session", sessionId });
        setConfirm(false);
      } catch {
        sayRow(`\u56DE\u6536\u5931\u8D25`);
        setConfirm(false);
      }
      setBusy2(false);
    }, children: "\u786E\u8BA4\u5F52\u6863\uFF1F\uFF08\u4F1A\u8BDD\u5C06\u8FDB\u5165\u5F52\u6863\u6C60\uFF09" });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { role: "menuitem", style: menuItemStyle, onClick: () => setConfirm(true), children: t ? t("menu.trash") : "\u5F52\u6863\u5230\u5F52\u6863\u6C60" });
}
function sayRow(message) {
  store.error = message;
  for (const listener of store.listeners) listener();
}
var menuItemStyle = { background: "transparent", border: "none", color: "inherit", font: "inherit", padding: "6px 10px", textAlign: "left", cursor: "pointer", width: "100%" };
function MoveDialog({ sessionId, close }) {
  const ref = (0, import_react.useRef)(null);
  const [toCwd, setToCwd] = (0, import_react.useState)("");
  const [createTarget, setCreateTarget] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy2] = (0, import_react.useState)(false);
  const [projects, setProjects] = (0, import_react.useState)([]);
  const [fromProject, setFromProject] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      try {
        dialog?.close();
      } catch {
      }
    };
  }, []);
  (0, import_react.useEffect)(() => {
    let alive = true;
    void loadState().then((next) => {
      if (alive) setProjects(next?.projects ?? []);
    }).catch(() => {
    });
    void callHost({ type: "project.of", sessionId }).then((result) => {
      if (alive) setFromProject(result?.project ?? null);
    }).catch(() => {
      if (alive) setFromProject(null);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);
  const submit = async () => {
    setBusy2(true);
    setError("");
    try {
      await callHost({ type: "move", sessionId, toCwd, createTarget });
      close();
    } catch (err) {
      setError(err.message);
      setBusy2(false);
    }
  };
  const valid = /^\/|^[A-Za-z]:[\\/]/.test(toCwd);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dialog", { ref, onCancel: (e) => {
      e.preventDefault();
      if (!busy) close();
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "\u4F1A\u8BDD\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: close, disabled: busy, children: "\u5173\u95ED" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "modal-body", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted mono", children: sessionId }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
          "\u5F53\u524D\u9879\u76EE\uFF1A",
          fromProject === null ? "\uFF08\u672A\u627E\u5230\uFF0C\u6216\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u9879\u76EE\uFF09" : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: fromProject.title }),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "mono", children: fromProject.path })
          ] })
        ] }),
        projects.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            className: "grow",
            value: projects.some((p) => p.path === toCwd) ? toCwd : "",
            onChange: (e) => setToCwd(e.target.value),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u9009\u62E9\u76EE\u6807\u9879\u76EE\u2026" }),
              projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: project.path, disabled: fromProject?.path === project.path, children: [
                project.title,
                "\uFF08",
                project.sessions,
                " \u4E2A\u4F1A\u8BDD\uFF09",
                fromProject?.path === project.path ? " \u2014 \u5F53\u524D\u9879\u76EE" : ""
              ] }, project.id))
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "grow mono", placeholder: "\u76EE\u6807\u9879\u76EE\u7EDD\u5BF9\u8DEF\u5F84", value: toCwd, onChange: (e) => setToCwd(e.target.value) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: createTarget, onChange: (e) => setCreateTarget(e.target.checked) }),
          " \u76EE\u5F55\u4E0D\u5B58\u5728\u65F6\u521B\u5EFA"
        ] }),
        error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "error", children: error }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "primary", disabled: busy || !valid, onClick: () => void submit(), children: "\u4F53\u68C0\u5E76\u8FC1\u79FB" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "muted", children: "\u4F1A\u8BDD\u9700\u7A7A\u95F2\uFF1B\u8FC1\u79FB\u5728\u540E\u53F0\u79BB\u7EBF\u5B8C\u6210\u3002" })
        ] })
      ] })
    ] })
  ] });
}
function VaultBadge({ sessionId }) {
  const [count, setCount] = (0, import_react.useState)(0);
  const [notice, setNotice] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    if (vault === void 0) return;
    let live = true;
    const sync = async () => {
      try {
        const value = await vault.countFor(sessionId ?? vault.currentSession());
        if (live) setCount(value);
      } catch {
        if (live) setCount(0);
      }
      if (live) setNotice(vault.lastNotice ?? "");
    };
    void sync();
    const listener = () => void sync();
    vault.on("change", listener);
    window.addEventListener(`${NS}-notice`, listener);
    const timer = setInterval(listener, 2e4);
    return () => {
      live = false;
      vault.off("change", listener);
      window.removeEventListener(`${NS}-notice`, listener);
      clearInterval(timer);
    };
  }, [sessionId]);
  if (count === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sk", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "pill", title: `\u672C\u4F1A\u8BDD\u6709 ${count} \u5F20\u56FE\u7247\u8349\u7A3F\u5DF2\u5907\u4EFD\uFF08\u5207\u6362\u4F1A\u8BDD/\u5237\u65B0/\u91CD\u542F\u540E\u53EF\u6062\u590D\uFF09${notice ? `\uFF5C\u6700\u8FD1\uFF1A${notice}` : ""}`, children: [
    "\u{1F6DF} \u8349\u7A3F\u5907\u4EFD ",
    count
  ] }) });
}
return module.exports; } });
//# sourceMappingURL=client.js.map
