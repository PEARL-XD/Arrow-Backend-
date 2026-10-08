import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/app.js';
import { deletionPage } from '../src/deletion_page.js';
import { WalletDatabase } from '../src/database.js';

test('Render: startup refuses local storage and never prints a credential-containing URI', async () => {
  const run = promisify(execFile);
  const base = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    RENDER: 'true', STORE_ENVIRONMENT: 'sandbox', REQUIRE_HTTPS: 'true' };
  try { await run(process.execPath, ['src/server.js'], { env: base }); assert.fail('should refuse'); }
  catch (error) { assert.equal(error.code, 1); assert.match(error.stderr, /mongodb_required_for_deployment/); }
  try {
    await run(process.execPath, ['src/server.js'], { env: { ...base,
      MONGODB_URI: 'mongodb://private:never_print_this@host/?tlsInsecure=true', MONGODB_DATABASE: 'arrow' } });
    assert.fail('should refuse insecure TLS');
  } catch (error) {
    assert.equal(error.code, 1); assert.match(error.stderr, /insecure_mongodb_configuration/);
    assert.ok(!error.stderr.includes('never_print_this'));
  }
});

test('Render: health/readiness work behind TLS, public deletion page uses no inline token scripts', async t => {
  const database = { async ping() {} };
  const server = createApp({ database, verifier: { environment: 'sandbox', ready: () => false }, requireHttps: true, proxyHops: 1 }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/ready')).status, 200);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/v1/config')).status, 400);
  const page = await fetch(url + '/delete-account', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /ARROW: THE LAST LANTERN/);
  assert.match(deletionPage.script, /nonce: challenge.nonce/);
  assert.match(deletionPage.script, /confirm: true/);
});

test('monitoring: database outage returns sanitized 503, recovery returns ready for GET and HEAD', async t => {
  let reachable = false, checks = 0;
  const database = { async ping() {
    checks++;
    if (!reachable) throw new Error('mongodb://private:never_print_this@host');
  } };
  const server = createApp({ database, verifier: { environment: 'sandbox', ready: () => false } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const down = await fetch(url + '/ready');
  assert.equal(down.status, 503); assert.equal(down.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await down.json(), { status: 'not_ready' });
  const downHead = await fetch(url + '/ready', { method: 'HEAD' });
  assert.equal(downHead.status, 503); assert.equal(await downHead.text(), '');
  assert.equal((await fetch(url + '/health')).status, 200); // Process alive is not database readiness.
  reachable = true;
  const up = await fetch(url + '/ready');
  assert.equal(up.status, 200); assert.deepEqual(await up.json(), { status: 'ready' });
  const upHead = await fetch(url + '/ready', { method: 'HEAD' });
  assert.equal(upHead.status, 200); assert.equal(await upHead.text(), '');
  assert.equal(checks, 4);
});

test('monitoring: a missing database health check never reports ready', async t => {
  const server = createApp({ database: {}, verifier: { environment: 'sandbox', ready: () => false } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'not_ready' });
});

test('monitoring: repeated unauthenticated checks do not create accounts or change a wallet/save', async t => {
  const database = new WalletDatabase(':memory:'); t.after(() => database.close());
  const account = database.createAccount();
  database.credit(account.id, { key: 'ios:sandbox:monitor', productId: 'coins_1500', amount: 1500, consumed: false });
  const wallet = database.wallet(account.id);
  const server = createApp({ database, verifier: { environment: 'sandbox', ready: () => false } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`, { method: i % 2 ? 'HEAD' : 'GET' });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(database.wallet(account.id), wallet);
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 1);
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM cloud_progress').get().n, 0);
});
