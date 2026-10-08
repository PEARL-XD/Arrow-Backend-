import { openDatabase } from './open_database.js';
import { StoreVerifier } from './verifier.js';
import { createApp } from './app.js';
import { ProofVault } from './proof_vault.js';
import { IdentityVerifier } from './identity.js';

import { requireValue } from './errors.js';
import { AppleAccount } from './apple_account.js';
import { AccountLifecycle } from './account_lifecycle.js';

let database;
try {
  const port = Number(process.env.PORT || 8080), proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535 && Number.isInteger(proxyHops) && proxyHops >= 0 && proxyHops <= 5,
    500, 'invalid_server_configuration');
  const verifier = new StoreVerifier(process.env);
  requireValue((verifier.environment !== 'production' && process.env.RENDER !== 'true') || process.env.REQUIRE_HTTPS === 'true',
    500, 'https_required_for_deployment');
  database = await openDatabase(process.env);
  await database.bindEnvironment(verifier.environment);
  const vault = verifier.enabled || process.env.RECEIPT_ENCRYPTION_KEY ? new ProofVault(process.env.RECEIPT_ENCRYPTION_KEY) : undefined;
  const identity = new IdentityVerifier(process.env);
  const lifecycle = new AccountLifecycle(database, new AppleAccount(process.env, identity, vault));
  const app = createApp({ database, verifier, identity, lifecycle, vault, requireHttps: process.env.REQUIRE_HTTPS === 'true', proxyHops });
  // The owner may monitor /ready externally; this server does not self-ping.
  // Monitoring cannot guarantee uptime. Durable cleanup resumes after restarts;
  // use a separately monitored runner for work while the web server is offline.
  let maintaining = false;
  const maintain = async () => {
    if (maintaining || !database.deletionJobs) return;
    maintaining = true;
    try { const result = await lifecycle.maintenance(); if (result.deferred) console.warn('Account maintenance has deferred work.'); }
    catch { console.warn('Account maintenance unavailable; retry scheduled.'); }
    finally { maintaining = false; }
  };
  void maintain();
  const maintenanceTimer = setInterval(maintain, 60000).unref();
  const server = app.listen(port, process.env.HOST || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1'),
    () => console.log(`Arrow wallet listening; ${verifier.environment}; checkout ${verifier.enabled ? 'configured per platform' : 'disabled'}`));
  server.on('error', async () => { console.error('Server failed to listen.'); await database.close(); process.exitCode = 1; });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(maintenanceTimer);
    const deadline = setTimeout(() => process.exit(1), 15000).unref();
    server.close(async () => {
      try { await database.close(); clearTimeout(deadline); process.exit(0); }
      catch { process.exitCode = 1; }
    });
  });
} catch (error) {
  // Connection strings and provider errors may contain credentials: never log them.
  console.error(`Backend startup failed: ${error.status && error.code ? error.code : 'configuration_or_database_unavailable'}`);
  if (database) await database.close().catch(() => {});
  process.exitCode = 1;
}
