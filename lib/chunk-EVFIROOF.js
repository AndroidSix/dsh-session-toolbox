// src/store.mjs
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";
var DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  draftVault: { enabled: true, maxSizeBytes: 200 * 1024 * 1024, ttlDays: 7 },
  trash: { ttlDays: 30, autoPurge: false },
  move: { enabled: true },
  nextTasks: { enabled: true }
});
var OWNED = { mode: 384, dirMode: 448 };
function mergeSettings(raw) {
  return {
    version: 1,
    draftVault: { ...DEFAULT_SETTINGS.draftVault, ...raw.draftVault ?? {} },
    trash: { ...DEFAULT_SETTINGS.trash, ...raw.trash ?? {} },
    move: { ...DEFAULT_SETTINGS.move, ...raw.move ?? {} },
    nextTasks: { ...DEFAULT_SETTINGS.nextTasks, ...raw.nextTasks ?? {} }
  };
}
var positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
var JsonDocument = class {
  file;
  #fallback;
  #guard;
  constructor(root, name, fallback, guard) {
    this.file = join(root, name);
    this.#fallback = fallback;
    this.#guard = guard;
  }
  async read() {
    let value;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") value = structuredClone(this.#fallback);
      else if (error instanceof SyntaxError) throw new Error(`session-toolbox: corrupt JSON in ${this.file}: ${error.message}`, { cause: error });
      else throw error;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`session-toolbox: ${this.file} is not a JSON object`);
    return this.#guard === void 0 ? value : this.#guard(value, this.file);
  }
  async write(value) {
    this.#guard?.(value, this.file);
    await mkdir(dirname(this.file), { recursive: true, mode: 448 });
    await withFileLock(this.file, () => writeFileAtomic(this.file, JSON.stringify(value, null, 2), OWNED));
    return value;
  }
  /** Serialized read-modify-write; `fn` returning undefined aborts without writing. */
  async update(fn) {
    await mkdir(dirname(this.file), { recursive: true, mode: 448 });
    return withFileLock(this.file, async () => {
      const current = await this.read();
      const next = fn(current);
      if (next === void 0) return current;
      this.#guard?.(next, this.file);
      await writeFileAtomic(this.file, JSON.stringify(next, null, 2), OWNED);
      return next;
    });
  }
};
function guardSettings(value, file) {
  if (value.version !== void 0 && value.version !== 1) throw new Error(`session-toolbox: unsupported settings version in ${file}: ${String(value.version)}`);
  if (value.move?.enabled !== void 0 && typeof value.move.enabled !== "boolean") throw new Error(`session-toolbox: settings.move.enabled must be boolean (${file})`);
  if (value.nextTasks?.enabled !== void 0 && typeof value.nextTasks.enabled !== "boolean") throw new Error(`session-toolbox: settings.nextTasks.enabled must be boolean (${file})`);
  const draft = value.draftVault ?? {};
  if (draft.enabled !== void 0 && typeof draft.enabled !== "boolean") throw new Error(`session-toolbox: settings.draftVault.enabled must be boolean (${file})`);
  if (draft.maxSizeBytes !== void 0 && !positiveInt(draft.maxSizeBytes)) throw new Error(`session-toolbox: settings.draftVault.maxSizeBytes must be a positive safe integer (${file})`);
  if (draft.ttlDays !== void 0 && !positiveInt(draft.ttlDays)) throw new Error(`session-toolbox: settings.draftVault.ttlDays must be a positive integer (${file})`);
  const trash = value.trash ?? {};
  if (trash.ttlDays !== void 0 && !positiveInt(trash.ttlDays)) throw new Error(`session-toolbox: settings.trash.ttlDays must be a positive integer (${file})`);
  if (trash.autoPurge !== void 0 && typeof trash.autoPurge !== "boolean") throw new Error(`session-toolbox: settings.trash.autoPurge must be boolean (${file})`);
  return mergeSettings(value);
}
function guardJournal(value, file) {
  if (value.version !== 1) throw new Error(`session-toolbox: unsupported journal version in ${file}: ${String(value.version)}`);
  const entry = value.active;
  if (entry === null || entry === void 0) return value;
  if (typeof entry.sessionId !== "string" || typeof entry.fromCwd !== "string" && entry.fromCwd !== null || typeof entry.toCwd !== "string") {
    throw new Error(`session-toolbox: malformed move journal (${file})`);
  }
  if (!Array.isArray(entry.done) || typeof entry.startedAt !== "string") throw new Error(`session-toolbox: move journal lacks done/startedAt (${file})`);
  return value;
}
function guardLedger(value, file) {
  if (value.version !== 1) throw new Error(`session-toolbox: unsupported ledger version in ${file}: ${String(value.version)}`);
  if (!Array.isArray(value.items)) throw new Error(`session-toolbox: trash ledger has no items array (${file})`);
  for (const item of value.items) {
    if (item.kind !== "session" && item.kind !== "workspace" || typeof item.id !== "string") throw new Error(`session-toolbox: malformed trash item (${file})`);
    if (item.snapshot === null || typeof item.snapshot !== "object") throw new Error(`session-toolbox: trash item lacks snapshot (${file})`);
  }
  return value;
}
function guardManifest(value, file) {
  if (value.version !== 1) throw new Error(`session-toolbox: unsupported vault manifest version in ${file}: ${String(value.version)}`);
  if (!Array.isArray(value.records)) throw new Error(`session-toolbox: vault manifest has no records array (${file})`);
  for (const record of value.records) {
    if (typeof record.sessionId !== "string" || typeof record.attachmentId !== "string") throw new Error(`session-toolbox: malformed vault record (${file})`);
  }
  return value;
}

// src/move.mjs
import { createHash } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { cp, mkdir as mkdir2, open, readFile as readFile2, readdir as readdir2, realpath, rename, rm, stat as stat2, utimes, writeFile } from "node:fs/promises";
import { dirname as dirname2, join as join3 } from "node:path";

// src/paths.mjs
import { readdir, stat } from "node:fs/promises";
import { join as join2 } from "node:path";
var NO_CWD_DIR = "_no-cwd";
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function projectDir(root, cwd) {
  return cwd === void 0 ? join2(root, NO_CWD_DIR) : join2(root, projectKey(cwd));
}
function sessionDir(root, cwd, id) {
  return join2(projectDir(root, cwd), encodeSegment(id));
}
var LOG_BASENAMES = [
  "session.jsonl",
  "session.v1.jsonl",
  "session.v2.jsonl",
  "session.v3.jsonl",
  "session.v4.jsonl",
  "session.jsonl.zstd",
  "session.v1.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v4.jsonl.zstd"
];
async function findLogFile(dir) {
  const entries = await readdir(dir);
  const present = LOG_BASENAMES.filter((name) => entries.includes(name));
  if (present.length === 0) return void 0;
  const zstd = present.filter((name) => name.endsWith(".zstd"));
  const pool = zstd.length > 0 ? zstd : present;
  return pool.sort((left, right) => right.length - left.length || right.localeCompare(left))[0];
}
function verifyEncoders(samples, root) {
  if (samples.length === 0) return false;
  return samples.every(({ cwd, id, project, dir }) => join2(root, project, dir) === sessionDir(root, cwd, id) && join2(root, project) === projectDir(root, cwd));
}

// src/session-log.mjs
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
var ZSTD_MAGIC = 4247762216;
var SKIPPABLE_MAGIC_MIN = 407710288;
var SKIPPABLE_MAGIC_MAX = 407710303;
var CHECKSUM = { [constants.ZSTD_c_checksumFlag]: 1 };
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) throw new Error(`truncated zstd artifact: fewer than 4 bytes at ${offset}`);
    const magic = buffer.readUInt32LE(offset);
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      if (offset > buffer.length) throw new Error(`truncated skippable frame at ${start}`);
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) throw new Error(`frame header missing at byte ${start}`);
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remaining) throw new Error(`truncated frame header at byte ${start}`);
    offset += remaining;
    for (; ; ) {
      if (buffer.length - offset < 3) throw new Error(`truncated block header at byte ${offset}`);
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) throw new Error(`truncated block payload at byte ${offset}`);
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`truncated frame checksum at byte ${offset}`);
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function decodeFrame(buffer, frame) {
  return zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}
function readHeader(buffer) {
  const frames = scanFrames(buffer);
  if (frames.length === 0) throw new Error("empty zstd artifact");
  const text = decodeFrame(buffer, frames[0]).toString("utf8").trim();
  const header = JSON.parse(text);
  if (header.type !== "session" || typeof header.id !== "string") throw new Error("malformed session header frame");
  return { header, frames };
}
function rewriteHeaderFrame(buffer, nextCwd) {
  const { header, frames } = readHeader(buffer);
  const updated = { ...header };
  if (nextCwd === void 0) delete updated.cwd;
  else updated.cwd = nextCwd;
  if (JSON.stringify(updated) === JSON.stringify(header)) return Buffer.from(buffer);
  const frame0 = zstdCompressSync(Buffer.from(`${JSON.stringify(updated)}
`, "utf8"), { params: CHECKSUM });
  scanFrames(frame0);
  return Buffer.concat([frame0, buffer.subarray(frames[0].end)]);
}

// src/move.mjs
var PHASES = ["backup", "rewrite", "commit", "ledger", "projcache", "index"];
var MovePreflightError = class extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MovePreflightError";
    this.code = code;
    this.details = details;
  }
};
var sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
async function fsyncFile(path) {
  const handle = await open(path, constants2.O_WRONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeOwned(file, data, mode = 384) {
  await mkdir2(dirname2(file), { recursive: true, mode: 448 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode, flag: "wx" });
  await rename(temp, file);
  return file;
}
async function relocate(source, target) {
  await mkdir2(dirname2(target), { recursive: true, mode: 448 });
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  await rm(source, { recursive: true, force: true });
}
var MoveEngine = class {
  constructor(deps) {
    this.root = deps.root;
    this.sessionsRoot = deps.sessionsRoot;
    this.projcacheRoot = deps.projcacheRoot;
    this.journal = deps.journal;
    this.caps = deps.capabilities ?? {};
    this.now = deps.now ?? (() => Date.now());
  }
  async readJournal() {
    return (await this.journal.read()).active ?? null;
  }
  async writeJournal(entry) {
    await this.journal.write({ version: 1, active: entry });
  }
  /** List every journaled placement hazard for status surfaces. */
  async recoverable() {
    return await this.readJournal() !== null;
  }
  /**
   * Fail-closed feasibility check (§10 MR1). Returns the plan or throws
   * MovePreflightError with a stable code; never touches anything.
   */
  async preflight({ sessionId, toCwd, createTarget = false }) {
    if (typeof sessionId !== "string" || !sessionId.startsWith("session-")) throw new MovePreflightError("bad-request", "sessionId must look like session-<uuid>");
    if (typeof toCwd !== "string" || !toCwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(toCwd)) throw new MovePreflightError("bad-request", "toCwd must be an absolute path");
    if (await this.readJournal() !== null) throw new MovePreflightError("journal-active", "another move is journaled; complete or roll it back first");
    if (await this.caps.sessionLive?.(sessionId)) throw new MovePreflightError("session-busy", `session ${sessionId} is live; stop its work before moving`);
    if (this.caps.sessionLoaded?.(sessionId) && !this.caps.sessionMaintenance) throw new MovePreflightError("session-loaded", "\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u5728\u7EBF\u91CA\u653E\u8BE5\u4F1A\u8BDD\uFF0C\u8BF7\u5173\u95ED DSH \u540E\u4F7F\u7528 CLI \u8FC1\u79FB\u3002");
    const headers = await this.caps.listHeaders();
    const header = headers.find((row) => row.id === sessionId);
    if (header === void 0) throw new MovePreflightError("session-unknown", `no stored session ${sessionId}`);
    if (typeof header.version === "number" && header.version < 4) throw new MovePreflightError("format-legacy", `stored log is format v${header.version}; open the session once in DSH so the host migrates it, then retry`);
    const encoded = encodeSegment(sessionId);
    const entries = await readdir2(this.sessionsRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const projects = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    const found = [];
    for (const project of projects) {
      try {
        if ((await stat2(join3(this.sessionsRoot, project, encoded))).isDirectory()) found.push(project);
      } catch {
      }
    }
    if (found.length > 1) throw new MovePreflightError("duplicate-artifact", `session ${sessionId} lives in ${found.length} project directories; refusing to guess`);
    if (found.length === 0) throw new MovePreflightError("artifact-missing", `session ${sessionId} has no session directory under any project`);
    const fromProject = found[0];
    const logName = await findLogFile(join3(this.sessionsRoot, fromProject, encoded));
    if (logName === void 0) throw new MovePreflightError("artifact-missing", `session directory for ${sessionId} holds no session log`);
    const logPath = join3(this.sessionsRoot, fromProject, encoded, logName);
    const logStat = await stat2(logPath);
    if (!this.caps.sessionMaintenance && this.now() - logStat.mtimeMs < 1e4) throw new MovePreflightError("session-churning", `session log was written ${Math.round((this.now() - logStat.mtimeMs) / 1e3)}s ago; make sure DSH has stopped using it, then retry`);
    if (header.cwd !== void 0 && fromProject !== projectKey(header.cwd)) {
      throw new MovePreflightError("unknown-layout", `cwd '${header.cwd}' should live at '${projectKey(header.cwd)}' but the artifact was observed at '${fromProject}'`);
    }
    const fromCwd = header.cwd;
    let canonicalTo;
    try {
      canonicalTo = await realpath(toCwd.replace(/[/\\]+$/, "") || toCwd);
    } catch {
      canonicalTo = void 0;
    }
    if (canonicalTo === void 0) {
      if (!createTarget) throw new MovePreflightError("target-missing", `target directory ${toCwd} does not exist (choose create to make it)`);
      await mkdir2(toCwd, { recursive: true });
      canonicalTo = await realpath(toCwd);
    }
    if (fromCwd !== void 0 && canonicalTo === fromCwd) throw new MovePreflightError("same-target", "the session already belongs to that project");
    const samples = headers.filter((row) => row.cwd !== void 0).slice(0, 5).map((row) => ({ cwd: row.cwd, id: row.id, project: projectKey(row.cwd), dir: encodeSegment(row.id) }));
    if (samples.length > 0 && !verifyEncoders(samples, this.sessionsRoot)) {
      throw new MovePreflightError("unknown-layout", "project-key / segment encoders disagree with the shipped layout; refusing to write");
    }
    return {
      sessionId,
      fromCwd: fromCwd ?? null,
      toCwd: canonicalTo,
      fromProject,
      toProject: projectKey(canonicalTo),
      dir: join3(this.sessionsRoot, fromProject, encoded),
      newDir: join3(this.sessionsRoot, projectKey(canonicalTo), encoded),
      logName,
      startedAt: new Date(this.now()).toISOString()
    };
  }
  async #stage(entry, phase) {
    if (!entry.done.includes(phase)) {
      entry.done = [...entry.done, phase];
      await this.writeJournal(entry);
    }
  }
  /** Execute the whole move; on failure the journal survives for rollback/complete. */
  async move(plan) {
    const operation = async (lease) => this.#move(await this.preflight({ sessionId: plan.sessionId, toCwd: plan.toCwd }), lease);
    return this.caps.sessionMaintenance ? this.caps.sessionMaintenance(plan.sessionId, operation) : operation();
  }
  async #move(plan, lease) {
    const entry = {
      ...plan,
      done: [],
      deferredLedger: false,
      backup: join3(this.root, "backups", `${plan.sessionId}.orig`),
      stagedNew: join3(this.root, "backups", `${plan.sessionId}.new`),
      retired: join3(this.root, "pending-purge", `${plan.sessionId}__${this.now()}`)
    };
    await this.writeJournal(entry);
    try {
      await this.phaseBackup(entry);
      await this.phaseRewrite(entry);
      await this.phaseCommit(entry, lease);
      await this.phaseLedger(entry);
      await this.phaseProjcache(entry);
      await this.phaseIndex(entry);
    } catch (error) {
      error.journal = await this.readJournal();
      if (error.journal !== null && (error.journal.done?.includes("commit") || await stat2(entry.retired).then(() => true, () => false))) {
        try {
          await this.#rollback(await this.readJournal(), lease);
          error.rolledBack = true;
        } catch (rollbackError) {
          error.rollbackError = rollbackError.message;
        }
      }
      throw error;
    }
    if (entry.deferredLedger === true) {
      await this.writeJournal(entry);
      return {
        ok: true,
        deferred: true,
        sessionId: entry.sessionId,
        toCwd: entry.toCwd,
        note: "\u6587\u4EF6\u5DF2\u8FC1\u79FB\uFF0C\u4F46\u9879\u76EE\u8D26\u672C\u5C1A\u672A\u5B8C\u6210\uFF1B\u8BF7\u5728\u6062\u590D\u533A\u70B9\u5B8C\u6210\uFF0C\u6216\u9009\u62E9\u56DE\u6EDA"
      };
    }
    await this.#finish(entry);
    return { ok: true, sessionId: entry.sessionId, toCwd: entry.toCwd, deferredLedger: entry.deferredLedger === true };
  }
  async #finish(entry) {
    await this.writeJournal(null);
    await rm(entry.backup, { force: true });
    await rm(entry.stagedNew, { force: true });
    if (entry.retired !== void 0) await rm(entry.retired, { recursive: true, force: true });
  }
  async phaseBackup(entry) {
    const source = await readFile2(join3(entry.dir, entry.logName));
    await writeOwned(entry.backup, source);
    entry.sourceHash = sha256(source);
    await this.#stage(entry, "backup");
  }
  async phaseRewrite(entry) {
    const source = await readFile2(entry.backup);
    if (sha256(source) !== entry.sourceHash) throw new MovePreflightError("source-changed", "the session log changed between backup and rewrite");
    const current = readHeader(source);
    if (current.header.id !== entry.sessionId) throw new MovePreflightError("artifact-mismatch", `log header id '${current.header.id}' does not name ${entry.sessionId}`);
    const rewritten = rewriteHeaderFrame(source, entry.toCwd);
    readHeader(rewritten);
    if (sha256(rewritten) === entry.sourceHash) throw new MovePreflightError("rewrite-noop", "header rewrite produced identical bytes");
    await writeOwned(entry.stagedNew, rewritten);
    await fsyncFile(entry.stagedNew);
    await this.#stage(entry, "rewrite");
  }
  async phaseCommit(entry, lease) {
    if (this.caps.sessionLoaded?.(entry.sessionId) || await this.caps.sessionLive?.(entry.sessionId)) throw new MovePreflightError("session-busy", "\u4F1A\u8BDD\u5DF2\u88AB\u52A0\u8F7D\u6216\u5F00\u59CB\u8FD0\u884C\uFF0C\u8BF7\u505C\u6B62\u4F7F\u7528\u540E\u91CD\u8BD5");
    if (!await stat2(entry.retired).then(() => true, () => false)) {
      if (sha256(await readFile2(join3(entry.dir, entry.logName))) !== entry.sourceHash) throw new MovePreflightError("source-changed", "\u4F1A\u8BDD\u65E5\u5FD7\u5728\u5907\u4EFD\u540E\u53D1\u751F\u53D8\u5316\uFF0C\u8FC1\u79FB\u5DF2\u505C\u6B62");
      await relocate(entry.dir, entry.retired);
    }
    await mkdir2(entry.newDir, { recursive: true, mode: 448 });
    await lease?.protectDirectory(entry.newDir);
    await writeOwned(join3(entry.newDir, entry.logName), await readFile2(entry.stagedNew));
    await fsyncFile(join3(entry.newDir, entry.logName));
    const sourceStat = await stat2(join3(entry.retired, entry.logName));
    await utimes(join3(entry.newDir, entry.logName), sourceStat.atime, sourceStat.mtime);
    for (const name of await readdir2(entry.retired)) {
      if (name === entry.logName || name === "session.lock") continue;
      await cp(join3(entry.retired, name), join3(entry.newDir, name), { recursive: true });
    }
    if (!lease?.protectDirectory) await rm(join3(entry.newDir, "session.lock"), { force: true });
    await this.#stage(entry, "commit");
  }
  async phaseLedger(entry) {
    const published = join3(entry.newDir, entry.logName);
    let landed = false;
    try {
      const { header } = readHeader(await readFile2(published));
      landed = header.cwd === entry.toCwd;
    } catch {
      landed = false;
    }
    if (!landed) throw new MovePreflightError("publish-missing", `migrated log not found at ${published}; refusing to touch the ledger`);
    if (this.caps.moveLedger === void 0) {
      entry.deferredLedger = true;
      await this.#stage(entry, "ledger");
      return;
    }
    try {
      await this.caps.refreshHeaderCache?.();
      await this.caps.moveLedger(entry.sessionId, entry.fromCwd ?? void 0, entry.toCwd);
      entry.deferredLedger = false;
    } catch (error) {
      entry.deferredLedger = true;
      entry.ledgerError = String(error?.message ?? error);
    }
    await this.#stage(entry, "ledger");
  }
  async phaseProjcache(entry) {
    if (this.projcacheRoot !== void 0) await rm(join3(this.projcacheRoot, `${entry.sessionId}.json`), { force: true });
    await this.#stage(entry, "projcache");
  }
  async phaseIndex(entry) {
    await this.caps.resyncIndex?.();
    await this.caps.refreshPlacement?.(entry.sessionId)?.catch?.(() => {
    });
    await this.#stage(entry, "index");
  }
  /** Undo completed phases in reverse (§10 MR3). */
  async rollback() {
    const entry = await this.readJournal();
    if (entry === null) throw new MovePreflightError("no-journal", "no journaled move to roll back");
    const operation = (lease) => this.#rollback(entry, lease);
    return this.caps.sessionMaintenance ? this.caps.sessionMaintenance(entry.sessionId, operation, { retired: entry.retired }) : operation();
  }
  async #rollback(entry, lease) {
    if (this.caps.sessionLoaded?.(entry.sessionId) || await this.caps.sessionLive?.(entry.sessionId)) throw new MovePreflightError("session-busy", "\u4F1A\u8BDD\u5DF2\u88AB\u52A0\u8F7D\u6216\u5F00\u59CB\u8FD0\u884C\uFF0C\u8BF7\u5B8C\u5168\u9000\u51FA DSH \u540E\u6062\u590D\u8FC1\u79FB");
    const retiredExists = entry.retired !== void 0 && await stat2(entry.retired).then(() => true, () => false);
    if (entry.done.includes("commit") || retiredExists) {
      if (!retiredExists && sha256(await readFile2(join3(entry.dir, entry.logName))) !== entry.sourceHash) throw new MovePreflightError("journal-order", "committed journal lost its retired directory");
      await rm(entry.newDir, { recursive: true, force: true });
      await mkdir2(dirname2(entry.dir), { recursive: true, mode: 448 });
      if (retiredExists) await relocate(entry.retired, entry.dir);
    }
    if (entry.done.includes("ledger") && this.caps.moveLedger !== void 0) {
      await this.caps.refreshHeaderCache?.();
      await this.caps.moveLedger(entry.sessionId, entry.toCwd, entry.fromCwd ?? void 0);
      await this.caps.refreshHeaderCache?.().catch(() => {
      });
    }
    if (this.projcacheRoot !== void 0) await rm(join3(this.projcacheRoot, `${entry.sessionId}.json`), { force: true });
    await this.caps.resyncIndex?.().catch(() => {
    });
    await this.caps.refreshPlacement?.(entry.sessionId)?.catch?.(() => {
    });
    await this.#finish({ ...entry, retired: entry.done.includes("commit") ? void 0 : entry.retired });
    return { ok: true, rolledBack: entry.done };
  }
  /** Resume a journaled move from its first missing phase (post-crash forward roll). */
  async complete() {
    const entry = await this.readJournal();
    if (entry === null) throw new MovePreflightError("no-journal", "no journaled move to complete");
    const operation = (lease) => this.#complete(entry, lease);
    return this.caps.sessionMaintenance ? this.caps.sessionMaintenance(entry.sessionId, operation, { retired: entry.retired }) : operation();
  }
  async #complete(entry, lease) {
    if (this.caps.sessionLoaded?.(entry.sessionId) || await this.caps.sessionLive?.(entry.sessionId)) throw new MovePreflightError("session-busy", "\u4F1A\u8BDD\u5DF2\u88AB\u52A0\u8F7D\u6216\u5F00\u59CB\u8FD0\u884C\uFF0C\u8BF7\u5B8C\u5168\u9000\u51FA DSH \u540E\u6062\u590D\u8FC1\u79FB");
    const runs = {
      backup: (e) => this.phaseBackup(e),
      rewrite: (e) => this.phaseRewrite(e),
      commit: (e) => this.phaseCommit(e, lease),
      ledger: (e) => this.phaseLedger(e),
      projcache: (e) => this.phaseProjcache(e),
      index: (e) => this.phaseIndex(e)
    };
    for (const phase of PHASES) {
      if (entry.done.includes(phase)) {
        if (phase === "ledger" && entry.deferredLedger === true) await runs.ledger(entry);
        continue;
      }
      if (phase !== "backup" && !entry.done.includes("backup")) throw new MovePreflightError("journal-order", `journal skipped '${phase}' before completing 'backup'`);
      await runs[phase](entry);
    }
    if (entry.deferredLedger === true) {
      await this.writeJournal(entry);
      return {
        ok: true,
        deferred: true,
        sessionId: entry.sessionId,
        toCwd: entry.toCwd,
        ledgerError: entry.ledgerError,
        note: "\u6587\u4EF6\u5DF2\u8FC1\u79FB\u4F46 DSH \u8D26\u672C\u4ECD\u672A\u6536\u655B\uFF1B\u91CD\u542F DSH \u540E\u518D\u6B21\u70B9\u5B8C\u6210\uFF0C\u6216\u9009\u62E9\u56DE\u6EDA"
      };
    }
    await this.#finish(entry);
    return { ok: true, sessionId: entry.sessionId, toCwd: entry.toCwd };
  }
};

// src/trash.mjs
import { readdir as readdir3, rm as rm2, stat as stat3 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { randomUUID } from "node:crypto";
var TrashError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "TrashError";
    this.code = code;
  }
};
var DAY = 24 * 60 * 60 * 1e3;
var TrashEngine = class {
  /**
   * @param deps - {adapter: RegistryAdapter, sessions?: () => liveSessionIds,
   *   sessionsRoot, projcacheRoot, kitRoot, ledger: JsonDocument, vault?,
   *   journal?: () => activeJournalEntry|null, settings?: () => trashSettings, now}
   */
  constructor(deps) {
    this.deps = deps;
    this.ledger = deps.ledger;
    this.now = deps.now ?? (() => Date.now());
  }
  async items() {
    const state = await this.ledger.read();
    return [...state.items, ...await this.#nativeItems(state)].map(publicItem);
  }
  /** Read native archives without enrolling them in the plugin's TTL policy. */
  async #nativeItems(state) {
    const covered = new Set(state.items.flatMap((item) => item.kind === "session" ? [item.id2] : item.snapshot.sessions.map((row) => row.sessionId)));
    const items = [];
    for (const sessionId of await this.deps.adapter.archivedSet()) {
      if (covered.has(sessionId)) continue;
      const location = await this.deps.adapter.locateSession(sessionId);
      items.push({
        id: `native:${sessionId}`,
        kind: "session",
        id2: sessionId,
        source: "native",
        trashedAt: null,
        snapshot: {
          sessionId,
          workspaceId: location.workspaceId ?? null,
          beforeId: location.beforeId ?? null,
          title: location.title ?? null,
          previouslyArchived: false,
          previouslyPinned: false
        }
      });
    }
    return items;
  }
  async #item(state, itemId) {
    return this.#find(state, (row) => row.id === itemId) ?? (await this.#nativeItems(state)).find((row) => row.id === itemId);
  }
  async #guardJournal() {
    if (typeof this.deps.journal === "function" && await this.deps.journal() !== null) {
      throw new TrashError("journal-active", "a journaled move is unresolved; finish or roll it back first");
    }
  }
  async #guardFree(id, { force = false, purge = false } = {}) {
    await this.#guardJournal();
    const live = await this.deps.sessions?.() ?? [];
    if (!force && live.includes(id)) throw new TrashError("session-busy", `session ${id} is active; stop its work first`);
    if (purge && this.deps.loaded?.(id)) throw new TrashError("session-loaded", "\u4F1A\u8BDD\u4ECD\u7531 DSH \u6301\u6709\u3002\u8BF7\u5B8C\u5168\u91CD\u542F\u540E\uFF0C\u4E0D\u6253\u5F00\u8BE5\u4F1A\u8BDD\u518D\u5F7B\u5E95\u5220\u9664\uFF0C\u6216\u9000\u51FA DSH \u540E\u4F7F\u7528 CLI\u3002");
  }
  #find(state, predicate) {
    return state.items.find(predicate);
  }
  /** §11 TB3: trash one session (archive + ledger; already-archived sessions only enter the bin). */
  async trashSession(sessionId, { force = false } = {}) {
    await this.#guardFree(sessionId, { force });
    const adapter = this.deps.adapter;
    const state = await this.ledger.read();
    if (this.#find(state, (item2) => item2.kind === "session" && item2.id2 === sessionId)) throw new TrashError("already-trashed", "this session is already in the trash bin");
    if (!await adapter.sessionKnown(sessionId)) throw new TrashError("session-unknown", `session ${sessionId} is unknown to the registry`);
    const archived = await adapter.archivedSet();
    const pinned = await adapter.pinnedSet();
    const { workspaceId, beforeId, title } = await adapter.locateSession(sessionId);
    const item = {
      id: randomUUID(),
      kind: "session",
      id2: sessionId,
      trashedAt: new Date(this.now()).toISOString(),
      snapshot: {
        sessionId,
        workspaceId: workspaceId ?? null,
        beforeId: beforeId ?? null,
        previouslyArchived: archived.has(sessionId),
        previouslyPinned: pinned.has(sessionId),
        title: title ?? null
      }
    };
    state.items.push(item);
    await this.ledger.write(state);
    if (!archived.has(sessionId)) await adapter.archiveSession(sessionId, force ? { stopActivity: true } : {});
    return { ok: true, itemId: item.id };
  }
  /** §11 TB4: trash a project (archive all its sessions, snapshot order/state, delete registration). */
  async trashWorkspace(workspaceId, { force = false } = {}) {
    await this.#guardJournal();
    const adapter = this.deps.adapter;
    const state = await this.ledger.read();
    if (this.#find(state, (item2) => item2.kind === "workspace" && item2.id2 === workspaceId)) throw new TrashError("already-trashed", "this project is already in the trash bin");
    const snapshot = await adapter.workspaceSnapshot(workspaceId);
    if (snapshot === void 0) throw new TrashError("workspace-unknown", `workspace ${workspaceId} not found`);
    const live = new Set(await this.deps.sessions?.() ?? []);
    if (!force && snapshot.sessions.some((row) => live.has(row.sessionId))) throw new TrashError("workspace-busy", "the project has live sessions; use force to stop and trash them");
    const item = { id: randomUUID(), kind: "workspace", id2: workspaceId, trashedAt: new Date(this.now()).toISOString(), snapshot };
    state.items.push(item);
    await this.ledger.write(state);
    for (const row of snapshot.sessions) {
      if (row.previouslyArchived) continue;
      await adapter.archiveSession(row.sessionId, live.has(row.sessionId) ? { stopActivity: true } : {});
    }
    await adapter.deleteWorkspace(workspaceId);
    return { ok: true, itemId: item.id };
  }
  /** §11 TB5 idempotent restore: converge to the snapshot; failures propagate so the item survives for retry. */
  async restore(itemId) {
    await this.#guardJournal();
    const adapter = this.deps.adapter;
    const state = await this.ledger.read();
    const item = await this.#item(state, itemId);
    if (item === void 0) throw new TrashError("item-unknown", `no trash item ${itemId}`);
    if (item.purge) throw new TrashError("purge-in-progress", "\u5F7B\u5E95\u5220\u9664\u5DF2\u5F00\u59CB\uFF0C\u8BF7\u91CD\u8BD5\u5F7B\u5E95\u5220\u9664\u4EE5\u5B8C\u6210\u6E05\u7406");
    if (item.kind === "session") await this.#restoreSession(adapter, item.snapshot);
    else await this.#restoreWorkspace(adapter, item.snapshot);
    const affected = item.kind === "session" ? [item.snapshot.sessionId] : item.snapshot.sessions.map((row) => row.sessionId);
    for (const sessionId of affected) await adapter.refreshPlacement?.(sessionId)?.catch?.(() => {
    });
    state.items = state.items.filter((row) => row.id !== itemId);
    await this.ledger.write(state);
    return { ok: true };
  }
  async #restoreSession(adapter, snapshot) {
    const { sessionId, workspaceId, beforeId, previouslyArchived, previouslyPinned } = snapshot;
    if (!previouslyArchived) await adapter.unarchiveSession(sessionId);
    if (workspaceId !== null) await adapter.repairSlot(sessionId, workspaceId, beforeId);
    if (previouslyPinned) await adapter.pinSession(sessionId);
  }
  async #restoreWorkspace(adapter, snapshot) {
    await adapter.restoreWorkspace(snapshot);
    for (const row of snapshot.sessions) {
      if (!row.previouslyArchived) await adapter.unarchiveSession(row.sessionId);
    }
    for (const row of snapshot.sessions) {
      if (row.previouslyPinned && !row.previouslyArchived) await adapter.pinSession(row.sessionId);
    }
  }
  /** §11 TB6: hard-delete with staging so a crash never yields a half-deleted state. */
  async purge(itemId) {
    await this.#guardJournal();
    const adapter = this.deps.adapter;
    const state = await this.ledger.read();
    const item = await this.#item(state, itemId);
    if (item === void 0) throw new TrashError("item-unknown", `no trash item ${itemId}`);
    const sessionIds = item.kind === "session" ? [item.snapshot.sessionId] : item.snapshot.sessions.map((row) => row.sessionId);
    for (const sessionId of sessionIds) await this.#guardFree(sessionId, { purge: true });
    if (!item.purge) {
      if (item.source === "native") {
        item.trashedAt = new Date(this.now()).toISOString();
        state.items.push(item);
      }
      item.purge = [];
      for (const sessionId of sessionIds) {
        const encoded = encodeSegment(sessionId);
        const found = [];
        for (const project of await readdir3(this.deps.sessionsRoot).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })) {
          if (project.startsWith(".")) continue;
          const dir = join4(this.deps.sessionsRoot, project, encoded);
          if (await stat3(dir).then((s) => s.isDirectory(), (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          })) found.push(dir);
        }
        if (found.length > 1) throw new TrashError("duplicate-artifact", `session ${sessionId} has duplicate placements`);
        item.purge.push({ sessionId, source: found[0] ?? null, staged: join4(this.deps.kitRoot, "pending-purge", `${encoded}__${randomUUID()}`) });
      }
      await this.ledger.write(state);
    }
    for (const row of item.purge) {
      if (row.source !== null && await stat3(row.source).then(() => true, () => false)) await relocate(row.source, row.staged);
      if (this.deps.projcacheRoot) await rm2(join4(this.deps.projcacheRoot, `${row.sessionId}.json`), { force: true });
      await adapter.purgeSession?.(row.sessionId);
      await adapter.unpinSession(row.sessionId);
      await adapter.unarchiveSession(row.sessionId);
      await this.deps.vault?.dropSession?.(row.sessionId);
    }
    if (item.kind === "workspace") await adapter.deleteWorkspace(item.id2);
    for (const row of item.purge) await rm2(row.staged, { recursive: true, force: true });
    state.items = state.items.filter((row) => row.id !== itemId);
    await this.ledger.write(state);
    return { ok: true, purged: sessionIds };
  }
  /** TTL sweep (§11 T5). With autoPurge, expired items are hard-deleted; otherwise reported. */
  async sweep({ now = this.now() } = {}) {
    const state = await this.ledger.read();
    const settings = this.deps.settings?.() ?? {};
    const ttlDays = settings.ttlDays ?? 30;
    const auto = settings.autoPurge === true;
    const report = { expired: [], purged: [], skipped: [] };
    for (const item of state.items) {
      const trashedAt = Date.parse(item.trashedAt);
      if (!Number.isFinite(trashedAt) || now - trashedAt < ttlDays * DAY) continue;
      report.expired.push({ itemId: item.id, kind: item.kind, targetId: item.id2 });
      if (!auto) continue;
      try {
        await this.purge(item.id);
        report.purged.push(item.id);
      } catch (error) {
        report.skipped.push({ itemId: item.id, reason: String(error?.message ?? error) });
      }
    }
    return report;
  }
};
function publicItem(item) {
  return { itemId: item.id, kind: item.kind, targetId: item.id2, trashedAt: item.trashedAt, snapshot: item.snapshot, source: item.source ?? "toolbox" };
}

// src/api.mjs
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
var MAX_BODY = 4 * 1024 * 1024;
var ApiError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
};
var hostIsLoopback = (host) => {
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i.test(String(host ?? ""))) return false;
  try {
    const { hostname } = new URL(`http://${host}`);
    return hostname === "localhost" || hostname === "[::1]" || isIP(hostname) === 4 && hostname.startsWith("127.");
  } catch {
    return false;
  }
};
function apiHandler(kit) {
  const key = randomBytes(32).toString("base64url");
  return async (req, res) => {
    try {
      const remote = req.socket?.remoteAddress;
      if (!hostIsLoopback(req.headers.host) || remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) throw new ApiError(403, "\u4EC5\u5141\u8BB8\u672C\u673A\u8BF7\u6C42");
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new ApiError(403, "\u6765\u6E90\u65E0\u6548");
      if (req.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "\u6765\u6E90\u65E0\u6548");
      if (req.method === "GET") {
        json(res, 200, { ...await kit.state(), key });
        return;
      }
      if (req.method !== "POST") throw new ApiError(405, "\u65B9\u6CD5\u65E0\u6548");
      const actual = Buffer.from(String(req.headers["x-session-toolbox-key"] ?? "")), expected = Buffer.from(key);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, "\u8BF7\u5237\u65B0\u9762\u677F\u540E\u91CD\u8BD5");
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) throw new ApiError(415, "\u9700\u8981 JSON");
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new ApiError(413, "\u8BF7\u6C42\u8FC7\u5927");
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ApiError(400, "JSON \u65E0\u6548");
      }
      if (input === null || typeof input !== "object" || typeof input.type !== "string") throw new ApiError(400, "\u7F3A\u5C11\u64CD\u4F5C\u7C7B\u578B");
      json(res, 200, { ...await kit.action(input), key });
    } catch (error) {
      json(res, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : `\u64CD\u4F5C\u5931\u8D25\uFF1A${error?.message ?? error}` });
    }
  };
}
async function dispatch(kit, input) {
  if (["preflight", "move"].includes(input.type) && (await kit.settings?.read())?.move?.enabled === false) {
    throw Object.assign(new Error("\u4F1A\u8BDD\u8FC1\u79FB\u529F\u80FD\u5DF2\u505C\u7528"), { code: "feature-disabled" });
  }
  switch (input.type) {
    case "nextTasks.get":
      return kit.nextTasks.state(String(input.sessionId ?? ""));
    case "nextTasks.generate":
      return kit.nextTasks.request(String(input.sessionId ?? ""), input.seq);
    case "message.list":
      return kit.messages.list(String(input.sessionId ?? ""));
    case "message.delete": {
      const result = await kit.messages.delete(String(input.sessionId ?? ""), input.seq);
      kit.nextTasks?.invalidate(String(input.sessionId ?? ""));
      return result;
    }
    case "checkpoint.status":
      return await kit.checkpoints.status(String(input.sessionId ?? ""), input.seq);
    case "checkpoint.preview":
      return await kit.checkpoints.preview(String(input.sessionId ?? ""), input.seq);
    case "checkpoint.restore":
      return await kit.checkpoints.restore(String(input.sessionId ?? ""), input.seq, input.id);
    case "group.create":
      return await kit.workspace.createGroup(input.title);
    case "group.rename":
      return await kit.workspace.renameGroup(String(input.groupId ?? ""), input.title);
    case "group.delete":
      return await kit.workspace.deleteGroup(String(input.groupId ?? ""));
    case "group.move":
      return await kit.workspace.moveGroup(String(input.groupId ?? ""), String(input.beforeGroupId ?? ""));
    case "group.assign":
      return await kit.workspace.assignGroup(String(input.workspaceId ?? ""), String(input.groupId ?? ""));
    case "workspace.edit": {
      if ((await kit.settings?.read())?.move?.enabled === false && kit.workspace.row(input.workspaceId).path !== input.path) throw Object.assign(new Error("\u4F1A\u8BDD\u8FC1\u79FB\u529F\u80FD\u5DF2\u505C\u7528"), { code: "feature-disabled" });
      return await kit.workspace.edit({ workspaceId: String(input.workspaceId ?? ""), path: input.path, title: input.title });
    }
    case "workspace.complete":
      return await kit.workspace.complete();
    case "preflight":
      return await kit.move.preflight({ sessionId: String(input.sessionId ?? ""), toCwd: String(input.toCwd ?? ""), createTarget: input.createTarget === true });
    case "move":
      return await kit.move.move(await kit.move.preflight({ sessionId: String(input.sessionId ?? ""), toCwd: String(input.toCwd ?? ""), createTarget: input.createTarget === true }));
    case "move.rollback":
      return await kit.move.rollback();
    case "move.complete":
      return await kit.move.complete();
    case "trash.list":
      return { items: await kit.trash.items() };
    case "trash.session":
      return await kit.trash.trashSession(String(input.sessionId ?? ""), { force: input.force === true });
    case "trash.workspace":
      return await kit.trash.trashWorkspace(String(input.workspaceId ?? ""), { force: input.force === true });
    case "trash.restore":
      return await kit.trash.restore(String(input.itemId ?? ""));
    case "trash.purge":
      return await kit.trash.purge(String(input.itemId ?? ""));
    case "trash.sweep":
      return await kit.trash.sweep();
    case "project.of":
      return { project: await kit.projectOf(String(input.sessionId ?? "")) };
    case "settings.update":
      return { settings: await kit.updateSettings(input.patch ?? {}) };
    case "vault.sync":
      return { records: (await kit.vaultSync(Array.isArray(input.records) ? input.records : [])).records.length };
    case "vault.sweep": {
      const settings = await kit.settings.read();
      const ttlMs = (settings.draftVault?.ttlDays ?? 7) * 24 * 60 * 60 * 1e3;
      const manifest = await kit.manifest.update((current) => ({
        version: 1,
        records: current.records.filter((record) => Date.now() - (record.createdAt ?? 0) <= ttlMs)
      }));
      return { records: manifest.records.length };
    }
    default:
      throw new Error(`\u672A\u77E5\u7684\u64CD\u4F5C\u7C7B\u578B\uFF1A${input.type}`);
  }
}

export {
  JsonDocument,
  guardSettings,
  guardJournal,
  guardLedger,
  guardManifest,
  MoveEngine,
  TrashEngine,
  apiHandler,
  dispatch
};
//# sourceMappingURL=chunk-EVFIROOF.js.map
