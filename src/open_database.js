import { MongoWalletDatabase } from './mongo_database.js';
import { requireValue } from './errors.js';

export async function openDatabase(env = process.env) {
  if (env.MONGODB_URI) {
    requireValue(!/tlsAllowInvalid|tlsInsecure|ssl=false|tls=false/i.test(env.MONGODB_URI), 500, 'insecure_mongodb_configuration');
    const database = new MongoWalletDatabase(env.MONGODB_URI, env.MONGODB_DATABASE);
    try { return await database.initialize(); }
    catch (error) { await database.close(); throw error; }
  }
  requireValue(env.RENDER !== 'true' && env.STORE_ENVIRONMENT !== 'production', 500, 'mongodb_required_for_deployment');
  const { WalletDatabase } = await import('./database.js');
  return new WalletDatabase(env.DATABASE_PATH || './data/wallet.sqlite');
}
