import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { discoverIronclawGateway, loadConfig } from "../src/config.mjs";

test("loadConfig merges env overrides", () => {
  const config = loadConfig({
    env: {
      BRIDGE_STATE_DIR: "/tmp/bridge-state",
      IRONCLAW_BASE_URL: "http://127.0.0.1:4567",
      IRONCLAW_GATEWAY_TOKEN: "secret",
      WEIXIN_BASE_URL: "https://example.weixin",
    },
    discoverIronclawGatewayImpl: () => ({
      gatewayToken: "discovered-secret",
      baseUrl: "http://127.0.0.1:3000",
    }),
  });

  assert.equal(config.stateDir, path.resolve("/tmp/bridge-state"));
  assert.equal(config.ironclaw.baseUrl, "http://127.0.0.1:4567");
  assert.equal(config.ironclaw.gatewayToken, "secret");
  assert.equal(config.weixin.baseUrl, "https://example.weixin");
});

test("loadConfig auto-discovers IronClaw gateway settings", () => {
  const config = loadConfig({
    env: {},
    discoverIronclawGatewayImpl: () => ({
      gatewayToken: "discovered-secret",
      baseUrl: "http://127.0.0.1:4317",
    }),
  });

  assert.equal(config.ironclaw.baseUrl, "http://127.0.0.1:4317");
  assert.equal(config.ironclaw.gatewayToken, "discovered-secret");
});

test("discoverIronclawGateway reads token and host from ironclaw config", () => {
  const values = new Map([
    ["channels.gateway_auth_token", "token-123\n"],
    ["channels.gateway_host", "0.0.0.0\n"],
    ["channels.gateway_port", "4123\n"],
    ["channels.gateway_enabled", "true\n"],
  ]);

  const discovered = discoverIronclawGateway({
    execFileSyncImpl(command, args) {
      assert.equal(command, "ironclaw");
      return values.get(args[2]) ?? "\n";
    },
  });

  assert.deepEqual(discovered, {
    gatewayToken: "token-123",
    baseUrl: "http://0.0.0.0:4123",
  });
});
