// Learn unsupported optional fields per endpoint/model. Never retry auth,
// quota, network, or arbitrary server errors as compatibility failures.
export function createChatTransport(fetchImpl) {
  const omitted = new Map();
  const optional = ["enable_thinking", "reasoning_effort", "temperature"];
  return async function chat(url, body, { key = "", signal } = {}) {
    const scope = JSON.stringify([String(url), body.model]);
    const excluded = new Set(omitted.get(scope) || []);
    for (let attempt = 0; attempt <= optional.length; attempt++) {
      signal?.throwIfAborted();
      const request = { ...body };
      for (const name of excluded) delete request[name];
      const response = await fetchImpl(String(url), {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(request),
      });
      const result = await response.json().catch(() => null);
      if (response.ok) {
        omitted.delete(scope);
        omitted.set(scope, [...excluded]);
        while (omitted.size > 128) omitted.delete(omitted.keys().next().value);
        return result;
      }
      const error = result?.error;
      const message = typeof error === "string" ? error : error?.message || "";
      const evidence = `${error?.code || ""} ${message}`;
      const unsupported =
        /unsupported|not[_ ]supported|not allowed|unknown (?:field|parameter)|unrecognized|unexpected (?:field|parameter)|extra inputs are not permitted/i.test(
          evidence,
        );
      const field = optional.find(
        (name) =>
          Object.hasOwn(request, name) &&
          !excluded.has(name) &&
          (error?.param === name || new RegExp(`\\b${name}\\b`).test(message)),
      );
      if ([400, 422].includes(response.status) && unsupported && field) {
        excluded.add(field);
        continue;
      }
      throw new Error(`AI 服务请求失败（HTTP ${response.status}）。`);
    }
    throw new Error("AI 服务不支持当前请求参数。");
  };
}
