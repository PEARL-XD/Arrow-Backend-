import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { MongoWalletDatabase } from '../src/mongo_database.js';
import { openDatabase } from '../src/open_database.js';
import { createApp } from '../src/app.js';
import { reconcile } from '../src/reconcile.js';
import { ProofVault } from '../src/proof_vault.js';
import { AccountLifecycle } from '../src/account_lifecycle.js';

// A real, isolated MongoDB replica set. Never reads .env or a developer's URI.
let replica;
before(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); }, { timeout: 240000 });
after(async () => { await replica?.stop(); });
const progress = coins => ({ version: 1, adminTesting: false, index: 0, lives: 3,
  hints: 4, removed: [], completed: [0], rewards: { coins }, shop: {} });
const receipt = (key = randomUUID()) => ({ key, productId: 'coins_1500', amount: 1500, consumed: false });
async function fixture(t) {
  const name = `arrow_checks_${randomUUID().replaceAll('-', '')}`;
  const db = await new MongoWalletDatabase(replica.getUri(), name).initialize();
  t.after(async () => { await db.close(); });
  const guest = await db.createAccount();
  const signIn = async (account = guest, subject = 'player', provider = 'google') => {
    const challenge = await db.challenge(account.id, provider);
    return db.linkIdentity(account.id, { provider, subject }, challenge.id);
  };
  return { db, guest, signIn, name };
}

test('Mongo: indexes enforce identities/entitlements and credentials are hashed', async t => {
  const { db, guest, signIn } = await fixture(t);
  assert.equal(await db.authenticate(guest.token), guest.id);
  await assert.rejects(db.authenticate('bad'), /unauthorized/);
  const linked = await signIn();
  assert.equal(await db.authenticate(linked.token), guest.id);
  assert.ok(!JSON.stringify(await db.accounts.find().toArray()).includes(guest.token));
  assert.ok(!JSON.stringify(await db.sessions.find().toArray()).includes(linked.token));
  const indexes = await db.identities.indexes();
  assert.ok(indexes.some(x => x.unique && x.key.provider && x.key.subject));
  assert.ok(indexes.some(x => x.unique && x.key.account_id && x.key.provider));
  assert.ok((await db.sessions.indexes()).some(x => x.expireAfterSeconds === 0));
});

test('Mongo: simultaneous retries credit one receipt only once', async t => {
  const { db, guest } = await fixture(t), paid = receipt();
  await Promise.all(Array.from({ length: 12 }, () => db.credit(guest.id, paid)));
  assert.equal((await db.wallet(guest.id)).balance, 1500);
  assert.equal((await db.wallet(guest.id)).revision, 1);
  assert.equal(await db.purchases.countDocuments(), 1);
  const stranger = await db.createAccount();
  await assert.rejects(db.credit(stranger.id, paid), /purchase_owned_elsewhere/);
});

test('Mongo: one receipt cannot race into two different wallets', async t => {
  const { db, guest } = await fixture(t), second = await db.createAccount(), paid = receipt();
  const results = await Promise.allSettled([db.credit(guest.id, paid), db.credit(second.id, paid)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(results.find(x => x.status === 'rejected').reason.message, /purchase_owned_elsewhere/);
  assert.equal((await db.wallet(guest.id)).balance + (await db.wallet(second.id)).balance, 1500);
});

test('Mongo: unknown consumed receipts and forged coin amounts fail closed', async t => {
  const { db, guest } = await fixture(t), paid = receipt();
  await assert.rejects(db.credit(guest.id, { ...paid, consumed: true }), /already_consumed_without_ledger/);
  await assert.rejects(db.credit(guest.id, { ...paid, amount: 999999 }), /invalid_credit/);
  await db.credit(guest.id, paid);
  assert.equal((await db.credit(guest.id, { ...paid, consumed: true })).balance, 1500);
});

test('Mongo: distinct credits and competing spends are atomic without overdraft', async t => {
  const { db, guest } = await fixture(t);
  await Promise.all([db.credit(guest.id, receipt()), db.credit(guest.id, receipt())]);
  assert.equal((await db.wallet(guest.id)).balance, 3000);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => db.spend(guest.id, { id: randomUUID(), sku: 'revive', amount: 200 })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 15);
  for (const rejected of results.filter(x => x.status === 'rejected')) assert.match(rejected.reason.message, /insufficient_coins/);
  const wallet = await db.wallet(guest.id);
  assert.equal(wallet.balance, 0); assert.equal(wallet.deliveries.length, 15);
});

test('Mongo: spend retries debit once, scoped acknowledgement and ID conflicts work', async t => {
  const { db, guest } = await fixture(t);
  await db.credit(guest.id, receipt());
  const spend = { id: randomUUID(), sku: 'hint', amount: 80 };
  await Promise.all(Array.from({ length: 8 }, () => db.spend(guest.id, spend)));
  let wallet = await db.wallet(guest.id);
  assert.equal(wallet.balance, 1420); assert.equal(wallet.deliveries.length, 1);
  await assert.rejects(db.spend(guest.id, { ...spend, amount: 50 }), /idempotency_conflict/);
  const other = await db.createAccount();
  await assert.rejects(db.spend(other.id, spend), /idempotency_conflict/);
  await db.acknowledge(other.id, spend.id);
  assert.equal((await db.wallet(guest.id)).deliveries.length, 1);
  await db.acknowledge(guest.id, spend.id);
  assert.equal((await db.spend(guest.id, spend)).deliveries.length, 0);
});

test('Mongo: simultaneous permanent-item purchases produce one entitlement and debit', async t => {
  const { db, guest } = await fixture(t);
  await db.credit(guest.id, receipt());
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => db.spend(guest.id, { id: randomUUID(), sku: 'theme:sakura', amount: 150 })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await db.wallet(guest.id)).balance, 1350);
  assert.deepEqual((await db.wallet(guest.id)).entitlements, ['theme:sakura']);
});

test('Mongo: failure after writing a ledger or debit rolls back every partial change', async t => {
  const { db, guest } = await fixture(t);
  const wallet = db.wallet.bind(db);
  db.wallet = async () => { throw new Error('simulated response build failure'); };
  await assert.rejects(db.credit(guest.id, receipt()), /simulated/);
  assert.equal(await db.purchases.countDocuments(), 0);
  db.wallet = wallet;
  assert.equal((await db.wallet(guest.id)).balance, 0);
  await db.credit(guest.id, receipt());
  db.wallet = async () => { throw new Error('simulated failure'); };
  await assert.rejects(db.spend(guest.id, { id: randomUUID(), sku: 'arrow:neon', amount: 180 }), /simulated/);
  db.wallet = wallet;
  assert.equal((await db.wallet(guest.id)).balance, 1500);
  assert.deepEqual((await db.wallet(guest.id)).entitlements, []);
  assert.deepEqual((await db.wallet(guest.id)).deliveries, []);
});

test('Mongo: restart preserves coins, cloud progress, pending deliveries and linked recovery', async t => {
  const { db, guest, signIn, name } = await fixture(t);
  await db.bindEnvironment('sandbox'); await db.credit(guest.id, receipt()); await signIn();
  await db.saveProgress(guest.id, { revision: 0, progress: progress(210) });
  const spend = { id: randomUUID(), sku: 'hint', amount: 80 }; await db.spend(guest.id, spend);
  await db.close();
  const restarted = await openDatabase({ MONGODB_URI: replica.getUri(), MONGODB_DATABASE: name, RENDER: 'true' });
  t.after(() => restarted.close()); await restarted.bindEnvironment('sandbox');
  assert.equal((await restarted.wallet(guest.id)).balance, 1420);
  assert.equal((await restarted.wallet(guest.id)).deliveries[0].id, spend.id);
  const fresh = await restarted.createAccount(), challenge = await restarted.challenge(fresh.id, 'google');
  const restored = await restarted.linkIdentity(fresh.id, { provider: 'google', subject: 'player' }, challenge.id);
  assert.equal(restored.wallet.id, guest.id); assert.equal(restored.cloud.progress.rewards.coins, 210);
  assert.equal(await restarted.authenticate(restored.token), guest.id);
});

test('Mongo: cloud revision races never overwrite another device save; users stay isolated', async t => {
  const { db, guest, signIn } = await fixture(t); await signIn();
  const results = await Promise.allSettled([70, 100, 150].map(coins => db.saveProgress(guest.id, { revision: 0, progress: progress(coins) })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await db.progress(guest.id)).revision, 1);
  const other = await db.createAccount(); await signIn(other, 'another-player');
  assert.deepEqual(await db.progress(other.id), { revision: 0, progress: null });
  for (const change of [{ adminTesting: true }, { balance: 100000 }, { index: -1 }, { token: 'private' }]) {
    await assert.rejects(db.saveProgress(guest.id, { revision: 1, progress: { ...progress(10), ...change } }), /invalid_progress/);
  }
  assert.equal((await db.wallet(guest.id)).balance, 0);
});

test('Mongo: link conflicts never abandon paid guest funds or switch a linked identity', async t => {
  const { db, guest, signIn } = await fixture(t); await signIn();
  const paid = await db.createAccount(); await db.credit(paid.id, receipt());
  await assert.rejects(signIn(paid), /wallet_link_conflict/);
  assert.equal((await db.wallet(paid.id)).balance, 1500);
  await assert.rejects(signIn(guest, 'different-player'), /account_link_conflict/);
});

test('Mongo: challenge/session expiration is enforced before TTL cleanup and nonce replay fails', async t => {
  const { db, guest, signIn } = await fixture(t);
  const challenge = await db.challenge(guest.id, 'google'), other = await db.createAccount();
  await assert.rejects(db.challengeFor(other.id, 'google', challenge.id), /invalid_challenge/);
  await assert.rejects(db.challengeFor(guest.id, 'apple', challenge.id), /invalid_challenge/);
  await db.auth_challenges.updateOne({ _id: challenge.id }, { $set: { expires_at: new Date(0) } });
  await assert.rejects(db.challengeFor(guest.id, 'google', challenge.id), /invalid_challenge/);
  const once = await db.challenge(guest.id, 'google');
  await db.linkIdentity(guest.id, { provider: 'google', subject: 'player' }, once.id);
  await assert.rejects(db.linkIdentity(guest.id, { provider: 'google', subject: 'player' }, once.id), /invalid_challenge/);
  const linked = await signIn();
  await db.sessions.updateOne({ _id: createHash('sha256').update(linked.token).digest('hex') }, { $set: { expires_at: new Date(0) } });
  await assert.rejects(db.authenticate(linked.token), /unauthorized/);
});

test('Mongo: refund retries reverse once and spent refunds are settled by future packs', async t => {
  const { db, guest } = await fixture(t), paid = receipt();
  await db.credit(guest.id, paid);
  await db.spend(guest.id, { id: randomUUID(), sku: 'companion:1', amount: 600 });
  await Promise.all([db.revoke(paid.key), db.revoke(paid.key)]);
  assert.equal((await db.wallet(guest.id)).balance, 0); assert.equal((await db.wallet(guest.id)).debt, 600);
  await assert.rejects(db.credit(guest.id, paid), /purchase_revoked/);
  await db.credit(guest.id, receipt());
  assert.equal((await db.wallet(guest.id)).balance, 900); assert.equal((await db.wallet(guest.id)).debt, 0);
});

test('Mongo: reconciliation paginates encrypted receipts and never treats outages as refunds', async t => {
  const { db, guest } = await fixture(t), vault = new ProofVault('1'.repeat(64));
  for (const key of ['a', 'b', 'c']) await db.credit(guest.id, { ...receipt(key), proof: vault.seal({ token: key }) });
  const batch = await db.reconciliationBatch('', 2); assert.deepEqual(batch.map(x => x.receipt_key), ['a', 'b']);
  assert.deepEqual((await db.reconciliationBatch('b', 2)).map(x => x.receipt_key), ['c']);
  const verifier = { async verify(_, proof) {
    if (proof.token === 'b') throw Object.assign(new Error(), { code: 'purchase_revoked' });
    if (proof.token === 'c') throw new Error('temporary outage');
  } };
  assert.deepEqual(await reconcile(db, verifier, vault), { checked: 1, revoked: 1, deferred: 1 });
  assert.equal((await db.wallet(guest.id)).balance, 3000);
  assert.deepEqual(await reconcile(db, verifier, vault), { checked: 1, revoked: 0, deferred: 1 });
});

test('Mongo: HTTP purchase/link/save/spend routes await durable writes and hide database failures', async t => {
  const { db } = await fixture(t), paid = receipt();
  const identity = { ready: p => p === 'google', async verify(provider, token) {
    assert.equal(token, 'verified'); return { provider, subject: 'http-player' };
  } };
  const verifier = { environment: 'sandbox', ready: () => true, async verify() { return paid; } };
  const server = createApp({ database: db, identity, verifier }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (path, method = 'GET', token, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/ready')).status, 200);
  assert.equal((await call('/v1/wallet')).status, 401);
  const guest = await (await call('/v1/accounts', 'POST', null, {})).json();
  assert.equal((await (await call('/v1/purchases/verify', 'POST', guest.token, { amount: 999999 })).json()).balance, 1500);
  const challenge = await (await call('/v1/auth/challenge', 'POST', guest.token, { provider: 'google' })).json();
  const linked = await (await call('/v1/auth/link', 'POST', guest.token, { provider: 'google', challengeId: challenge.id, idToken: 'verified' })).json();
  assert.equal(linked.wallet.id, guest.id);
  assert.equal((await call('/v1/progress', 'PUT', linked.token, { revision: 0, progress: progress(100) })).status, 200);
  assert.equal((await call('/v1/progress', 'PUT', linked.token, { revision: 0, progress: progress(10) })).status, 409);
  const spend = { id: randomUUID(), sku: 'hint', amount: 80 };
  assert.equal((await (await call('/v1/spends', 'POST', linked.token, spend)).json()).balance, 1420);
  await call(`/v1/spends/${spend.id}/ack`, 'POST', linked.token, {});
  assert.equal((await (await call('/v1/wallet', 'GET', linked.token)).json()).deliveries.length, 0);
  db.ping = async () => { throw new Error('mongodb://private:password@host'); };
  const failed = await call('/ready'); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { status: 'not_ready' });
});

test('Mongo: environments cannot be mixed and deployment never falls back to local SQLite', async t => {
  const { db } = await fixture(t); await db.bindEnvironment('sandbox');
  await assert.rejects(db.bindEnvironment('production'), /database_environment_mismatch/);
  await assert.rejects(openDatabase({ RENDER: 'true' }), /mongodb_required_for_deployment/);
  await assert.rejects(openDatabase({ STORE_ENVIRONMENT: 'production' }), /mongodb_required_for_deployment/);
  await assert.rejects(openDatabase({ MONGODB_URI: replica.getUri() }), /dedicated_mongodb_database_required/);
  assert.throws(() => new MongoWalletDatabase(replica.getUri(), 'admin'), /dedicated_mongodb_database_required/);
  await assert.rejects(openDatabase({ MONGODB_URI: 'mongodb://localhost/?tlsInsecure=true', MONGODB_DATABASE: 'arrow' }), /insecure_mongodb_configuration/);
});

test('Mongo: a standalone database without transactions is refused', async t => {
  const standalone = await MongoMemoryServer.create(); t.after(() => standalone.stop());
  const db = new MongoWalletDatabase(standalone.getUri(), 'arrow_standalone'); t.after(() => db.close());
  await assert.rejects(db.initialize(), /mongodb_transactions_required/);
});

test('Mongo: deletion erases identity, save and wallet but cannot replay a deleted receipt', async t => {
  const { db, guest, signIn } = await fixture(t), paid = receipt();
  await db.credit(guest.id, paid); const linked = await signIn();
  await db.saveProgress(guest.id, { revision: 0, progress: progress(100) });
  await db.spend(guest.id, { id: randomUUID(), sku: 'hint', amount: 80 });
  const challenge = await db.challenge(guest.id, 'google');
  await assert.rejects(db.requestDeletion(guest.id, { provider: 'google', subject: 'wrong' }, challenge.id), /identity_mismatch/);
  assert.equal((await db.wallet(guest.id)).balance, 1420);
  await db.requestDeletion(guest.id, { provider: 'google', subject: 'player' }, challenge.id);
  await assert.rejects(db.wallet(guest.id), /account_deletion_pending/);
  await assert.rejects(db.spend(guest.id, { id: randomUUID(), sku: 'hint', amount: 80 }), /insufficient_coins/);
  assert.equal(await db.cloud_progress.countDocuments(), 0);
  await db.finishDeletion(guest.id); await db.finishDeletion(guest.id);
  for (const collection of [db.accounts, db.identities, db.sessions, db.cloud_progress, db.purchases, db.spends, db.entitlements, db.deletion_jobs]) {
    assert.equal(await collection.countDocuments(), 0);
  }
  await assert.rejects(db.authenticate(guest.token), /account_deleted/);
  await assert.rejects(db.authenticate(linked.token), /account_deleted/);
  const recreated = await db.createAccount();
  await assert.rejects(db.credit(recreated.id, paid), /purchase_account_deleted/);
  assert.equal(await db.receipt_tombstones.countDocuments(), 1);
  const stored = JSON.stringify(await db.receipt_tombstones.find().toArray());
  assert.ok(!stored.includes(guest.id)); assert.ok(!stored.includes(paid.key)); assert.ok(!stored.includes('player'));
});

test('Mongo: guest wallets can be deleted without a provider and signed-in deletion needs its owner', async t => {
  const { db, guest, signIn } = await fixture(t);
  await db.requestDeletion(guest.id); await db.finishDeletion(guest.id);
  await assert.rejects(db.authenticate(guest.token), /account_deleted/);
  const other = await db.createAccount(); await signIn(other);
  await assert.rejects(db.requestDeletion(other.id), /identity_mismatch/);
  assert.equal(await db.accounts.countDocuments(), 1);
});

test('Mongo: Apple deletion retries survive restart and a provider outage never discards the job', async t => {
  const { db, guest, name } = await fixture(t);
  const challenge = await db.challenge(guest.id, 'apple');
  await db.linkIdentity(guest.id, { provider: 'apple', subject: 'apple-user', authorization: { secret: 'encrypted-token', checked_at: new Date(), revoked: false } }, challenge.id);
  const confirmation = await db.challenge(guest.id, 'apple');
  await db.requestDeletion(guest.id, { provider: 'apple', subject: 'apple-user' }, confirmation.id);
  const failing = new AccountLifecycle(db, { async revoke() { throw new Error('outage'); } });
  assert.equal(await failing.finishDeletion(guest.id), false);
  assert.equal(await db.deletion_jobs.countDocuments(), 1);
  await db.close();
  const restarted = await new MongoWalletDatabase(replica.getUri(), name).initialize(); t.after(() => restarted.close());
  let revoked = 0;
  const recovered = new AccountLifecycle(restarted, { async revoke(secret) { assert.equal(secret, 'encrypted-token'); revoked++; } });
  assert.deepEqual(await recovered.maintenance(), { checked: 0, deleted: 1, deferred: 0 });
  assert.equal(revoked, 1); assert.equal(await restarted.accounts.countDocuments(), 0);
});

test('Mongo: daily Apple checks are bounded, revoked sessions are denied, outages do not delete saves', async t => {
  const { db, guest } = await fixture(t), challenge = await db.challenge(guest.id, 'apple');
  const linked = await db.linkIdentity(guest.id, { provider: 'apple', subject: 'apple-user',
    authorization: { secret: 'encrypted', checked_at: new Date(0), revoked: false } }, challenge.id);
  let calls = 0;
  const apple = { ready: true, async validate() { calls++; } };
  const lifecycle = new AccountLifecycle(db, apple);
  await Promise.all([lifecycle.authorize(guest.id), lifecycle.authorize(guest.id)]);
  await lifecycle.authorize(guest.id); assert.equal(calls, 1);
  await db.identities.updateOne({ account_id: guest.id }, { $set: { 'authorization.checked_at': new Date(0) } });
  apple.validate = async () => { throw new Error('temporary outage'); };
  await assert.rejects(lifecycle.authorize(guest.id), /temporary outage/);
  assert.equal(await db.accounts.countDocuments(), 1);
  assert.equal(await db.authenticate(linked.token), guest.id);
  apple.validate = async () => { throw Object.assign(new Error('revoked'), { code: 'apple_authorization_revoked' }); };
  await assert.rejects(lifecycle.authorize(guest.id), /revoked/);
  await assert.rejects(db.authenticate(linked.token), /unauthorized/);
  await assert.rejects(lifecycle.authorize(guest.id), /apple_authorization_revoked/);
});

test('Mongo: signed Apple notifications are replay-safe and older events do not delete a recreated account', async t => {
  const { db, guest, signIn } = await fixture(t); await signIn(guest, 'apple-user', 'apple');
  const now = Math.floor(Date.now() / 1000), event = { id: 'event-one', sub: 'apple-user', type: 'account-deleted', event_time: now };
  assert.equal(await db.appleNotification(event), guest.id);
  assert.equal(await db.appleNotification(event), null);
  await db.finishDeletion(guest.id);
  const recreated = await db.createAccount(); await signIn(recreated, 'apple-user', 'apple');
  assert.equal(await db.appleNotification(event), null);
  assert.equal(await db.appleNotification({ ...event, id: 'very-old-event', event_time: now - 100 }), null);
  assert.equal((await db.wallet(recreated.id)).balance, 0);
});

test('Mongo: HTTP deletion requires explicit confirmation and recent verified sign-in; guest route works', async t => {
  const { db, guest, signIn } = await fixture(t); await signIn();
  let subject = 'player', issuedAt = Math.floor(Date.now() / 1000);
  const identity = { ready: () => true, async verify(provider) { return { provider, subject, issuedAt }; } };
  const lifecycle = new AccountLifecycle(db);
  const server = createApp({ database: db, verifier: { environment: 'sandbox', ready: () => false }, identity, lifecycle }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (method, path, token, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('DELETE', '/v1/account', null, { confirm: true })).status, 401);
  assert.equal((await call('DELETE', '/v1/account', guest.token, {})).status, 400);
  const challenge = await db.challenge(guest.id, 'google');
  const body = { confirm: true, provider: 'google', challengeId: challenge.id, idToken: 'verified' };
  subject = 'wrong'; assert.equal((await call('DELETE', '/v1/account', guest.token, body)).status, 403);
  subject = 'player'; issuedAt = 0;
  assert.equal((await call('DELETE', '/v1/account', guest.token, body)).status, 401);
  issuedAt = Math.floor(Date.now() / 1000);
  const response = await call('DELETE', '/v1/account', guest.token, body);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'deleted' });
  assert.equal((await call('GET', '/v1/wallet', guest.token)).status, 410);
  const anonymous = await db.createAccount();
  assert.equal((await call('DELETE', '/v1/account', anonymous.token, { confirm: true })).status, 200);
});

test('Mongo: outside-app Google deletion is challenge-bound, one-use, and does not reveal profile existence', async t => {
  const { db, guest, signIn } = await fixture(t); await signIn();
  const challenge = await db.webDeletionChallenge();
  const account = await db.requestWebDeletion({ provider: 'google', subject: 'player' }, challenge.id);
  assert.equal(account, guest.id); await db.finishDeletion(account);
  await assert.rejects(db.requestWebDeletion({ provider: 'google', subject: 'player' }, challenge.id), /invalid_challenge/);
  const unknown = await db.webDeletionChallenge();
  assert.equal(await db.requestWebDeletion({ provider: 'google', subject: 'unknown' }, unknown.id), null);
});
