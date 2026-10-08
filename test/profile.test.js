import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { WalletDatabase } from '../src/database.js';
import { IdentityVerifier } from '../src/identity.js';
import { createApp } from '../src/app.js';

const progress = coins => ({ version: 1, adminTesting: false, index: 0, lives: 3,
  hints: 4, removed: [], completed: [0], rewards: { coins }, shop: {} });
function setup(t) {
  const db = new WalletDatabase(':memory:'); t.after(() => db.close());
  const guest = db.createAccount();
  const signIn = (account, subject = 'player', provider = 'google') => {
    const challenge = db.challenge(account.id, provider);
    return db.linkIdentity(account.id, { provider, subject }, challenge.id);
  };
  return { db, guest, signIn };
}
test('linking preserves the original paid wallet; reinstall reconnects without the old device key', t => {
  const { db, guest, signIn } = setup(t);
  db.credit(guest.id, { key: 'test-one', productId: 'coins_1500', amount: 1500 });
  const linked = signIn(guest);
  assert.equal(linked.wallet.id, guest.id);
  db.saveProgress(guest.id, { revision: 0, progress: progress(200) });
  const reinstalled = signIn(db.createAccount());
  assert.equal(reinstalled.wallet.id, guest.id);
  assert.equal(reinstalled.wallet.balance, 1500);
  assert.equal(reinstalled.cloud.progress.rewards.coins, 200);
  assert.equal(db.authenticate(reinstalled.token), guest.id);
  assert.deepEqual(db.providers(guest.id), ['google']);
  assert.ok(!JSON.stringify(db.db.prepare('SELECT * FROM sessions').all()).includes(reinstalled.token));
});
test('other provider subjects cannot read another player save', t => {
  const { db, guest, signIn } = setup(t);
  signIn(guest, 'one');
  db.saveProgress(guest.id, { revision: 0, progress: progress(70) });
  const second = signIn(db.createAccount(), 'two');
  assert.notEqual(second.wallet.id, guest.id);
  assert.equal(second.cloud.progress, null);
});
test('link conflicts never abandon paid guest coins or replace an already linked account', t => {
  const { db, guest, signIn } = setup(t);
  signIn(guest);
  const paidGuest = db.createAccount();
  db.credit(paidGuest.id, { key: 'paid-guest', productId: 'coins_1500', amount: 1500 });
  assert.throws(() => signIn(paidGuest), /wallet_link_conflict/);
  assert.equal(db.wallet(paidGuest.id).balance, 1500);
  assert.throws(() => signIn(guest, 'different'), /account_link_conflict/);
});
test('challenges are account/provider bound, one-use and expire', t => {
  const { db, guest } = setup(t);
  const challenge = db.challenge(guest.id, 'apple');
  assert.throws(() => db.challengeFor(db.createAccount().id, 'apple', challenge.id), /invalid_challenge/);
  assert.throws(() => db.challengeFor(guest.id, 'google', challenge.id), /invalid_challenge/);
  db.linkIdentity(guest.id, { provider: 'apple', subject: 'one' }, challenge.id);
  assert.throws(() => db.linkIdentity(guest.id, { provider: 'apple', subject: 'one' }, challenge.id), /invalid_challenge/);
  const expired = db.challenge(guest.id, 'apple');
  db.db.prepare('UPDATE auth_challenges SET expires_at=0 WHERE id=?').run(expired.id);
  assert.throws(() => db.challengeFor(guest.id, 'apple', expired.id), /invalid_challenge/);
});
test('guest saves, admin money, invalid states and paid-balance injection are rejected', t => {
  const { db, guest, signIn } = setup(t);
  assert.throws(() => db.saveProgress(guest.id, { revision: 0, progress: progress(10) }), /account_not_linked/);
  signIn(guest);
  for (const change of [{ adminTesting: true }, { lives: 9 }, { index: -1 }, { paidBalance: 999999 }, { token: 'secret' }]) {
    assert.throws(() => db.saveProgress(guest.id, { revision: 0, progress: { ...progress(10), ...change } }), /invalid_progress/);
  }
  db.saveProgress(guest.id, { revision: 0, progress: progress(10) });
  assert.equal(db.wallet(guest.id).balance, 0);
});
test('cloud save revisions reject stale concurrent writes without losing the newer save', t => {
  const { db, guest, signIn } = setup(t); signIn(guest);
  db.saveProgress(guest.id, { revision: 0, progress: progress(70) });
  db.saveProgress(guest.id, { revision: 1, progress: progress(150) });
  assert.throws(() => db.saveProgress(guest.id, { revision: 1, progress: progress(0) }), /progress_conflict/);
  assert.equal(db.progress(guest.id).progress.rewards.coins, 150);
});
test('Google verification uses configured audience and rejects fake, expired and invalid identities', async () => {
  let payload = { iss: 'https://accounts.google.com', sub: 'verified-user', exp: Math.floor(Date.now() / 1000) + 60 };
  const identity = new IdentityVerifier({ GOOGLE_SIGN_IN_CLIENT_ID: 'web-client' }, {
    google: { async verifyIdToken(options) { assert.equal(options.audience, 'web-client'); return { getPayload: () => payload }; } },
  });
  assert.equal((await identity.verify('google', 'verified-token')).subject, 'verified-user');
  payload = { ...payload, iss: 'attacker' };
  await assert.rejects(identity.verify('google', 'token'), /invalid_identity/);
  payload = { ...payload, iss: 'accounts.google.com', exp: 0 };
  await assert.rejects(identity.verify('google', 'token'), /invalid_identity/);
  await assert.rejects(new IdentityVerifier().verify('google', 'token'), /sign_in_not_configured/);
});
test('Apple signatures, issuer, audience, expiry and server nonce are checked cryptographically', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
  const identity = new IdentityVerifier({ APPLE_SIGN_IN_BUNDLE_ID: 'our.bundle' }, {
    appleKeys: createLocalJWKSet({ keys: [key] }),
  });
  const token = await new SignJWT({ nonce: 'server-nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://appleid.apple.com').setAudience('our.bundle').setSubject('apple-player')
    .setIssuedAt().setExpirationTime('2m').sign(privateKey);
  assert.equal((await identity.verify('apple', token, 'server-nonce')).subject, 'apple-player');
  await assert.rejects(identity.verify('apple', token, 'wrong-nonce'), /invalid_identity/);
  const other = new IdentityVerifier({ APPLE_SIGN_IN_BUNDLE_ID: 'wrong.bundle' }, { appleKeys: createLocalJWKSet({ keys: [key] }) });
  await assert.rejects(other.verify('apple', token, 'server-nonce'), /invalid_identity/);
  await assert.rejects(identity.verify('apple', token + 'tampered', 'server-nonce'), /invalid_identity/);
});
test('HTTP account linking only accepts verified identities and cloud writes are authenticated', async t => {
  const { db, guest } = setup(t);
  const identity = { ready: p => p === 'google', async verify(provider, token) {
    if (token !== 'valid') throw new Error('private provider error');
    return { provider, subject: 'user' };
  } };
  const verifier = { environment: 'sandbox', ready: () => false };
  const server = createApp({ database: db, verifier, identity }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method, token, body) => fetch(url + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/v1/progress', 'GET')).status, 401);
  const challenge = await (await call('/v1/auth/challenge', 'POST', guest.token, { provider: 'google' })).json();
  const bad = await call('/v1/auth/link', 'POST', guest.token, { provider: 'google', challengeId: challenge.id, idToken: 'fake', subject: 'user' });
  assert.equal(bad.status, 503); assert.ok(!(await bad.text()).includes('private'));
  const linked = await (await call('/v1/auth/link', 'POST', guest.token, { provider: 'google', challengeId: challenge.id, idToken: 'valid' })).json();
  assert.equal((await call('/v1/progress', 'PUT', linked.token, { revision: 0, progress: progress(70) })).status, 200);
  assert.equal((await call('/v1/progress', 'PUT', linked.token, { revision: 0, progress: progress(80) })).status, 409);
  assert.equal((await (await call('/v1/progress', 'GET', linked.token)).json()).progress.rewards.coins, 70);
});
