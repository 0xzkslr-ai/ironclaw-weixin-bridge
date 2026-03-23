import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WeixinBridgeRuntime } from "../src/bridge.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ironclaw-weixin-bridge-"));
}

test("processInboundMessage creates thread, waits for response, and sends reply", async () => {
  const stateDir = makeTempDir();
  const config = {
    stateDir,
    ironclaw: {
      baseUrl: "http://ironclaw.test",
      gatewayToken: "token",
      responseTimeoutMs: 1000,
      reconnectDelayMs: 50,
    },
    weixin: {
      baseUrl: "https://weixin.test",
      loginBotType: "3",
      longPollTimeoutMs: 1000,
      idleRetryDelayMs: 10,
    },
    bridge: {
      sendTyping: false,
      unsupportedMediaNotice: true,
    },
    accounts: [{ id: "default", enabled: true, name: "default", allowFrom: [] }],
  };

  const sentMessages = [];
  const runtime = new WeixinBridgeRuntime({
    config,
    fetchImpl: async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/chat/thread/new")) {
        return new Response(JSON.stringify({ id: "thread-1" }), { status: 200 });
      }
      if (href.endsWith("/api/chat/send")) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.thread_id, "thread-1");
        assert.equal(payload.content, "hello");
        return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
      }
      if (href.includes("/api/chat/events?token=")) {
        return new Response(
          ReadableStream.from([
            "event: response\n",
            "data: {\"type\":\"response\",\"thread_id\":\"thread-1\",\"content\":\"hi from ironclaw\"}\n\n",
          ]),
          { status: 200 },
        );
      }
      if (href.endsWith("/ilink/bot/sendmessage")) {
        sentMessages.push(JSON.parse(options.body));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${href}`);
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });

  runtime.store.saveAccount("default", {
    token: "wx-token",
    baseUrl: "https://weixin.test",
  });
  runtime.client.createThread = async () => ({ id: "thread-1" });
  runtime.client.sendRichMessage = async () => ({ status: "accepted" });
  runtime.client.waitForResponse = async () => ({
    text: "hi from ironclaw",
    imageDataUrls: [],
    localPaths: [],
  });

  await runtime.processInboundMessage({
    account: config.accounts[0],
    savedAccount: runtime.store.loadAccount("default"),
    message: {
      from_user_id: "alice@im.wechat",
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    },
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].msg.to_user_id, "alice@im.wechat");
  assert.equal(sentMessages[0].msg.context_token, "ctx-1");
  assert.equal(sentMessages[0].msg.item_list[0].text_item.text, "hi from ironclaw");
});

test("processInboundMessage forwards inbound image and sends generated image reply", async () => {
  const stateDir = makeTempDir();
  const config = {
    stateDir,
    ironclaw: {
      baseUrl: "http://ironclaw.test",
      gatewayToken: "token",
      responseTimeoutMs: 1500,
      reconnectDelayMs: 50,
    },
    weixin: {
      baseUrl: "https://weixin.test",
      loginBotType: "3",
      longPollTimeoutMs: 1000,
      idleRetryDelayMs: 10,
    },
    bridge: {
      sendTyping: false,
      unsupportedMediaNotice: true,
    },
    accounts: [{ id: "default", enabled: true, name: "default", allowFrom: [] }],
  };

  const sentBodies = [];
  const runtime = new WeixinBridgeRuntime({
    config,
    fetchImpl: async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/download?encrypted_query_param=")) {
        return new Response(Buffer.from("fake-image"), { status: 200 });
      }
      if (href.endsWith("/ilink/bot/getuploadurl")) {
        return new Response(JSON.stringify({ upload_param: "u1" }), { status: 200 });
      }
      if (href.includes("/upload?encrypted_query_param=")) {
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "download-param" },
        });
      }
      if (href.endsWith("/ilink/bot/sendmessage")) {
        sentBodies.push(JSON.parse(options.body));
        return new Response("{}", { status: 200 });
      }
      if (href === "https://cdn.example/out.png") {
        return new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });

  runtime.store.saveAccount("default", {
    token: "wx-token",
    baseUrl: "https://weixin.test",
  });
  runtime.client.createThread = async () => ({ id: "thread-2" });
  runtime.client.sendRichMessage = async ({ threadId, content, images }) => {
    assert.equal(threadId, "thread-2");
    assert.equal(images.length, 1);
    assert.match(content, /^\[Weixin image message\]\n\n<weixin_saved_media>\n.+\n<\/weixin_saved_media>$/);
    return { status: "accepted" };
  };
  runtime.client.waitForResponse = async () => ({
    text: "![img](https://cdn.example/out.png)",
    imageDataUrls: ["data:image/png;base64,aGVsbG8="],
    localPaths: [],
  });

  await runtime.processInboundMessage({
    account: config.accounts[0],
    savedAccount: runtime.store.loadAccount("default"),
    message: {
      from_user_id: "bob@im.wechat",
      context_token: "ctx-2",
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "enc-1",
            },
          },
        },
      ],
    },
  });

  assert.equal(sentBodies.length >= 2, true);
  assert.equal(sentBodies[0].msg.context_token, "ctx-2");
});
