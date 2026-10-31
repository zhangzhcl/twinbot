const assert = require('node:assert/strict');
const test = require('node:test');
const { cronMatches, nextCronFire, parseCronExpression } = require('../dist/cron.js');

test('parseCronExpression accepts every-minute and rejects garbage', () => {
  assert.ok(parseCronExpression('* * * * *'));
  assert.equal(parseCronExpression('not a cron'), null);
  assert.equal(parseCronExpression('* * *'), null);
});

test('cronMatches and nextCronFire advance by minute', () => {
  const from = new Date('2026-10-31T12:00:00');
  assert.equal(cronMatches('0 * * * *', from), true);
  const next = nextCronFire('0 * * * *', from);
  assert.ok(next);
  assert.equal(next.getHours(), 13);
  assert.equal(next.getMinutes(), 0);
});
