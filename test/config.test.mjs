import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";

test("loadConfig merges env overrides", () => {
  const config = loadConfig({
    env: {
      BRIDGE_STATE_DIR: "/tmp/bridge-state",
      IRONCLAW_BASE_URL: "http://127.0.0.1:4567",
      IRONCLAW_GATEWAY_TOKEN: "secret",
      WEIXIN_BASE_URL: "https://example.weixin",
    },
  });

  assert.equal(config.stateDir, path.resolve("/tmp/bridge-state"));
  assert.equal(config.ironclaw.baseUrl, "http://127.0.0.1:4567");
  assert.equal(config.ironclaw.gatewayToken, "secret");
  assert.equal(config.weixin.baseUrl, "https://example.weixin");
});
