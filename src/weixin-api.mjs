import crypto from "node:crypto";

import { sleep, truncate } from "./util.mjs";

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders({ token, body, routeTag }) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routeTag) headers.SKRouteTag = String(routeTag);
  return headers;
}

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, routeTag, fetchImpl }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders({ token, body, routeTag }),
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Weixin API ${endpoint} failed: ${response.status} ${truncate(text, 240)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = "",
  timeoutMs = 35000,
  routeTag,
  fetchImpl = fetch,
}) {
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: "ironclaw-weixin-bridge" },
      }),
      token,
      timeoutMs,
      routeTag,
      fetchImpl,
    });
    return JSON.parse(raw);
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

export async function sendTextMessage({
  baseUrl,
  token,
  toUserId,
  contextToken,
  text,
  timeoutMs = 15000,
  routeTag,
  fetchImpl = fetch,
}) {
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: text ? [{ type: 1, text_item: { text } }] : [],
    },
    base_info: { channel_version: "ironclaw-weixin-bridge" },
  });
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs,
    routeTag,
    fetchImpl,
  });
}

export function extractMessageText(itemList = []) {
  for (const item of itemList) {
    if (item?.type === 1 && item?.text_item?.text != null) {
      const text = String(item.text_item.text);
      const quoted = item.ref_msg?.title ? `[引用: ${item.ref_msg.title}]\n` : "";
      return `${quoted}${text}`.trim();
    }
    if (item?.type === 3 && item?.voice_item?.text) {
      return String(item.voice_item.text).trim();
    }
  }
  return "";
}

export function describeUnsupportedMessage(itemList = []) {
  const types = itemList
    .map((item) => item?.type)
    .filter((value) => value != null)
    .map(String);
  if (types.length === 0) return "empty";
  return `unsupported-media:${types.join(",")}`;
}

async function fetchQrCode({ baseUrl, botType, routeTag, fetchImpl = fetch }) {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    ensureTrailingSlash(baseUrl),
  );
  const headers = {};
  if (routeTag) headers.SKRouteTag = String(routeTag);
  const response = await fetchImpl(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch QR code: ${response.status} ${truncate(text, 240)}`);
  }
  return JSON.parse(text);
}

async function fetchQrStatus({ baseUrl, qrcode, routeTag, fetchImpl = fetch }) {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    ensureTrailingSlash(baseUrl),
  );
  const headers = {
    "iLink-App-ClientVersion": "1",
  };
  if (routeTag) headers.SKRouteTag = String(routeTag);
  const response = await fetchImpl(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to poll QR status: ${response.status} ${truncate(text, 240)}`);
  }
  return JSON.parse(text);
}

export async function startQrLogin({
  baseUrl,
  botType = "3",
  routeTag,
  fetchImpl = fetch,
}) {
  const result = await fetchQrCode({ baseUrl, botType, routeTag, fetchImpl });
  return {
    qrcode: result.qrcode,
    qrcodeUrl: result.qrcode_img_content,
  };
}

export async function waitForQrLogin({
  baseUrl,
  qrcode,
  botType = "3",
  routeTag,
  timeoutMs = 480000,
  pollDelayMs = 1200,
  logger,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs;
  let currentQr = qrcode;
  while (Date.now() < deadline) {
    const status = await fetchQrStatus({
      baseUrl,
      qrcode: currentQr,
      routeTag,
      fetchImpl,
    });
    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      return {
        connected: true,
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl: status.baseurl || baseUrl,
      };
    }
    if (status.status === "expired") {
      logger?.info?.("QR code expired, refreshing");
      const refresh = await startQrLogin({ baseUrl, botType, routeTag, fetchImpl });
      currentQr = refresh.qrcode;
      logger?.info?.(`New QR URL: ${refresh.qrcodeUrl}`);
      await sleep(pollDelayMs);
      continue;
    }
    await sleep(pollDelayMs);
  }
  return { connected: false, message: "QR login timed out" };
}

export function markdownToPlainText(text) {
  let result = text ?? "";
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/[*_~`>#-]/g, "");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}
