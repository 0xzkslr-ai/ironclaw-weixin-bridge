import test from "node:test";
import assert from "node:assert/strict";

import { IronclawClient } from "../src/ironclaw-client.mjs";

test("IronclawClient aggregates response and generated images", async () => {
  const client = new IronclawClient({
    baseUrl: "http://ironclaw.test",
    gatewayToken: "token",
    responseTimeoutMs: 2000,
    reconnectDelayMs: 10,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const promise = client.waitForResponse("thread-1", 2000);
  client.handleEvent({
    event: "image_generated",
    data: JSON.stringify({
      thread_id: "thread-1",
      data_url: "data:image/png;base64,aGVsbG8=",
    }),
  });
  client.handleEvent({
    event: "response",
    data: JSON.stringify({
      thread_id: "thread-1",
      content: "done",
    }),
  });

  const result = await promise;
  assert.equal(result.text, "done");
  assert.deepEqual(result.imageDataUrls, ["data:image/png;base64,aGVsbG8="]);
});
