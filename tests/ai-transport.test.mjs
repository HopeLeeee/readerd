import test from "node:test";
import assert from "node:assert/strict";
import { createChatTransport } from "../electron/ai-transport.mjs";

test("unsupported optional fields are removed only with explicit evidence and learned per model", async () => {
  const requests = [];
  const chat = createChatTransport(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const field = ["enable_thinking", "reasoning_effort", "temperature"].find(
      (key) => Object.hasOwn(body, key),
    );
    return {
      ok: !field,
      status: field ? 400 : 200,
      json: async () =>
        field
          ? { error: { param: field, code: "unsupported_parameter" } }
          : { choices: [] },
    };
  });
  const body = {
    model: "one",
    enable_thinking: false,
    reasoning_effort: "none",
    temperature: 0,
    messages: [],
  };
  await chat("https://example.test/v1", body);
  assert.equal(requests.length, 4);
  await chat("https://example.test/v1", body);
  assert.equal(requests.length, 5);
  assert.deepEqual(Object.keys(requests.at(-1)), ["model", "messages"]);
  await chat("https://example.test/v1", { ...body, model: "two" });
  assert.equal(requests.length, 9);
  assert.equal(body.enable_thinking, false);
});

test("auth, rate limits, network errors and unrelated bad requests never trigger retries", async () => {
  for (const status of [400, 401, 429, 500]) {
    let calls = 0;
    const chat = createChatTransport(async () => {
      calls++;
      return {
        ok: false,
        status,
        json: async () => ({ error: { message: "Invalid model" } }),
      };
    });
    await assert.rejects(
      chat("https://example.test", { model: "test", enable_thinking: false }),
      new RegExp(String(status)),
    );
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    createChatTransport(async () => {
      called = true;
    })("https://example.test", {}, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(called, false);
});
