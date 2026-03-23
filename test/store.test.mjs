import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../src/store.mjs";

test("StateStore persists account, cursor, and conversation state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iwb-store-"));
  const store = new StateStore(dir);

  store.saveAccount("default", { token: "abc", baseUrl: "https://wx" });
  store.saveCursor("default", "cursor-1");
  store.upsertConversation("default", "alice", {
    threadId: "thread-123",
    contextToken: "ctx-1",
  });

  const reloaded = new StateStore(dir);
  assert.equal(reloaded.loadAccount("default").token, "abc");
  assert.equal(reloaded.loadCursor("default"), "cursor-1");
  assert.deepEqual(reloaded.getConversation("default", "alice").threadId, "thread-123");
});
