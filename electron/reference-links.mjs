// Resolve only explicit user clicks. No PDF text or reading profile is sent.
const resolved = new Map();

export function normalizeDoi(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let doi = value
    .trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "");
  try {
    doi = decodeURIComponent(doi);
  } catch {
    return null;
  }
  doi = doi.replace(/\s+/g, "").replace(/[.,;]+$/, "");
  if (!/^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(doi)) return null;
  // Parentheses are valid in DOI suffixes; drop only unmatched closing punctuation.
  while (
    doi.endsWith(")") &&
    (doi.match(/\)/g)?.length ?? 0) > (doi.match(/\(/g)?.length ?? 0)
  )
    doi = doi.slice(0, -1);
  return doi.toLowerCase();
}

function normalized(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function titleSimilarity(a, b) {
  a = normalized(a);
  b = normalized(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 1500 || b.length > 1500) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function firstAuthorMatches(authors, item) {
  const family = normalized(item.author?.[0]?.family);
  if (!family || !authors) return true;
  const first = Array.isArray(authors)
    ? authors[0]
    : String(authors).split(/[,;，；]|\band\b|\bet al\b/i)[0];
  const text = normalized(
    typeof first === "object" ? (first.family ?? first.name) : first,
  );
  return ` ${text} `.includes(` ${family} `);
}

function publicationYears(item) {
  return [item.published, item["published-print"], item["published-online"]]
    .map((date) => date?.["date-parts"]?.[0]?.[0])
    .filter(Number.isFinite);
}

export async function resolveReference(
  reference,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!reference || typeof reference !== "object")
    throw new Error("参考文献信息无效。");
  const supplied = normalizeDoi(reference.doi);
  if (supplied) return { doi: supplied, url: `https://doi.org/${supplied}` };
  const title =
    typeof reference.title === "string" ? reference.title.trim() : "";
  if (title.length < 8 || title.length > 1500)
    throw new Error("参考文献题名不完整，无法可靠查找 DOI。");
  const year = Number(reference.year) || null;
  const key = JSON.stringify([
    normalized(title),
    reference.authors ?? "",
    year,
  ]);
  if (resolved.has(key)) return resolved.get(key);
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.title", title);
  url.searchParams.set("rows", "5");
  url.searchParams.set(
    "select",
    "DOI,title,author,published,published-print,published-online",
  );
  if (reference.authors || year)
    url.searchParams.set(
      "query.bibliographic",
      [
        typeof reference.authors === "string"
          ? reference.authors.slice(0, 300)
          : "",
        year,
      ]
        .filter(Boolean)
        .join(" "),
    );
  let items;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    items = (await response.json()).message?.items;
    if (!Array.isArray(items)) throw new Error("invalid response");
  } catch {
    throw new Error("DOI 查询失败，请检查网络后重试。");
  }
  const short =
    normalized(title).split(" ").length < 5 || normalized(title).length < 30;
  const matches = items.filter((item) => {
    if (!normalizeDoi(item.DOI)) return false;
    if (titleSimilarity(title, item.title?.[0]) < (short ? 1 : 0.92))
      return false;
    const years = publicationYears(item);
    if (year && !years.some((candidate) => Math.abs(candidate - year) <= 1))
      return false;
    if (short && (!year || !reference.authors || !item.author?.[0]?.family))
      return false;
    return firstAuthorMatches(reference.authors, item);
  });
  // A preprint can share the final article title and authors. Prefer the supplied
  // exact publication year before considering the +/-1 online/print tolerance.
  const exactYear = year
    ? matches.filter((item) => publicationYears(item).includes(year))
    : [];
  const finalMatches = exactYear.length ? exactYear : matches;
  const dois = [...new Set(finalMatches.map((item) => normalizeDoi(item.DOI)))];
  if (dois.length !== 1)
    throw new Error("未找到唯一且可靠匹配的 DOI，请核对参考文献题名。");
  const result = { doi: dois[0], url: `https://doi.org/${dois[0]}` };
  if (resolved.size >= 500) resolved.delete(resolved.keys().next().value);
  resolved.set(key, result);
  return result;
}
