#!/usr/bin/env node

import { loadConfig, validateConfig } from "./config.mjs";
import { WeixinBridgeRuntime } from "./bridge.mjs";
import { createLogger } from "./util.mjs";

function parseArgs(argv) {
  const args = [...argv];
  const out = {
    command: args.shift() ?? "help",
    configPath: null,
    accountId: "default",
    quiet: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--config") {
      out.configPath = args.shift() ?? null;
    } else if (token === "--account") {
      out.accountId = args.shift() ?? "default";
    } else if (token === "--quiet") {
      out.quiet = true;
    } else if (token === "--help" || token === "-h") {
      out.command = "help";
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return out;
}

function printHelp() {
  console.log(`Usage: ironclaw-weixin-bridge <command> [options]

Commands:
  login            Start QR login and save the Weixin token
  run              Start the bridge. If not logged in, QR login runs first
  doctor           Validate IronClaw connectivity and local state
  help             Show this message

Options:
  --config <path>  Path to config JSON
  --account <id>   Account id for login (default: default)
  --quiet          Hide debug logs
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }

  const config = loadConfig({ configPath: args.configPath });
  validateConfig(config, { requireGatewayToken: args.command !== "login" });
  const logger = createLogger({ quiet: args.quiet });
  const runtime = new WeixinBridgeRuntime({ config, logger });

  if (args.command === "login") {
    const result = await runtime.login({ accountId: args.accountId });
    logger.info(`Login complete for ${args.accountId}`, {
      rawAccountId: result.accountId,
      userId: result.userId,
    });
    return;
  }

  if (args.command === "doctor") {
    await runtime.doctor();
    logger.info("Doctor checks passed");
    return;
  }

  if (args.command === "run") {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort(new Error("SIGINT")));
    process.on("SIGTERM", () => controller.abort(new Error("SIGTERM")));
    await runtime.run({ signal: controller.signal });
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
