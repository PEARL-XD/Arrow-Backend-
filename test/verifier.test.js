import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StoreVerifier } from '../src/verifier.js';
import { ProofVault } from '../src/proof_vault.js';
import { WalletDatabase } from '../src/database.js';
import { reconcile } from '../src/reconcile.js';
import { ApiError } from '../src/errors.js';

const account = randomUUID();
const input = { platform: 'android', productId: 'coins_1500', token: 'verified-token-12345' };
function google(data = {}) {
  const verifier = new StoreVerifier({ PURCHASES_ENABLED: 'true', ANDROID_PACKAGE_NAME: 'app.arrow.test', GOOGLE_APPLICATION_CREDENTIALS: '/not-read-in-unit-test' });
  verifier.auth = { getClient: async () => ({ request: async () => ({ data: { purchaseState: 0, purchaseType: 0, quantity: 1, consumptionState: 0, obfuscatedExternalAccountId: account, ...data } }) }) };
  return verifier;
}
test('Google accepts a verified test purchase and computes amount from its own catalog', async () => {
  const result = await google().verify(account, { ...input, amount: 9999999 });
  assert.equal(result.amount, 1500);
  assert.equal(result.consumed, false);
  assert.ok(!result.key.includes(input.token));
});
test('Google rejects pending, revoked, mismatched account, quantity, environment and product', async () => {
  for (const [data, code] of [
    [{ purchaseState: 2 }, 'purchase_not_completed'], [{ purchaseState: 1 }, 'purchase_revoked'],
    [{ obfuscatedExternalAccountId: 'someone-else' }, 'purchase_account_mismatch'],
    [{ quantity: 2 }, 'purchase_not_completed'], [{ purchaseType: undefined }, 'wrong_store_environment'],
  ]) await assert.rejects(google(data).verify(account, input), new RegExp(code));
  await assert.rejects(google().verify(account, { ...input, productId: 'coins_99999' }), /unknown_product/);
});
test('Apple verifies the signed server response and account token, not client receipt claims', async () => {
  const verifier = new StoreVerifier({ PURCHASES_ENABLED: 'true' });
  verifier.appleReady = true;
  verifier.apple = { getTransactionInfo: async id => { assert.equal(id, '1234'); return { signedTransactionInfo: 'signed-response' }; } };
  let receipt = { transactionId: '1234', productId: 'coins_4000', quantity: 1, type: 'Consumable', appAccountToken: account };
  verifier.appleVerifier = { verifyAndDecodeTransaction: async signed => { assert.equal(signed, 'signed-response'); return receipt; } };
  const args = { platform: 'ios', productId: 'coins_4000', transactionId: '1234' };
  assert.equal((await verifier.verify(account, args)).amount, 4000);
  receipt = { ...receipt, revocationDate: 123 };
  await assert.rejects(verifier.verify(account, args), /purchase_revoked/);
  receipt = { ...receipt, appAccountToken: randomUUID() };
  await assert.rejects(verifier.verify(account, args), /purchase_account_mismatch/);
  verifier.appleVerifier.verifyAndDecodeTransaction = async () => { throw new Error('bad signature'); };
  await assert.rejects(verifier.verify(account, args), /bad signature/);
});
test('encryption hides receipt data and detects tampering/wrong key', () => {
  const vault = new ProofVault('a'.repeat(64));
  const value = vault.seal(input);
  assert.ok(!value.includes(input.token));
  assert.deepEqual(vault.open(value), input);
  assert.throws(() => new ProofVault('b'.repeat(64)).open(value));
  assert.throws(() => new ProofVault('short'));
});
test('database cannot be reused between sandbox and production', () => {
  const db = new WalletDatabase(':memory:');
  try { db.bindEnvironment('sandbox'); db.bindEnvironment('sandbox'); assert.throws(() => db.bindEnvironment('production'), /database_environment_mismatch/); }
  finally { db.close(); }
});
test('refund debits once, records spent debt and future topups settle debt', () => {
  const db = new WalletDatabase(':memory:');
  try {
    const user = db.createAccount();
    db.credit(user.id, { key: 'first', productId: 'coins_1500', amount: 1500 });
    db.spend(user.id, { id: randomUUID(), sku: 'companion:1', amount: 600 });
    db.revoke('first'); db.revoke('first');
    assert.equal(db.wallet(user.id).balance, 0); assert.equal(db.wallet(user.id).debt, 600);
    db.credit(user.id, { key: 'second', productId: 'coins_1500', amount: 1500 });
    assert.equal(db.wallet(user.id).balance, 900); assert.equal(db.wallet(user.id).debt, 0);
    assert.throws(() => db.credit(user.id, { key: 'first', productId: 'coins_1500', amount: 1500 }), /purchase_revoked/);
  } finally { db.close(); }
});
test('refund scan only revokes confirmed invalidation, never outages', async () => {
  const db = new WalletDatabase(':memory:');
  try {
    const user = db.createAccount(), vault = new ProofVault('a'.repeat(64));
    for (const key of ['a', 'b', 'c']) db.credit(user.id, { key, productId: 'coins_1500', amount: 1500, proof: vault.seal({ key }) });
    const verifier = { verify: async (_, data) => {
      if (data.key === 'a') throw new ApiError(422, 'purchase_revoked');
      if (data.key === 'b') throw new Error('network timeout');
    } };
    assert.deepEqual(await reconcile(db, verifier, vault), { checked: 1, revoked: 1, deferred: 1 });
    assert.equal(db.wallet(user.id).balance, 3000);
  } finally { db.close(); }
});
