import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { requireValue } from './errors.js';

// Provider IDs are verified subjects, never client-supplied email addresses.
export class IdentityVerifier {
  constructor(env = {}, { google = new OAuth2Client(), appleKeys } = {}) {
    this.google = google;
    this.googleAudience = env.GOOGLE_SIGN_IN_CLIENT_ID || '';
    this.appleAudience = env.APPLE_SIGN_IN_BUNDLE_ID || '';
    this.appleKeys = appleKeys ?? createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
  }
  ready(provider) {
    return provider === 'google' ? Boolean(this.googleAudience) :
      provider === 'apple' && Boolean(this.appleAudience);
  }
  async verify(provider, idToken, nonce, { requireNonce = false } = {}) {
    requireValue(this.ready(provider), 503, 'sign_in_not_configured');
    requireValue(typeof idToken === 'string' && idToken.length <= 10000, 400, 'invalid_identity');
    let payload;
    try {
      if (provider === 'google') {
        payload = (await this.google.verifyIdToken({ idToken, audience: this.googleAudience })).getPayload();
        requireValue(['accounts.google.com', 'https://accounts.google.com'].includes(payload?.iss), 401, 'invalid_identity');
        if (requireNonce) requireValue(payload.nonce === nonce, 401, 'invalid_identity');
      } else {
        ({ payload } = await jwtVerify(idToken, this.appleKeys, {
          issuer: 'https://appleid.apple.com', audience: this.appleAudience,
          algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        }));
        requireValue(payload.nonce === nonce, 401, 'invalid_identity');
      }
    } catch (_) { requireValue(false, 401, 'invalid_identity'); }
    requireValue(typeof payload?.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 256, 401, 'invalid_identity');
    requireValue(Number.isSafeInteger(payload.exp) && payload.exp > Date.now() / 1000, 401, 'invalid_identity');
    return { provider, subject: payload.sub, issuedAt: payload.iat };
  }
}
