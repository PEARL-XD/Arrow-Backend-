import { openDatabase } from './open_database.js';
import { ProofVault } from './proof_vault.js';
import { IdentityVerifier } from './identity.js';
import { AppleAccount } from './apple_account.js';
import { AccountLifecycle } from './account_lifecycle.js';
let database;
try {
  database = await openDatabase();
  await database.bindEnvironment(process.env.STORE_ENVIRONMENT || 'sandbox');
  const vault = process.env.RECEIPT_ENCRYPTION_KEY ? new ProofVault(process.env.RECEIPT_ENCRYPTION_KEY) : undefined;
  const lifecycle = new AccountLifecycle(database, new AppleAccount(process.env, new IdentityVerifier(process.env), vault));
  const result = await lifecycle.maintenance(); console.log(JSON.stringify(result));
  if (result.deferred) process.exitCode = 1;
} catch {
  console.error('Account maintenance failed; check database and Apple configuration privately.'); process.exitCode = 1;
} finally { if (database) await database.close(); }
