#!/usr/bin/env node
"use strict";

// Native messaging host for the Authenticator browser extension.
//
// The extension cannot read arbitrary files, so this process is the bridge: it
// watches a folder (default ~/.authenticator-import/inbox), hands the newest
// Vaultwarden/Bitwarden JSON export to the extension in chunks, and remembers
// which file it already delivered.
//
// Protocol: 4-byte little-endian length prefix + UTF-8 JSON, on stdin/stdout.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BASE_DIR = process.env.AUTHENTICATOR_IMPORT_HOME
  ? path.resolve(process.env.AUTHENTICATOR_IMPORT_HOME)
  : path.join(os.homedir(), ".authenticator-import");
const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const STATE_PATH = path.join(BASE_DIR, "state.json");
const DEFAULT_DIR = path.join(BASE_DIR, "inbox");
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
// Chrome rejects host -> browser messages larger than 1 MB, so stay well below.
const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_INPUT_MESSAGE_BYTES = 1024 * 1024;
const MAX_KEPT_ACKS = 20;

function loadConfig() {
  const config = {
    dir: DEFAULT_DIR,
    pattern: "\\.json$",
    maxBytes: DEFAULT_MAX_BYTES,
    // The export contains plaintext secrets; delete it once imported.
    deleteAfterImport: true,
    // How often the extension asks for a new file.
    intervalMinutes: 5,
  };
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`configInvalid: ${error.message}`);
    }
  }
  if (process.env.AUTHENTICATOR_IMPORT_DIR) {
    config.dir = process.env.AUTHENTICATOR_IMPORT_DIR;
  }
  config.dir = path.resolve(config.dir);
  try {
    config.pattern = new RegExp(config.pattern);
  } catch (error) {
    throw new Error(`configInvalid: ${error.message}`);
  }
  config.maxBytes = Number(config.maxBytes) || DEFAULT_MAX_BYTES;
  config.intervalMinutes = clampInterval(config.intervalMinutes);
  return config;
}

function clampInterval(value) {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes < 1) {
    return 5;
  }
  return Math.min(1440, minutes);
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const OPEN_NOFOLLOW_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function saveState(state) {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, STATE_PATH);
}

function listBackups(config) {
  let names;
  try {
    names = fs.readdirSync(config.dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const name of names) {
    if (!config.pattern.test(name)) {
      continue;
    }
    const fullPath = path.join(config.dir, name);
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > config.maxBytes
    ) {
      continue;
    }
    files.push({ name, size: stat.size, mtime: stat.mtimeMs, fullPath });
  }

  files.sort((left, right) => right.mtime - left.mtime);
  return files;
}

function digestOf(fullPath) {
  const fd = fs.openSync(fullPath, OPEN_NOFOLLOW_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("invalidName");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    fs.closeSync(fd);
  }
}

// How many files a single status call may inspect. The normal case is one
// file; this only matters when a backlog built up (browser was closed).
const MAX_CANDIDATES = 10;

function importedRecord(state, name) {
  const record = (state.imported || {})[name];
  if (!record) {
    return null;
  }
  // Legacy state stored just the digest string.
  if (typeof record === "string") {
    return { digest: record, mtime: 0 };
  }
  return record;
}

/**
 * Returns the newest file that has not been imported yet, so a backlog drains
 * one file per tick instead of being blocked by the newest already-acknowledged
 * file (which happens when deleteAfterImport is off).
 */
function pendingBackup(config) {
  const files = listBackups(config);
  if (!files.length) {
    return { pending: null, fileCount: 0 };
  }
  const state = loadState();

  for (const file of files.slice(0, MAX_CANDIDATES)) {
    const record = importedRecord(state, file.name);
    if (record) {
      // Same mtime as the acknowledged copy: no need to hash it again.
      if (record.mtime && record.mtime === file.mtime) {
        continue;
      }
      if (digestOf(file.fullPath) === record.digest) {
        continue;
      }
    }
    return {
      pending: {
        name: file.name,
        size: file.size,
        mtime: file.mtime,
        digest: digestOf(file.fullPath),
      },
      fileCount: files.length,
    };
  }

  return { pending: null, fileCount: files.length };
}

function resolveBackupPath(config, name) {
  const requested = String(name || "");
  const safeName = path.basename(requested);
  if (!safeName || safeName !== requested || !config.pattern.test(safeName)) {
    throw new Error("invalidName");
  }
  const fullPath = path.join(config.dir, safeName);
  let stat;
  try {
    stat = fs.lstatSync(fullPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("backupNotFound");
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("invalidName");
  }
  if (stat.size > config.maxBytes) {
    throw new Error("backupTooLarge");
  }
  return { fullPath, safeName };
}

function readChunk(config, request) {
  const { fullPath, safeName } = resolveBackupPath(config, request.name);
  const fd = fs.openSync(fullPath, OPEN_NOFOLLOW_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("invalidName");
    }
    if (stat.size > config.maxBytes) {
      throw new Error("backupTooLarge");
    }
    const start = Math.max(
      0,
      Math.min(stat.size, Math.floor(Number(request.offset) || 0))
    );
    const wanted = Math.floor(Number(request.length) || MAX_CHUNK_BYTES);
    const length = Math.max(
      0,
      Math.min(MAX_CHUNK_BYTES, wanted, stat.size - start)
    );

    const buffer = Buffer.alloc(length);
    const bytesRead =
      length > 0 ? fs.readSync(fd, buffer, 0, length, start) : 0;

    return {
      ok: true,
      name: safeName,
      offset: start,
      total: stat.size,
      length: bytesRead,
      eof: bytesRead === 0 || start + bytesRead >= stat.size,
      data: buffer.subarray(0, bytesRead).toString("base64"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function acknowledge(config, request) {
  const { fullPath, safeName } = resolveBackupPath(config, request.name);
  const digest = String(request.digest || "");
  if (!digest.startsWith("sha256:")) {
    throw new Error("invalidDigest");
  }
  const state = loadState();
  const imported = state.imported || {};
  let currentDigest = "";
  let mtime = 0;
  try {
    const stat = fs.lstatSync(fullPath);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      mtime = stat.mtimeMs;
      currentDigest = digestOf(fullPath);
    }
  } catch {
    mtime = 0;
    currentDigest = "";
  }
  const unchanged = currentDigest === digest;

  // Newest wins: every older export is superseded by the one we just imported.
  // Only supersede against the acknowledged file's mtime if the file on disk
  // still matches the imported digest (not a newer replacement).
  const superseded = [];
  if (unchanged && mtime > 0) {
    for (const file of listBackups(config)) {
      if (file.name === safeName || file.mtime >= mtime) {
        continue;
      }
      imported[file.name] = { digest: "", mtime: file.mtime, superseded: true };
      superseded.push(file.name);
      if (config.deleteAfterImport !== false) {
        try {
          fs.unlinkSync(file.fullPath);
        } catch (error) {
          process.stderr.write(`[host] failed to delete ${file.name}: ${error}\n`);
        }
      }
    }
  }

  // Re-insert safeName last so slice(-MAX_KEPT_ACKS) never evicts the newly
  // acknowledged export when many older files remain on disk.
  delete imported[safeName];
  imported[safeName] = { digest, mtime: unchanged ? mtime : 0 };

  const entries = Object.entries(imported).slice(-MAX_KEPT_ACKS);
  state.imported = Object.fromEntries(entries);
  state.lastImported = { name: safeName, digest, at: Date.now() };
  saveState(state);

  // The export holds plaintext TOTP secrets, so it should not stay on disk.
  // Only delete when the file still contains exactly what was imported: if the
  // user replaced it meanwhile, leave it alone so the next tick picks it up.
  let deleted = false;
  if (unchanged && config.deleteAfterImport !== false) {
    try {
      if (digestOf(fullPath) === digest) {
        fs.unlinkSync(fullPath);
        deleted = true;
      }
    } catch (error) {
      process.stderr.write(`[host] failed to delete ${safeName}: ${error}\n`);
    }
  }

  return {
    ok: true,
    name: safeName,
    deleted,
    superseded,
    imported: Object.keys(state.imported),
  };
}

function handle(request) {
  const config = loadConfig();
  switch (request && request.type) {
    case "status": {
      const { pending, fileCount } = pendingBackup(config);
      const state = loadState();
      return {
        ok: true,
        dir: config.dir,
        dirExists: fs.existsSync(config.dir),
        maxBytes: config.maxBytes,
        // Send the raw source (`\\.json$`), not String(regexp) which adds
        // slashes the UI would have to strip again.
        pattern: config.pattern.source,
        deleteAfterImport: config.deleteAfterImport !== false,
        intervalMinutes: config.intervalMinutes,
        fileCount,
        pending,
        importedCount: Object.keys(state.imported || {}).length,
        lastImported: state.lastImported || null,
      };
    }
    case "read":
      return readChunk(config, request);
    case "ack":
      return acknowledge(config, request);
    case "ping":
      return { ok: true, dir: config.dir };
    default:
      throw new Error("unknownRequest");
  }
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(request, result) {
  const id = request && typeof request.id === "number" ? request.id : null;
  writeMessage(Object.assign({ id }, result));
}

let buffered = Buffer.alloc(0);

function drain() {
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (length > MAX_INPUT_MESSAGE_BYTES) {
      respond(null, { ok: false, error: "messageTooLarge" });
      process.exit(1);
    }
    if (buffered.length < 4 + length) {
      return;
    }
    const payload = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);

    let request = null;
    try {
      request = JSON.parse(payload.toString("utf8"));
      respond(request, handle(request));
    } catch (error) {
      respond(request, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  drain();
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.stdout.on("error", () => {
  process.exit(0);
});
