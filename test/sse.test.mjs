import test from "node:test";
import assert from "node:assert/strict";

import { parseSseStream } from "../src/sse.mjs";

test("parseSseStream parses named events", async () => {
  const stream = ReadableStream.from([
    "event: response\n",
    "data: {\"thread_id\":\"t1\",\"content\":\"hello\"}\n\n",
  ]);

  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      event: "response",
      data: "{\"thread_id\":\"t1\",\"content\":\"hello\"}",
    },
  ]);
});
