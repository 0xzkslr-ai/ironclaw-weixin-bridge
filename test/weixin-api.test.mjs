import test from "node:test";
import assert from "node:assert/strict";

import {
  describeUnsupportedMessage,
  extractMessageText,
  markdownToPlainText,
} from "../src/weixin-api.mjs";
import { parseMarkdownMedia } from "../src/media.mjs";

test("extractMessageText reads text and quote title", () => {
  const text = extractMessageText([
    {
      type: 1,
      text_item: { text: "hello" },
      ref_msg: { title: "earlier" },
    },
  ]);
  assert.equal(text, "[引用: earlier]\nhello");
});

test("extractMessageText falls back to voice transcription", () => {
  const text = extractMessageText([
    {
      type: 3,
      voice_item: { text: "spoken words" },
    },
  ]);
  assert.equal(text, "spoken words");
});

test("describeUnsupportedMessage reports message item types", () => {
  assert.equal(describeUnsupportedMessage([{ type: 2 }, { type: 4 }]), "unsupported-media:2,4");
});

test("markdownToPlainText strips simple markdown", () => {
  const output = markdownToPlainText("**bold** [link](https://example.com)\n\n```js\nconst x = 1;\n```");
  assert.equal(output, "bold link\n\nconst x = 1;");
});

test("parseMarkdownMedia extracts remote and local media hints", () => {
  const items = parseMarkdownMedia("![chart](https://x.test/chart.png)\n/tmp/out.png\nhttps://x.test/report.pdf");
  assert.deepEqual(items, [
    { type: "remote", url: "https://x.test/chart.png" },
    { type: "local", path: "/tmp/out.png" },
    { type: "remote", url: "https://x.test/report.pdf" },
  ]);
});
