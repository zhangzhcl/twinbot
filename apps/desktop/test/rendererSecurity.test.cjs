const assert = require('node:assert/strict');
const test = require('node:test');
const { isTrustedRendererFrame } = require('../dist/rendererSecurity.js');

test('only the exact main application frame can access privileged IPC', () => {
  const mainFrame = {
    url: 'file:///C:/Program%20Files/TwinBot/static/index.html',
  };

  assert.equal(isTrustedRendererFrame(
    mainFrame,
    mainFrame,
    'file:///C:/Program%20Files/TwinBot/static/index.html',
  ), true);
  assert.equal(isTrustedRendererFrame(
    { url: 'file:///C:/Program%20Files/TwinBot/static/child.html' },
    mainFrame,
    mainFrame.url,
  ), false);
  assert.equal(isTrustedRendererFrame(
    { url: 'https://attacker.example/' },
    mainFrame,
    mainFrame.url,
  ), false);
});

test('a same-origin subframe cannot access privileged IPC', () => {
  const mainFrame = { url: 'file:///C:/TwinBot/static/index.html' };
  const childFrame = { url: mainFrame.url };

  assert.equal(
    isTrustedRendererFrame(childFrame, mainFrame, mainFrame.url),
    false,
  );
});

test('a different local file cannot replace the registered application page', () => {
  const applicationFrame = { url: 'file:///C:/TwinBot/static/index.html' };
  const navigatedFrame = { url: 'file:///C:/Users/user/other.html' };

  assert.equal(
    isTrustedRendererFrame(
      navigatedFrame,
      navigatedFrame,
      applicationFrame.url,
    ),
    false,
  );
});
