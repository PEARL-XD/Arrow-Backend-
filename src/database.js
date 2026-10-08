import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { items, permanent, packs } from './catalog.js';
import { requireValue } from './errors.js';
import { validateProgress } from './profile.js';

const hash = token => createHash('sha256').update(token).digest('hex');
export class WalletDatabase {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
        debt INTEGER NOT NULL DEFAULT 0 CHECK(debt >= 0), revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS purchases (
        receipt_key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        product_id TEXT NOT NULL, amount INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, proof TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS spends (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        sku TEXT NOT NULL, amount INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS entitlements (
        account_id TEXT NOT NULL REFERENCES accounts(id), sku TEXT NOT NULL,
        PRIMARY KEY(account_id, sku));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        provider TEXT NOT NULL, subject TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        PRIMARY KEY(provider,subject));
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        provider TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_progress (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        revision INTEGER NOT NULL, progress TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    // Additive migrations for databases created during local development.
    const accountColumns = new Set(this.db.prepare('PRAGMA table_info(accounts)').all().map(x => x.name));
    for (const column of ['debt', 'revision']) if (!accountColumns.has(column)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!this.db.prepare('PRAGMA table_info(purchases)').all().some(x => x.name === 'proof')) this.db.exec('ALTER TABLE purchases ADD COLUMN proof TEXT');
  }
  ping() { this.db.prepare('SELECT 1').get(); }
  bindEnvironment(environment) {
    this.atomic(() => {
      const row = this.db.prepare("SELECT value FROM metadata WHERE key='store_environment'").get();
      requireValue(!row || row.value === environment, 500, 'database_environment_mismatch');
      this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('store_environment',?)").run(environment);
    });
  }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createAccount() {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO accounts(id,token_hash) VALUES (?,?)').run(id, hash(token));
    return { id, token };
  }
  authenticate(token) {
    requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'unauthorized');
    const row = this.db.prepare('SELECT id FROM accounts WHERE token_hash=?').get(hash(token)) ??
      this.db.prepare('SELECT account_id AS id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    requireValue(row, 401, 'unauthorized');
    return row.id;
  }
  wallet(id) {
    const row = this.db.prepare('SELECT balance,debt,revision FROM accounts WHERE id=?').get(id);
    requireValue(row, 404, 'account_not_found');
    return {
      id, balance: row.balance, debt: row.debt, revision: row.revision,
      providers: this.providers(id),
      entitlements: this.db.prepare('SELECT sku FROM entitlements WHERE account_id=?').all(id).map(x => x.sku),
      deliveries: this.db.prepare('SELECT id,sku,amount FROM spends WHERE account_id=? AND acknowledged=0 ORDER BY created_at,id').all(id),
    };
  }
  credit(id, verified) {
    requireValue(Object.hasOwn(packs, verified.productId) && verified.amount === packs[verified.productId], 422, 'invalid_credit');
    return this.atomic(() => {
      const old = this.db.prepare('SELECT * FROM purchases WHERE receipt_key=?').get(verified.key);
      if (old) {
        requireValue(old.account_id === id && old.product_id === verified.productId, 409, 'purchase_owned_elsewhere');
        requireValue(!old.revoked, 409, 'purchase_revoked');
        return this.wallet(id);
      }
      requireValue(!verified.consumed, 409, 'already_consumed_without_ledger');
      this.db.prepare('INSERT INTO purchases(receipt_key,account_id,product_id,amount,proof) VALUES (?,?,?,?,?)')
        .run(verified.key, id, verified.productId, verified.amount, verified.proof ?? null);
      this.db.prepare('UPDATE accounts SET balance=balance+MAX(0,?-debt), debt=MAX(0,debt-?), revision=revision+1 WHERE id=?').run(verified.amount, verified.amount, id);
      return this.wallet(id);
    });
  }
  spend(account, { id, sku, amount }) {
    requireValue(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 400, 'invalid_request_id');
    requireValue(Object.hasOwn(items, sku) && Number.isSafeInteger(amount) && amount > 0 && amount <= items[sku], 400, 'invalid_spend');
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT * FROM spends WHERE id=?').get(id);
      if (previous) {
        requireValue(previous.account_id === account && previous.sku === sku && previous.amount === amount, 409, 'idempotency_conflict');
        return this.wallet(account);
      }
      if (permanent(sku)) requireValue(!this.db.prepare('SELECT 1 FROM entitlements WHERE account_id=? AND sku=?').get(account, sku), 409, 'already_owned');
      const result = this.db.prepare('UPDATE accounts SET balance=balance-?,revision=revision+1 WHERE id=? AND balance>=? AND debt=0').run(amount, account, amount);
      requireValue(result.changes === 1, 409, 'insufficient_coins');
      this.db.prepare('INSERT INTO spends(id,account_id,sku,amount) VALUES (?,?,?,?)').run(id, account, sku, amount);
      if (permanent(sku)) this.db.prepare('INSERT INTO entitlements(account_id,sku) VALUES (?,?)').run(account, sku);
      return this.wallet(account);
    });
  }
  acknowledge(account, id) {
    this.db.prepare('UPDATE spends SET acknowledged=1 WHERE account_id=? AND id=?').run(account, id);
  }
  revoke(key) {
    this.atomic(() => {
      const purchase = this.db.prepare('SELECT * FROM purchases WHERE receipt_key=?').get(key);
      if (!purchase || purchase.revoked) return;
      this.db.prepare('UPDATE accounts SET debt=debt+MAX(0,?-balance),balance=MAX(0,balance-?),revision=revision+1 WHERE id=?')
        .run(purchase.amount, purchase.amount, purchase.account_id);
      this.db.prepare('UPDATE purchases SET revoked=1 WHERE receipt_key=?').run(key);
    });
  }
  reconciliationBatch(after = '', limit = 100) {
    return this.db.prepare('SELECT receipt_key,account_id,proof FROM purchases WHERE revoked=0 AND proof IS NOT NULL AND receipt_key>? ORDER BY receipt_key LIMIT ?').all(after, limit);
  }
  close() { this.db.close(); }

  providers(account) {
    return this.db.prepare('SELECT DISTINCT provider FROM identities WHERE account_id=?').all(account).map(x => x.provider);
  }
  challenge(account, provider) {
    requireValue(['apple', 'google'].includes(provider), 400, 'invalid_provider');
    this.db.prepare('DELETE FROM auth_challenges WHERE expires_at<?').run(Date.now());
    const id = randomUUID(), nonce = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO auth_challenges VALUES (?,?,?,?,?)').run(id, account, provider, nonce, Date.now() + 300000);
    return { id, nonce };
  }
  challengeFor(account, provider, id) {
    requireValue(typeof id === 'string', 400, 'invalid_challenge');
    const challenge = this.db.prepare('SELECT * FROM auth_challenges WHERE id=? AND account_id=? AND provider=? AND expires_at>?').get(id, account, provider, Date.now());
    requireValue(challenge, 401, 'invalid_challenge');
    return challenge;
  }
  linkIdentity(account, identity, challengeId) {
    requireValue(['apple','google'].includes(identity.provider) && typeof identity.subject === 'string' && identity.subject.length > 0, 400, 'invalid_identity');
    return this.atomic(() => {
      this.challengeFor(account, identity.provider, challengeId);
      const found = this.db.prepare('SELECT account_id FROM identities WHERE provider=? AND subject=?').get(identity.provider, identity.subject);
      const target = found?.account_id ?? account;
      if (target !== account) {
        // Never silently abandon or merge a paid guest wallet / another linked profile.
        const wallet = this.wallet(account);
        requireValue(wallet.providers.length === 0, 409, 'account_link_conflict');
        requireValue(wallet.balance === 0 && wallet.debt === 0 && wallet.entitlements.length === 0 && wallet.deliveries.length === 0 &&
          !this.db.prepare('SELECT 1 FROM purchases WHERE account_id=?').get(account), 409, 'wallet_link_conflict');
      } else if (!found) {
        requireValue(!this.db.prepare('SELECT 1 FROM identities WHERE account_id=? AND provider=?').get(account, identity.provider), 409, 'account_link_conflict');
        this.db.prepare('INSERT INTO identities VALUES (?,?,?)').run(identity.provider, identity.subject, account);
      }
      this.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(challengeId);
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), target, Date.now() + 30 * 86400000);
      return { token, wallet: this.wallet(target), cloud: this.progress(target) };
    });
  }
  progress(account) {
    requireValue(this.providers(account).length > 0, 403, 'account_not_linked');
    const row = this.db.prepare('SELECT revision,progress,updated_at FROM cloud_progress WHERE account_id=?').get(account);
    return row ? { revision: row.revision, progress: JSON.parse(row.progress), updatedAt: row.updated_at } : { revision: 0, progress: null };
  }
  saveProgress(account, { revision, progress } = {}) {
    requireValue(this.providers(account).length > 0, 403, 'account_not_linked');
    requireValue(Number.isSafeInteger(revision) && revision >= 0, 400, 'invalid_revision');
    const json = validateProgress(progress);
    return this.atomic(() => {
      const current = this.progress(account);
      requireValue(current.revision === revision, 409, 'progress_conflict');
      this.db.prepare(`INSERT INTO cloud_progress(account_id,revision,progress) VALUES (?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,progress=excluded.progress,updated_at=CURRENT_TIMESTAMP`).run(account, revision + 1, json);
      return this.progress(account);
    });
  }
}
