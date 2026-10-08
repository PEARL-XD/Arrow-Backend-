import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from 'jose';
import { IdentityVerifier } from '../src/identity.js';
import { AppleAccount } from '../src/apple_account.js';
import { ProofVault } from '../src/proof_vault.js';

async function fixture() {
  const apple = await generateKeyPair('RS256'), client = await generateKeyPair('ES256');
  const key = { ...await exportJWK(apple.publicKey), kid: 'apple-key', alg: 'RS256' };
  const identity = new IdentityVerifier({ APPLE_SIGN_IN_BUNDLE_ID: 'our.bundle' }, { appleKeys: createLocalJWKSet({ keys: [key] }) });
  const vault = new ProofVault('1'.repeat(64));
  const requests = [];
  const signed = async (subject = 'player', nonce = 'server-nonce', events) => {
    const jwt = new SignJWT(events ? { events } : { ...(nonce ? { nonce } : {}) }).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
      .setIssuer('https://appleid.apple.com').setAudience('our.bundle').setIssuedAt().setJti('event-id');
    if (!events) jwt.setSubject(subject).setExpirationTime('2m');
    return jwt.sign(apple.privateKey);
  };
  let token = await signed();
  let response = { id_token: token, refresh_token: 'private-refresh' }, code = 200;
  const lifecycle = new AppleAccount({ APPLE_SIGN_IN_BUNDLE_ID: 'our.bundle', APPLE_SIGN_IN_TEAM_ID: 'TEAM', APPLE_SIGN_IN_KEY_ID: 'CLIENT_KEY' }, identity, vault, {
    signingKey: client.privateKey,
    fetcher: async (url, request) => {
      requests.push({ url, request });
      const { payload, protectedHeader } = await jwtVerify(request.body.get('client_secret'), client.publicKey, {
        audience: 'https://appleid.apple.com', issuer: 'TEAM', subject: 'our.bundle', algorithms: ['ES256'],
      });
      assert.equal(protectedHeader.kid, 'CLIENT_KEY'); assert.ok(payload.exp - payload.iat <= 300);
      return new Response(url.endsWith('/revoke') && code === 200 ? null : JSON.stringify(response), { status: code });
    },
  });
  return { lifecycle, identity, vault, requests, signed,
    respond: (next, status = 200) => { response = next; code = status; } };
}

test('Apple: code exchange verifies signed identity and stores only encrypted refresh evidence', async () => {
  const { lifecycle, vault, requests } = await fixture();
  const authorization = await lifecycle.exchange('private-code', 'player', 'server-nonce');
  assert.ok(!JSON.stringify(authorization).includes('private-refresh'));
  assert.equal(vault.open(authorization.secret).refreshToken, 'private-refresh');
  assert.equal(requests[0].request.body.get('grant_type'), 'authorization_code');
  assert.equal(requests[0].request.body.get('code'), 'private-code');
  await assert.rejects(lifecycle.exchange('code', 'attacker', 'server-nonce'), /invalid_identity/);
  await assert.rejects(lifecycle.exchange('code', 'player', 'wrong-nonce'), /invalid_identity/);
  await assert.rejects(lifecycle.exchange('', 'player', 'server-nonce'), /apple_authorization_code_required/);
});

test('Apple: daily refresh checks verify subject without demanding the initial nonce', async () => {
  const { lifecycle, vault, signed, respond } = await fixture();
  const row = { subject: 'player', authorization: { secret: vault.seal({ refreshToken: 'refresh' }) } };
  respond({ id_token: await signed('player', null) }); await lifecycle.validate(row);
  respond({ id_token: await signed('other', null) }); await assert.rejects(lifecycle.validate(row), /invalid_identity/);
  respond({ error: 'invalid_grant' }, 400); await assert.rejects(lifecycle.validate(row), /apple_authorization_revoked/);
  respond({ error: 'invalid_client' }, 400); await assert.rejects(lifecycle.validate(row), /apple_service_unavailable/);
});

test('Apple: revocation uses encrypted refresh token, exact endpoint, and accepts empty success bodies', async () => {
  const { lifecycle, vault, requests } = await fixture();
  await lifecycle.revoke(vault.seal({ refreshToken: 'refresh' }));
  assert.equal(requests[0].url, 'https://appleid.apple.com/auth/revoke');
  assert.equal(requests[0].request.body.get('token'), 'refresh');
  assert.equal(requests[0].request.body.get('token_type_hint'), 'refresh_token');
  assert.equal(requests[0].request.redirect, 'error');
});

test('Apple: notifications verify real signatures/issuer/audience, accept Apple no-exp format and reject tampering', async () => {
  const { lifecycle, signed } = await fixture();
  const token = await signed(null, null, { type: 'account-deleted', sub: 'player', event_time: Math.floor(Date.now() / 1000) });
  assert.equal((await lifecycle.notification(token)).type, 'account-deleted');
  await assert.rejects(lifecycle.notification(token + 'x'), /invalid_notification/);
  await assert.rejects(lifecycle.notification(await signed(null, null, { type: 'account-deleted' })), /invalid_notification/);
});

test('Google: public deletion tokens must carry the exact server nonce, not just a valid audience', async () => {
  const payload = { iss: 'accounts.google.com', sub: 'player', exp: Math.floor(Date.now() / 1000) + 120, nonce: 'server-nonce' };
  const verifier = new IdentityVerifier({ GOOGLE_SIGN_IN_CLIENT_ID: 'web-client' }, { google: { async verifyIdToken() { return { getPayload: () => payload }; } } });
  assert.equal((await verifier.verify('google', 'token', 'server-nonce', { requireNonce: true })).subject, 'player');
  await assert.rejects(verifier.verify('google', 'token', 'wrong', { requireNonce: true }), /invalid_identity/);
});
