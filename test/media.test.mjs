import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  filePathToDataImage,
  parseDataUrl,
  saveBufferToFile,
} from "../src/media.mjs";

test("AES ECB helpers round-trip plaintext", async () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("hello bridge");
  const encrypted = encryptAesEcb(plaintext, key);
  const decrypted = decryptAesEcb(encrypted, key);
  assert.deepEqual(decrypted, plaintext);
  assert.equal(aesEcbPaddedSize(plaintext.length), encrypted.length);
});

test("parseDataUrl decodes base64 payload", () => {
  const parsed = parseDataUrl("data:image/png;base64,aGVsbG8=");
  assert.equal(parsed.mimeType, "image/png");
  assert.equal(parsed.buffer.toString("utf8"), "hello");
});

test("filePathToDataImage encodes local image bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iwb-media-"));
  const filePath = await saveBufferToFile({
    buffer: Buffer.from("png-bytes"),
    destDir: dir,
    filename: "demo.png",
    mimeType: "image/png",
  });
  const image = filePathToDataImage(filePath);
  assert.equal(image.media_type, "image/png");
  assert.equal(Buffer.from(image.data, "base64").toString("utf8"), "png-bytes");
});
