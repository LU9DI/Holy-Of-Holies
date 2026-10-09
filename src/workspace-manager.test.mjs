import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "./workspace-manager.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "holy-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  const workspace = new WorkspaceManager({ root });
  await workspace.initialize();
  return { directory, root, workspace };
}

test("writes atomically, reads content and enforces expected hashes", async (t) => {
  const { workspace } = await fixture(t);
  const first = await workspace.writeText("src/main.js", "export const answer = 42;\n", { createOnly: true });
  const read = await workspace.readText("src/main.js");
  assert.equal(read.content, "export const answer = 42;\n");
  assert.equal(read.sha256, first.sha256);

  const second = await workspace.writeText("src/main.js", "export const answer = 43;\n", {
    expectedSha256: first.sha256,
  });
  assert.notEqual(second.sha256, first.sha256);
  await assert.rejects(
    workspace.writeText("src/main.js", "stale", { expectedSha256: first.sha256 }),
    (error) => error.code === "STALE_FILE_VERSION",
  );
  await assert.rejects(
    workspace.writeText("src/main.js", "overwrite", { createOnly: true }),
    (error) => error.code === "FILE_ALREADY_EXISTS",
  );
});

test("rejects traversal, absolute paths and dot components", async (t) => {
  const { workspace } = await fixture(t);
  for (const path of ["../outside.txt", "a/../../outside.txt", "/etc/passwd", "a/./b", "C:\\Windows\\win.ini"]) {
    await assert.rejects(
      workspace.readText(path),
      (error) => error.code === "INVALID_WORKSPACE_PATH",
    );
  }
});

test("rejects symlink files and symlink parent directories", async (t) => {
  const { directory, root, workspace } = await fixture(t);
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "do not read");
  await symlink(outside, join(root, "link.txt"));
  await symlink(directory, join(root, "escape"));

  await assert.rejects(
    workspace.readText("link.txt"),
    (error) => error.code === "UNSAFE_FILE_TYPE",
  );
  await assert.rejects(
    workspace.writeText("link.txt", "overwrite"),
    (error) => error.code === "UNSAFE_FILE_TYPE",
  );
  await assert.rejects(
    workspace.readText("escape/outside.txt"),
    (error) => error.code === "UNSAFE_PATH_COMPONENT",
  );
});

test("bounds file reads and writes", async (t) => {
  const { workspace } = await fixture(t);
  await workspace.writeText("large.txt", "123456");
  await assert.rejects(
    workspace.readText("large.txt", { maxBytes: 5 }),
    (error) => error.code === "READ_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    workspace.writeText("too-large.txt", "123456", { maxBytes: 5 }),
    (error) => error.code === "WRITE_LIMIT_EXCEEDED",
  );
});

test("requires initialization before accessing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-workspace-uninit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceManager({ root: directory });
  await assert.rejects(
    workspace.readText("file.txt"),
    (error) => error.code === "WORKSPACE_NOT_INITIALIZED",
  );
});
