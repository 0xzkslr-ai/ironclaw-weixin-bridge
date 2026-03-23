import { parseSseStream } from "./sse.mjs";
import { sleep, truncate } from "./util.mjs";

export class IronclawClient {
  constructor({
    baseUrl,
    gatewayToken,
    responseTimeoutMs = 300000,
    reconnectDelayMs = 1500,
    fetchImpl = fetch,
    logger,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.gatewayToken = gatewayToken;
    this.responseTimeoutMs = responseTimeoutMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.pending = new Map();
    this.running = false;
    this.eventLoopPromise = null;
    this.abortController = null;
  }

  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.gatewayToken}`,
    };
  }

  async requestJson(path, { method = "GET", body } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`IronClaw ${path} failed: ${response.status} ${truncate(text, 240)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async doctor() {
    return this.requestJson("/api/chat/threads");
  }

  async createThread() {
    return this.requestJson("/api/chat/thread/new", { method: "POST" });
  }

  async sendMessage({ threadId, content }) {
    return this.requestJson("/api/chat/send", {
      method: "POST",
      body: {
        content,
        thread_id: threadId,
      },
    });
  }

  async sendRichMessage({ threadId, content, images = [] }) {
    return this.requestJson("/api/chat/send", {
      method: "POST",
      body: {
        content,
        thread_id: threadId,
        images,
      },
    });
  }

  async getHistory(threadId) {
    return this.requestJson(`/api/chat/history?thread_id=${encodeURIComponent(threadId)}`);
  }

  async start(signal) {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    if (signal) {
      signal.addEventListener(
        "abort",
        () => this.stop(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    }
    this.eventLoopPromise = this.runEventLoop();
  }

  async stop(reason = new Error("stopped")) {
    this.running = false;
    this.abortController?.abort(reason);
    this.rejectAllPending(reason);
    await this.eventLoopPromise;
  }

  rejectAllPending(error) {
    for (const waiters of this.pending.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.pending.clear();
  }

  enqueueWaiter(threadId, waiter) {
    const list = this.pending.get(threadId) ?? [];
    list.push(waiter);
    this.pending.set(threadId, list);
  }

  completeWaiter(threadId, payload) {
    const list = this.pending.get(threadId);
    if (!list?.length) return false;
    const waiter = list.shift();
    if (list.length === 0) this.pending.delete(threadId);
    else this.pending.set(threadId, list);
    waiter.finish(payload);
    return true;
  }

  rejectWaiter(threadId, error) {
    const list = this.pending.get(threadId);
    if (!list?.length) return false;
    const waiter = list.shift();
    if (list.length === 0) this.pending.delete(threadId);
    else this.pending.set(threadId, list);
    waiter.reject(error);
    return true;
  }

  async waitForResponse(threadId, timeoutMs = this.responseTimeoutMs, options = {}) {
    const baselineTurnCount = options.baselineTurnCount ?? 0;
    const ssePromise = new Promise((resolve, reject) => {
      const state = {
        text: null,
        images: [],
        localPaths: [],
        settled: false,
        timer: null,
      };
      const timer = setTimeout(() => {
        this.rejectWaiter(threadId, new Error(`Timed out waiting for response on thread ${threadId}`));
      }, timeoutMs);

      this.enqueueWaiter(threadId, {
        state,
        finish: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    const pollPromise = this.pollForTerminalTurn(threadId, timeoutMs, baselineTurnCount);
    return Promise.race([ssePromise, pollPromise]);
  }

  async runEventLoop() {
    while (this.running) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/chat/events?token=${encodeURIComponent(this.gatewayToken)}`,
          {
            signal: this.abortController?.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(`SSE connect failed: ${response.status}`);
        }
        for await (const event of parseSseStream(response.body)) {
          this.handleEvent(event);
        }
      } catch (error) {
        if (!this.running) break;
        if (error?.name === "AbortError") break;
        this.logger?.warn?.("IronClaw SSE disconnected", String(error));
        await sleep(this.reconnectDelayMs);
      }
    }
  }

  handleEvent(event) {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    const threadId = parsed.thread_id;
    if (!threadId) return;

    switch (event.event) {
      case "response":
        this.noteThreadResponse(threadId, parsed.content);
        break;
      case "image_generated":
        this.noteThreadImage(threadId, parsed);
        break;
      case "error":
        this.rejectWaiter(threadId, new Error(parsed.message || `IronClaw error on thread ${threadId}`));
        break;
      case "approval_needed":
        this.rejectWaiter(
          threadId,
          new Error(`Tool approval required for ${parsed.tool_name || "unknown tool"}`),
        );
        break;
      default:
        break;
    }
  }

  noteThreadResponse(threadId, content) {
    const waiter = this.pending.get(threadId)?.[0];
    if (!waiter) return;
    waiter.state.text = content;
    this.scheduleSettle(threadId, waiter);
  }

  noteThreadImage(threadId, payload) {
    const waiter = this.pending.get(threadId)?.[0];
    if (!waiter) return;
    if (payload.data_url) waiter.state.images.push(payload.data_url);
    if (payload.path) waiter.state.localPaths.push(payload.path);
    this.scheduleSettle(threadId, waiter);
  }

  scheduleSettle(threadId, waiter) {
    if (waiter.state.settled) return;
    if (waiter.state.timer) clearTimeout(waiter.state.timer);
    waiter.state.timer = setTimeout(() => {
      waiter.state.settled = true;
      this.completeWaiter(threadId, {
        text: waiter.state.text ?? "",
        imageDataUrls: waiter.state.images.slice(),
        localPaths: waiter.state.localPaths.slice(),
      });
    }, 700);
  }

  async pollForTerminalTurn(threadId, timeoutMs, baselineTurnCount = 0) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(2000);
      const history = await this.getHistory(threadId);
      const turns = history?.turns;
      if (!Array.isArray(turns) || turns.length === 0) continue;
      if (turns.length <= baselineTurnCount) continue;
      const latest = turns[turns.length - 1];
      if (latest.state === "Completed" && latest.response) {
        return {
          text: latest.response,
          imageDataUrls: [],
          localPaths: [],
        };
      }
      if (latest.state === "Failed") {
        throw new Error("IronClaw turn failed before producing a reply");
      }
    }
    throw new Error(`Timed out waiting for response on thread ${threadId}`);
  }
}
