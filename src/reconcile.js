// Run periodically on the same host/database. Transient upstream failures never
// revoke a purchase. Invalidated/cancelled receipts produce a once-only reversal.
export async function reconcile(database, verifier, vault) {
  let cursor = '', checked = 0, revoked = 0, deferred = 0;
  for (;;) {
    const batch = await database.reconciliationBatch(cursor);
    if (!batch.length) break;
    for (const row of batch) {
      cursor = row.receipt_key;
      try {
        await verifier.verify(row.account_id, vault.open(row.proof));
        checked++;
      } catch (error) {
        if (error.code === 'purchase_revoked') {
          try { await database.revoke(row.receipt_key); revoked++; }
          catch { deferred++; }
        }
        else deferred++;
      }
    }
  }
  return { checked, revoked, deferred };
}
