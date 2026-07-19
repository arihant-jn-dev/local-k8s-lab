// Minimal smoke tests using Node's built-in test runner (node:test) - no
// extra test framework dependency needed for a project this size. Only
// covers /health and /pod since those don't touch Postgres/Redis; CI runs
// this with no real database or queue running, so routes that do need
// them (/users, /jobs) aren't covered here - see docs/debugging.md's CI
// section for why that trade-off is fine for a learning project.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('./index.js');

let server;
let baseUrl;

before(() => {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => server.close(resolve));
});

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('GET /pod returns a hostname and timestamp', async () => {
  const res = await fetch(`${baseUrl}/pod`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.hostname === 'string' && body.hostname.length > 0);
  assert.ok(typeof body.timestamp === 'string');
});

test('GET /version returns a version string', async () => {
  const res = await fetch(`${baseUrl}/version`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.version === 'string');
});
