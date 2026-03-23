import crypto from "node:crypto";

import { IronclawClient } from "./ironclaw-client.mjs";
import { StateStore } from "./store.mjs";
import {
  describeUnsupportedMessage,
  extractMessageText,
  getUpdates,
  markdownToPlainText,
  startQrLogin,
  waitForQrLogin,
} from "./weixin-api.mjs";
import { sleep } from "./util.mjs";
import {
  downloadAndDecryptBuffer,
  downloadPlainBuffer,
  downloadRemoteMediaToFile,
  filePathToDataImage,
  getMimeFromFilename,
  parseDataUrl,
  parseMarkdownMedia,
  saveBufferToFile,
  uploadFileToWeixin,
} from "./media.mjs";

export class WeixinBridgeRuntime {
  constructor({ config, fetchImpl = fetch, logger }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.store = new StateStore(config.stateDir);
    this.client = new IronclawClient({
      baseUrl: config.ironclaw.baseUrl,
      gatewayToken: config.ironclaw.gatewayToken,
      responseTimeoutMs: config.ironclaw.responseTimeoutMs,
      reconnectDelayMs: config.ironclaw.reconnectDelayMs,
      fetchImpl,
      logger,
    });
    this.conversationLocks = new Map();
  }

  getEnabledAccounts() {
    return this.config.accounts.filter((account) => account.enabled !== false);
  }

  async doctor() {
    await this.client.doctor();
    for (const account of this.getEnabledAccounts()) {
      const saved = this.store.loadAccount(account.id);
      if (!saved?.token) {
        this.logger.warn(`Account ${account.id} is not logged in yet`);
      }
    }
  }

  async login({ accountId }) {
    const account = this.config.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new Error(`Unknown account: ${accountId}`);

    const qr = await startQrLogin({
      baseUrl: this.config.weixin.baseUrl,
      botType: this.config.weixin.loginBotType,
      fetchImpl: this.fetchImpl,
    });

    this.logger.info(`Scan this QR URL with Weixin: ${qr.qrcodeUrl}`);

    const result = await waitForQrLogin({
      baseUrl: this.config.weixin.baseUrl,
      qrcode: qr.qrcode,
      botType: this.config.weixin.loginBotType,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
    });

    if (!result.connected) {
      throw new Error(result.message || "QR login failed");
    }

    this.store.saveAccount(account.id, {
      token: result.botToken,
      baseUrl: result.baseUrl || this.config.weixin.baseUrl,
      rawAccountId: result.accountId,
      userId: result.userId,
    });

    return result;
  }

  async run({ signal } = {}) {
    await this.client.start(signal);
    const runners = this.getEnabledAccounts().map((account) => this.runAccount(account, signal));
    await Promise.all(runners);
  }

  async runAccount(account, signal) {
    const saved = this.store.loadAccount(account.id);
    if (!saved?.token) {
      this.logger.warn(`Skipping ${account.id}: no saved token. Run login first.`);
      return;
    }

    const baseUrl = saved.baseUrl || this.config.weixin.baseUrl;
    let cursor = this.store.loadCursor(account.id);

    this.logger.info(`Starting account ${account.id} against ${baseUrl}`);

    while (!signal?.aborted) {
      try {
        const response = await getUpdates({
          baseUrl,
          token: saved.token,
          getUpdatesBuf: cursor,
          timeoutMs: this.config.weixin.longPollTimeoutMs,
          fetchImpl: this.fetchImpl,
        });

        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          this.store.saveCursor(account.id, cursor);
        }

        if ((response.msgs ?? []).length > 0) {
          this.logger.info(
            `Account ${account.id} polled ${response.msgs.length} inbound message(s)`,
          );
        }

        for (const message of response.msgs ?? []) {
          await this.enqueueConversation(account.id, message.from_user_id, () =>
            this.processInboundMessage({
              account,
              savedAccount: saved,
              message,
            }),
          );
        }
      } catch (error) {
        this.logger.error(`Account ${account.id} polling failed`, String(error));
        await sleep(this.config.weixin.idleRetryDelayMs, signal);
      }
    }
  }

  async enqueueConversation(accountId, peerId, task) {
    if (!peerId) return;
    const key = `${accountId}:${peerId}`;
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.conversationLocks.get(key) === next) {
          this.conversationLocks.delete(key);
        }
      });
    this.conversationLocks.set(key, next);
    return next;
  }

  async ensureThread(accountId, peerId) {
    const existing = this.store.getConversation(accountId, peerId);
    if (existing?.threadId) return existing.threadId;
    const thread = await this.client.createThread();
    this.store.upsertConversation(accountId, peerId, { threadId: thread.id });
    return thread.id;
  }

  async processInboundMessage({ account, savedAccount, message }) {
    const peerId = message.from_user_id;
    if (!peerId) return;
    this.logger.info(`Inbound message from ${peerId} on account ${account.id}`);

    const text = extractMessageText(message.item_list);
    const conversation = this.store.upsertConversation(account.id, peerId, {
      contextToken: message.context_token,
      rawPeerId: peerId,
    });

    if (account.allowFrom.length > 0 && !account.allowFrom.includes(peerId)) {
      this.logger.debug(`Ignoring message from unauthorized peer ${peerId}`);
      return;
    }

    const threadId = conversation.threadId || (await this.ensureThread(account.id, peerId));
    const inbound = await this.buildInboundPayload({ accountId: account.id, peerId, text, message });
    const contextToken = this.store.getConversation(account.id, peerId)?.contextToken;
    if (!contextToken) {
      throw new Error(`Missing context token for conversation ${account.id}:${peerId}`);
    }
    try {
      const historyBefore = await this.client.getHistory(threadId).catch(() => ({ turns: [] }));
      const baselineTurnCount = Array.isArray(historyBefore?.turns) ? historyBefore.turns.length : 0;
      this.logger.info(
        `Forwarding conversation ${account.id}:${peerId} to IronClaw thread ${threadId}`,
      );
      await this.client.sendRichMessage({
        threadId,
        content: inbound.content,
        images: inbound.images,
      });
      const response = await this.client.waitForResponse(
        threadId,
        this.config.ironclaw.responseTimeoutMs,
        { baselineTurnCount },
      );
      this.logger.info(
        `Received IronClaw result for thread ${threadId}: text=${Boolean(response.text)} images=${response.imageDataUrls?.length ?? 0} localPaths=${response.localPaths?.length ?? 0}`,
      );
      await this.deliverReply({
        accountId: account.id,
        savedAccount,
        peerId,
        contextToken,
        response,
      });
    } catch (error) {
      this.logger.error(`Failed to complete reply for ${account.id}:${peerId}`, String(error));
      await this.sendTextReply({
        baseUrl: savedAccount.baseUrl || this.config.weixin.baseUrl,
        token: savedAccount.token,
        toUserId: peerId,
        contextToken,
        text: "抱歉，这一轮处理失败了。请再发一次，或换个更明确的问题。",
      });
    }
  }

  mediaDir(accountId) {
    const dir = `${this.config.stateDir}/media/${accountId}`;
    return dir;
  }

  async buildInboundPayload({ accountId, peerId, text, message }) {
    let content = text || "";
    const images = [];
    const savedPaths = [];
    for (const item of message.item_list ?? []) {
      if (item?.type === 1 || item?.type === 3) continue;

      if (item?.type === 2 && item?.image_item?.media?.encrypt_query_param) {
        const aesKeyBase64 = item.image_item?.aeskey
          ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
          : item.image_item?.media?.aes_key;
        const buffer = aesKeyBase64
          ? await downloadAndDecryptBuffer({
              encryptedQueryParam: item.image_item.media.encrypt_query_param,
              aesKeyBase64,
              cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
              fetchImpl: this.fetchImpl,
            })
          : await downloadPlainBuffer({
              encryptedQueryParam: item.image_item.media.encrypt_query_param,
              cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
              fetchImpl: this.fetchImpl,
            });
        const filePath = await saveBufferToFile({
          buffer,
          destDir: `${this.mediaDir(accountId)}/inbound`,
          mimeType: "image/png",
        });
        savedPaths.push(filePath);
        images.push(filePathToDataImage(filePath));
      } else if (item?.type === 4 && item?.file_item?.media?.encrypt_query_param && item?.file_item?.media?.aes_key) {
        const buffer = await downloadAndDecryptBuffer({
          encryptedQueryParam: item.file_item.media.encrypt_query_param,
          aesKeyBase64: item.file_item.media.aes_key,
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          fetchImpl: this.fetchImpl,
        });
        const filePath = await saveBufferToFile({
          buffer,
          destDir: `${this.mediaDir(accountId)}/inbound`,
          filename: item.file_item.file_name || undefined,
          mimeType: getMimeFromFilename(item.file_item.file_name || "file.bin"),
        });
        savedPaths.push(filePath);
      } else if (item?.type === 5 && item?.video_item?.media?.encrypt_query_param && item?.video_item?.media?.aes_key) {
        const buffer = await downloadAndDecryptBuffer({
          encryptedQueryParam: item.video_item.media.encrypt_query_param,
          aesKeyBase64: item.video_item.media.aes_key,
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          fetchImpl: this.fetchImpl,
        });
        const filePath = await saveBufferToFile({
          buffer,
          destDir: `${this.mediaDir(accountId)}/inbound`,
          mimeType: "video/mp4",
        });
        savedPaths.push(filePath);
      } else if (item?.type === 3 && item?.voice_item?.media?.encrypt_query_param && item?.voice_item?.media?.aes_key && !item?.voice_item?.text) {
        const buffer = await downloadAndDecryptBuffer({
          encryptedQueryParam: item.voice_item.media.encrypt_query_param,
          aesKeyBase64: item.voice_item.media.aes_key,
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          fetchImpl: this.fetchImpl,
        });
        const filePath = await saveBufferToFile({
          buffer,
          destDir: `${this.mediaDir(accountId)}/inbound`,
          mimeType: "audio/silk",
        });
        savedPaths.push(filePath);
      }
    }

    if (!content) {
      if (images.length > 0) content = "[Weixin image message]";
      else if (savedPaths.length > 0) content = `[Weixin ${describeUnsupportedMessage(message.item_list)} message]`;
      else if (!this.config.bridge.unsupportedMediaNotice) return { content: "", images: [] };
      else content = `[Weixin ${describeUnsupportedMessage(message.item_list)} message]`;
    }

    if (savedPaths.length > 0) {
      content += `\n\n<weixin_saved_media>\n${savedPaths.join("\n")}\n</weixin_saved_media>`;
    }

    return { content, images };
  }

  async deliverReply({ accountId, savedAccount, peerId, contextToken, response }) {
    const baseUrl = savedAccount.baseUrl || this.config.weixin.baseUrl;
    const text = markdownToPlainText(response.text || "");
    this.logger.info(
      `Delivering reply to ${peerId}: text_len=${text.length} generated_images=${response.imageDataUrls?.length ?? 0}`,
    );

    const mediaCandidates = [];
    for (const dataUrl of response.imageDataUrls || []) {
      const parsed = parseDataUrl(dataUrl);
      const filePath = await saveBufferToFile({
        buffer: parsed.buffer,
        destDir: `${this.mediaDir(accountId)}/outbound`,
        mimeType: parsed.mimeType,
      });
      mediaCandidates.push({ kind: "local", filePath });
    }

    for (const localPath of response.localPaths || []) {
      mediaCandidates.push({ kind: "local", filePath: localPath });
    }

    for (const candidate of parseMarkdownMedia(response.text || "")) {
      if (candidate.type === "local") {
        mediaCandidates.push({ kind: "local", filePath: candidate.path });
      } else {
        mediaCandidates.push({ kind: "remote", url: candidate.url });
      }
    }

    const unique = [];
    const seen = new Set();
    for (const candidate of mediaCandidates) {
      const key = candidate.kind === "local" ? `l:${candidate.filePath}` : `r:${candidate.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(candidate);
    }

    if (unique.length === 0) {
      this.logger.info(`Sending plain text reply to ${peerId}`);
      await this.sendTextReply({
        baseUrl,
        token: savedAccount.token,
        toUserId: peerId,
        contextToken,
        text,
      });
      return;
    }

    let caption = text;
    for (let index = 0; index < unique.length; index += 1) {
      const candidate = unique[index];
      const fileInfo =
        candidate.kind === "remote"
          ? await downloadRemoteMediaToFile({
              url: candidate.url,
              destDir: `${this.mediaDir(accountId)}/outbound`,
              fetchImpl: this.fetchImpl,
            })
          : { filePath: candidate.filePath, mimeType: getMimeFromFilename(candidate.filePath) };
      this.logger.info(
        `Sending media reply ${index + 1}/${unique.length} to ${peerId} via ${candidate.kind}`,
      );
      await this.sendMediaReply({
        baseUrl,
        token: savedAccount.token,
        toUserId: peerId,
        contextToken,
        filePath: fileInfo.filePath,
        text: index === 0 ? caption : "",
      });
      caption = "";
    }

    if (caption.trim()) {
      await this.sendTextReply({
        baseUrl,
        token: savedAccount.token,
        toUserId: peerId,
        contextToken,
        text: caption,
      });
    }
  }

  async sendTextReply({ baseUrl, token, toUserId, contextToken, text }) {
    const body = JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: crypto.randomUUID?.() ?? `${Date.now()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: text ? [{ type: 1, text_item: { text } }] : [],
      },
      base_info: { channel_version: "ironclaw-weixin-bridge" },
    });
    const headers = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 100000)), "utf8").toString("base64"),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(`sendmessage failed: ${response.status}`);
    }
    this.logger.info(`Weixin text reply sent to ${toUserId}`);
  }

  async sendMediaReply({ baseUrl, token, toUserId, contextToken, filePath, text }) {
    const mime = getMimeFromFilename(filePath);
    const mediaType = mime.startsWith("video/")
      ? 2
      : mime.startsWith("image/")
        ? 1
        : 3;
    const uploaded = await uploadFileToWeixin({
      filePath,
      toUserId,
      baseUrl,
      token,
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      mediaType,
      fetchImpl: this.fetchImpl,
    });

    const item =
      mediaType === 1
        ? {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: uploaded.fileSizeCiphertext,
            },
          }
        : mediaType === 2
          ? {
              type: 5,
              video_item: {
                media: {
                  encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                  aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
                  encrypt_type: 1,
                },
                video_size: uploaded.fileSizeCiphertext,
              },
            }
          : {
              type: 4,
              file_item: {
                media: {
                  encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                  aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
                  encrypt_type: 1,
                },
                file_name: filePath.split("/").pop(),
                len: String(uploaded.fileSize),
              },
            };

    const items = [];
    if (text) items.push({ type: 1, text_item: { text } });
    items.push(item);

    for (const entry of items) {
      const body = JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [entry],
        },
        base_info: { channel_version: "ironclaw-weixin-bridge" },
      });
      const headers = {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 100000)), "utf8").toString("base64"),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`sendmessage failed: ${response.status}`);
      }
    }
    this.logger.info(`Weixin media reply sent to ${toUserId} from ${filePath}`);
  }
}
