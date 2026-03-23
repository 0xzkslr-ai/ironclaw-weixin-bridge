import fs from "node:fs";
import path from "node:path";

import { resolveDefaultStateDir, toArray } from "./util.mjs";

const DEFAULT_CONFIG = {
  stateDir: resolveDefaultStateDir(),
  ironclaw: {
    baseUrl: "http://127.0.0.1:3000",
    gatewayToken: "",
    responseTimeoutMs: 300000,
    reconnectDelayMs: 1500,
  },
  weixin: {
    baseUrl: "https://ilinkai.weixin.qq.com",
    loginBotType: "3",
    longPollTimeoutMs: 35000,
    idleRetryDelayMs: 2000,
  },
  bridge: {
    sendTyping: false,
    unsupportedMediaNotice: true,
  },
  accounts: [
    {
      id: "default",
      enabled: true,
      name: "default",
      allowFrom: [],
    },
  ],
};

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function merge(base, override) {
  if (override == null) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(override)) {
    return structuredClone(override);
  }
  if (typeof base !== "object" || typeof override !== "object") {
    return structuredClone(override);
  }

  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = key in base ? merge(base[key], value) : structuredClone(value);
  }
  return out;
}

function normalizeAccount(account) {
  return {
    id: account.id,
    enabled: account.enabled !== false,
    name: account.name ?? account.id,
    allowFrom: toArray(account.allowFrom).filter(Boolean),
  };
}

export function loadConfig({ configPath, env = process.env } = {}) {
  const fileConfig = configPath ? readJsonIfExists(configPath) : null;
  const merged = merge(DEFAULT_CONFIG, fileConfig ?? {});

  if (env.BRIDGE_STATE_DIR) merged.stateDir = env.BRIDGE_STATE_DIR;
  if (env.IRONCLAW_BASE_URL) merged.ironclaw.baseUrl = env.IRONCLAW_BASE_URL;
  if (env.IRONCLAW_GATEWAY_TOKEN) {
    merged.ironclaw.gatewayToken = env.IRONCLAW_GATEWAY_TOKEN;
  }
  if (env.WEIXIN_BASE_URL) merged.weixin.baseUrl = env.WEIXIN_BASE_URL;
  if (env.WEIXIN_LOGIN_BOT_TYPE) merged.weixin.loginBotType = env.WEIXIN_LOGIN_BOT_TYPE;

  merged.stateDir = path.resolve(merged.stateDir);
  merged.accounts = toArray(merged.accounts).map(normalizeAccount);

  validateConfig(merged, { requireGatewayToken: false });
  return merged;
}

export function validateConfig(config, { requireGatewayToken = true } = {}) {
  if (!config.ironclaw?.baseUrl) {
    throw new Error("ironclaw.baseUrl is required");
  }
  if (requireGatewayToken && !config.ironclaw?.gatewayToken) {
    throw new Error("ironclaw.gatewayToken is required");
  }
  if (!config.weixin?.baseUrl) {
    throw new Error("weixin.baseUrl is required");
  }
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
    throw new Error("at least one account is required");
  }
  for (const account of config.accounts) {
    if (!account.id || typeof account.id !== "string") {
      throw new Error("each account requires a string id");
    }
  }
}
