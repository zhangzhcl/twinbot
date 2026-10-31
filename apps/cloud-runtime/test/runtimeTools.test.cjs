const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeShellTools } = require('../dist/runtimeShellTools.js');
const { RuntimeCodeTools } = require('../dist/runtimeCodeTools.js');
const { RuntimeWebTools, parseDuckDuckGoHtml } = require('../dist/runtimeWebTools.js');
const { RuntimeVcsTools } = require('../dist/runtimeVcsTools.js');
const { WorkspaceGuard } = require('../dist/runtimeWorkspace.js');

async function createWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'twinbot-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('shell.exec runs inside the workspace and reports exit codes', async (t) => {
  const root = await createWorkspace(t);
  const tools = new RuntimeShellTools(new WorkspaceGuard(root));

  const result = await tools.exec({
    command: `${process.execPath} -e "process.stdout.write('shell-ok')"`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.exitCode, 0);
  assert.match(result.data.stdout, /shell-ok/);

  const failing = await tools.exec({ command: 'exit 7' });
  assert.equal(failing.data.exitCode, 7);
});

test('code.run executes node scripts in a scratch directory and cleans up', async (t) => {
  const root = await createWorkspace(t);
  const tools = new RuntimeCodeTools(new WorkspaceGuard(root));

  const result = await tools.run({
    language: 'node',
    code: "console.log('code-run-ok'); console.error('warn-line');",
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.exitCode, 0);
  assert.match(result.data.stdout, /code-run-ok/);
  assert.match(result.data.stderr, /warn-line/);

  const scratchRoot = path.join(root, '.twinbot-scratch');
  const leftovers = await fs.readdir(scratchRoot).catch(() => []);
  assert.deepEqual(leftovers, []);
});

const DDG_FIXTURE = `
<div class="results">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Result One</a>
  <a class="result__snippet" href="#">First snippet</a>
  <a rel="nofollow" class="result__a" href="https://direct.example.com/two">Result Two</a>
  <a class="result__snippet" href="#">Second snippet</a>
</div>
`;

test('web.fetch returns text bodies with injected fetch', async (t) => {
  const fetchImpl = async () => new Response('<html>hello</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const tools = new RuntimeWebTools({ fetchImpl });
  const result = await tools.fetchUrl({ url: 'https://example.com/page' });
  assert.deepEqual(result, {
    ok: true,
    data: {
      url: 'https://example.com/page',
      status: 200,
      contentType: 'text/html',
      body: '<html>hello</html>',
      encoding: 'utf8',
      truncated: false,
    },
  });

  const rejected = await tools.fetchUrl({ url: 'ftp://example.com/file' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_ARGS');
});

test('web.search falls back to DuckDuckGo parsing without an API key', async (t) => {
  const fetchImpl = async () => new Response(DDG_FIXTURE, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const tools = new RuntimeWebTools({ fetchImpl });
  const result = await tools.search({ query: 'twinbot' });
  assert.equal(result.ok, true);
  assert.equal(result.data.provider, 'duckduckgo');
  assert.deepEqual(result.data.results, [
    { title: 'Result One', url: 'https://example.com/one', snippet: 'First snippet' },
    { title: 'Result Two', url: 'https://direct.example.com/two', snippet: 'Second snippet' },
  ]);
});

test('parseDuckDuckGoHtml decodes redirect links and entities', () => {
  const parsed = parseDuckDuckGoHtml(DDG_FIXTURE, 5);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://example.com/one');
  assert.equal(parsed[1].url, 'https://direct.example.com/two');
});

test('vcs.checkpoint creates, lists and restores workspace snapshots', async (t) => {
  const root = await createWorkspace(t);
  const tools = new RuntimeVcsTools(new WorkspaceGuard(root));
  await fs.writeFile(path.join(root, 'keep.txt'), 'version one');
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'ignored');

  const created = await tools.checkpoint({ op: 'create', label: 'before-edit' });
  assert.equal(created.ok, true);
  assert.equal(created.data.files, 1);
  assert.match(created.data.id, /^cp-\d{4}-\d{2}-\d{2}-/);
  const checkpointId = created.data.id;

  const listed = await tools.checkpoint({ op: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.checkpoints.length, 1);
  assert.equal(listed.data.checkpoints[0].id, checkpointId);
  assert.equal(listed.data.checkpoints[0].label, 'before-edit');

  await fs.writeFile(path.join(root, 'keep.txt'), 'version two');
  await fs.writeFile(path.join(root, 'extra.txt'), 'to be removed');

  const restored = await tools.checkpoint({ op: 'restore', id: checkpointId });
  assert.equal(restored.ok, true);
  assert.equal(restored.data.files, 1);
  assert.equal(
    await fs.readFile(path.join(root, 'keep.txt'), 'utf8'),
    'version one',
  );
  // restore 会清空快照之外的工作区内容
  assert.equal(fsSync.existsSync(path.join(root, 'extra.txt')), false);

  const missing = await tools.checkpoint({ op: 'restore', id: 'cp-none' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
});
