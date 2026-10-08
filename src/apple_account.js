import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT, jwtVerify } from 'jose';
import { ApiError, requireValue } from './errors.js';

// Separate Sign in with Apple key, not the App Store purchase-verification key.
export class AppleAccount {
  constructor(env, identity, vault, { fetcher = fetch, signingKey } = {}) {
    this.identity = identity; this.vault = vault; this.fetcher = fetcher; this.signingKey = signingKey;
    this.team = env.APPLE_SIGN_IN_TEAM_ID; this.keyId = env.APPLE_SIGN_IN_KEY_ID;
    this.keyPath = env.APPLE_SIGN_IN_PRIVATE_KEY_PATH; this.audience = env.APPLE_SIGN_IN_BUNDLE_ID;
  }
  get ready() { return Boolean(this.audience && this.team && this.keyId && (this.keyPath || this.signingKey) && this.vault); }
  async secret() {
    requireValue(this.ready, 503, 'apple_account_not_configured');
    this.signingKey ??= await importPKCS8(await readFile(this.keyPath, 'utf8'), 'ES256');
    return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.team).setAudience('https://appleid.apple.com').setSubject(this.audience)
      .setIssuedAt().setExpirationTime('5m').sign(this.signingKey);
  }
  async post(path, values) {
    const body = new URLSearchParams({ client_id: this.audience, client_secret: await this.secret(), ...values });
    let response, result;
    try {
      response = await this.fetcher(`https://appleid.apple.com/auth/${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (path === 'revoke' && response.status === 200) return {};
      result = await response.json();
    } catch { throw new ApiError(503, 'apple_service_unavailable'); }
    if (result?.error === 'invalid_grant') throw new ApiError(401, 'apple_authorization_revoked');
    requireValue(response.ok && !result?.error, 503, 'apple_service_unavailable');
    return result;
  }
  async exchange(code, subject, nonce) {
    requireValue(typeof code === 'string' && code.length > 0 && code.length <= 10000, 400, 'apple_authorization_code_required');
    const response = await this.post('token', { code, grant_type: 'authorization_code' });
    const verified = await this.identity.verify('apple', response.id_token, nonce);
    requireValue(verified.subject === subject && typeof response.refresh_token === 'string' && response.refresh_token.length <= 10000 &&
      response.refresh_token.length > 0, 401, 'invalid_identity');
    return { secret: this.vault.seal({ refreshToken: response.refresh_token }), checked_at: new Date(), revoked: false };
  }
  async validate(row) {
    const { refreshToken } = this.vault.open(row.authorization.secret);
    const response = await this.post('token', { refresh_token: refreshToken, grant_type: 'refresh_token' });
    // Refresh responses do not contain the original nonce. Still verify every
    // signature, issuer, audience, expiry and the originally linked subject.
    const { payload } = await jwtVerify(response.id_token, this.identity.appleKeys, {
      issuer: 'https://appleid.apple.com', audience: this.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'],
    });
    requireValue(payload.sub === row.subject, 401, 'invalid_identity');
  }
  async revoke(secret) {
    const { refreshToken } = this.vault.open(secret);
    await this.post('revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
  }
  async notification(token) {
    requireValue(typeof token === 'string' && token.length <= 20000, 400, 'invalid_notification');
    try {
      const { payload } = await jwtVerify(token, this.identity.appleKeys, { issuer: 'https://appleid.apple.com',
        audience: this.audience, algorithms: ['RS256'], requiredClaims: ['iat', 'jti', 'events'] });
      const event = typeof payload.events === 'string' ? JSON.parse(payload.events) : payload.events;
      requireValue(typeof event?.sub === 'string' && event.sub.length > 0 && event.sub.length <= 256 &&
        typeof event.type === 'string' && Number.isSafeInteger(event.event_time) && typeof payload.jti === 'string' &&
        payload.jti.length > 0 && payload.jti.length <= 512, 401, 'invalid_notification');
      return { ...event, id: payload.jti };
    } catch { throw new ApiError(401, 'invalid_notification'); }
  }
}
