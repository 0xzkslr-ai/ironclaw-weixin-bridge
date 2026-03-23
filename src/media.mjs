import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const EXTENSION_TO_MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const MIME_TO_EXTENSION = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

export function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

export function getExtensionFromMime(mimeType) {
  const ct = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return MIME_TO_EXTENSION[ct] ?? ".bin";
}

export function getExtensionFromContentTypeOrUrl(contentType, url) {
  if (contentType) {
    const ext = getExtensionFromMime(contentType);
    if (ext !== ".bin") return ext;
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext && EXTENSION_TO_MIME[ext]) return ext;
  } catch {}
  return ".bin";
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Unsupported aes_key payload length: ${decoded.length}`);
}

async function fetchBuffer(url, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Download failed: ${response.status} ${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadAndDecryptBuffer({
  encryptedQueryParam,
  aesKeyBase64,
  cdnBaseUrl,
  fetchImpl = fetch,
}) {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  const encrypted = await fetchBuffer(url, fetchImpl);
  return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
}

export async function downloadPlainBuffer({
  encryptedQueryParam,
  cdnBaseUrl,
  fetchImpl = fetch,
}) {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  return fetchBuffer(url, fetchImpl);
}

export async function saveBufferToFile({
  buffer,
  destDir,
  filename,
  mimeType,
}) {
  await fsp.mkdir(destDir, { recursive: true });
  const safeName =
    filename ||
    `media-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${getExtensionFromMime(mimeType || "application/octet-stream")}`;
  const filePath = path.join(destDir, safeName);
  await fsp.writeFile(filePath, buffer);
  return filePath;
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(dataUrl || "");
  if (!match) {
    throw new Error("Unsupported data URL");
  }
  return {
    mimeType: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  };
}

export function filePathToDataImage(filePath) {
  const buffer = fs.readFileSync(filePath);
  const mimeType = getMimeFromFilename(filePath);
  return {
    media_type: mimeType,
    data: buffer.toString("base64"),
  };
}

export async function downloadRemoteMediaToFile({
  url,
  destDir,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Remote media download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = getExtensionFromContentTypeOrUrl(response.headers.get("content-type"), url);
  const filePath = path.join(
    destDir,
    `remote-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`,
  );
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(filePath, buffer);
  return {
    filePath,
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim()?.toLowerCase() || getMimeFromFilename(filePath),
  };
}

export async function getUploadUrl({
  baseUrl,
  token,
  routeTag,
  payload,
  fetchImpl = fetch,
}) {
  const body = JSON.stringify({
    ...payload,
    base_info: { channel_version: "ironclaw-weixin-bridge" },
  });
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routeTag) headers.SKRouteTag = String(routeTag);
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/ilink/bot/getuploadurl`, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`getuploadurl failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

export async function uploadBufferToCdn({
  buffer,
  uploadParam,
  filekey,
  cdnBaseUrl,
  aeskey,
  fetchImpl = fetch,
}) {
  const ciphertext = encryptAesEcb(buffer, aeskey);
  const url = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (response.status !== 200) {
    const text = await response.text().catch(() => "");
    throw new Error(`CDN upload failed: ${response.status} ${text}`);
  }
  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload missing x-encrypted-param");
  }
  return { downloadParam };
}

export async function uploadFileToWeixin({
  filePath,
  toUserId,
  baseUrl,
  token,
  cdnBaseUrl,
  mediaType,
  routeTag,
  fetchImpl = fetch,
}) {
  const plaintext = await fsp.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    baseUrl,
    token,
    routeTag,
    fetchImpl,
    payload: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    },
  });

  if (!uploadUrlResp.upload_param) {
    throw new Error("getuploadurl returned no upload_param");
  }

  const { downloadParam } = await uploadBufferToCdn({
    buffer: plaintext,
    uploadParam: uploadUrlResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
    fetchImpl,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export function parseMarkdownMedia(text) {
  const candidates = [];
  const markdownImage = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = markdownImage.exec(text || "")) !== null) {
    candidates.push({ type: "remote", url: match[1] });
  }

  const lines = String(text || "").split("\n").map((line) => line.trim());
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("http://") || line.startsWith("https://")) {
      if (/\.(png|jpg|jpeg|gif|webp|bmp|mp4|mov|webm|mkv|avi|pdf|txt|csv|zip)(\?|$)/i.test(line)) {
        candidates.push({ type: "remote", url: line });
      }
    } else if (line.startsWith("/")) {
      candidates.push({ type: "local", path: line });
    }
  }

  return candidates;
}
