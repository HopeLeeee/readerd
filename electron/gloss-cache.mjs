import fs from "node:fs/promises";
import core from "../src/words/readerc-core.js";
import { atomicWrite } from "./storage.mjs";

const MAX_RECORDS = 5000;
const MAX_KEY_LENGTH = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCES = new Set(["persistent", "context", "prefetch"]);

function snapshot(entries) {
  if (!Array.isArray(entries)) throw new TypeError("词释缓存必须是数组。");
  const result = [];
  const seen = new Set();
  let bytes = 2;
  // Retain the most recent entries when either budget is reached.
  for (let index = entries.length - 1; index >= 0; index--) {
    if (result.length === MAX_RECORDS) break;
    const entry = entries[index];
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (
      typeof key !== "string" ||
      !key.length ||
      key.length > MAX_KEY_LENGTH ||
      RESERVED_KEYS.has(key) ||
      seen.has(key) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "gloss") ||
      !core.saneGloss(value.gloss)
    )
      continue;
    const clean = [
      key,
      {
        gloss: value.gloss.trim(),
        source:
          Object.hasOwn(value, "source") && SOURCES.has(value.source)
            ? value.source
            : "persistent",
      },
    ];
    const size =
      Buffer.byteLength(JSON.stringify(clean), "utf8") +
      (result.length ? 1 : 0);
    if (bytes + size > MAX_BYTES) break;
    bytes += size;
    seen.add(key);
    result.push(clean);
  }
  return result.reverse();
}

export function createGlossCacheStore(file) {
  let pending = Promise.resolve();
  return {
    async load() {
      await pending.catch(() => {});
      try {
        if ((await fs.stat(file)).size > MAX_BYTES) return [];
        const buffer = await fs.readFile(file);
        if (buffer.length > MAX_BYTES) return [];
        return snapshot(JSON.parse(buffer.toString("utf8")));
      } catch {
        // A cache is disposable; missing, corrupt or unreadable data must not
        // prevent the reader from opening or alter any original PDF files.
        return [];
      }
    },
    save(entries) {
      // Copy before queuing so callers can continue mutating their in-memory Map.
      let data;
      try {
        data = JSON.stringify(snapshot(entries));
      } catch (error) {
        return Promise.reject(error);
      }
      const write = pending.catch(() => {}).then(() => atomicWrite(file, data));
      pending = write;
      return write;
    },
  };
}
