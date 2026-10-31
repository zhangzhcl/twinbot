const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalWorkspaceGuard } = require('../dist/localWorkspace.js');

test('LocalWorkspaceGuard allows paths inside root and rejects escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinbot-ws-'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'hi');
  const guard = new LocalWorkspaceGuard(root);
  const inside = await guard.resolve('note.txt');
  assert.equal(inside.relativePath, 'note.txt');

  await assert.rejects(() => guard.resolve('../outside.txt'), (error) => {
    assert.equal(error.code, 'EACCES');
    return true;
  });

  const toolError = guard.toToolError(Object.assign(new Error('nope'), { code: 'EACCES' }));
  assert.equal(toolError.ok, false);
  assert.equal(toolError.error.code, 'PERMISSION_DENIED');
});
