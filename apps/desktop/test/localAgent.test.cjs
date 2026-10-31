const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listLocalDirectory } = require('../dist/localFileTools.js');

test('fs.list returns the immediate entries of an approved directory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-fs-list-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'subdirectory'));
  await fs.writeFile(path.join(directory, 'note.txt'), 'private content');

  const result = await listLocalDirectory({ path: directory });

  assert.equal(result.ok, true);
  assert.equal(result.data.path, directory);
  assert.deepEqual(result.data.entries.map(({ name, type }) => ({ name, type })).sort(
    (left, right) => left.name.localeCompare(right.name),
  ), [
    { name: 'note.txt', type: 'file' },
    { name: 'subdirectory', type: 'directory' },
  ]);
});

test('fs.list returns NOT_FOUND for a missing directory', async () => {
  const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}`);
  const result = await listLocalDirectory({ path: missingPath });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `Directory not found: ${missingPath}`,
    },
  });
});
