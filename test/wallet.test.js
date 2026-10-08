import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WalletDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { StoreVerifier } from '../src/verifier.js';

function fixture(t) {
  const db = new WalletDatabase(':memory:');
  t.after(() => db.close());
  const account = db.createAccount();
  const receipt = { key: 'ios:sandbox:123', productId: 'coins_1500', amount: 1500, consumed: false };
  return { db, account, receipt };
}
test('account authentication stores only a credential hash', t => {
  const { db, account } = fixture(t);
  assert.equal(db.authenticate(account.token), account.id);
  assert.throws(() => db.authenticate('bad'), /unauthorized/);
  const row = db.db.prepare('SELECT * FROM accounts').get();
  assert.notEqual(row.token_hash, account.token);
});
test('credit is idempotent and tied to the original account', t => {
  const { db, account, receipt } = fixture(t);
  db.credit(account.id, receipt);
  for (let i = 0; i < 20; i++) assert.equal(db.credit(account.id, receipt).balance, 1500);
  assert.throws(() => db.credit(db.createAccount().id, receipt), /purchase_owned_elsewhere/);
});
test('previously consumed unknown receipts cannot mint coins', t => {
  const { db, account, receipt } = fixture(t);
  assert.throws(() => db.credit(account.id, { ...receipt, consumed: true }), /already_consumed/);
  db.credit(account.id, receipt);
  assert.equal(db.credit(account.id, { ...receipt, consumed: true }).balance, 1500);
});
test('spend debits once and delivery survives repeated requests until acknowledgement', t => {
  const { db, account, receipt } = fixture(t);
  db.credit(account.id, receipt);
  const spend = { id: randomUUID(), sku: 'hint', amount: 80 };
  assert.equal(db.spend(account.id, spend).balance, 1420);
  assert.equal(db.spend(account.id, spend).deliveries.length, 1);
  assert.equal(db.wallet(account.id).balance, 1420);
  db.acknowledge(db.createAccount().id, spend.id);
  assert.equal(db.wallet(account.id).deliveries.length, 1);
  db.acknowledge(account.id, spend.id);
  assert.equal(db.spend(account.id, spend).deliveries.length, 0);
});
test('invalid, negative, excessive and unknown spends are rejected', t => {
  const { db, account, receipt } = fixture(t);
  db.credit(account.id, receipt);
  for (const amount of [0, -10, 81, 1.5, '80', NaN]) assert.throws(() => db.spend(account.id, { id: randomUUID(), sku: 'hint', amount }), /invalid_spend/);
  assert.throws(() => db.spend(account.id, { id: randomUUID(), sku: 'fake', amount: 1 }), /invalid_spend/);
  assert.equal(db.wallet(account.id).balance, 1500);
});
test('request ID cannot be reused for another item or amount', t => {
  const { db, account, receipt } = fixture(t);
  db.credit(account.id, receipt);
  const spend = { id: randomUUID(), sku: 'hint', amount: 50 };
  db.spend(account.id, spend);
  assert.throws(() => db.spend(account.id, { ...spend, amount: 51 }), /idempotency_conflict/);
  assert.throws(() => db.spend(db.createAccount().id, spend), /idempotency_conflict/);
  assert.equal(db.wallet(account.id).balance, 1450);
});
test('insufficient funds roll back without creating delivery', t => {
  const { db, account } = fixture(t);
  assert.throws(() => db.spend(account.id, { id: randomUUID(), sku: 'revive', amount: 200 }), /insufficient_coins/);
  assert.deepEqual(db.wallet(account.id).deliveries, []);
});
test('permanent entitlements persist and cannot be bought twice', t => {
  const { db, account, receipt } = fixture(t);
  db.credit(account.id, receipt);
  const spend = { id: randomUUID(), sku: 'theme:sakura', amount: 150 };
  db.spend(account.id, spend);
  db.acknowledge(account.id, spend.id);
  assert.deepEqual(db.wallet(account.id).entitlements, ['theme:sakura']);
  assert.throws(() => db.spend(account.id, { ...spend, id: randomUUID() }), /already_owned/);
  assert.equal(db.wallet(account.id).balance, 1350);
});
test('default store configuration never permits live or test checkout', async () => {
  const verifier = new StoreVerifier({});
  assert.equal(verifier.ready('ios'), false);
  assert.equal(verifier.ready('android'), false);
  await assert.rejects(verifier.verify('account', { platform: 'ios', productId: 'coins_1500' }), /purchases_not_configured/);
});
test('HTTP routes authenticate, verify before credit and never accept client coin amounts', async t => {
  const { db, receipt } = fixture(t);
  const verifier = {
    environment: 'sandbox', ready: () => true,
    async verify(account, input) {
      if (input.token !== 'verified-token') throw new Error('secret-upstream-error');
      return receipt;
    },
  };
  const server = createApp({ database: db, verifier }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, body) => fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/v1/wallet')).status, 401);
  const account = await (await call('/v1/accounts', null, {})).json();
  assert.equal((await call('/v1/purchases/verify', account.token, { token: 'invalid' })).status, 503);
  assert.equal((await (await call('/v1/wallet', account.token)).json()).balance, 0);
  const result = await call('/v1/purchases/verify', account.token, { token: 'verified-token', amount: 999999 });
  assert.equal((await result.json()).balance, 1500);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
