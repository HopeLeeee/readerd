import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read filename arguments only; never interpret switches or remote URLs. */
export function pdfPathsFromArguments(argv, cwd = process.cwd()) {
  const files = [];
  for (const argument of argv) {
    if (typeof argument !== "string") continue;
    let value = argument.trim();
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    if (!value || value.startsWith("-")) continue;
    if (/^file:/i.test(value)) {
      try {
        const url = new URL(value);
        url.hash = "";
        url.search = "";
        value = fileURLToPath(url);
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) continue;
    if (path.extname(value).toLowerCase() !== ".pdf") continue;
    const file = path.resolve(cwd, value);
    if (
      !files.some((existing) =>
        process.platform === "win32"
          ? existing.toLowerCase() === file.toLowerCase()
          : existing === file,
      )
    )
      files.push(file);
  }
  return files;
}
