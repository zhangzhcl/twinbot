const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalWorkspaceGuard } = require('../dist/localWorkspace.js');
const { LocalFileTools } = require('../dist/localFileTools.js');

async function createWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('local fs.list returns entries with sizes and NOT_FOUND for missing paths', async (t) => {
  const root = await createWorkspace(t);
  const tools = new LocalFileTools(new LocalWorkspaceGuard(root));
  const notePath = path.join(root, 'note.txt');
  await fs.writeFile(notePath, 'local note');

  const listed = await tools.handlers()['fs.list']({ path: root });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.data.entries, [{
    name: 'note.txt',
    path: notePath,
    type: 'file',
    size: 10,
  }]);

  const missing = await tools.handlers()['fs.list']({ path: path.join(root, 'nope') });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.match(missing.error.message, /^Directory not found/);
});

test('local fs.write and fs.edit operate on absolute paths', async (t) => {
  const root = await createWorkspace(t);
  const tools = new LocalFileTools(new LocalWorkspaceGuard(root));
  const target = path.join(root, 'nested', 'file.txt');

  const written = await tools.handlers()['fs.write']({
    path: target,
    content: 'local write',
    createDirs: true,
  });
  assert.deepEqual(written, {
    ok: true,
    data: { path: target, bytesWritten: 11 },
  });

  const edited = await tools.handlers()['fs.edit']({
    path: target,
    oldText: 'local',
    newText: 'remote',
  });
  assert.deepEqual(edited, {
    ok: true,
    data: { path: target, replacements: 1 },
  });
  assert.equal(await fs.readFile(target, 'utf8'), 'remote write');

  const ambiguous = await tools.handlers()['fs.edit']({
    path: target,
    oldText: 'e',
    newText: 'x',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, 'INVALID_ARGS');
});

test('local fs.glob and fs.grep search the given directory tree', async (t) => {
  const root = await createWorkspace(t);
  const tools = new LocalFileTools(new LocalWorkspaceGuard(root));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'alpha token\n');
  await fs.writeFile(path.join(root, 'src', 'b.md'), '# alpha doc\n');

  const globbed = await tools.handlers()['fs.glob']({ pattern: 'src/*.ts', path: root });
  assert.deepEqual(globbed.data.matches, [path.join(root, 'src', 'a.ts')]);

  const grepped = await tools.handlers()['fs.grep']({ pattern: 'alpha', path: root });
  assert.equal(grepped.ok, true);
  assert.equal(grepped.data.matches.length, 2);
  assert.equal(grepped.data.truncated, false);
});

test('local notebook tools read and edit .ipynb files', async (t) => {
  const root = await createWorkspace(t);
  const tools = new LocalFileTools(new LocalWorkspaceGuard(root));
  const notebookPath = path.join(root, 'work.ipynb');
  await fs.writeFile(notebookPath, JSON.stringify({
    cells: [
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: 'x = 1' },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }));

  const read = await tools.handlers()['notebook.read']({ path: notebookPath });
  assert.equal(read.ok, true);
  assert.equal(read.data.cellCount, 1);
  assert.equal(read.data.cells[0].source, 'x = 1');

  const replaced = await tools.handlers()['notebook.edit']({
    path: notebookPath,
    mode: 'replace',
    cellIndex: 0,
    cellContent: 'x = 2',
  });
  assert.deepEqual(replaced, {
    ok: true,
    data: { path: notebookPath, cellCount: 1 },
  });

  const invalid = await tools.handlers()['notebook.read']({
    path: path.join(root, 'broken.ipynb'),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'NOT_FOUND');
});
