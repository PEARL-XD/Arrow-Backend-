import { openDatabase } from './open_database.js';
import { StoreVerifier } from './verifier.js';
import { ProofVault } from './proof_vault.js';
import { reconcile } from './reconcile.js';
let database;
try {
  const verifier = new StoreVerifier(process.env);
  database = await openDatabase(process.env);
  await database.bindEnvironment(verifier.environment);
  const result = await reconcile(database, verifier, new ProofVault(process.env.RECEIPT_ENCRYPTION_KEY));
  console.log(JSON.stringify(result));
  if (result.deferred) process.exitCode = 1;
} catch {
  console.error('Reconciliation failed; check database and provider configuration privately.');
  process.exitCode = 1;
} finally { if (database) await database.close(); }
