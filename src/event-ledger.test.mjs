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

test("rejects invalid event input", async (t) => {
  const { path } = await fixture(t);
  const ledger = new EventLedger(path);
  await assert.rejects(ledger.append({ type: "", payload: {} }), /event type/);
  await assert.rejects(ledger.append({ type: "task.event", payload: null }), /payload/);
  await assert.rejects(ledger.append({ type: "task.event", payload: {}, at: "invalid" }), /timestamp/);
});
