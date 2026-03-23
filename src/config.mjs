import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

function normalizeCliValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined") return null;
  return text;
}

function readIronclawConfigValue(key, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const output = execFileSyncImpl("ironclaw", ["config", "get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeCliValue(output);
  } catch {
    return null;
  }
}

export function discoverIronclawGateway({ execFileSyncImpl = execFileSync } = {}) {
  const gatewayToken = readIronclawConfigValue("channels.gateway_auth_token", { execFileSyncImpl });
  const gatewayHost = readIronclawConfigValue("channels.gateway_host", { execFileSyncImpl });
  const gatewayPort = readIronclawConfigValue("channels.gateway_port", { execFileSyncImpl });
  const gatewayEnabled = readIronclawConfigValue("channels.gateway_enabled", { execFileSyncImpl });

  let baseUrl = null;
  if (gatewayEnabled !== "false") {
    const host = gatewayHost || "127.0.0.1";
    const port = gatewayPort || "3000";
    baseUrl = `http://${host}:${port}`;
  }

  return {
    gatewayToken,
    baseUrl,
  };
}

export function loadConfig({
  configPath,
  env = process.env,
  discoverIronclawGatewayImpl = discoverIronclawGateway,
} = {}) {
  const fileConfig = configPath ? readJsonIfExists(configPath) : null;
  const merged = merge(DEFAULT_CONFIG, fileConfig ?? {});
  const discoveredIronclaw = discoverIronclawGatewayImpl();

  if (env.BRIDGE_STATE_DIR) merged.stateDir = env.BRIDGE_STATE_DIR;
  if (env.IRONCLAW_BASE_URL) {
    merged.ironclaw.baseUrl = env.IRONCLAW_BASE_URL;
  } else if (!fileConfig?.ironclaw?.baseUrl && discoveredIronclaw.baseUrl) {
    merged.ironclaw.baseUrl = discoveredIronclaw.baseUrl;
  }
  if (env.IRONCLAW_GATEWAY_TOKEN) {
    merged.ironclaw.gatewayToken = env.IRONCLAW_GATEWAY_TOKEN;
  } else if (!fileConfig?.ironclaw?.gatewayToken && discoveredIronclaw.gatewayToken) {
    merged.ironclaw.gatewayToken = discoveredIronclaw.gatewayToken;
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
