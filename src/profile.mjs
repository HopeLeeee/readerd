const AUTO = /<!-- readerd:auto:start -->[\s\S]*?<!-- readerd:auto:end -->/;
const LEGACY_HISTORY =
  /<!-- readerd:history:start -->[\s\S]*?<!-- readerd:history:end -->/;
const FIELD_NAMES = {
  identity: "身份",
  direction: "研究方向",
  interests: "(?:感兴趣的主题|兴趣关键词)",
};
const CANONICAL_NAMES = {
  identity: "身份",
  direction: "研究方向",
  interests: "感兴趣的主题",
};

function fieldPattern(name, global = false) {
  return new RegExp(
    `^([\\t ]*(?:[-*][\\t ]*)?${name}[\\t ]*[：:][\\t ]*)([^\\r\\n]*)`,
    global ? "gm" : "m",
  );
}

function readHistory(block) {
  if (!block) return null;
  const source = block.match(/```(?:json)?[\t ]*\r?\n([\s\S]*?)```/i)?.[1];
  if (!source) return null;
  try {
    const value = JSON.parse(source);
    const history = Array.isArray(value) ? value : value?.history;
    return Array.isArray(history)
      ? history.filter(
          (entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry),
        )
      : null;
  } catch {
    return null;
  }
}

/** Read editable fields and the machine-owned JSON history without executing Markdown. */
export function parseProfile(markdown = "") {
  const text = String(markdown || "");
  const manual = text.replace(AUTO, "").replace(LEGACY_HISTORY, "");
  const get = (key) =>
    manual.match(fieldPattern(FIELD_NAMES[key]))?.[2].trim() || "";
  return {
    identity: get("identity"),
    direction: get("direction"),
    interests: get("interests")
      .split(/[,，、;；]/)
      .map((value) => value.trim())
      .filter(Boolean),
    history:
      readHistory(text.match(AUTO)?.[0]) ??
      readHistory(text.match(LEGACY_HISTORY)?.[0]) ??
      [],
  };
}

const singleLine = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();

/** historyOnly replaces only the explicitly owned auto region; all other bytes survive. */
export function updateProfile(
  markdown = "",
  profile = {},
  { historyOnly = false } = {},
) {
  let text = String(markdown || "");
  const previous = parseProfile(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const history = Array.isArray(profile.history)
    ? profile.history
    : previous.history;
  const json = JSON.stringify(history, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/`/g, "\\u0060")
    .replace(/\n/g, newline);
  const automatic = [
    "<!-- readerd:auto:start -->",
    "## 最近阅读记录",
    "",
    "```json",
    json,
    "```",
    "<!-- readerd:auto:end -->",
  ].join(newline);

  if (!historyOnly) {
    // Hide the auto region while locating manual fields, so JSON values cannot
    // accidentally be mistaken for editable Markdown field lines.
    const originalAuto = text.match(AUTO)?.[0];
    let before = originalAuto
      ? text.slice(0, text.indexOf(originalAuto))
      : text;
    let after = originalAuto
      ? text.slice(text.indexOf(originalAuto) + originalAuto.length)
      : "";
    const missing = [];
    for (const key of Object.keys(FIELD_NAMES)) {
      const supplied = Object.hasOwn(profile, key)
        ? profile[key]
        : previous[key];
      const value =
        key === "interests"
          ? singleLine(Array.isArray(supplied) ? supplied.join("，") : supplied)
          : singleLine(supplied);
      const expression = fieldPattern(FIELD_NAMES[key], true);
      const exists =
        fieldPattern(FIELD_NAMES[key]).test(before) ||
        fieldPattern(FIELD_NAMES[key]).test(after);
      if (exists) {
        before = before.replace(
          expression,
          (_match, prefix) => `${prefix}${value}`,
        );
        after = after.replace(
          fieldPattern(FIELD_NAMES[key], true),
          (_match, prefix) => `${prefix}${value}`,
        );
      } else missing.push(`- ${CANONICAL_NAMES[key]}：${value}`);
    }
    if (missing.length)
      before += `${before && !before.endsWith("\n") ? newline : ""}${missing.join(newline)}${newline}${newline}`;
    text = before + (originalAuto || "") + after;
  }
  if (AUTO.test(text)) return text.replace(AUTO, () => automatic);
  return (
    text +
    (text && !text.endsWith("\n") ? newline : "") +
    (text ? newline : "") +
    automatic +
    newline
  );
}
