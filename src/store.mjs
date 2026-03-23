import fs from "node:fs";
import path from "node:path";

import { nowIso } from "./util.mjs";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.accountsDir = path.join(stateDir, "accounts");
    this.cursorsDir = path.join(stateDir, "cursors");
    this.runtimeDir = path.join(stateDir, "runtime");
    this.threadMapPath = path.join(this.runtimeDir, "conversations.json");
    ensureDir(this.accountsDir);
    ensureDir(this.cursorsDir);
    ensureDir(this.runtimeDir);
  }

  loadAccount(accountId) {
    return readJson(path.join(this.accountsDir, `${accountId}.json`), null);
  }

  saveAccount(accountId, value) {
    const payload = {
      ...value,
      savedAt: nowIso(),
    };
    writeJsonAtomic(path.join(this.accountsDir, `${accountId}.json`), payload);
  }

  loadCursor(accountId) {
    const data = readJson(path.join(this.cursorsDir, `${accountId}.json`), {});
    return typeof data.getUpdatesBuf === "string" ? data.getUpdatesBuf : "";
  }

  saveCursor(accountId, getUpdatesBuf) {
    writeJsonAtomic(path.join(this.cursorsDir, `${accountId}.json`), {
      getUpdatesBuf,
      updatedAt: nowIso(),
    });
  }

  loadConversationState() {
    return readJson(this.threadMapPath, {});
  }

  saveConversationState(state) {
    writeJsonAtomic(this.threadMapPath, state);
  }

  getConversation(accountId, peerId) {
    const key = `${accountId}:${peerId}`;
    const state = this.loadConversationState();
    return state[key] ?? null;
  }

  upsertConversation(accountId, peerId, patch) {
    const key = `${accountId}:${peerId}`;
    const state = this.loadConversationState();
    state[key] = {
      ...(state[key] ?? {}),
      ...patch,
      accountId,
      peerId,
      updatedAt: nowIso(),
    };
    this.saveConversationState(state);
    return state[key];
  }
}
