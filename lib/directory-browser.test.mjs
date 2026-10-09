import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Through jiti, as the other lib tests load their subject: the module graph then
// resolves the extensionless local imports the bundler and jiti both accept.
const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./directory-browser.ts");
}

const { homeDir } = await jiti.import("./home-dir.ts");

test("lists directories and directory symlinks without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    await symlink(path.join(root, "project"), path.join(root, "linked-project"));

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const {
    getBrowseStartDirectory,
    normalizeDirectory,
    resolveDirectory,
    shouldShowWindowsDrivePicker,
  } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homeDir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "linux"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.equal(normalizeDirectory("~/project"), path.join(homeDir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `pi-web-missing-${Date.now()}`)));
});

test("builds every Windows drive-letter candidate", async () => {
  const { getWindowsDriveCandidates } = await loadSubject();
  const drives = getWindowsDriveCandidates();

  assert.equal(drives.length, 26);
  assert.deepEqual(drives[0], { name: "A:", path: "A:\\" });
  assert.deepEqual(drives.at(-1), { name: "Z:", path: "Z:\\" });
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});

test("creates one direct child directory and returns its resolved path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-create-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { createDirectory, resolveDirectory } = await loadSubject();
  const createdPath = await createDirectory(root, "new-project");

  assert.equal(createdPath, await resolveDirectory(path.join(root, "new-project")));
  await assert.rejects(createDirectory(root, "new-project"), { code: "EEXIST" });
});

test("new directory names cannot escape the current directory", async () => {
  const { isValidDirectoryName } = await loadSubject();

  assert.equal(isValidDirectoryName("project"), true);
  assert.equal(isValidDirectoryName("project name"), true);
  assert.equal(isValidDirectoryName(""), false);
  assert.equal(isValidDirectoryName("."), false);
  assert.equal(isValidDirectoryName(".."), false);
  assert.equal(isValidDirectoryName("../outside"), false);
  assert.equal(isValidDirectoryName("nested/directory"), false);
  assert.equal(isValidDirectoryName("nested\\directory"), false);
  assert.equal(isValidDirectoryName("bad\0name"), false);
});
