import { requireValue } from './errors.js';

export class AccountLifecycle {
  constructor(database, apple) { this.database = database; this.apple = apple; this.checks = new Map(); }
  ready(provider) { return provider !== 'apple' || this.apple?.ready === true; }
  async authorize(account) {
    if (!this.database.assertActive) return;
    await this.database.assertActive(account);
    const row = await this.database.appleIdentity(account);
    if (!row) return;
    requireValue(row.authorization && !row.authorization.revoked, 401, 'apple_authorization_revoked');
    if (row.authorization.checked_at > new Date(Date.now() - 86400000)) return;
    let operation = this.checks.get(account);
    if (!operation) {
      operation = this.validate(row).finally(() => this.checks.delete(account));
      this.checks.set(account, operation);
    }
    await operation;
  }
  async validate(row) {
    requireValue(this.apple?.ready, 503, 'apple_account_not_configured');
    try {
      await this.apple.validate(row);
      await this.database.appleChecked(row, false);
    } catch (error) {
      if (error.code === 'apple_authorization_revoked') await this.database.appleChecked(row, true);
      throw error;
    }
  }
  async finishDeletion(account) {
    const job = await this.database.deletionJob(account);
    if (!job) return true;
    try {
      for (const secret of job.apple_tokens) await this.apple.revoke(secret);
      await this.database.finishDeletion(account);
      return true;
    } catch { return false; } // Durable queue survives Render restarts; maintenance retries.
  }
  async maintenance() {
    let checked = 0, deleted = 0, deferred = 0;
    for await (const job of this.database.deletionJobs()) {
      if (await this.finishDeletion(job._id)) deleted++; else deferred++;
    }
    for await (const row of this.database.appleDue()) {
      try { await this.validate(row); checked++; }
      catch { deferred++; }
    }
    return { checked, deleted, deferred };
  }
}
