import fs from "node:fs";
import path from "node:path";

export const PORTABLE_DATA_DIR = "ReaderD-data";
export const MIGRATED_FILES = Object.freeze([
  "settings.json",
  "ai-key.bin",
  "reading-profile.md",
  "gloss-cache.json",
  "Local State",
]);

export function dataDirFor(baseDir) {
  if (typeof baseDir !== "string" || !path.isAbsolute(baseDir)) return null;
  return path.join(baseDir, PORTABLE_DATA_DIR);
}

export function isWritableDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(
      directory,
      `.readerd-write-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function migrateLegacyData(
  legacyDir,
  targetDir,
  fileNames = MIGRATED_FILES,
) {
  const copied = [];
  if (
    !legacyDir ||
    !targetDir ||
    path.resolve(legacyDir) === path.resolve(targetDir)
  )
    return copied;
  for (const name of fileNames) {
    const source = path.join(legacyDir, name);
    const destination = path.join(targetDir, name);
    try {
      if (!fs.statSync(source).isFile()) continue;
      if (fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      copied.push(name);
    } catch {
      /* Best-effort migration: a missing or locked old file is not fatal. */
    }
  }
  return copied;
}

/**
 * Choose the green data directory next to the executable. The portable
 * launcher exposes PORTABLE_EXECUTABLE_DIR; win-unpacked builds use their own
 * directory. Development runs keep Electron's normal AppData location.
 */
export function preparePortableDataDir({
  environment = process.env,
  isPackaged = false,
  execPath = process.execPath,
  appDataDir = "",
} = {}) {
  if (!isPackaged && !environment.PORTABLE_EXECUTABLE_DIR) return null;
  const base = environment.PORTABLE_EXECUTABLE_DIR
    ? path.resolve(environment.PORTABLE_EXECUTABLE_DIR)
    : path.dirname(execPath);
  const target = dataDirFor(base);
  if (!target || !isWritableDirectory(target)) return null;

  const legacyDirs = appDataDir
    ? [path.join(appDataDir, "readerd"), path.join(appDataDir, "ReaderD")]
    : [];
  const migrated = [];
  for (const legacyDir of legacyDirs)
    migrated.push(...migrateLegacyData(legacyDir, target));
  return { path: target, migrated };
}
