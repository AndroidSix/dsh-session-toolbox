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
  GroupedSidebar: () => GroupedSidebar,
  GroupsDialog: () => GroupsDialog,
  KitPage: () => KitPage,
  MoveDialog: () => MoveDialog,
  MoveGroupDialog: () => MoveGroupDialog,
  MoveSessionMenuItem: () => MoveSessionMenuItem,
  NOTICE_EVENT: () => NOTICE_EVENT,
  NS: () => NS,
  NativeSteerQueue: () => NativeSteerQueue,
  ReplyMessage: () => ReplyMessage,
  ReplyPreview: () => ReplyPreview,
  SteerQueueButton: () => SteerQueueButton,
  ToolboxOverlay: () => ToolboxOverlay,
  TrashSessionMenuItem: () => TrashSessionMenuItem,
  VaultBadge: () => VaultBadge,
  WorkspaceDialog: () => WorkspaceDialog,
  apply: () => apply,
  callHost: () => callHost,
  inject: () => inject,
  loadState: () => loadState,
  name: () => name,
  refreshSessionList: () => refreshSessionList,
  refreshState: () => refreshState,
  sessionKey: () => sessionKey
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");

// package.json
var package_default = {
  name: "dsh-session-toolbox",
  version: "0.1.26",
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

// src/client.jsx
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/reply.mjs
var REPLY_SOURCE = "dsh-session-toolbox.reply";
function readReply(ref) {
  const value = JSON.parse(ref);
  if (value?.version !== 1 || !["user", "assistant"].includes(value.role) || typeof value.text !== "string" || !value.text.trim()) throw new Error("Invalid message quote");
  return { role: value.role, text: value.text };
}
function quoteText(quote) {
  return `> ${quote.role === "assistant" ? "Assistant" : "User"}
${quote.text.replace(/\r\n?/g, "\n").split("\n").map((line) => "> " + line).join("\n")}

`;
}
function replySource() {
  return {
    name: REPLY_SOURCE,
    trigger: "@",
    showGroupTitle: false,
    candidates: async () => [],
    codec: { clipboardText: (ref) => quoteText(readReply(ref)), serialize: async (ref) => quoteText(readReply(ref)) }
  };
}
var referenceFields = ({ source, ref, offset, length, label, clipboardText, appearance, invalid }) => ({ source, ref, offset, length, label, clipboardText, ...appearance === void 0 ? {} : { appearance }, ...invalid === void 0 ? {} : { invalid } });
function withoutReply(snapshot) {
  let text2 = snapshot.draft ?? "", references = (snapshot.occurrences ?? []).map(referenceFields);
  for (const quote of references.filter((row) => row.source === REPLY_SOURCE).sort((a, b) => b.offset - a.offset)) {
    const end = quote.offset + quote.length;
    if (text2.slice(quote.offset, end) !== quote.clipboardText) throw new Error("Message quote no longer matches the draft");
    text2 = text2.slice(0, quote.offset) + text2.slice(end);
    references = references.filter((row) => row !== quote).map((row) => row.offset >= end ? { ...row, offset: row.offset - quote.length } : row);
  }
  return { text: text2, references };
}
function withReply(snapshot, quote, label) {
  if (snapshot.phase !== "plain") throw new Error("\u8BF7\u7B49\u5F85\u8F93\u5165\u6846\u5C31\u7EEA\u540E\u518D\u5F15\u7528 / Wait until the composer is ready");
  const ref = JSON.stringify({ version: 1, ...quote });
  const content = quoteText(readReply(ref)), draft = withoutReply(snapshot);
  return { text: content + draft.text, references: [{ source: REPLY_SOURCE, ref, offset: 0, length: content.length, label, appearance: "session", clipboardText: content }, ...draft.references.map((row) => ({ ...row, offset: row.offset + content.length }))] };
}
function messageReply(node) {
  if (["user", "steering"].includes(node?.kind)) {
    const content = node.data?.content;
    const text3 = typeof content === "string" ? content : (Array.isArray(content) ? content : []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    return text3.trim() ? { role: "user", text: text3 } : null;
  }
  const blocks = node?.data?.closing?.blocks ?? [];
  const text2 = blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
  return text2.trim() ? { role: "assistant", text: text2 } : null;
}
function installReplyNodes(ctx, makeComponent) {
  if (typeof ctx.slots.entries !== "function" || typeof ctx.slots.subscribe !== "function") return;
  const name2 = "conversation.chat.node";
  ctx.slots.inject(name2, () => ctx.effect(() => {
    const owned = /* @__PURE__ */ new Set(), copies = /* @__PURE__ */ new Map();
    let syncing = false;
    const sync = () => {
      if (syncing) return;
      syncing = true;
      try {
        const entries = ctx.slots.entries(name2).filter((entry) => ["user", "steering", "turn-tail"].includes(entry.options.key) && !owned.has(entry.component));
        for (const [entry, release] of copies) if (!entries.includes(entry)) {
          release();
          copies.delete(entry);
        }
        for (const native of entries) {
          if (copies.has(native)) continue;
          const releases = [], mirrors = /* @__PURE__ */ new Map();
          try {
            for (const [child, spec] of Object.entries(native.children ?? {})) {
              const mirror = `session-toolbox.reply.${child}`;
              mirrors.set(child, mirror);
              if (spec.scope !== "session" || spec.kind !== "list") throw new Error(`Unsupported reply child slot: ${child}`);
            }
            const component = makeComponent(native, mirrors);
            owned.add(component);
            releases.push(ctx.slots.register({
              ...native.options,
              name: name2,
              priority: (native.options.priority ?? 0) - 10,
              store: native.store,
              inject: native.inject,
              locale: native.locale,
              ...mirrors.size ? { children: Object.fromEntries([...mirrors].map(([child, mirror]) => [mirror, native.children[child]])) } : {}
            }, component));
            for (const [child, mirror] of mirrors) {
              const mirrored = /* @__PURE__ */ new Map();
              const update = () => {
                const children = ctx.slots.entries(child);
                for (const [entry, release] of mirrored) if (!children.includes(entry)) {
                  release();
                  mirrored.delete(entry);
                }
                for (const entry of children) if (!mirrored.has(entry) && !entry.children) mirrored.set(entry, ctx.slots.register({ ...entry.options, name: mirror, store: entry.store, inject: entry.inject, locale: entry.locale }, entry.component));
              };
              releases.push(() => {
                for (const release of mirrored.values()) release();
              });
              update();
              releases.push(ctx.slots.subscribe(child, update));
            }
            copies.set(native, () => {
              for (const release of releases.reverse()) release?.();
            });
          } catch (error) {
            for (const release of releases.reverse()) release?.();
            console.warn("[dsh-session-toolbox] Reply renderer unavailable", error);
          }
        }
      } finally {
        syncing = false;
      }
    };
    const unsubscribe = ctx.slots.subscribe(name2, sync);
    sync();
    return () => {
      unsubscribe();
      for (const release of copies.values()) release();
    };
  }));
}

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
    let outcome, result;
    const transaction = database.transaction(STORE, mode);
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("vault transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("vault transaction failed"));
    try {
      outcome = run(transaction.objectStore(STORE));
    } catch (error) {
      reject(error);
      return;
    }
    Promise.resolve(outcome).then((value) => {
      result = value;
    }, reject);
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
  let captureCleanup = () => {
  };
  let generation = 0;
  const inputs = /* @__PURE__ */ new Map();
  const seeded = /* @__PURE__ */ new WeakMap();
  const seeding = /* @__PURE__ */ new WeakSet();
  let storageQueue = Promise.resolve();
  const serialize = (task) => {
    const next = storageQueue.then(task);
    storageQueue = next.catch(() => {
    });
    return next;
  };
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
  async function syncHost(attempt = 0) {
    const endpoint = options.endpoint ?? "/.well-known/dsh-session-toolbox";
    try {
      if (hostKey === "") {
        const probe = await fetchImpl(endpoint, { cache: "no-store" });
        hostKey = (await probe.json()).key ?? "";
      }
      const records = (await allRecords()).filter((record) => !record.sentAt).slice(-2e3).map(({ key, sessionId, attachmentId, name: name2, size, hash, seeded: seeded2, createdAt, sentAt }) => ({ key, sessionId, attachmentId, name: name2, size, hash, seeded: seeded2, createdAt, sentAt: sentAt ?? 0 }));
      const response = await fetchImpl(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-session-toolbox-key": hostKey },
        body: JSON.stringify({ type: "vault.sync", records })
      });
      if (response.status === 401) {
        hostKey = "";
        if (attempt === 0) await syncHost(1);
      }
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
  async function intakeImages(sessionId, files) {
    if (!limits.enabled || sessionId === void 0 || sessionId === "") return;
    const existing = (await allRecords()).filter((record) => record.sessionId === sessionId && !record.sentAt);
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
    await sweep();
    if (added > 0) notice(`\u5DF2\u5907\u4EFD ${added} \u5F20\u8349\u7A3F\u56FE\u7247\uFF08\u4F1A\u8BDD ${sessionId.slice(-6)}\uFF09`);
    await syncHost();
    changed();
  }
  const intake = (sessionId, files) => serialize(() => intakeImages(sessionId, files));
  const readImages = (event) => [...event.clipboardData?.files ?? event.dataTransfer?.files ?? []].filter(isImageFile);
  const fileInputImages = (event) => {
    const target = event.target;
    if (typeof HTMLInputElement === "undefined" || !(target instanceof HTMLInputElement) || target.type !== "file" || target.files === null) return [];
    return [...target.files].filter(isImageFile);
  };
  function currentSession() {
    return document.querySelector?.("[data-conversation-session]")?.getAttribute?.("data-conversation-session") ?? "";
  }
  function composerRoot() {
    return document.querySelector?.('[data-conversation-session] [contenteditable="true"]') ?? void 0;
  }
  function attachmentRail(editor) {
    const seat = editor?.closest?.('[data-composer-seat], [data-conversation-region="composer"]');
    const root = seat ?? editor?.parentElement?.parentElement?.parentElement;
    if (root?.querySelectorAll === void 0) return void 0;
    return [...root.querySelectorAll("img")].filter((img) => {
      const src = img.getAttribute?.("src") ?? "";
      return src.startsWith("blob:") || src.startsWith("data:image/");
    });
  }
  function inputFor(sessionId) {
    try {
      return options.getInput?.(sessionId);
    } catch (error) {
      log("warn", `native input unavailable: ${error.message}`);
      return void 0;
    }
  }
  function observeInput(sessionId) {
    const input = inputFor(sessionId);
    if (!input?.store?.subscribe) return false;
    if (inputs.get(sessionId)?.store === input.store) return true;
    inputs.get(sessionId)?.dispose();
    const observation = { store: input.store, dispose: () => {
    } };
    const current = () => inputs.get(sessionId) === observation;
    let previous = /* @__PURE__ */ new Set();
    const update = () => {
      if (!current()) return;
      const ids = input.store.getSnapshot()?.attachmentIds ?? [];
      const files = input.resolve(ids).filter((a) => a.kind === "image" && isImageFile(a.file)).map((a) => a.file);
      void serialize(async () => {
        if (!current()) return;
        const active = new Set(await Promise.all(files.map(contentHash)));
        if (!current()) return;
        let retired = false;
        for (const record of await allRecords()) {
          if (!current()) return;
          if (record.sessionId === sessionId && !record.sentAt && previous.has(record.hash) && !active.has(record.hash)) {
            await putRecord({ ...record, sentAt: now() });
            retired = true;
          }
        }
        previous = active;
        if (!current()) return;
        if (files.length) await intakeImages(sessionId, files);
        else if (retired) {
          await syncHost();
          changed();
        }
      }).catch((error) => log("warn", `native draft sync failed: ${error.message}`));
    };
    inputs.set(sessionId, observation);
    observation.dispose = input.store.subscribe(update);
    update();
    return true;
  }
  async function seedSession(sessionId = currentSession()) {
    if (!sessionId || !limits.enabled || sessionId !== currentSession()) return false;
    const editor = composerRoot();
    if (editor === void 0 || seeding.has(editor)) return false;
    const rail = attachmentRail(editor);
    if (rail === void 0) return false;
    if (rail.length > 0 || (inputFor(sessionId)?.store.getSnapshot()?.attachmentIds?.length ?? 0) > 0) return true;
    seeding.add(editor);
    try {
      const delivered = seeded.get(editor) ?? /* @__PURE__ */ new Set();
      const hashes = /* @__PURE__ */ new Set();
      const pending = (await allRecords()).filter((record) => {
        if (record.sessionId !== sessionId || record.sentAt || delivered.has(record.hash) || hashes.has(record.hash)) return false;
        hashes.add(record.hash);
        return true;
      });
      if (pending.length === 0) return true;
      const files = [];
      for (const record of pending) files.push(await blobToFile(record));
      if (!limits.enabled || sessionId !== currentSession() || editor !== composerRoot() || editor.isConnected === false) return false;
      if ((attachmentRail(editor)?.length ?? 0) > 0 || (inputFor(sessionId)?.store.getSnapshot()?.attachmentIds?.length ?? 0) > 0) return true;
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: fakeClipboardData(files) });
      Object.defineProperty(event, SEED_MARKER, { value: true });
      editor.dispatchEvent(event);
      const accepted = event.defaultPrevented === true;
      if (accepted) {
        for (const record of pending) delivered.add(record.hash);
        seeded.set(editor, delivered);
        notice(`\u5DF2\u6062\u590D ${files.length} \u5F20\u8349\u7A3F\u56FE\u7247\uFF08\u4F1A\u8BDD ${sessionId.slice(-6)}\uFF09`);
      } else log("warn", "synthetic paste was not accepted; backup retained for retry");
      changed();
      return accepted;
    } finally {
      seeding.delete(editor);
    }
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
        await serialize(() => retireSession(sessionId, "sent"));
      }
      rail = next;
      changed();
    };
    if (typeof MutationObserver !== "function") return () => {
    };
    const observer = new MutationObserver(() => void check());
    observer.observe(scope, { subtree: true, childList: true });
    return () => observer.disconnect();
  }
  function watchMounts() {
    let boundSession = "", boundEditor, dispose = () => {
    }, timer;
    const sync = () => {
      const sessionId = currentSession(), editor = composerRoot();
      if (sessionId === boundSession && editor === boundEditor) return;
      clearTimeout(timer);
      dispose();
      if (boundEditor) seeded.delete(boundEditor);
      boundSession = sessionId;
      boundEditor = editor;
      if (!sessionId || !editor) return;
      dispose = observeInput(sessionId) ? () => {
      } : watchSession(sessionId, editor);
      timer = setTimeout(() => void seedSession(sessionId).catch((error) => log("warn", `vault seed failed: ${error.message}`)), 120);
      void sweep().catch(() => {
      });
    };
    sync();
    const interval = setInterval(sync, 1e3);
    const observer = typeof MutationObserver === "function" ? new MutationObserver(sync) : null;
    observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-conversation-session"] });
    return () => {
      observer?.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
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
      return records.filter((record) => !record.sentAt && (!sessionId || record.sessionId === sessionId)).length;
    },
    start: async ({ limits: override } = {}) => {
      if (started || typeof document === "undefined") return false;
      started = true;
      const startGeneration = ++generation;
      if (override !== void 0) limits = { ...limits, ...override };
      else {
        try {
          const res = await fetchImpl(`${options.endpoint ?? "/.well-known/dsh-session-toolbox"}`, { cache: "no-store" });
          const next = await res.json();
          limits = { ...limits, ...next.settings?.draftVault ?? {} };
        } catch {
        }
      }
      if (!started || generation !== startGeneration) return false;
      const capture = (event) => {
        if (event[SEED_MARKER] === true || observeInput(currentSession())) return;
        void intake(currentSession(), readImages(event)).catch(() => {
        });
      };
      document.addEventListener("paste", capture, true);
      document.addEventListener("drop", capture, true);
      const change = (event) => {
        if (!observeInput(currentSession())) void intake(currentSession(), fileInputImages(event)).catch(() => {
        });
      };
      document.addEventListener("change", change, true);
      captureCleanup = () => {
        document.removeEventListener("paste", capture, true);
        document.removeEventListener("drop", capture, true);
        document.removeEventListener("change", change, true);
      };
      teardown = watchMounts();
      void sweep().catch(() => {
      });
      log("info", "draft vault started");
      return true;
    },
    stop: () => {
      started = false;
      generation++;
      captureCleanup();
      teardown?.();
      teardown = null;
      for (const input of inputs.values()) input.dispose();
      inputs.clear();
    },
    setLimits: (next) => {
      const updated = { ...limits, ...next };
      if (JSON.stringify(updated) === JSON.stringify(limits)) return;
      limits = updated;
      void serialize(sweep).then(syncHost).catch((error) => log("warn", error.message));
    },
    sweep,
    seedSession,
    /** Retire a session's unsent drafts (called when its images were sent). */
    retire: (sessionId = currentSession(), reason = "sent") => serialize(() => retireSession(sessionId, reason)),
    syncHost,
    intake,
    watchMounts
  };
}

// src/sidebar.mjs
var mirroredSlot = (name2) => `session-toolbox.${name2}`;
var SESSION_DRAG = "application/x-dsh-toolbox-session";
function sessionProjectDrag({ read, move, report }) {
  let sessionId, highlighted, resetTimer, consumed = false, moving = false;
  const clear = () => {
    highlighted?.removeAttribute("data-toolbox-session-drop");
    highlighted = void 0;
  };
  const projectRow = (event) => event.target.closest?.('[data-row-key^="workspace:"]');
  const ours = (event) => !!sessionId && Array.from(event.dataTransfer?.types ?? []).includes(SESSION_DRAG);
  const target = (row) => {
    const snapshot = read();
    if (moving || snapshot.blocked) return;
    const id = row?.getAttribute("data-row-key")?.slice("workspace:".length);
    const workspace = snapshot.workspaces.find((item) => item.workspaceId === id);
    const project = snapshot.projects.find((item) => item.id === id);
    if (!workspace || !project?.path || workspace.sessionIds.includes(sessionId)) return;
    return project;
  };
  return {
    get suppressOrder() {
      return consumed;
    },
    start(event) {
      clearTimeout(resetTimer);
      sessionId = void 0;
      consumed = false;
      clear();
      const row = event.target.closest?.('[data-row-key^="session:"]');
      const snapshot = read();
      const id = row?.getAttribute("data-row-key")?.slice("session:".length);
      const session = snapshot.sessions?.byId[id];
      if (!row?.draggable || !session || session.blank || snapshot.archived?.includes(id) || snapshot.blocked || moving) return;
      sessionId = id;
      event.dataTransfer.setData(SESSION_DRAG, id);
    },
    over(event) {
      if (!ours(event)) return;
      const row = projectRow(event);
      clear();
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      const project = target(row);
      event.dataTransfer.dropEffect = project ? "move" : "none";
      if (project) {
        highlighted = row;
        row.setAttribute("data-toolbox-session-drop", "");
      }
    },
    leave(event) {
      if (highlighted && !highlighted.contains(event.relatedTarget)) clear();
    },
    async drop(event) {
      if (!ours(event)) return;
      const row = projectRow(event);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      consumed = true;
      clear();
      if (event.dataTransfer.getData(SESSION_DRAG) !== sessionId) return;
      const project = target(row);
      if (!project) return;
      const id = sessionId;
      moving = true;
      report({ busy: true, message: "" });
      try {
        const result = await move({ type: "move", sessionId: id, toCwd: project.path, createTarget: false });
        report({ busy: false, message: result?.deferred ? "\u6587\u4EF6\u5DF2\u8FC1\u79FB\uFF0C\u4F46\u9879\u76EE\u8D26\u672C\u5C1A\u672A\u5B8C\u6210\uFF1B\u8BF7\u5728\u5DE5\u5177\u7BB1\u70B9\u51FB\u5B8C\u6210\u6216\u56DE\u6EDA" : `\u5DF2\u5207\u6362\u5230\u9879\u76EE\u300C${project.title}\u300D`, error: false });
      } catch (error) {
        report({ busy: false, message: error.message, error: true });
      } finally {
        moving = false;
      }
    },
    end() {
      sessionId = void 0;
      clear();
      resetTimer = setTimeout(() => {
        consumed = false;
      }, 0);
    },
    dispose() {
      clearTimeout(resetTimer);
      clear();
    }
  };
}
function installSidebar(ctx, makeComponent) {
  if (typeof ctx.slots.entries !== "function" || typeof ctx.slots.subscribe !== "function") return;
  ctx.slots.inject("sidebar.workspaces", () => {
    const native = ctx.slots.entries("sidebar.workspaces")[0];
    if (!native?.component || !native.children || Object.values(native.children).some((spec) => spec.scope !== "root")) return;
    ctx.effect(() => {
      const dispose = [];
      try {
        dispose.push(ctx.slots.register({
          ...native.options,
          name: "sidebar.workspaces",
          priority: (native.options.priority ?? 0) - 10,
          store: native.store,
          inject: native.inject,
          locale: native.locale,
          children: Object.fromEntries(Object.entries(native.children).map(([name2, spec]) => [mirroredSlot(name2), spec]))
        }, makeComponent(native)));
        for (const name2 of Object.keys(native.children)) {
          const copies = /* @__PURE__ */ new Map();
          const sync = () => {
            const entries = ctx.slots.entries(name2);
            for (const [entry, release] of copies) if (!entries.includes(entry)) {
              release();
              copies.delete(entry);
            }
            for (const entry of entries) {
              if (copies.has(entry)) continue;
              if (entry.children) throw new Error(`Unsupported nested sidebar slot: ${name2}`);
              copies.set(entry, ctx.slots.register({ ...entry.options, name: mirroredSlot(name2), inject: entry.inject, store: entry.store, locale: entry.locale }, entry.component));
            }
          };
          dispose.push(() => {
            for (const release of copies.values()) release();
            copies.clear();
          });
          sync();
          dispose.push(ctx.slots.subscribe(name2, sync));
        }
      } catch (error) {
        for (const release of dispose.reverse()) release?.();
        console.warn("[dsh-session-toolbox] Native sidebar decoration unavailable", error);
        return;
      }
      return () => {
        for (const release of dispose.reverse()) release?.();
      };
    });
  });
}
function sidebarLayout(workspaces, groups) {
  const ranks = /* @__PURE__ */ new Map();
  for (const [index, group] of groups.entries()) for (const id of group.workspaceIds) if (!ranks.has(id)) ranks.set(id, index);
  return workspaces.map((workspace, index) => ({ workspace, group: ranks.get(workspace.workspaceId) ?? groups.length, index })).sort((a, b) => a.group - b.group || a.index - b.index);
}
function installQueueSteering(ctx, makeComponent) {
  if (typeof ctx.slots.entries !== "function" || typeof ctx.slots.subscribe !== "function") return;
  ctx.slots.inject("conversation.input.dock", () => ctx.effect(() => {
    let original, release, syncing = false;
    const owned = /* @__PURE__ */ new Set();
    const sync = () => {
      if (syncing) return;
      const native = ctx.slots.entries("conversation.input.dock").find((entry) => entry.options.id === "queue" && !owned.has(entry.component));
      if (native === original) return;
      syncing = true;
      try {
        release?.();
        release = void 0;
        original = native;
        if (!native?.component || native.children) return;
        const component = makeComponent(native);
        owned.add(component);
        release = ctx.slots.register({
          ...native.options,
          name: "conversation.input.dock",
          priority: (native.options.priority ?? 0) - 10,
          store: native.store,
          inject: native.inject,
          locale: native.locale
        }, component);
      } finally {
        syncing = false;
      }
    };
    const unsubscribe = ctx.slots.subscribe("conversation.input.dock", sync);
    sync();
    return () => {
      unsubscribe();
      release?.();
    };
  }));
}
function protectProjectMenu(doc, anchor, menu, close) {
  let timer;
  const inside = (node) => !!node && (anchor.contains(node) || menu.contains(node));
  const enter = (event) => {
    if (inside(event.target)) clearTimeout(timer);
  };
  const leave = (event) => {
    if (!inside(event.target)) return;
    event.stopPropagation();
    clearTimeout(timer);
    if (!inside(event.relatedTarget)) timer = setTimeout(close, 180);
  };
  doc.addEventListener("pointerout", leave, true);
  doc.addEventListener("pointerover", enter, true);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("pointerout", leave, true);
    doc.removeEventListener("pointerover", enter, true);
  };
}

// src/client.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var pluginVersion = package_default.version;
var name = "dsh-session-toolbox-client";
var inject = ["slots", "locale", "sessions", "conversation"];
var NS = "dsh-session-toolbox";
var ENDPOINT = `/.well-known/${NS}`;
var NOTICE_EVENT = "dsh-session-toolbox:notice";
function dispatchNotice(message) {
  try {
    window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: message }));
  } catch {
  }
}
var vault;
var directoryPicker;
var conversationService;
var replyAvailable = false;
var sessionsService;
var refreshState = { running: false };
var store = { state: null, error: "", overlay: null, listeners: /* @__PURE__ */ new Set() };
function showOverlay(request) {
  store.overlay = request;
  for (const listener of store.listeners) listener();
}
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
var stateRequest = 0;
async function loadState() {
  const request = ++stateRequest;
  try {
    const next = await readResponse(await fetch(ENDPOINT, { cache: "no-store" }));
    if (request !== stateRequest) return store.state;
    store.state = next;
    store.error = "";
    sessionKey = next.key ?? sessionKey;
    vault?.setLimits(next.settings?.draftVault ?? {});
  } catch (error) {
    if (request !== stateRequest) return store.state;
    store.error = error.message;
  }
  for (const listener of store.listeners) listener();
  return store.state;
}
async function callHost(input) {
  if (input.type === "vault.sweep") {
    if (!vault) throw new Error("\u8349\u7A3F\u4FDD\u9669\u7BB1\u5C1A\u672A\u5C31\u7EEA");
    const report = await vault.sweep();
    await vault.syncHost();
    return report;
  }
  if (!sessionKey) await loadState();
  const post = () => fetch(ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-session-toolbox-key": sessionKey },
    body: JSON.stringify(input)
  });
  let response = await post();
  if (response.status === 401) {
    await loadState();
    response = await post();
  }
  const res = await readResponse(response);
  sessionKey = res.key ?? sessionKey;
  if (["move", "move.complete", "move.rollback", "workspace.edit", "workspace.complete", "trash.session", "trash.workspace", "trash.restore", "trash.purge"].includes(input.type)) {
    try {
      await refreshSessionList();
    } catch (error) {
      dispatchNotice(`\u64CD\u4F5C\u5DF2\u5B8C\u6210\uFF0C\u4F46\u5217\u8868\u5237\u65B0\u5931\u8D25\uFF1A${error.message}`);
    }
  }
  return res;
}
async function refreshSessionList() {
  const service = sessionsService;
  if (service === void 0) throw new Error("\u5F53\u524D DSH \u672A\u63D0\u4F9B\u4F1A\u8BDD\u670D\u52A1\uFF0C\u65E0\u6CD5\u5237\u65B0");
  if (typeof service.refresh !== "function") throw new Error("\u5F53\u524D DSH \u7248\u672C\u7684\u4F1A\u8BDD\u670D\u52A1\u4E0D\u652F\u6301\u5237\u65B0");
  refreshState.running = true;
  try {
    await service.refresh();
  } finally {
    refreshState.running = false;
  }
  await loadState();
}
function apply(ctx) {
  directoryPicker = ctx.get?.("directoryPicker");
  sessionsService = ctx.sessions;
  conversationService = ctx.conversation;
  const workspaceList = ctx.get?.("workspaces")?.list;
  if (typeof workspaceList?.subscribe === "function") ctx.effect(() => workspaceList.subscribe(() => {
    void loadState();
  }));
  const vaultInstance = vault = createVault({
    endpoint: ENDPOINT,
    getInput: (sessionId) => {
      const binding = sessionsService?.binding?.(sessionId);
      const conversation = ctx.conversation;
      if (!binding || !conversation?.input?.for) return void 0;
      return { store: conversation.input.for(binding.ctx).state, resolve: (ids) => conversation.resolveDraftAttachments(ids) };
    },
    log: (level, message) => {
      try {
        (level === "error" ? console.warn : console.log)(`[${NS}]`, message);
      } catch {
      }
    }
  });
  void loadState();
  const timer = setInterval(() => void loadState(), 3e4);
  const onVaultChange = () => {
    void loadState();
  };
  vaultInstance.on("change", onVaultChange);
  ctx.effect(() => () => {
    clearInterval(timer);
    vaultInstance.off("change", onVaultChange);
    vaultInstance.stop();
  });
  void vaultInstance.start().catch((error) => sayRow(`\u8349\u7A3F\u4FDD\u9669\u7BB1\u542F\u52A8\u5931\u8D25\uFF1A${error.message}`));
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { "menu.move": "\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE\u2026", "menu.trash": "\u5F52\u6863\u5230\u5F52\u6863\u6C60", ...workspaceChinese },
    en: { "menu.move": "Move to another project\u2026", "menu.trash": "Archive", ...workspaceEnglish }
  }), "session-toolbox: dictionaries");
  if (typeof ctx.inject === "function") ctx.inject(["inputTriggers"], (scope) => scope.effect(() => {
    const triggers = scope.get?.("inputTriggers");
    if (typeof triggers?.registerSource !== "function") return;
    const release = triggers.registerSource(replySource());
    replyAvailable = true;
    return () => {
      replyAvailable = false;
      release();
    };
  }));
  installReplyNodes(ctx, (native, mirrors) => (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReplyMessage, { ...props, Native: native.component, mirrors, toolboxT: ctx.locale.bind?.(NS) }));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "session-toolbox-reply", order: 1, locale: NS }, ReplyPreview));
  installSidebar(ctx, (native) => (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GroupedSidebar, { ...props, toolboxT: ctx.locale.bind?.(NS), Native: native.component }));
  installQueueSteering(ctx, (native) => (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NativeSteerQueue, { ...props, Native: native.component, toolboxT: ctx.locale.bind?.(NS) }));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "session-toolbox-steer",
    order: 15,
    locale: NS,
    inject: (sessionId) => {
      const scope = ctx.sessions?.scope?.(sessionId);
      const conversation = scope?.get("conversation");
      return { updateQueue: typeof conversation?.updateQueue === "function" ? (id, action) => conversation.updateQueue(id, action) : void 0 };
    }
  }, SteerQueueButton));
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: NS, locale: NS }, KitPage));
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-toolbox-move", order: 500, locale: NS }, MoveSessionMenuItem));
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-toolbox-trash", order: 600, locale: NS }, TrashSessionMenuItem));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "session-toolbox-dialog", order: 500, locale: NS }, ToolboxOverlay));
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
.sk .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sk.stack,.sk .stack{display:flex;flex-direction:column;gap:16px}
.sk .community{padding:10px 14px;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-card)}.sk .community a{color:var(--sk-accent);font-weight:500;text-decoration:underline;text-underline-offset:3px}.sk .community a:hover{opacity:.8}.sk .community a:focus-visible{outline:2px solid var(--sk-accent);outline-offset:4px;border-radius:2px}
.sk button,.sk input,.sk select{font:inherit;color:inherit;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-bg);min-height:36px;padding:7px 12px}
.sk button{cursor:pointer}.sk button:hover{background:var(--sk-card)}.sk button:disabled{opacity:.45;cursor:default}
.sk button.primary{background:var(--sk-accent);color:#fff;border-color:transparent}
.sk table{width:100%;border-collapse:collapse;font-size:13px}.sk th,.sk td{border-bottom:1px solid var(--sk-border);padding:8px;text-align:left}.sk th{color:var(--sk-muted);font-weight:500}
.sk .error{color:var(--dsw-alias-state-error-primary,#ef9393)}.sk .good{color:var(--dsw-alias-state-success-primary,#77ca9d)}
.sk .pill{border:1px solid var(--sk-border);border-radius:100px;padding:2px 10px;font-size:12px;background:var(--sk-bg);display:inline-block}
.sk .mono{font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.sk input.grow{flex:1;min-width:0}
.sk-dialog-body{max-height:calc(100dvh - 160px);overflow-y:auto;overscroll-behavior:contain;padding-right:4px}.sk-dialog-body>*{flex-shrink:0}
`;
function KitPage({ t } = {}) {
  const { state, error } = useKit();
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [refreshing, setRefreshing] = (0, import_react.useState)(false);
  const [feedback, setFeedback] = (0, import_react.useState)("");
  const say = (message) => {
    setFeedback(message);
    setTimeout(() => setFeedback(""), 8e3);
  };
  (0, import_react.useEffect)(() => {
    const onNotice = (event) => {
      const message = typeof event?.detail === "string" ? event.detail : "";
      if (message) say(message);
      void loadState().catch(() => {
      });
    };
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(NOTICE_EVENT, onNotice);
  }, []);
  const act = async (input, ok) => {
    setBusy(true);
    try {
      const result = await callHost(input);
      if (result.deferred) say(result.note ?? "\u8FC1\u79FB\u8D26\u672C\u5C1A\u5F85\u5B8C\u6210\uFF0C\u8BF7\u5728\u6062\u590D\u533A\u7EE7\u7EED\u5904\u7406");
      else if (ok) say(ok);
      await loadState();
      setBusy(false);
      return result;
    } catch (err) {
      say(`\u5931\u8D25\uFF1A${err.message}`);
      setBusy(false);
      throw err;
    }
  };
  const settings = state?.settings;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk stack", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "\u4F1A\u8BDD\u5DE5\u5177\u7BB1" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row community", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { href: "https://qm.qq.com/q/eQC7OQXQe4", target: "_blank", rel: "noopener noreferrer", children: text(t, "community.join") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "muted", children: [
        text(t, "community.name"),
        " \xB7 ",
        text(t, "community.number"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "1124103038" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      "\u8349\u7A3F\u4FDD\u9669\u7BB1 \xB7 \u4F1A\u8BDD\u5207\u6362\u9879\u76EE \xB7 \u5F52\u6863\u6C60 \u2014 v",
      pluginVersion,
      "\u3002\u6570\u636E\u4EC5\u5B58\u672C\u673A\uFF08\u6D4F\u89C8\u5668 IndexedDB + ~/.dsh/session-toolbox/\uFF09\u3002"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy || refreshing, onClick: () => {
        setRefreshing(true);
        void refreshSessionList().then(() => say("\u4F1A\u8BDD\u5217\u8868\u5DF2\u5237\u65B0\uFF1B\u8FC1\u79FB\u6216\u8FD8\u539F\u8FC7\u7684\u4F1A\u8BDD\u5E94\u51FA\u73B0\u5728\u65B0\u9879\u76EE\u4E0B")).catch((err) => say(`\u5237\u65B0\u5931\u8D25\uFF1A${err.message}`)).finally(() => setRefreshing(false));
      }, children: refreshing ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0\u4F1A\u8BDD\u5217\u8868" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "muted", children: "\u8FC1\u79FB\u6216\u8FD8\u539F\u4F1A\u8BDD\u540E\uFF0C\u82E5\u4FA7\u680F\u6CA1\u53D8\u5316\uFF0C\u70B9\u8FD9\u91CC\u91CD\u65B0\u62C9\u53D6\u5217\u8868\uFF08\u4E0D\u5F71\u54CD\u4EFB\u4F55\u4F1A\u8BDD\u5185\u5BB9\uFF09\u3002" })
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
                onChange: (e) => void act({ type: "settings.update", patch: { draftVault: { ...settings.draftVault, enabled: e.target.checked } } }, e.target.checked ? "\u5DF2\u542F\u7528\u8349\u7A3F\u4FDD\u9669\u7BB1" : "\u5DF2\u505C\u7528\u8349\u7A3F\u4FDD\u9669\u7BB1\uFF08\u4FDD\u7559\u5DF2\u6709\u5907\u4EFD\uFF09").catch(() => {
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
        vault?.lastNotice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: vault.lastNotice }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "vault.sweep" }, "\u5DF2\u6309 TTL/\u5BB9\u91CF\u6E05\u7406").catch(() => {
        }), children: "\u7ACB\u5373\u6574\u7406" }) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\u7B49\u5F85\u540E\u53F0\u6570\u636E\u2026" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WorkspaceSection, { state, t }),
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: createTarget, onChange: (e) => {
        setCreateTarget(e.target.checked);
        setPlan(null);
      } }),
      " \u76EE\u6807\u4E0D\u5B58\u5728\u65F6\u521B\u5EFA"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy || !sessionId || !toCwd, onClick: () => {
        setPlan(null);
        void act({ type: "preflight", sessionId, toCwd, createTarget }).then(setPlan).catch(() => {
        });
      }, children: "\u4F53\u68C0" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "primary", disabled: busy || plan?.toProject === void 0, onClick: () => void act({ type: "move", sessionId, toCwd, createTarget }, "\u8FC1\u79FB\u5B8C\u6210\uFF0C\u5DF2\u5237\u65B0\u4F1A\u8BDD\u5217\u8868").catch(() => {
      }), children: "\u8FC1\u79FB" })
    ] }),
    plan?.toProject && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "mono muted", style: { whiteSpace: "pre-wrap" }, children: JSON.stringify({ \u4ECE: plan.fromCwd, \u5230: plan.toCwd, \u539F\u76EE\u5F55: plan.fromProject, \u65B0\u76EE\u5F55: plan.toProject, \u65E5\u5FD7\u6587\u4EF6: plan.logName }, null, 2) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\u53EA\u6539 DSH \u5185\u90E8\u5F52\u5C5E\u4E0E\u4F1A\u8BDD\u5934\uFF1B\u5386\u53F2\u4E0D\u53D8\uFF0C\u65E7\u6D88\u606F\u4E2D\u7684\u7EDD\u5BF9\u8DEF\u5F84\u4ECD\u6307\u5411\u539F\u9879\u76EE\uFF08\u5DF2\u77E5\u8BED\u4E49\uFF09\u3002\u4F1A\u8BDD\u7A7A\u95F2\u4E14\u65E0\u6392\u961F\u6D88\u606F\u65F6\uFF0C\u81EA\u52A8\u91CA\u653E\u5199\u5165\u53E5\u67C4\u540E\u8FC1\u79FB\uFF0C\u65E0\u9700\u91CD\u542F DSH\u3002" })
  ] });
}
function TrashSection({ act, busy, say, state }) {
  const items = state?.trash ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "box", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u5F52\u6863\u6C60" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      "\u8FD9\u91CC\u540C\u65F6\u663E\u793A DSH \u539F\u751F\u5F52\u6863\u548C\u901A\u8FC7\u5DE5\u5177\u7BB1\u5F52\u6863\u7684\u4F1A\u8BDD\u3002\u5DE5\u5177\u7BB1\u5F52\u6863\u989D\u5916\u4FDD\u5B58",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u9879\u76EE\u5F52\u5C5E\u3001\u5217\u8868\u4F4D\u7F6E\u4E0E\u7F6E\u9876\u72B6\u6001" }),
      "\uFF1B\u539F\u751F\u5F52\u6863\u6309\u5F53\u524D\u9879\u76EE\u5F52\u5C5E\u8FD8\u539F\uFF0C\u539F\u59CB\u5F52\u6863\u65F6\u95F4\u548C\u5F52\u6863\u524D\u7F6E\u9876\u72B6\u6001\u4E0D\u53EF\u8FFD\u6EAF\uFF0C\u4E5F\u4E0D\u53C2\u4E0E\u5230\u671F\u81EA\u52A8\u5220\u9664\u3002 \u5F52\u6863\u9879\u76EE\u5219\u4FDD\u7559\u5168\u90E8\u4F1A\u8BDD\u65E5\u5FD7\uFF0C\u53EA\u79FB\u9664\u9879\u76EE\u6CE8\u518C\u8868\u9879\u3002\u5F7B\u5E95\u5220\u9664\u4F1A\u5148\u79FB\u5165\u6682\u5B58\u76EE\u5F55\u518D\u6E05\u7406\uFF0C\u4E2D\u65AD\u53EF\u7528 CLI \u68C0\u51FA\u3002"
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: item.source === "native" ? "\u4F1A\u8BDD\uFF08\u539F\u751F\u5F52\u6863\uFF09" : item.kind === "session" ? "\u4F1A\u8BDD" : "\u9879\u76EE" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "mono", children: shortId(item.targetId) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "mono", children: item.kind === "session" ? item.snapshot.title || "\uFF08\u65E0\u6807\u9898\uFF09" : item.snapshot.path }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: item.trashedAt ? new Date(item.trashedAt).toLocaleString("zh-CN", { hour12: false }) : "\u672A\u77E5\uFF08\u539F\u751F\u5F52\u6863\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => void act({ type: "trash.restore", itemId: item.itemId }, "\u5DF2\u8FD8\u539F\u5230\u539F\u4F4D").catch(() => {
          }), children: "\u8FD8\u539F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { disabled: busy, onClick: () => showOverlay({ kind: "purge", itemId: item.itemId, title: item.snapshot.title || item.snapshot.path || item.targetId }), children: "\u5F7B\u5E95\u5220\u9664" })
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
function MoveSessionMenuItem({ sessionId, useMenuOpenState, t }) {
  const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {
  }];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.MenuItemButton, { separatorBefore: true, icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, { size: 14 }), onSelect: () => {
    setMenuOpen(false);
    showOverlay({ kind: "move", sessionId });
  }, children: t ? t("menu.move") : "\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE\u2026" });
}
function TrashSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
  const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {
  }];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.MenuItemButton, { icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconArchiveOutlineRegular, { size: 14 }), onSelect: () => {
    setMenuOpen(false);
    showOverlay({ kind: "archive", sessionId, title: displayTitle || sessionId });
  }, children: t ? t("menu.trash") : "\u5F52\u6863\u5230\u5F52\u6863\u6C60" });
}
function sayRow(message) {
  store.error = message;
  for (const listener of store.listeners) listener();
}
function ToolboxOverlay({ t } = {}) {
  const { overlay } = useKit();
  if (!overlay) return null;
  const close = () => showOverlay(null);
  if (overlay.kind === "groups") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GroupsDialog, { close, t });
  if (overlay.kind === "group-move") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MoveGroupDialog, { workspaceId: overlay.workspaceId, close, t }, overlay.workspaceId);
  if (overlay.kind === "workspace") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WorkspaceDialog, { workspaceId: overlay.workspaceId, close, t }, overlay.workspaceId);
  if (overlay.kind === "move") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MoveDialog, { sessionId: overlay.sessionId, close }, overlay.sessionId);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TrashDialog, { request: overlay, close }, overlay.itemId || overlay.sessionId);
}
function TrashDialog({ request, close }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const purge = request.kind === "purge";
  const dismiss = () => {
    if (!busy) close();
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await callHost(purge ? { type: "trash.purge", itemId: request.itemId } : { type: "trash.session", sessionId: request.sessionId });
      await loadState();
      close();
    } catch (reason) {
      setError(reason.message);
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose: dismiss,
      closeLabel: "\u5173\u95ED",
      title: purge ? "\u5F7B\u5E95\u5220\u9664" : "\u5F52\u6863\u5230\u5F52\u6863\u6C60",
      description: purge ? `\u5C06\u6C38\u4E45\u5220\u9664\u300C${request.title}\u300D\u7684\u4F1A\u8BDD\u8BB0\u5F55\uFF0C\u6B64\u64CD\u4F5C\u65E0\u6CD5\u8FD8\u539F\u3002` : `\u5F52\u6863\u300C${request.title}\u300D\u540E\uFF0C\u53EF\u5728\u5DE5\u5177\u7BB1\u5F52\u6863\u6C60\u4E2D\u8FD8\u539F\u3002`,
      footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: dismiss, children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: () => void submit(), children: busy ? "\u5904\u7406\u4E2D\u2026" : purge ? "\u786E\u8BA4\u5F7B\u5E95\u5220\u9664" : "\u786E\u8BA4\u5F52\u6863" })
      ] }),
      children: error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", children: error }) : null
    }
  );
}
function MoveDialog({ sessionId, close }) {
  const [toCwd, setToCwd] = (0, import_react.useState)("");
  const [createTarget, setCreateTarget] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const { state } = useKit();
  const projects = state?.projects ?? [];
  const [fromProject, setFromProject] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
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
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await callHost({ type: "move", sessionId, toCwd, createTarget });
      close();
      dispatchNotice(result?.deferred ? "\u6587\u4EF6\u5DF2\u8FC1\u79FB\uFF0C\u4F46\u9879\u76EE\u8D26\u672C\u5C1A\u672A\u5B8C\u6210\uFF1B\u8BF7\u5728\u5DE5\u5177\u7BB1\u70B9\u51FB\u5B8C\u6210\u6216\u56DE\u6EDA" : "\u8FC1\u79FB\u5B8C\u6210\uFF0C\u5DF2\u5237\u65B0\u4F1A\u8BDD\u5217\u8868");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const valid = /^\/|^[A-Za-z]:[\\/]/.test(toCwd);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose: () => {
        if (!busy) close();
      },
      closeLabel: "\u5173\u95ED",
      title: "\u4F1A\u8BDD\u5207\u6362\u5230\u5176\u5B83\u9879\u76EE",
      footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: close, children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy || !valid || fromProject?.path === toCwd, onClick: () => void submit(), children: busy ? "\u8FC1\u79FB\u4E2D\u2026" : "\u4F53\u68C0\u5E76\u8FC1\u79FB" })
      ] }),
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk stack", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted mono", children: sessionId }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
          "\u5F53\u524D\u9879\u76EE\uFF1A",
          fromProject ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: fromProject.title }),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "mono", children: fromProject.path })
          ] }) : "\uFF08\u672A\u627E\u5230\u9879\u76EE\uFF09"
        ] }),
        projects.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "stack", children: [
          "\u76EE\u6807\u9879\u76EE",
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: projects.some((p) => p.path === toCwd) ? toCwd : "", onChange: (e) => setToCwd(e.target.value), disabled: busy, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u9009\u62E9\u76EE\u6807\u9879\u76EE\u2026" }),
            projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: project.path, disabled: fromProject?.path === project.path, children: [
              project.title,
              "\uFF08",
              project.sessions,
              " \u4E2A\u4F1A\u8BDD\uFF09",
              fromProject?.path === project.path ? " \u2014 \u5F53\u524D\u9879\u76EE" : ""
            ] }, project.id))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "stack", children: [
          "\u76EE\u6807\u76EE\u5F55",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "mono", value: toCwd, onChange: (e) => setToCwd(e.target.value), disabled: busy, placeholder: "\u76EE\u6807\u9879\u76EE\u7EDD\u5BF9\u8DEF\u5F84" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: createTarget, onChange: (e) => setCreateTarget(e.target.checked), disabled: busy }),
          " \u76EE\u5F55\u4E0D\u5B58\u5728\u65F6\u521B\u5EFA"
        ] }),
        error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "error", role: "alert", children: error }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: "\u4F1A\u8BDD\u9700\u7A7A\u95F2\u4E14\u6CA1\u6709\u6392\u961F\u6D88\u606F\u3002\u63D2\u4EF6\u4F1A\u5B8C\u6210\u5199\u5165\u5E76\u91CA\u653E\u53E5\u67C4\u540E\u8FC1\u79FB\uFF0C\u65E0\u9700\u91CD\u542F DSH\u3002" })
      ] })
    }
  );
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
var workspaceChinese = {
  "reply.action": "\u5F15\u7528\u56DE\u590D",
  "reply.cancel": "\u53D6\u6D88\u5F15\u7528",
  "reply.user": "\u7528\u6237",
  "reply.assistant": "\u52A9\u624B",
  "reply.unavailable": "\u5F53\u524D\u8F93\u5165\u6846\u6682\u4E0D\u652F\u6301\u5F15\u7528\u56DE\u590D",
  "community.join": "\u52A0\u5165 QQ \u4EA4\u6D41\u7FA4 \u2197",
  "community.name": "AndroidSix \u7684\u5F00\u6E90\u9879\u76EE\u4EA4\u6D41\u7FA4",
  "community.number": "\u7FA4\u53F7",
  "groups.title": "\u9879\u76EE\u5206\u7EC4",
  "groups.all": "\u5168\u90E8\u9879\u76EE",
  "groups.none": "\u672A\u5206\u7EC4",
  "groups.manage": "\u7BA1\u7406\u9879\u76EE\u4E0E\u5206\u7EC4",
  "groups.move": "\u79FB\u5165\u5206\u7EC4\u2026",
  "groups.drop": "\u53EF\u5C06\u9879\u76EE\u62D6\u5230\u5206\u7EC4\u6807\u9898\uFF0C\u6216\u4ECE\u9879\u76EE\u83DC\u5355\u9009\u62E9\u201C\u79FB\u5165\u5206\u7EC4\u201D\u3002",
  "groups.name": "\u5206\u7EC4\u540D\u79F0",
  "groups.create": "\u65B0\u5EFA\u5206\u7EC4",
  "groups.rename": "\u91CD\u547D\u540D",
  "groups.delete": "\u5220\u9664\u5206\u7EC4",
  "groups.help": "\u6BCF\u4E2A\u9879\u76EE\u53EF\u5F52\u5165\u4E00\u4E2A\u5206\u7EC4\uFF1B\u5220\u9664\u5206\u7EC4\u4F1A\u5C06\u5176\u4E2D\u9879\u76EE\u6062\u590D\u4E3A\u672A\u5206\u7EC4\u3002\u4FA7\u680F\u6309\u201C\u5206\u7EC4 \u2192 \u9879\u76EE \u2192 \u4F1A\u8BDD\u201D\u5C55\u5F00\uFF0C\u539F\u751F\u641C\u7D22\u4ECD\u641C\u7D22\u5168\u90E8\u4F1A\u8BDD\u3002",
  "project.groupHelp": "\u5206\u7EC4\u9009\u62E9\u540E\u7ACB\u5373\u4FDD\u5B58\uFF1B\u540D\u79F0\u548C\u8DEF\u5F84\u70B9\u51FB\u201C\u4FDD\u5B58\u201D\u540E\u751F\u6548\u3002",
  "project.editGroup": "\u7F16\u8F91\u9879\u76EE",
  "queue.rowSteer": "\u5F15\u5BFC",
  "project.edit": "\u7F16\u8F91\u9879\u76EE",
  "project.title": "\u9879\u76EE\u540D\u79F0",
  "project.path": "\u9879\u76EE\u76EE\u5F55",
  "project.browse": "\u6D4F\u89C8\u2026",
  "project.help": "\u9009\u62E9\u5DF2\u6709\u4EE3\u7801\u76EE\u5F55\u3002\u4FDD\u5B58\u540E\uFF0C\u5C06\u8BE5\u9879\u76EE\u7684\u5168\u90E8\u5DF2\u6709\u4F1A\u8BDD\u4E00\u8D77\u8FC1\u5165\u65B0\u8DEF\u5F84\uFF0C\u4FDD\u7559\u987A\u5E8F\u3001\u5F52\u6863\u53CA\u7F6E\u9876\u72B6\u6001\uFF1B\u4EE3\u7801\u6587\u4EF6\u4E0D\u4F1A\u642C\u52A8\uFF0C\u5386\u53F2\u6D88\u606F\u4E2D\u7684\u8DEF\u5F84\u4FDD\u6301\u539F\u6837\u3002\u4F1A\u8BDD\u5FC5\u987B\u7A7A\u95F2\u4E14\u6CA1\u6709\u6392\u961F\u6D88\u606F\u3002",
  "project.resume": "\u7EE7\u7EED\u8FC1\u79FB",
  "project.pending": "\u9879\u76EE\u8FC1\u79FB\u5C1A\u672A\u5B8C\u6210\uFF0C\u8BF7\u7EE7\u7EED\u8FC1\u79FB\u3002",
  "common.save": "\u4FDD\u5B58",
  "common.cancel": "\u53D6\u6D88",
  "common.close": "\u5173\u95ED",
  "common.busy": "\u5904\u7406\u4E2D\u2026",
  "common.loading": "\u6B63\u5728\u52A0\u8F7D\u9879\u76EE\u2026",
  "queue.steer": "\u5F15\u5BFC\u4E0B\u4E00\u6761",
  "queue.help": "\u5C06\u961F\u5217\u7B2C\u4E00\u6761\u4EA4\u7ED9\u5F53\u524D\u8FD0\u884C\u8F6E\u6B21\uFF0C\u5728\u4E0B\u4E00\u53EF\u7528\u6B65\u9AA4\u63A5\u6536\uFF0C\u5F53\u524D\u5DE5\u5177\u7EE7\u7EED\u6267\u884C\u3002\u4E5F\u53EF\u5728\u539F\u751F\u961F\u5217\u6BCF\u6761\u6D88\u606F\u65C1\u70B9\u51FB\u201C\u5F15\u5BFC\u201D\u3002"
};
var workspaceEnglish = {
  "reply.action": "Quote reply",
  "reply.cancel": "Cancel quote",
  "reply.user": "User",
  "reply.assistant": "Assistant",
  "reply.unavailable": "Quote reply is unavailable for this composer",
  "community.join": "Join the QQ community \u2197",
  "community.name": "AndroidSix open-source projects",
  "community.number": "Group",
  "groups.title": "Project groups",
  "groups.all": "All projects",
  "groups.none": "Ungrouped",
  "groups.manage": "Manage projects and groups",
  "groups.move": "Move to group\u2026",
  "groups.drop": "Drag a project onto a group heading, or choose Move to group from its menu.",
  "groups.name": "Group name",
  "groups.create": "New group",
  "groups.rename": "Rename",
  "groups.delete": "Delete group",
  "groups.help": "Each project belongs to one group. Deleting a group leaves its projects ungrouped. The sidebar nests projects under collapsible groups; native search still searches all chats.",
  "project.groupHelp": "Group changes save immediately. Name and directory changes apply when you click Save.",
  "project.editGroup": "Edit project",
  "queue.rowSteer": "Steer",
  "project.edit": "Edit project",
  "project.title": "Project name",
  "project.path": "Project directory",
  "project.browse": "Browse\u2026",
  "project.help": "Choose an existing code directory. Saving moves all existing chats to the new path and keeps their order, archive and pin state. Code files and paths in past messages stay as they are. Chats must be idle with no queued messages; the host releases their writer before migration.",
  "project.resume": "Resume migration",
  "project.pending": "Project migration is incomplete. Resume it to continue.",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.busy": "Working\u2026",
  "common.loading": "Loading projects\u2026",
  "queue.steer": "Steer next message",
  "queue.help": "Send the first queued message into the running turn at its next available step. Current tools keep running. Use the native queue to steer another message."
};
var text = (t, key) => t ? t(key) : workspaceChinese[key];
function GroupedSidebar({ Native, ...props }) {
  const { state } = useKit();
  const root = (0, import_react.useRef)(null), projectMenu = (0, import_react.useRef)(null);
  const [list, setList] = (0, import_react.useState)(null), [menu, setMenu] = (0, import_react.useState)(null), [collapsed, setCollapsed] = (0, import_react.useState)({});
  const [dropGroup, setDropGroup] = (0, import_react.useState)(null), [groupError, setGroupError] = (0, import_react.useState)("");
  const [sessionFeedback, setSessionFeedback] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (!sessionFeedback || sessionFeedback.busy) return;
    const timer = setTimeout(() => setSessionFeedback(null), sessionFeedback.error ? 8e3 : 4e3);
    return () => clearTimeout(timer);
  }, [sessionFeedback]);
  const movingGroup = (0, import_react.useRef)(false);
  const groups = state?.groups ?? [];
  const workspaces = props.useWorkspaces((value) => value);
  const sessions = props.useSessions((value) => value);
  const dragSnapshot = (0, import_react.useRef)(null);
  dragSnapshot.current = {
    workspaces: workspaces.items,
    projects: state?.projects ?? [],
    sessions,
    archived: workspaces.archivedSessionIds,
    blocked: !!state?.journal || !!state?.workspaceMove || state?.settings?.move?.enabled === false || typeof props.actions?.setSessionOrder !== "function"
  };
  const sessionDrag = (0, import_react.useMemo)(() => sessionProjectDrag({ read: () => dragSnapshot.current, move: callHost, report: setSessionFeedback }), []);
  (0, import_react.useEffect)(() => () => sessionDrag.dispose(), [sessionDrag]);
  const view = props.useStore((value) => value.groupBy);
  const grouped = props.wide && view !== "flat" && groups.length > 0;
  const layout = (0, import_react.useMemo)(() => sidebarLayout(workspaces.items, groups), [workspaces, groups]);
  (0, import_react.useEffect)(() => {
    const discover = () => {
      const row = root.current?.querySelector('[data-row-key^="workspace:"]');
      setList(row?.closest('[role="tree"]') ?? null);
      const seat = projectMenu.current;
      const nativeMenu = seat?.button?.isConnected && [...document.querySelectorAll('[role="menu"]')].find((element) => element.textContent.includes(props.t("delete.workspace")));
      const visible = nativeMenu?.querySelector('[role="presentation"]');
      setMenu((previous) => {
        if (visible) return previous?.target === visible && previous.workspaceId === seat.workspaceId ? previous : { ...seat, target: visible };
        return null;
      });
    };
    const observer = new MutationObserver(discover);
    observer.observe(document.body, { childList: true, subtree: true });
    discover();
    return () => observer.disconnect();
  }, []);
  const capture = (event) => {
    const button = event.target.closest?.("button");
    const row = button?.closest('[data-row-key^="workspace:"]');
    if (!row) return;
    const workspaceId = row.getAttribute("data-row-key").slice("workspace:".length);
    const workspace = workspaces.items.find((item) => item.workspaceId === workspaceId);
    if (workspace && button.getAttribute("aria-label") === props.t("actions.workspace.aria", { name: row.textContent.trim() })) projectMenu.current = { workspaceId, button };
  };
  (0, import_react.useEffect)(() => {
    if (!menu) return;
    const element = menu.target.closest('[role="menu"]');
    if (!element) return;
    element.setAttribute("data-toolbox-project-menu", "");
    const release = protectProjectMenu(document, menu.button, element, () => {
      if (element.isConnected) menu.button.click();
    });
    return () => {
      release();
      element.removeAttribute("data-toolbox-project-menu");
    };
  }, [menu]);
  const moveGroup = async (workspaceId, groupId) => {
    if (movingGroup.current || state?.workspaceMove || !workspaces.items.some((row) => row.workspaceId === workspaceId)) return;
    movingGroup.current = true;
    setGroupError("");
    try {
      await callHost({ type: "group.assign", workspaceId, groupId: groupId === "ungrouped" ? "" : groupId });
      await loadState();
    } catch (error) {
      setGroupError(error.message);
    } finally {
      movingGroup.current = false;
      setDropGroup(null);
    }
  };
  const openEditor = (kind = "workspace") => {
    const id = menu.workspaceId;
    menu.button.click();
    projectMenu.current = null;
    setMenu(null);
    showOverlay({ kind, workspaceId: id });
  };
  const projectedWorkspaces = (0, import_react.useMemo)(() => grouped ? { ...workspaces, items: layout.map((row) => row.workspace) } : workspaces, [grouped, workspaces, layout]);
  const nativeProps = {
    ...props,
    actions: props.actions && { ...props.actions, setSessionOrder: (...args) => {
      if (!sessionDrag.suppressOrder) return props.actions.setSessionOrder(...args);
    } },
    useWorkspaces: (selector) => selector(projectedWorkspaces),
    useStore: (selector) => props.useStore((value) => selector(grouped && value.groupBy === "workspace-tree" ? { ...value, groupBy: "workspace" } : value)),
    renderSlot: (name2, ...args) => props.renderSlot(mirroredSlot(name2), ...args)
  };
  const headings = [...groups, { id: "ungrouped", title: text(props.toolboxT, "groups.none") }];
  const rules = grouped && list ? layout.map(({ workspace, group }) => {
    const selector = `.sk-sidebar [role="tree"]>div:has([data-row-key=${JSON.stringify("workspace:" + workspace.workspaceId)}])`;
    return `${selector}{order:${group * 2 + 1};padding-left:12px;${collapsed[headings[group].id] ? "display:none!important;" : ""}}`;
  }).join("") : "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      className: "sk-sidebar",
      ref: root,
      onClickCapture: capture,
      onDragStartCapture: (event) => {
        sessionDrag.start(event);
        if (event.target.closest?.('[data-row-key^="session:"]')) return;
        const row = event.target.closest?.('[data-row-key^="workspace:"]');
        const id = row?.getAttribute("data-row-key").slice("workspace:".length);
        if (workspaces.items.some((item) => item.workspaceId === id)) event.dataTransfer.setData("application/x-dsh-toolbox-workspace", id);
      },
      onDragOverCapture: sessionDrag.over,
      onDragLeaveCapture: sessionDrag.leave,
      onDropCapture: sessionDrag.drop,
      onDragEndCapture: () => {
        sessionDrag.end();
        setDropGroup(null);
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `.sk-sidebar [data-toolbox-session-drop]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);outline-offset:-1px;border-radius:6px}` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `.sk-sidebar{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.sk-groupbar{display:flex;gap:4px;padding:4px 12px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}.sk-groupbar span{flex:1}.sk-group-heading{display:flex;align-items:center;gap:6px;min-height:32px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 8px}[data-toolbox-project-menu]{min-width:172px!important}[data-toolbox-project-menu] [role="menuitem"]>span:last-child{white-space:nowrap;overflow:visible}.sk-group-heading[data-drop="true"]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);border-radius:6px}.sk-group-heading>button:first-child{flex:1;text-align:left}.sk-group-heading button{background:transparent;color:inherit;border:0;border-radius:6px;cursor:pointer;padding:5px}.sk-group-heading button:hover{background:var(--dsw-alias-interactive-bg-hover)}${rules}` }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk-groupbar", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: text(props.toolboxT, "groups.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", title: text(props.toolboxT, "groups.manage"), "aria-label": text(props.toolboxT, "groups.manage"), onClick: () => showOverlay({ kind: "groups" }), children: "\u2026" })
        ] }),
        groupError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", children: groupError }),
        sessionFeedback && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: sessionFeedback.error ? "alert" : "status", style: { padding: "0 12px", fontSize: 12 }, children: sessionFeedback.busy ? "\u6B63\u5728\u5207\u6362\u9879\u76EE\u2026" : sessionFeedback.message }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Native, { ...nativeProps }),
        grouped && list && (0, import_react_dom.createPortal)(/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `.sk-sidebar div:has(>.sk-group-heading){display:flex;flex-direction:column}.sk-sidebar [role="tree"]>div:has([data-row-key="workspace:"]){order:${groups.length * 2 + 1};${collapsed.ungrouped ? "display:none!important;" : ""}}` }),
          headings.map((group, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              className: "sk-group-heading",
              style: { order: index * 2 },
              "data-toolbox-group": group.id,
              "data-drop": dropGroup === group.id,
              title: text(props.toolboxT, "groups.drop"),
              onDragOver: (event) => {
                if (!state?.workspaceMove && event.dataTransfer.types.includes("application/x-dsh-toolbox-workspace")) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropGroup(group.id);
                }
              },
              onDragLeave: (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setDropGroup(null);
              },
              onDrop: (event) => {
                const id = event.dataTransfer.getData("application/x-dsh-toolbox-workspace");
                if (!id) return;
                event.preventDefault();
                event.stopPropagation();
                void moveGroup(id, group.id);
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { "aria-expanded": !collapsed[group.id], onClick: () => setCollapsed((value) => ({ ...value, [group.id]: !value[group.id] })), children: [
                  collapsed[group.id] ? "\u25B8" : "\u25BE",
                  " ",
                  group.title,
                  " ",
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
                    "(",
                    layout.filter((row) => row.group === index).length,
                    ")"
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { "aria-label": `${group.title} \u2014 ${text(props.toolboxT, "groups.manage")}`, onClick: () => showOverlay({ kind: "groups" }), children: "\u2026" })
              ]
            },
            group.id
          ))
        ] }), list),
        menu && (0, import_react_dom.createPortal)(/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-toolbox-project-actions": true, style: { display: "contents" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.MenuItemButton, { onSelect: () => openEditor(), icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, {}), children: text(props.toolboxT, "project.editGroup") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.MenuItemButton, { onSelect: () => openEditor("group-move"), icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, {}), children: text(props.toolboxT, "groups.move") })
        ] }), menu.target)
      ]
    }
  );
}
function replyInput(sessionId) {
  try {
    const binding = sessionsService?.binding?.(sessionId);
    if (!binding || typeof conversationService?.input?.for !== "function") return;
    return conversationService.input.for(binding.ctx);
  } catch {
    return void 0;
  }
}
function useReplyInput(sessionId, phaseOnly = false) {
  const input = replyInput(sessionId);
  const read = () => {
    const value = input?.state?.getSnapshot?.();
    return phaseOnly ? value?.phase : value;
  };
  const [snapshot, setSnapshot] = (0, import_react.useState)(read);
  (0, import_react.useEffect)(() => {
    const sync = () => setSnapshot(read());
    sync();
    return input?.state?.subscribe?.(sync);
  }, [input, phaseOnly]);
  return [input, snapshot];
}
var replyStyle = `.sk-reply-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:5px;background:transparent;border:0;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);cursor:pointer}.sk-reply-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sk-reply-button:disabled{opacity:.4;cursor:default}.sk-reply-preview{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;background:var(--dsw-alias-bg-module-platform)}.sk-reply-preview>div{min-width:0;flex:1;border-left:2px solid var(--dsw-alias-label-tertiary);padding-left:10px}.sk-reply-preview p{margin:4px 0 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;overflow-wrap:anywhere}.sk-reply-preview strong{font-size:12px;font-weight:500}`;
function ReplyMessage({ Native, mirrors, toolboxT, ...props }) {
  const root = (0, import_react.useRef)(null), [target, setTarget] = (0, import_react.useState)(null), [error, setError] = (0, import_react.useState)("");
  const [input, phase] = useReplyInput(props.sessionId, true);
  const quote = messageReply(props.node);
  const canWrite = props.useSession ? props.useSession((value) => !value.removed && (value.subagent === null || value.subagent?.address?.mode === "continuable")) : false;
  (0, import_react.useEffect)(() => {
    const discover = () => setTarget(root.current?.querySelector("[data-clock]") ?? null);
    const observer = new MutationObserver(discover);
    if (root.current) observer.observe(root.current, { childList: true, subtree: true });
    discover();
    return () => observer.disconnect();
  }, []);
  const label = text(toolboxT, "reply.action");
  const reply = () => {
    try {
      if (!replyAvailable || !input || !canWrite) throw new Error(text(toolboxT, "reply.unavailable"));
      input.setDraft(withReply(input.state.getSnapshot(), quote, `${label} \xB7 ${text(toolboxT, quote.role === "user" ? "reply.user" : "reply.assistant")}`));
      input.persistCurrentDraft?.();
      setError("");
      const surface = root.current?.closest("[data-conversation-session]");
      surface?.querySelector('[data-composer-card] [contenteditable="true"]')?.focus();
    } catch (reason) {
      setError(reason.message);
    }
  };
  const nativeProps = { ...props, renderSlot: (name2, ...args) => props.renderSlot(mirrors.get(name2) ?? name2, ...args) };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { ref: root, style: { display: "contents" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Native, { ...nativeProps }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: replyStyle }),
    quote && target && (0, import_react_dom.createPortal)(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label, side: "bottom", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "sk-reply-button", "aria-label": label, disabled: !replyAvailable || !input || !canWrite || phase !== "plain", onClick: reply, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6 3 2 6.5 6 10M2.5 6.5H10a4 4 0 0 1 0 8H8" }) }) }) }), target),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "alert", children: error })
  ] });
}
function ReplyPreview({ sessionId, t }) {
  const [input, snapshot] = useReplyInput(sessionId);
  const [error, setError] = (0, import_react.useState)("");
  const occurrence = snapshot?.occurrences?.find((row) => row.source === REPLY_SOURCE);
  let quote;
  try {
    if (occurrence) quote = readReply(occurrence.ref);
  } catch {
  }
  if (!quote) return null;
  const cancel = () => {
    try {
      input.setDraft(withoutReply(input.state.getSnapshot()));
      input.persistCurrentDraft?.();
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: replyStyle }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk-reply-preview", "data-toolbox-reply": true, role: "region", "aria-label": text(t, "reply.action"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
          text(t, "reply.action"),
          " \xB7 ",
          text(t, quote.role === "user" ? "reply.user" : "reply.assistant")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: quote.text })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "sk-reply-button", "aria-label": text(t, "reply.cancel"), disabled: snapshot.phase !== "plain", onClick: cancel, children: "\xD7" })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", children: error })
  ] });
}
function NativeSteerQueue({ Native, toolboxT, ...props }) {
  const label = text(toolboxT, "queue.rowSteer");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: `[data-queue-dock] button[aria-label="\u5F15\u5BFC"],[data-queue-dock] button[aria-label="Steer"]{display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:56px;gap:4px;padding:0 8px;font:inherit;font-size:12px}[data-queue-dock] button[aria-label="\u5F15\u5BFC"]::after,[data-queue-dock] button[aria-label="Steer"]::after{content:attr(aria-label)}` }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Native, { ...props, t: (key, ...args) => key === "queue.steer" ? label : props.t(key, ...args) })
  ] });
}
function WorkspaceSection({ state, t }) {
  const [busy, setBusy] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)("");
  const resume = async () => {
    setBusy(true);
    setError("");
    try {
      await callHost({ type: "workspace.complete" });
    } catch (reason) {
      setError(reason.message);
    } finally {
      await loadState();
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "box", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u9879\u76EE\u5206\u7EC4\u4E0E\u8DEF\u5F84 / Projects" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "muted", children: [
      state?.groups?.length ?? 0,
      " \u4E2A\u5206\u7EC4 \xB7 ",
      state?.projects?.length ?? 0,
      " \u4E2A\u9879\u76EE\u3002\u4FA7\u680F\u6309\u5206\u7EC4\u5C55\u5F00\u9879\u76EE\uFF0C\u9879\u76EE\u83DC\u5355\u53EF\u7F16\u8F91\u540D\u79F0\u3001\u8DEF\u5F84\u548C\u5206\u7EC4\u3002"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => showOverlay({ kind: "groups" }), children: text(t, "groups.manage") }) }),
    state?.workspaceMove && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { role: "status", children: [
      text(t, "project.pending"),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "mono", children: [
        state.workspaceMove.fromCwd,
        " \u2192 ",
        state.workspaceMove.toCwd
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
      state.workspaceMove.moved.length,
      " / ",
      state.workspaceMove.sessionIds.length,
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: () => void resume(), children: text(t, busy ? "common.busy" : "project.resume") })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "error", role: "alert", children: error })
  ] });
}
function GroupsDialog({ close, t }) {
  const { state } = useKit();
  const [name2, setName] = (0, import_react.useState)(""), [editing, setEditing] = (0, import_react.useState)(""), [busy, setBusy] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)("");
  const groups = state?.groups ?? [];
  const run = async (input) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await callHost(input);
      await loadState();
      setName("");
      setEditing("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Modal, { open: true, title: text(t, "groups.manage"), closeLabel: text(t, "common.close"), onClose: () => {
    if (!busy) close();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk stack sk-dialog-body", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: text(t, "groups.help") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { className: "row", onSubmit: (event) => {
      event.preventDefault();
      void run({ type: editing ? "group.rename" : "group.create", groupId: editing, title: name2 });
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "grow", "aria-label": text(t, "groups.name"), placeholder: text(t, "groups.name"), maxLength: 80, value: name2, disabled: busy, onChange: (event) => setName(event.target.value) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "submit", variant: "outline", disabled: busy || !name2.trim(), children: text(t, editing ? "common.save" : "groups.create") }),
      editing && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "button", variant: "ghost", disabled: busy, onClick: () => {
        setEditing("");
        setName("");
      }, children: text(t, "common.cancel") })
    ] }),
    groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { flex: 1 }, children: group.title }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: busy || !!state.workspaceMove, onClick: () => {
        setEditing(group.id);
        setName(group.title);
      }, children: text(t, "groups.rename") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: busy || !!state.workspaceMove, onClick: () => void run({ type: "group.delete", groupId: group.id }), children: text(t, "groups.delete") })
    ] }, group.id)),
    !state ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", children: text(t, "common.loading") }) : state.projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "box", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: project.title }),
        " \xB7 ",
        project.sessions,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted mono", children: project.path })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { "aria-label": `${project.title} \u2014 ${text(t, "groups.title")}`, disabled: busy || !!state.workspaceMove, value: groups.find((group) => group.workspaceIds.includes(project.id))?.id ?? "", onChange: (event) => void run({ type: "group.assign", workspaceId: project.id, groupId: event.target.value }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: text(t, "groups.none") }),
          groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: group.id, children: group.title }, group.id))
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy || !!state.workspaceMove, onClick: () => showOverlay({ kind: "workspace", workspaceId: project.id }), children: text(t, "project.edit") })
      ] })
    ] }, project.id)),
    state?.workspaceMove && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WorkspaceSection, { state, t }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", className: "error", children: error })
  ] }) });
}
function MoveGroupDialog({ workspaceId, close, t }) {
  const { state } = useKit();
  const [busy, setBusy] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)("");
  const assign = async (groupId) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await callHost({ type: "group.assign", workspaceId, groupId });
      await loadState();
      close();
    } catch (reason) {
      setError(reason.message);
      setBusy(false);
    }
  };
  const selected = state?.groups?.find((group) => group.workspaceIds.includes(workspaceId))?.id ?? "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Modal, { open: true, title: text(t, "groups.move"), onClose: () => {
    if (!busy) close();
  }, closeLabel: text(t, "common.close"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk stack", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: state?.projects?.find((project) => project.id === workspaceId)?.title }),
    [...state?.groups ?? [], { id: "", title: text(t, "groups.none") }].map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy || !state || !!state.workspaceMove, "aria-pressed": selected === group.id, onClick: () => void assign(group.id), children: [
      selected === group.id ? "\u2713 " : "",
      group.title
    ] }, group.id)),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: busy, onClick: () => showOverlay({ kind: "groups" }), children: text(t, "groups.create") }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", className: "error", children: error })
  ] }) });
}
function WorkspaceDialog({ workspaceId, close, t }) {
  const { state } = useKit();
  const project = state?.projects?.find((row) => row.id === workspaceId);
  const [title, setTitle] = (0, import_react.useState)(project?.title ?? ""), [path, setPath] = (0, import_react.useState)(project?.path ?? "");
  const [busy, setBusy] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)("");
  const initializedProject = (0, import_react.useRef)(project?.id);
  (0, import_react.useEffect)(() => {
    if (project && initializedProject.current !== project.id) {
      initializedProject.current = project.id;
      setTitle(project.title);
      setPath(project.path);
    }
  }, [project]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await callHost({ type: "workspace.edit", workspaceId, title, path });
      await loadState();
      close();
    } catch (reason) {
      setError(reason.message);
      await loadState();
      setBusy(false);
    }
  };
  const browse = async () => {
    try {
      const picked = await directoryPicker?.pick?.();
      if (picked?.ok && typeof picked.value === "string") setPath(picked.value);
    } catch (reason) {
      setError(reason.message);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Modal, { open: true, title: text(t, "project.edit"), closeLabel: text(t, "common.close"), onClose: () => {
    if (!busy) close();
  }, footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: close, children: text(t, "common.cancel") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy || !project || !title.trim() || !path.trim(), onClick: () => void submit(), children: text(t, busy ? "common.busy" : "common.save") })
  ] }), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sk stack", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: styles }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "stack", children: [
      text(t, "groups.title"),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { "aria-label": text(t, "groups.title"), disabled: busy || !!state?.workspaceMove, value: state?.groups?.find((group) => group.workspaceIds.includes(workspaceId))?.id ?? "", onChange: async (event) => {
        setBusy(true);
        setError("");
        try {
          await callHost({ type: "group.assign", workspaceId, groupId: event.target.value });
          await loadState();
        } catch (reason) {
          setError(reason.message);
        } finally {
          setBusy(false);
        }
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: text(t, "groups.none") }),
        state?.groups?.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: group.id, children: group.title }, group.id))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: text(t, "project.groupHelp") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: busy, onClick: () => showOverlay({ kind: "groups" }), children: text(t, "groups.manage") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "stack", children: [
      text(t, "project.title"),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: title, maxLength: 80, disabled: busy, onChange: (event) => setTitle(event.target.value) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "stack", children: [
      text(t, "project.path"),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "mono", value: path, disabled: busy, onChange: (event) => setPath(event.target.value) })
    ] }),
    directoryPicker?.pick && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled: busy, onClick: () => void browse(), children: text(t, "project.browse") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "muted", children: text(t, "project.help") }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "error", role: "alert", children: error }),
    state?.workspaceMove && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WorkspaceSection, { state, t })
  ] }) });
}
function SteerQueueButton({ useSession, useProjection, updateQueue, phase, readOnly, t }) {
  const inbox = useProjection("inbox");
  const running = useSession((state) => state.running);
  const mutable = useSession((state) => state.subagent === null || state.subagent?.address?.mode === "continuable");
  const submissions = useSession((state) => state.pendingSubmissions ?? []);
  const inChat = new Set(submissions.filter((row) => row.placement === "transcript").map((row) => row.requestId));
  const queue = (inbox?.["next-turn"] ?? []).filter((row) => row.source?.kind !== "user" || !inChat.has(row.source.rpcId));
  const [busy, setBusy] = (0, import_react.useState)(false), [error, setError] = (0, import_react.useState)("");
  const sending = (0, import_react.useRef)(false);
  if (!queue.length) return null;
  const disabled = busy || !running || !mutable || readOnly === true || phase !== void 0 && phase !== "ready" || typeof updateQueue !== "function";
  const steer = async () => {
    if (disabled || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await updateQueue(queue[0].id, { kind: "steer" });
    } catch (reason) {
      setError(reason.message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_dsh_client_ui_primitives.Button, { variant: "outline", disabled, title: text(t, "queue.help"), onClick: steer, children: [
      text(t, busy ? "common.busy" : "queue.steer"),
      " (",
      queue.length,
      ")"
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "alert", children: error })
  ] });
}
return module.exports; } });
//# sourceMappingURL=client.js.map
