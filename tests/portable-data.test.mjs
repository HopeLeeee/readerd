import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dataDirFor,
  isWritableDirectory,
  migrateLegacyData,
  preparePortableDataDir,
  MIGRATED_FILES,
} from "../electron/portable-data.mjs";

test("portable data directory is the ReaderD-data folder beside the executable", () => {
  assert.equal(
    dataDirFor("C:\\Apps\\ReaderD"),
    path.join("C:\\Apps\\ReaderD", "ReaderD-data"),
  );
  assert.equal(dataDirFor("relative"), null);
  assert.equal(dataDirFor(""), null);
});

test("packaged and launcher modes choose a writable directory next to the app", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-portable-"));
  try {
    const appDir = path.join(root, "ReaderD");
    const appData = path.join(root, "AppData");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(appData, { recursive: true });
    const exe = path.join(appDir, "ReaderD.exe");
    await fs.writeFile(exe, "fixture");

    const byExecutable = preparePortableDataDir({
      environment: {},
      isPackaged: true,
      execPath: exe,
      appDataDir: appData,
    });
    assert.equal(byExecutable.path, path.join(appDir, "ReaderD-data"));
    assert.ok(isWritableDirectory(byExecutable.path));

    const other = path.join(root, "Portable");
    const byLauncher = preparePortableDataDir({
      environment: { PORTABLE_EXECUTABLE_DIR: other },
      isPackaged: true,
      execPath: exe,
      appDataDir: appData,
    });
    assert.equal(byLauncher.path, path.join(other, "ReaderD-data"));

    assert.equal(
      preparePortableDataDir({
        environment: {},
        isPackaged: false,
        execPath: exe,
        appDataDir: appData,
      }),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("first portable launch migrates settings, credentials, profile, cache and Local State once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-migrate-"));
  try {
    const appDir = path.join(root, "ReaderD");
    const legacy = path.join(root, "AppData", "readerd");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(legacy, { recursive: true });
    const values = {
      "settings.json": '{"endpoint":"https://example.test/v1"}',
      "ai-key.bin": Buffer.from("encrypted-key"),
      "reading-profile.md": "# profile\n",
      "gloss-cache.json": "{}",
      "Local State": '{"os_crypt":{"encrypted_key":"x"}}',
    };
    for (const [name, value] of Object.entries(values))
      await fs.writeFile(path.join(legacy, name), value);
    await fs.mkdir(path.join(legacy, "Cache"), { recursive: true });
    await fs.writeFile(path.join(legacy, "Cache", "data"), "cache");

    const prepared = preparePortableDataDir({
      environment: { PORTABLE_EXECUTABLE_DIR: appDir },
      isPackaged: true,
      execPath: path.join(appDir, "ReaderD.exe"),
      appDataDir: path.join(root, "AppData"),
    });
    assert.equal(prepared.path, path.join(appDir, "ReaderD-data"));
    for (const name of MIGRATED_FILES) {
      assert.equal(
        await fs
          .readFile(path.join(prepared.path, name), "utf8")
          .then((text) => text.length > 0),
        true,
      );
    }
    await assert.rejects(fs.stat(path.join(prepared.path, "Cache")), /ENOENT/);

    await fs.writeFile(
      path.join(prepared.path, "settings.json"),
      "new-settings",
    );
    const again = preparePortableDataDir({
      environment: { PORTABLE_EXECUTABLE_DIR: appDir },
      isPackaged: true,
      execPath: path.join(appDir, "ReaderD.exe"),
      appDataDir: path.join(root, "AppData"),
    });
    assert.equal(
      await fs.readFile(path.join(again.path, "settings.json"), "utf8"),
      "new-settings",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migration ignores an unwritable location and reports no copied files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readerd-blocked-"));
  try {
    const blocked = path.join(root, "blocked");
    await fs.writeFile(blocked, "not a directory");
    const target = path.join(blocked, "ReaderD-data");
    assert.equal(isWritableDirectory(target), false);
    assert.deepEqual(
      migrateLegacyData(path.join(root, "old"), target, ["settings.json"]),
      [],
    );
    assert.equal(
      preparePortableDataDir({
        environment: { PORTABLE_EXECUTABLE_DIR: blocked },
        isPackaged: true,
        execPath: path.join(root, "ReaderD.exe"),
        appDataDir: path.join(root, "AppData"),
      }),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
