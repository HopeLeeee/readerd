import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_PROFILE = `# readerd 阅读画像\n\n## 手动填写（自动更新不会覆盖此区域）\n\n- 身份：\n- 研究方向：\n- 感兴趣的主题：\n\n<!-- readerd:auto:start -->\n## 最近阅读记录\n\n暂无记录。\n<!-- readerd:auto:end -->\n`;

export async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data);
    // Windows antivirus/indexers can briefly hold the destination. Retry the
    // replace instead of failing a settings or gloss-cache write.
    const delays = [20, 50, 100, 200];
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        if (
          !["EPERM", "EBUSY", "EACCES"].includes(error.code) ||
          attempt >= delays.length
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function mergeProfileAutomatic(existing, replacement) {
  const expression =
    /<!-- readerd:auto:start -->[\s\S]*?<!-- readerd:auto:end -->/;
  const automatic = replacement.match(expression)?.[0];
  if (!automatic) throw new Error("自动更新内容缺少 readerd 标记。");
  return expression.test(existing)
    ? existing.replace(expression, () => automatic)
    : `${existing.trimEnd()}\n\n${automatic}\n`;
}

export function validateEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error("AI 地址必须使用 HTTPS，或本机 HTTP 服务。");
  }
  if (url.username || url.password)
    throw new Error("AI 地址不能包含登录凭据。");
  return url;
}

export function normalizeAnnotations(annotations, pageCount) {
  if (!Array.isArray(annotations) || annotations.length > 20000)
    throw new Error("批注列表无效。");
  return annotations.map((item) => {
    if (!["highlight", "underline", "note"].includes(item.type))
      throw new Error("不支持的批注类型。");
    if (!Number.isInteger(item.page) || item.page < 1 || item.page > pageCount)
      throw new Error("批注页码无效。");
    if (
      !Array.isArray(item.rects) ||
      !item.rects.length ||
      item.rects.length > 1000
    )
      throw new Error("批注位置无效。");
    const rects = item.rects.map(({ x, y, width, height }) => {
      if (
        ![x, y, width, height].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
      )
        throw new Error("批注坐标无效。");
      return { x, y, width, height };
    });
    if (
      item.coordinateSpace &&
      !["pdf", "legacy-top-left"].includes(item.coordinateSpace)
    )
      throw new Error("批注坐标系无效。");
    if (item.anchor && ![item.anchor.x, item.anchor.y].every(Number.isFinite))
      throw new Error("批注锚点无效。");
    return {
      id: String(item.id ?? ""),
      type: item.type,
      page: item.page,
      rects,
      ...(item.type === "note" && item.anchor
        ? { anchor: { x: item.anchor.x, y: item.anchor.y } }
        : {}),
      coordinateSpace: item.coordinateSpace ?? "legacy-top-left",
      text: String(item.text ?? "").slice(0, 100000),
      createdAt: item.createdAt,
    };
  });
}
