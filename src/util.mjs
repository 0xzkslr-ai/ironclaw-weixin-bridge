import os from "node:os";
import path from "node:path";

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function resolveDefaultStateDir() {
  return path.join(os.homedir(), ".ironclaw-weixin-bridge");
}

export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

export function nowIso() {
  return new Date().toISOString();
}

export function createLogger({ quiet = false } = {}) {
  function write(level, message, extra) {
    if (quiet && level === "debug") return;
    const parts = [`[${new Date().toISOString()}]`, level.toUpperCase(), message];
    if (extra != null) {
      parts.push(typeof extra === "string" ? extra : JSON.stringify(extra));
    }
    console.error(parts.join(" "));
  }

  return {
    debug(message, extra) {
      write("debug", message, extra);
    },
    info(message, extra) {
      write("info", message, extra);
    },
    warn(message, extra) {
      write("warn", message, extra);
    },
    error(message, extra) {
      write("error", message, extra);
    },
  };
}

export function truncate(text, max = 120) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
