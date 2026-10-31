const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CloudRuntimeFileTools } = require('../dist/runtimeFileTools.js');
const { WorkspaceGuard } = require('../dist/runtimeWorkspace.js');

function createTools(root) {
  return new CloudRuntimeFileTools(new WorkspaceGuard(root));
}

test('runtime reads files and lists directories only inside its workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'note.txt'), 'cloud note');
  const tools = createTools(root);

  assert.deepEqual(await tools.read({ path: 'docs/note.txt' }), {
    ok: true,
    data: {
      path: 'docs/note.txt',
      content: 'cloud note',
      encoding: 'utf8',
      size: 10,
    },
  });
  assert.deepEqual(await tools.list({ path: 'docs' }), {
    ok: true,
    data: {
      path: 'docs',
      entries: [{
        name: 'note.txt',
        path: 'docs/note.txt',
        type: 'file',
        size: 10,
      }],
    },
  });
});

test('runtime rejects paths that escape its workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  });
  await fs.writeFile(outside, 'private');
  const tools = createTools(root);

  const result = await tools.read({ path: `..\\${path.basename(outside)}` });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
});

test('runtime refuses a symlink that targets outside its workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  });
  await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(root, 'outside.txt'));
  const tools = createTools(root);

  const result = await tools.read({ path: 'outside.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
});

test('runtime writes files with optional parent directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createTools(root);

  const written = await tools.write({
    path: 'nested/dir/file.txt',
    content: 'hello runtime',
    createDirs: true,
  });
  assert.deepEqual(written, {
    ok: true,
    data: { path: 'nested/dir/file.txt', bytesWritten: 13 },
  });
  const content = await fs.readFile(path.join(root, 'nested', 'dir', 'file.txt'), 'utf8');
  assert.equal(content, 'hello runtime');

  // 未开启 createDirs 时父目录缺失应报 NOT_FOUND
  const missing = await tools.write({ path: 'other/file.txt', content: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');

  // 写入不允许逃逸工作区
  const escaping = await tools.write({ path: '../escape.txt', content: 'x' });
  assert.equal(escaping.ok, false);
  assert.equal(escaping.error.code, 'PERMISSION_DENIED');
});

test('runtime edits files with exact unique replacement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createTools(root);
  await fs.writeFile(path.join(root, 'app.js'), 'const a = 1;\nconst a = 2;\n');

  const notFound = await tools.edit({ path: 'app.js', oldText: 'missing', newText: 'x' });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error.code, 'NOT_FOUND');

  const ambiguous = await tools.edit({ path: 'app.js', oldText: 'const a', newText: 'const b' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, 'INVALID_ARGS');

  const replaced = await tools.edit({
    path: 'app.js',
    oldText: 'const a',
    newText: 'const b',
    replaceAll: true,
  });
  assert.deepEqual(replaced, {
    ok: true,
    data: { path: 'app.js', replacements: 2 },
  });
  const content = await fs.readFile(path.join(root, 'app.js'), 'utf8');
  assert.equal(content, 'const b = 1;\nconst b = 2;\n');
});

test('runtime matches files by glob pattern', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createTools(root);
  await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'deep', 'b.test.ts'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'deep', 'c.txt'), 'plain\n');

  const result = await tools.glob({ pattern: 'src/**/*.ts' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.matches.sort(), ['src/a.ts', 'src/deep/b.test.ts']);
  assert.equal(result.data.truncated, false);
});

test('runtime greps files with bounded traversal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createTools(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'one.txt'), 'alpha line\nbeta line\n');
  await fs.writeFile(path.join(root, 'src', 'two.txt'), 'alpha again\n');

  const result = await tools.grep({ pattern: 'alpha' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.matches, [
    { file: 'src/one.txt', line: 1, column: 1, text: 'alpha line' },
    { file: 'src/two.txt', line: 1, column: 1, text: 'alpha again' },
  ]);
  assert.equal(result.data.truncated, false);

  // maxResults 截断
  const capped = await tools.grep({ pattern: 'alpha', maxResults: 1 });
  assert.equal(capped.data.matches.length, 1);
  assert.equal(capped.data.truncated, true);
});

test('runtime reads and edits notebook cells', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createTools(root);
  const notebookPath = path.join(root, 'analysis.ipynb');
  await fs.writeFile(notebookPath, JSON.stringify({
    cells: [
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: 'print(1)' },
      { cell_type: 'markdown', metadata: {}, source: '# Title' },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }));

  const read = await tools.notebookRead({ path: 'analysis.ipynb' });
  assert.equal(read.ok, true);
  assert.equal(read.data.cellCount, 2);
  assert.deepEqual(read.data.cells[0], {
    index: 0,
    type: 'code',
    source: 'print(1)',
    outputs: [],
    truncated: false,
  });

  const inserted = await tools.notebookEdit({
    path: 'analysis.ipynb',
    mode: 'insert',
    cellIndex: 1,
    cellContent: '## Section',
    cellType: 'markdown',
  });
  assert.deepEqual(inserted, { ok: true, data: { path: 'analysis.ipynb', cellCount: 3 } });

  const deleted = await tools.notebookEdit({
    path: 'analysis.ipynb',
    mode: 'delete',
    cellIndex: 0,
  });
  assert.deepEqual(deleted, { ok: true, data: { path: 'analysis.ipynb', cellCount: 2 } });

  const outOfRange = await tools.notebookEdit({
    path: 'analysis.ipynb',
    mode: 'delete',
    cellIndex: 99,
  });
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error.code, 'INVALID_ARGS');
});
