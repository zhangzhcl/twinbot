const assert = require('node:assert/strict');
const test = require('node:test');
const {
  globToRegExp,
  matchGlob,
  ToolNameSchema,
  ToolArgsSchemasByName,
  readNotebookCells,
  parseNotebookDocument,
  serializeNotebookDocument,
  buildNotebookCell,
  NotebookFormatError,
} = require('../dist/index.js');

test('glob matches single-star, double-star, question mark and braces', () => {
  assert.equal(matchGlob('*.ts', 'a.ts'), true);
  assert.equal(matchGlob('*.ts', 'dir/a.ts'), false);
  assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('**/*.ts', 'src/deep/a.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/a.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/deep/nested/a.ts'), true);
  assert.equal(matchGlob('a?c.txt', 'abc.txt'), true);
  assert.equal(matchGlob('a?c.txt', 'ac.txt'), false);
  assert.equal(matchGlob('{a,b}.txt', 'a.txt'), true);
  assert.equal(matchGlob('{a,b}.txt', 'b.txt'), true);
  assert.equal(matchGlob('{a,b}.txt', 'c.txt'), false);
  assert.equal(matchGlob('**', 'any/path/file.ts'), true);
  assert.equal(matchGlob('[a-c]*.md', 'b-note.md'), true);
  assert.equal(matchGlob('[!a]*.md', 'b-note.md'), true);
  assert.equal(matchGlob('[!a]*.md', 'a-note.md'), false);
  assert.equal(matchGlob('./*.ts', './x.ts'), true);
  assert.equal(matchGlob('a\\b.ts', 'a/b.ts'), true);
});

test('globToRegExp anchors the pattern to the whole path', () => {
  const regex = globToRegExp('src/*.ts');
  assert.equal(regex.test('src/x.ts'), true);
  assert.equal(regex.test('xsrc/x.ts'), false);
  assert.equal(regex.test('src/x.tsx'), false);
});

test('tool name and args schemas cover the full registry', () => {
  const toolNames = [
    'fs.read', 'fs.list', 'fs.write', 'fs.edit', 'fs.glob', 'fs.grep',
    'shell.exec', 'files.copy', 'code.run', 'web.fetch', 'web.search',
    'browser.use', 'user.ask', 'notebook.read', 'notebook.edit',
    'lsp.query', 'vcs.checkpoint',
  ];
  assert.deepEqual(ToolNameSchema.options, toolNames);
  for (const name of toolNames) {
    assert.ok(ToolArgsSchemasByName[name], `missing args schema for ${name}`);
  }

  // 默认值随解析生效
  const read = ToolArgsSchemasByName['fs.read'].parse({ path: 'a.txt' });
  assert.deepEqual(read, { path: 'a.txt', encoding: 'utf8' });

  // 越界参数被拒绝
  assert.equal(ToolArgsSchemasByName['fs.write'].safeParse({ path: 'a', content: 'x'.repeat(6_000_000) }).success, false);
  assert.equal(ToolArgsSchemasByName['code.run'].safeParse({ language: 'ruby', code: 'x' }).success, false);
  assert.equal(ToolArgsSchemasByName['web.fetch'].safeParse({ url: 'not-a-url' }).success, false);
  assert.equal(ToolArgsSchemasByName['user.ask'].safeParse({ question: 'q', choices: ['1','2','3','4','5','6','7'] }).success, false);
});

const NOTEBOOK_JSON = JSON.stringify({
  cells: [
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['line1\n', 'line2\n'] },
        { output_type: 'error', ename: 'ValueError', evalue: 'bad input', traceback: ['trace...'] },
      ],
      source: ['import os\n', 'os.getcwd()'],
    },
    { cell_type: 'markdown', metadata: {}, source: '# Heading' },
  ],
  metadata: { kernel: 'python3' },
  nbformat: 4,
  nbformat_minor: 5,
});

test('notebook parsing normalizes sources and outputs', () => {
  const cells = readNotebookCells(NOTEBOOK_JSON);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], {
    index: 0,
    type: 'code',
    truncated: false,
    source: 'import os\nos.getcwd()',
    outputs: ['line1\nline2', 'ValueError: bad input\ntrace...'],
  });
  assert.deepEqual(cells[1], {
    index: 1,
    type: 'markdown',
    truncated: false,
    source: '# Heading',
    outputs: [],
  });
});

test('notebook document edit round-trips through serialize', () => {
  const document = parseNotebookDocument(NOTEBOOK_JSON);
  assert.equal(document.cells.length, 2);
  document.cells.splice(1, 0, buildNotebookCell('markdown', '## Inserted'));
  const serialized = serializeNotebookDocument(document);
  const reparsed = parseNotebookDocument(serialized);
  assert.equal(reparsed.cells.length, 3);
  assert.equal(reparsed.cells[1].cell_type, 'markdown');
  assert.equal(reparsed.nbformat, 4);
});

test('notebook parser rejects invalid documents', () => {
  assert.throws(() => readNotebookCells('not json'), NotebookFormatError);
  assert.throws(() => readNotebookCells('{"metadata":{}}'), NotebookFormatError);
});
