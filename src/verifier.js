import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { AppStoreServerAPIClient, SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import { packs } from './catalog.js';
import { requireValue } from './errors.js';

// Never trust coin amounts, receipt contents or purchase status supplied by the app.
export class StoreVerifier {
  constructor(env) {
    this.environment = env.STORE_ENVIRONMENT || 'sandbox';
    requireValue(['sandbox', 'production'].includes(this.environment), 500, 'invalid_store_environment');
    this.enabled = env.PURCHASES_ENABLED === 'true';
    this.packageName = env.ANDROID_PACKAGE_NAME;
    this.androidReady = !!(this.packageName && env.GOOGLE_APPLICATION_CREDENTIALS);
    this.auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    this.appleReady = !!(env.APPLE_BUNDLE_ID && env.APPLE_KEY_ID && env.APPLE_ISSUER_ID && env.APPLE_PRIVATE_KEY_PATH && env.APPLE_ROOT_CERT_PATHS && (this.environment === 'sandbox' || env.APPLE_APP_ID));
    if (this.appleReady) {
      const environment = this.environment === 'sandbox' ? Environment.SANDBOX : Environment.PRODUCTION;
      this.apple = new AppStoreServerAPIClient(readFileSync(env.APPLE_PRIVATE_KEY_PATH, 'utf8'), env.APPLE_KEY_ID, env.APPLE_ISSUER_ID, env.APPLE_BUNDLE_ID, environment);
      const roots = env.APPLE_ROOT_CERT_PATHS.split(',').map(p => readFileSync(p.trim()));
      this.appleVerifier = new SignedDataVerifier(roots, true, environment, env.APPLE_BUNDLE_ID, env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined);
    }
  }
  ready(platform) { return this.enabled && (platform === 'ios' ? this.appleReady : platform === 'android' && this.androidReady); }
  async verify(account, input) {
    const { platform, productId, token, transactionId } = input;
    requireValue(this.ready(platform), 503, 'purchases_not_configured');
    requireValue(Object.hasOwn(packs, productId), 400, 'unknown_product');
    if (platform === 'ios') {
      requireValue(typeof transactionId === 'string' && /^\d{1,30}$/.test(transactionId), 400, 'invalid_transaction');
      const response = await this.apple.getTransactionInfo(transactionId);
      const receipt = await this.appleVerifier.verifyAndDecodeTransaction(response.signedTransactionInfo);
      requireValue(receipt.transactionId === transactionId && receipt.productId === productId && receipt.type === 'Consumable' && receipt.quantity === 1, 422, 'invalid_purchase');
      requireValue(receipt.appAccountToken?.toLowerCase() === account.toLowerCase(), 403, 'purchase_account_mismatch');
      requireValue(!receipt.revocationDate, 422, 'purchase_revoked');
      return { key: `ios:${this.environment}:${transactionId}`, productId, amount: packs[productId], consumed: false };
    }
    requireValue(typeof token === 'string' && token.length >= 10 && token.length <= 4096, 400, 'invalid_token');
    const client = await this.auth.getClient();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
    const { data } = await client.request({ url, timeout: 15000, retry: false });
    requireValue(data.obfuscatedExternalAccountId === account, 403, 'purchase_account_mismatch');
    const isTest = data.purchaseType === 0;
    requireValue(isTest === (this.environment === 'sandbox'), 422, 'wrong_store_environment');
    requireValue(data.purchaseState !== 1, 422, 'purchase_revoked');
    requireValue(data.purchaseState === 0 && (data.quantity ?? 1) === 1, 422, 'purchase_not_completed');
    return { key: `android:${this.environment}:${createHash('sha256').update(token).digest('hex')}`, productId, amount: packs[productId], consumed: data.consumptionState === 1 };
  }
}
