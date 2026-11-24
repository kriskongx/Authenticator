#!/usr/bin/env node
"use strict";

// Protocol smoke test for native-host/host.js. Runs the host exactly the way
// the browser does (stdio, 4-byte length-prefixed JSON) against a temporary
// home so the real ~/.authenticator-import is untouched.
//
//   node native-host/test-host.js

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST = path.join(__dirname, "host.js");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "authenticator-host-"));
const inbox = path.join(tempHome, "inbox");
fs.mkdirSync(inbox, { recursive: true });

const sample = JSON.stringify(
  {
    items: [
      {
        type: 1,
        name: "Example",
        login: { username: "alice", totp: "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP" },
      },
    ],
  },
  null,
  2
);
const samplePath = path.join(inbox, "vaultwarden-export.json");
fs.writeFileSync(samplePath, sample);

const child = spawn(process.execPath, [HOST], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AUTHENTICATOR_IMPORT_HOME: tempHome },
});

let buffered = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < 4 + length) {
      return;
    }
    const payload = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
    buffered = buffered.subarray(4 + length);
    const resolve = pending.get(payload.id);
    if (resolve) {
      pending.delete(payload.id);
      resolve(payload);
    }
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[host] ${chunk}`);
});

function call(request) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ ...request, id }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function main() {
  const status = await call({ type: "status" });
  assert.strictEqual(status.ok, true, "status should succeed");
  assert.ok(status.pending, "should report the export as pending");
  assert.strictEqual(status.pending.name, "vaultwarden-export.json");
  assert.ok(status.pending.digest.startsWith("sha256:"), "digest should be sha256");
  assert.strictEqual(status.fileCount, 1, "status should report the inbox size");
  assert.strictEqual(status.maxBytes, 104857600, "status should report the size limit");
  assert.strictEqual(status.deleteAfterImport, true, "status should report the delete flag");
  assert.ok(status.pattern.includes("json"), "status should report the filename pattern");
  assert.strictEqual(status.intervalMinutes, 5, "status should report the default interval");
  assert.strictEqual(status.importedCount, 0, "nothing imported yet");
  const chunks = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const chunk = await call({ type: "read", name: status.pending.name, offset, length: 1024 });
    assert.strictEqual(chunk.ok, true, "read should succeed");
    const data = Buffer.from(chunk.data, "base64");
    chunks.push(data);
    total = chunk.total;
    offset = chunk.offset + chunk.length;
    if (chunk.eof) {
      break;
    }
  }
  const assembled = Buffer.concat(chunks).toString("utf8");
  assert.strictEqual(total, Buffer.byteLength(sample), "total should match");
  assert.strictEqual(assembled, sample, "reassembled content should match the file");

  const ack = await call({ type: "ack", name: status.pending.name, digest: status.pending.digest });
  assert.strictEqual(ack.ok, true, "ack should succeed");
  assert.strictEqual(ack.deleted, true, "ack should delete the imported export");
  assert.strictEqual(
    fs.existsSync(samplePath),
    false,
    "the export must be removed from disk after import"
  );

  const after = await call({ type: "status" });
  assert.strictEqual(after.pending, null, "acked file should not be pending");
  assert.strictEqual(
    after.lastImported && after.lastImported.name,
    "vaultwarden-export.json",
    "status should report the last imported file"
  );
  assert.ok(after.lastImported.at > 0, "last import should carry a timestamp");
  assert.strictEqual(after.importedCount, 1, "imported count should grow");

  // Multi-chunk reassembly: a ~90 KB export already spans more than one read.
  const big = JSON.stringify({
    items: Array.from({ length: 300 }, (_, index) => ({
      type: 1,
      name: `Entry ${index}`,
      login: {
        username: `user${index}`,
        totp: `otpauth://totp/E${index}:u${index}?secret=JBSWY3DPEHPK3PXP`,
      },
    })),
  });
  const bigPath = path.join(inbox, "vaultwarden-big.json");
  fs.writeFileSync(bigPath, big);
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(bigPath, future, future);

  const bigStatus = await call({ type: "status" });
  assert.strictEqual(bigStatus.pending.name, "vaultwarden-big.json");

  const parts = [];
  let readOffset = 0;
  let chunksSeen = 0;
  for (;;) {
    const chunk = await call({
      type: "read",
      name: "vaultwarden-big.json",
      offset: readOffset,
      length: 32 * 1024,
    });
    assert.strictEqual(chunk.ok, true, "chunked read should succeed");
    parts.push(Buffer.from(chunk.data, "base64"));
    chunksSeen++;
    readOffset = chunk.offset + chunk.length;
    if (chunk.eof) {
      break;
    }
  }
  assert.ok(chunksSeen >= 2, "large export should need more than one read");
  assert.strictEqual(
    Buffer.concat(parts).toString("utf8"),
    big,
    "chunked reads should reassemble byte for byte"
  );

  const bigAck = await call({
    type: "ack",
    name: "vaultwarden-big.json",
    digest: bigStatus.pending.digest,
  });
  assert.strictEqual(bigAck.ok, true, "ack should succeed for the large export");
  assert.strictEqual(bigAck.deleted, true, "ack should delete by default");
  assert.strictEqual(fs.existsSync(bigPath), false, "large export should be removed");

  // deleteAfterImport: false keeps the file, for people who want a local copy.
  fs.writeFileSync(
    path.join(tempHome, "config.json"),
    JSON.stringify({ dir: inbox, deleteAfterImport: false, intervalMinutes: 2 })
  );
  const keepPath = path.join(inbox, "vaultwarden-keep.json");
  fs.writeFileSync(keepPath, big);
  const kept = await call({ type: "status" });
  assert.strictEqual(kept.pending.name, "vaultwarden-keep.json", "re-export should be pending");
  assert.strictEqual(kept.intervalMinutes, 2, "status should follow the configured interval");
  const keptAck = await call({
    type: "ack",
    name: "vaultwarden-keep.json",
    digest: kept.pending.digest,
  });
  assert.strictEqual(keptAck.ok, true);
  assert.strictEqual(keptAck.deleted, false, "config should disable deletion");
  assert.strictEqual(fs.existsSync(keepPath), true, "file must survive when deletion is off");
  fs.unlinkSync(keepPath);

  // Several exports queued at once: only the newest is imported, the older ones
  // are superseded on ack so their stale entries never get merged back in.
  const queue = ["q-old.json", "q-mid.json", "q-new.json"];
  const baseStamp = Date.now();
  const writeQueue = (base) =>
    queue.forEach((name, index) => {
      const file = path.join(inbox, name);
      fs.writeFileSync(
        file,
        JSON.stringify({
          items: [
            {
              type: 1,
              name,
              login: {
                username: name,
                totp: "otpauth://totp/Q:q?secret=JBSWY3DPEHPK3PXP",
              },
            },
          ],
        })
      );
      const stamp = new Date(base + index * 1000);
      fs.utimesSync(file, stamp, stamp);
    });
  writeQueue(baseStamp);

  const queued = await call({ type: "status" });
  assert.strictEqual(queued.pending.name, "q-new.json", "newest wins");
  assert.strictEqual(queued.fileCount, 3, "all three files are visible");

  const queuedAck = await call({
    type: "ack",
    name: "q-new.json",
    digest: queued.pending.digest,
  });
  assert.strictEqual(queuedAck.deleted, false, "keep mode keeps the file");
  assert.deepStrictEqual(
    queuedAck.superseded.sort(),
    ["q-mid.json", "q-old.json"],
    "older exports should be marked superseded"
  );

  const afterQueue = await call({ type: "status" });
  assert.strictEqual(afterQueue.pending, null, "superseded files are not imported");
  assert.strictEqual(afterQueue.fileCount, 3, "keep mode leaves them on disk");

  // Touching an old export makes it a new candidate again.
  fs.appendFileSync(path.join(inbox, "q-mid.json"), "\n");
  const retouched = await call({ type: "status" });
  assert.strictEqual(retouched.pending.name, "q-mid.json", "changed file is pending again");
  await call({ type: "ack", name: "q-mid.json", digest: retouched.pending.digest });
  queue.forEach((name) => fs.unlinkSync(path.join(inbox, name)));

  // With deletion enabled the superseded files are removed from disk as well.
  fs.writeFileSync(
    path.join(tempHome, "config.json"),
    JSON.stringify({ dir: inbox, deleteAfterImport: true })
  );
  // Start from a clean slate so the very same files are treated as new again.
  fs.rmSync(path.join(tempHome, "state.json"), { force: true });
  writeQueue(baseStamp + 100000);
  const deleting = await call({ type: "status" });
  const deletedAck = await call({
    type: "ack",
    name: deleting.pending.name,
    digest: deleting.pending.digest,
  });
  assert.strictEqual(deletedAck.deleted, true, "imported export is removed");
  assert.deepStrictEqual(
    deletedAck.superseded.sort(),
    ["q-mid.json", "q-old.json"],
    "older exports are superseded here too"
  );
  for (const name of queue) {
    assert.strictEqual(
      fs.existsSync(path.join(inbox, name)),
      false,
      `${name} should be gone when deletion is on`
    );
  }
  const cleared = await call({ type: "status" });
  assert.strictEqual(cleared.pending, null);
  assert.strictEqual(cleared.fileCount, 0, "inbox is empty again");

  const traversal = await call({ type: "read", name: "../state.json", offset: 0, length: 10 });
  assert.strictEqual(traversal.ok, false, "path traversal must be rejected");
  assert.strictEqual(traversal.error, "invalidName");

  const unknown = await call({ type: "nope" });
  assert.strictEqual(unknown.ok, false, "unknown request must fail");
  assert.strictEqual(unknown.error, "unknownRequest");

  process.stdout.write("host protocol: all checks passed\n");
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    child.stdin.end();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
