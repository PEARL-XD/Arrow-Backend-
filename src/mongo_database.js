import { MongoClient } from 'mongodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, requireValue } from './errors.js';
import { items, permanent, packs } from './catalog.js';
import { validateProgress } from './profile.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const duplicate = error => error?.code === 11000;
const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeoutMS: 10000 },
  readPreference: 'primary', maxCommitTimeMS: 10000, timeoutMS: 20000 };

// Identical HTTP contract to the local SQLite development adapter. Never write
// production wallets or saves to Render's ephemeral filesystem.
export class MongoWalletDatabase {
  constructor(uri, databaseName, { client } = {}) {
    requireValue(typeof uri === 'string' && /^mongodb(?:\+srv)?:\/\//.test(uri), 500, 'invalid_mongodb_configuration');
    requireValue(typeof databaseName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(databaseName) &&
      !['admin', 'local', 'config', 'test'].includes(databaseName), 500, 'dedicated_mongodb_database_required');
    const loopback = /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|\?|$)/i.test(uri);
    this.client = client ?? new MongoClient(uri, { ...(!loopback ? { tls: true } : {}), appName: 'arrow-last-lantern', maxPoolSize: 8,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, timeoutMS: 15000,
      readPreference: 'primary', readConcern: { level: 'majority' }, writeConcern: { w: 'majority', wtimeoutMS: 10000 } });
    this.db = this.client.db(databaseName);
    for (const name of ['accounts', 'purchases', 'spends', 'entitlements', 'metadata', 'identities', 'sessions', 'auth_challenges', 'cloud_progress', 'deletion_jobs', 'receipt_tombstones', 'apple_events', 'deleted_credentials']) {
      this[name] = this.db.collection(name);
    }
  }
  async initialize() {
    await this.client.connect();
    const hello = await this.db.admin().command({ hello: 1 });
    requireValue((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null,
      500, 'mongodb_transactions_required');
    await this.accounts.createIndex({ token_hash: 1 }, { unique: true });
    await this.purchases.createIndex({ account_id: 1 });
    await this.purchases.createIndex({ revoked: 1, _id: 1 });
    await this.spends.createIndex({ account_id: 1, acknowledged: 1, created_at: 1 });
    await this.entitlements.createIndex({ account_id: 1, sku: 1 }, { unique: true });
    await this.identities.createIndex({ provider: 1, subject: 1 }, { unique: true });
    await this.identities.createIndex({ account_id: 1, provider: 1 }, { unique: true });
    await this.sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await this.auth_challenges.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await this.auth_challenges.createIndex({ account_id: 1 });
    await this.metadata.createIndex({ _id: 1 });
    await this.cloud_progress.createIndex({ _id: 1 });
    await this.deletion_jobs.createIndex({ _id: 1 });
    await this.receipt_tombstones.createIndex({ _id: 1 });
    await this.apple_events.createIndex({ _id: 1 });
    await this.deleted_credentials.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    // Exercise a real committed transaction before opening the HTTP listener.
    await this.atomic(async session => {
      await this.metadata.updateOne({ _id: 'transaction_probe' }, { $set: { checked_at: new Date() } }, { upsert: true, session });
    });
    return this;
  }
  async ping() { await this.db.command({ ping: 1 }, { timeoutMS: 3000 }); }
  async close() { await this.client.close(); }
  async atomic(fn) {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => fn(session), txOptions); }
    finally { await session.endSession(); }
  }
  async bindEnvironment(environment) {
    requireValue(['sandbox', 'production'].includes(environment), 500, 'invalid_store_environment');
    try {
      await this.metadata.updateOne({ _id: 'store_environment' }, { $setOnInsert: { value: environment } }, { upsert: true });
    } catch (error) { if (!duplicate(error)) throw error; }
    const row = await this.metadata.findOne({ _id: 'store_environment' });
    requireValue(row?.value === environment, 500, 'database_environment_mismatch');
  }
  async createAccount() {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await this.accounts.insertOne({ _id: id, token_hash: hash(token), balance: 0, debt: 0, revision: 0, identity_revision: 0, status: 'active', created_at: new Date() });
    return { id, token };
  }
  async authenticate(token) {
    requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'unauthorized');
    const key = hash(token);
    const account = await this.accounts.findOne({ token_hash: key });
    if (account) return account._id;
    const session = await this.sessions.findOne({ _id: key, expires_at: { $gt: new Date() } });
    if (!session && await this.deleted_credentials.findOne({ _id: key, expires_at: { $gt: new Date() } })) throw new ApiError(410, 'account_deleted');
    requireValue(session && await this.accounts.findOne({ _id: session.account_id }), 401, 'unauthorized');
    return session.account_id;
  }
  async lockAccount(id, session) {
    const row = await this.accounts.findOneAndUpdate({ _id: id, status: { $ne: 'deleting' } }, { $inc: { identity_revision: 1 } }, { session, returnDocument: 'after' });
    requireValue(row, 404, 'account_not_found');
    return row;
  }
  async providers(account, session) {
    return (await this.identities.find({ account_id: account }, { session }).toArray()).map(x => x.provider);
  }
  async wallet(id, session) {
    if (!session) return this.atomic(s => this.wallet(id, s));
    const row = await this.accounts.findOne({ _id: id }, { session });
    requireValue(row, 404, 'account_not_found');
    requireValue(row.status !== 'deleting', 409, 'account_deletion_pending');
    const providers = await this.providers(id, session);
    const owned = await this.entitlements.find({ account_id: id }, { session }).toArray();
    const pending = await this.spends.find({ account_id: id, acknowledged: false }, { session }).sort({ created_at: 1, _id: 1 }).toArray();
    return { id, balance: row.balance, debt: row.debt, revision: row.revision, providers,
      entitlements: owned.map(x => x.sku), deliveries: pending.map(x => ({ id: x._id, sku: x.sku, amount: x.amount })) };
  }
  async credit(id, verified) {
    requireValue(Object.hasOwn(packs, verified.productId) && verified.amount === packs[verified.productId] &&
      typeof verified.key === 'string' && verified.key.length > 0 && verified.key.length <= 512, 422, 'invalid_credit');
    const operation = session => this.creditInside(id, verified, session);
    try { return await this.atomic(operation); }
    catch (error) { if (!duplicate(error)) throw error; return this.atomic(operation); }
  }
  async creditInside(id, verified, session) {
    requireValue(!await this.receipt_tombstones.findOne({ _id: hash(verified.key) }, { session }), 409, 'purchase_account_deleted');
    const old = await this.purchases.findOne({ _id: verified.key }, { session });
    if (old) {
      requireValue(old.account_id === id && old.product_id === verified.productId, 409, 'purchase_owned_elsewhere');
      requireValue(!old.revoked, 409, 'purchase_revoked');
      return this.wallet(id, session);
    }
    requireValue(!verified.consumed, 409, 'already_consumed_without_ledger');
    const row = await this.lockAccount(id, session);
    await this.purchases.insertOne({ _id: verified.key, account_id: id, product_id: verified.productId,
      amount: verified.amount, revoked: false, proof: verified.proof ?? null, created_at: new Date() }, { session });
    const balance = row.balance + Math.max(0, verified.amount - row.debt), debt = Math.max(0, row.debt - verified.amount);
    requireValue(Number.isSafeInteger(balance) && balance >= 0, 503, 'wallet_limit');
    await this.accounts.updateOne({ _id: id }, { $set: { balance, debt }, $inc: { revision: 1 } }, { session });
    return this.wallet(id, session);
  }
  async spend(account, { id, sku, amount } = {}) {
    requireValue(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 400, 'invalid_request_id');
    requireValue(typeof sku === 'string' && Object.hasOwn(items, sku) && Number.isSafeInteger(amount) && amount > 0 && amount <= items[sku], 400, 'invalid_spend');
    const operation = async session => {
      const previous = await this.spends.findOne({ _id: id }, { session });
      if (previous) {
        requireValue(previous.account_id === account && previous.sku === sku && previous.amount === amount, 409, 'idempotency_conflict');
        return this.wallet(account, session);
      }
      if (permanent(sku)) requireValue(!await this.entitlements.findOne({ account_id: account, sku }, { session }), 409, 'already_owned');
      const debit = await this.accounts.updateOne({ _id: account, status: { $ne: 'deleting' }, balance: { $gte: amount }, debt: 0 },
        { $inc: { balance: -amount, revision: 1 } }, { session });
      requireValue(debit.modifiedCount === 1, 409, 'insufficient_coins');
      await this.spends.insertOne({ _id: id, account_id: account, sku, amount, acknowledged: false, created_at: new Date() }, { session });
      if (permanent(sku)) await this.entitlements.insertOne({ account_id: account, sku }, { session });
      return this.wallet(account, session);
    };
    try { return await this.atomic(operation); }
    catch (error) { if (!duplicate(error)) throw error; return this.atomic(operation); }
  }
  async acknowledge(account, id) {
    requireValue(typeof id === 'string', 400, 'invalid_request_id');
    await this.spends.updateOne({ _id: id, account_id: account }, { $set: { acknowledged: true } });
  }
  async revoke(key) {
    return this.atomic(async session => {
      const purchase = await this.purchases.findOne({ _id: key }, { session });
      if (!purchase || purchase.revoked) return;
      const row = await this.lockAccount(purchase.account_id, session);
      await this.accounts.updateOne({ _id: row._id }, { $set: { balance: Math.max(0, row.balance - purchase.amount),
        debt: row.debt + Math.max(0, purchase.amount - row.balance) }, $inc: { revision: 1 } }, { session });
      await this.purchases.updateOne({ _id: key }, { $set: { revoked: true } }, { session });
    });
  }
  async reconciliationBatch(after = '', limit = 100) {
    const rows = await this.purchases.find({ revoked: false, proof: { $ne: null }, _id: { $gt: after } })
      .sort({ _id: 1 }).limit(Math.max(1, Math.min(100, limit))).toArray();
    return rows.map(x => ({ receipt_key: x._id, account_id: x.account_id, proof: x.proof }));
  }
  async challenge(account, provider) {
    requireValue(['apple', 'google'].includes(provider), 400, 'invalid_provider');
    await this.assertActive(account);
    const id = randomUUID(), nonce = randomBytes(32).toString('hex');
    await this.auth_challenges.insertOne({ _id: id, account_id: account, provider, nonce, expires_at: new Date(Date.now() + 300000) });
    return { id, nonce };
  }
  async challengeFor(account, provider, id, session) {
    requireValue(typeof id === 'string' && ['apple', 'google'].includes(provider), 400, 'invalid_challenge');
    const challenge = await this.auth_challenges.findOne({ _id: id, account_id: account, provider, expires_at: { $gt: new Date() } }, { session });
    requireValue(challenge, 401, 'invalid_challenge');
    return { ...challenge, id: challenge._id };
  }
  async linkIdentity(account, identity, challengeId) {
    requireValue(['apple', 'google'].includes(identity.provider) && typeof identity.subject === 'string' &&
      identity.subject.length > 0 && identity.subject.length <= 256, 400, 'invalid_identity');
    try { return await this.atomic(async session => {
      await this.lockAccount(account, session);
      await this.challengeFor(account, identity.provider, challengeId, session);
      const found = await this.identities.findOne({ provider: identity.provider, subject: identity.subject }, { session });
      const target = found?.account_id ?? account;
      if (target !== account) {
        const wallet = await this.wallet(account, session);
        requireValue(wallet.providers.length === 0, 409, 'account_link_conflict');
        requireValue(wallet.balance === 0 && wallet.debt === 0 && wallet.entitlements.length === 0 && wallet.deliveries.length === 0 &&
          !await this.purchases.findOne({ account_id: account }, { session }), 409, 'wallet_link_conflict');
        await this.lockAccount(target, session);
      } else if (!found) {
        requireValue(!await this.identities.findOne({ account_id: account, provider: identity.provider }, { session }), 409, 'account_link_conflict');
        await this.identities.insertOne({ provider: identity.provider, subject: identity.subject, account_id: account, created_at: new Date() }, { session });
      }
      if (identity.provider === 'apple' && identity.authorization) {
        await this.identities.updateOne({ provider: 'apple', subject: identity.subject }, { $set: { authorization: identity.authorization } }, { session });
      }
      await this.auth_challenges.deleteOne({ _id: challengeId }, { session });
      const token = randomBytes(32).toString('base64url');
      await this.sessions.insertOne({ _id: hash(token), account_id: target, expires_at: new Date(Date.now() + 30 * 86400000) }, { session });
      return { token, wallet: await this.wallet(target, session), cloud: await this.progress(target, session) };
    }); } catch (error) { if (duplicate(error)) throw new ApiError(409, 'account_link_conflict'); throw error; }
  }
  async progress(account, session) {
    requireValue((await this.providers(account, session)).length > 0, 403, 'account_not_linked');
    const row = await this.cloud_progress.findOne({ _id: account }, { session });
    return row ? { revision: row.revision, progress: row.progress, updatedAt: row.updated_at.toISOString() } : { revision: 0, progress: null };
  }
  async saveProgress(account, { revision, progress } = {}) {
    requireValue(Number.isSafeInteger(revision) && revision >= 0, 400, 'invalid_revision');
    const saved = JSON.parse(validateProgress(progress));
    try { return await this.atomic(async session => {
      await this.lockAccount(account, session);
      const current = await this.progress(account, session);
      requireValue(current.revision === revision, 409, 'progress_conflict');
      await this.cloud_progress.replaceOne({ _id: account }, { _id: account, revision: revision + 1,
        progress: saved, updated_at: new Date() }, { upsert: true, session });
      return this.progress(account, session);
    }); } catch (error) { if (duplicate(error)) throw new ApiError(409, 'progress_conflict'); throw error; }
  }
  async assertActive(account) {
    const row = await this.accounts.findOne({ _id: account });
    requireValue(row, 401, 'unauthorized');
    requireValue(row.status !== 'deleting', 409, 'account_deletion_pending');
  }
  async appleIdentity(account) { return this.identities.findOne({ account_id: account, provider: 'apple' }); }
  appleDue() { return this.identities.find({ provider: 'apple', 'authorization.revoked': false,
    'authorization.checked_at': { $lt: new Date(Date.now() - 86400000) } }); }
  async appleChecked(row, revoked) {
    await this.atomic(async session => {
      const result = await this.identities.updateOne({ _id: row._id, 'authorization.secret': row.authorization.secret },
        { $set: { 'authorization.checked_at': new Date(), 'authorization.revoked': revoked } }, { session });
      if (revoked && result.modifiedCount) await this.sessions.deleteMany({ account_id: row.account_id }, { session });
    });
  }
  async requestDeletion(account, identity, challengeId, { notified = false } = {}) {
    return this.atomic(session => this.requestDeletionInside(account, identity, challengeId, notified, session));
  }
  async requestDeletionInside(account, identity, challengeId, notified, session) {
      const existing = await this.deletion_jobs.findOne({ _id: account }, { session });
      if (existing) return existing;
      await this.lockAccount(account, session);
      const linked = await this.identities.find({ account_id: account }, { session }).toArray();
      if (!notified && linked.length) {
        requireValue(identity && linked.some(x => x.provider === identity.provider && x.subject === identity.subject), 403, 'identity_mismatch');
        await this.challengeFor(account, identity.provider, challengeId, session);
      }
      const job = { _id: account, apple_tokens: linked.filter(x => x.provider === 'apple' && x.authorization?.secret).map(x => x.authorization.secret), created_at: new Date() };
      await this.deletion_jobs.insertOne(job, { session });
      await this.accounts.updateOne({ _id: account }, { $set: { status: 'deleting' } }, { session });
      await this.cloud_progress.deleteOne({ _id: account }, { session });
      await this.auth_challenges.deleteMany({ account_id: account }, { session });
      return job;
  }
  async deletionJob(account) { return this.deletion_jobs.findOne({ _id: account }); }
  deletionJobs() { return this.deletion_jobs.find().sort({ created_at: 1 }); }
  async finishDeletion(account) {
    await this.atomic(async session => {
      if (!await this.deletion_jobs.findOne({ _id: account }, { session })) return;
      const row = await this.accounts.findOne({ _id: account }, { session });
      const tokens = (await this.sessions.find({ account_id: account }, { session }).toArray()).map(x => x._id);
      if (row?.token_hash) tokens.push(row.token_hash);
      for (const token of tokens) await this.deleted_credentials.updateOne({ _id: token },
        { $set: { expires_at: new Date(Date.now() + 30 * 86400000) } }, { upsert: true, session });
      // Retain only irreversible transaction fingerprints, without account IDs,
      // provider subjects or receipt evidence, so deleted receipts can't mint coins.
      for await (const purchase of this.purchases.find({ account_id: account }, { session })) {
        await this.receipt_tombstones.updateOne({ _id: hash(purchase._id) }, { $setOnInsert: { _id: hash(purchase._id) } }, { upsert: true, session });
      }
      for (const collection of [this.purchases, this.spends, this.entitlements, this.identities, this.sessions, this.auth_challenges]) {
        await collection.deleteMany({ account_id: account }, { session });
      }
      await this.cloud_progress.deleteOne({ _id: account }, { session });
      await this.accounts.deleteOne({ _id: account }, { session });
      await this.deletion_jobs.deleteOne({ _id: account }, { session });
    });
  }
  async appleNotification(event) {
    try { return await this.atomic(async session => {
      const eventId = hash(event.id);
      if (await this.apple_events.findOne({ _id: eventId }, { session })) return null;
      await this.apple_events.insertOne({ _id: eventId }, { session });
      const row = await this.identities.findOne({ provider: 'apple', subject: event.sub }, { session });
      if (!row || (row.created_at && event.event_time < Math.floor(row.created_at.getTime() / 1000))) return null;
      if (['consent-revoked', 'account-deleted'].includes(event.type)) {
        await this.requestDeletionInside(row.account_id, null, null, true, session);
        return row.account_id;
      }
      return null;
    }); } catch (error) { if (duplicate(error)) return null; throw error; }
  }
  async webDeletionChallenge() {
    const id = randomUUID(), nonce = randomBytes(32).toString('hex');
    await this.auth_challenges.insertOne({ _id: id, account_id: 'web_deletion', provider: 'google', nonce, expires_at: new Date(Date.now() + 300000) });
    return { id, nonce };
  }
  async requestWebDeletion(identity, challengeId) {
    return this.atomic(async session => {
      await this.challengeFor('web_deletion', 'google', challengeId, session);
      const row = await this.identities.findOne({ provider: 'google', subject: identity.subject }, { session });
      await this.auth_challenges.deleteOne({ _id: challengeId }, { session });
      if (!row) return null;
      await this.requestDeletionInside(row.account_id, null, null, true, session);
      return row.account_id;
    });
  }
}
