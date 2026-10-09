import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "holy-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    path: join(directory, "events.jsonl"),
  };
}

test("appends ordered events with a verifiable hash chain", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await ledger.append({
    type: "task.created",
    payload: { taskId: "t-1" },
    at: "2026-01-01T00:00:00.000Z",
  });
  await ledger.append({
    type: "task.started",
    payload: { taskId: "t-1" },
    at: "2026-01-01T00:00:01.000Z",
  });

  const events = await ledger.read();
  assert.equal(events.length, 2);
  assert.equal(events[0].sequence, 1);
  assert.equal(events[1].sequence, 2);
  assert.equal(events[1].previousHash, events[0].hash);
  assert.deepEqual(await ledger.verify(), {
    valid: true,
    eventCount: 2,
    lastSequence: 2,
    headHash: events[1].hash,
  });
});

test("deep-freezes returned event snapshots, including nested payloads", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  const appended = await ledger.append({
    type: "task.created",
    payload: { task: { id: "t-1" }, tags: ["safe"] },
  });

  assert.equal(Object.isFrozen(appended), true);
  assert.equal(Object.isFrozen(appended.payload), true);
  assert.equal(Object.isFrozen(appended.payload.task), true);
  assert.equal(Object.isFrozen(appended.payload.tags), true);
  assert.throws(() => { appended.payload.task.id = "tampered"; }, TypeError);

  const [readEntry] = await ledger.read();
  assert.equal(Object.isFrozen(readEntry.payload.task), true);
  assert.equal(readEntry.payload.task.id, "t-1");
});

test("serializes concurrent appends from the same ledger instance", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    ledger.append({ type: "test.concurrent", payload: { index } }),
  ));
  const events = await ledger.read();
  assert.equal(events.length, 20);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("detects modified payloads and incomplete final records", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await ledger.append({ type: "task.created", payload: { taskId: "t-1" } });

  const original = await readFile(path, "utf8");
  const entry = JSON.parse(original.trim());
  entry.payload.taskId = "tampered";
  await writeFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  await assert.rejects(ledger.read(), /hash mismatch/);

  await writeFile(path, '{"incomplete":', "utf8");
  await assert.rejects(ledger.read(), /incomplete record/);
});

test("compare-and-append rejects stale writers", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  const emptyHead = (await ledger.verify()).headHash;
  await ledger.append({ type: "task.created", payload: { taskId: "t-1" }, expectedHeadHash: emptyHead });
  await assert.rejects(
    ledger.append({ type: "task.created", payload: { taskId: "t-2" }, expectedHeadHash: emptyHead }),
    /head changed/,
  );
  assert.equal((await ledger.verify()).eventCount, 1);
});

test("releases its owned lock after an append is rejected", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  const emptyHead = (await ledger.verify()).headHash;

  await ledger.append({
    type: "task.created",
    payload: { taskId: "t-1" },
    expectedHeadHash: emptyHead,
  });
  await assert.rejects(ledger.append({
    type: "task.created",
    payload: { taskId: "t-2" },
    expectedHeadHash: emptyHead,
  }), /head changed/);

  await assert.rejects(readFile(`${path}.lock`, "utf8"), { code: "ENOENT" });
  const appended = await ledger.append({
    type: "task.started",
    payload: { taskId: "t-1" },
  });
  assert.equal(appended.sequence, 2);
  assert.equal((await ledger.verify()).eventCount, 2);
});

test("rejects invalid event input", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await assert.rejects(ledger.append({ type: "", payload: {} }), /event type/);
  await assert.rejects(ledger.append({ type: "task.event", payload: null }), /payload/);
  await assert.rejects(ledger.append({ type: "task.event", payload: {}, at: "invalid" }), /timestamp/);
});

test("refuses to append after a crash leaves an incomplete final record", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await ledger.append({ type: "task.created", payload: { taskId: "t-1" } });
  const validContents = await readFile(path, "utf8");
  await writeFile(path, `${validContents}{\\"partial\\":`, "utf8");

  await assert.rejects(ledger.append({
    type: "task.started",
    payload: { taskId: "t-1" },
  }), /incomplete record/);
  assert.equal(await readFile(path, "utf8"), `${validContents}{\\"partial\\":`);
});

test("fails closed on an existing lock and never steals or removes it", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  const lockPath = `${path}.lock`;
  const lockContents = "999999\\n";
  await writeFile(lockPath, lockContents, { flag: "wx", mode: 0o600 });

  await assert.rejects(ledger.read(), /locked/);
  await assert.rejects(ledger.append({
    type: "task.created",
    payload: { taskId: "t-1" },
  }), /locked/);
  assert.equal(await readFile(lockPath, "utf8"), lockContents);
});

