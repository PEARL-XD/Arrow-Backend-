import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { requireValue } from './errors.js';
import { deletionPage } from './deletion_page.js';

export function createApp({ database, verifier, identity, lifecycle, vault, requireHttps = false, proxyHops = 0 }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', proxyHops);
  app.use(helmet());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (requireHttps && !req.secure && !['/health', '/ready'].includes(req.path)) return res.status(400).json({ error: 'https_required' });
    next();
  });
  app.use(express.json({ limit: '80kb', strict: true }));
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.get('/health', (_, res) => res.json({ status: 'ok' }));
  // Public, read-only monitor endpoint. Never report ready without a database
  // check, or expose connection details when that check fails.
  app.get('/ready', async (_, res) => {
    try {
      await database.ping();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });
  app.get('/delete-account', (req, res) => {
    res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.type('html').send(deletionPage());
  });
  app.get('/delete-account.js', (_, res) => res.type('application/javascript').send(deletionPage.script));
  const publicAuthLimit = rateLimit({ windowMs: 60000, limit: 10 });
  app.post('/v1/public-deletion/challenge', publicAuthLimit, async (_, res) => {
    requireValue(identity?.ready('google') && database.webDeletionChallenge, 503, 'sign_in_not_configured');
    res.json({ ...await database.webDeletionChallenge(), clientId: identity.googleAudience });
  });
  app.post('/v1/public-deletion/confirm', publicAuthLimit, async (req, res) => {
    requireValue(req.body?.confirm === true && lifecycle && database.requestWebDeletion, 400, 'deletion_confirmation_required');
    const challenge = await database.challengeFor('web_deletion', 'google', req.body.challengeId);
    const verified = await identity.verify('google', req.body.idToken, challenge.nonce, { requireNonce: true });
    const account = await database.requestWebDeletion(verified, challenge.id);
    const deleted = !account || await lifecycle.finishDeletion(account);
    res.status(deleted ? 200 : 202).json({ status: deleted ? 'deleted' : 'deletion_pending' });
  });
  app.post('/v1/apple/notifications', async (req, res) => {
    requireValue(lifecycle?.apple?.ready && database.appleNotification, 503, 'apple_account_not_configured');
    const event = await lifecycle.apple.notification(req.body?.payload);
    const account = await database.appleNotification(event);
    if (account) await lifecycle.finishDeletion(account);
    res.json({ ok: true });
  });
  app.get('/v1/config', (_, res) => res.json({ environment: verifier.environment, ios: verifier.ready('ios'), android: verifier.ready('android'),
    signIn: { google: identity?.ready('google') === true, apple: identity?.ready('apple') === true && lifecycle?.ready('apple') === true },
    accountDeletion: Boolean(database.requestDeletion && lifecycle) }));
  app.post('/v1/accounts', rateLimit({ windowMs: 3600000, limit: 10 }), async (_, res) => res.status(201).json(await database.createAccount()));
  app.use('/v1', async (req, _, next) => {
    req.account = await database.authenticate(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!((req.method === 'DELETE' && req.path === '/account') || ['/auth/challenge', '/auth/link'].includes(req.path))) await lifecycle?.authorize(req.account);
    next();
  });
  app.get('/v1/wallet', async (req, res) => res.json(await database.wallet(req.account)));
  app.post('/v1/auth/challenge', rateLimit({ windowMs: 60000, limit: 10 }), async (req, res) => {
    requireValue(identity?.ready(req.body?.provider) && (req.body.provider !== 'apple' || lifecycle?.ready('apple')), 503, 'sign_in_not_configured');
    res.json(await database.challenge(req.account, req.body.provider));
  });
  app.post('/v1/auth/link', rateLimit({ windowMs: 60000, limit: 10 }), async (req, res) => {
    requireValue(identity?.ready(req.body?.provider), 503, 'sign_in_not_configured');
    const challenge = await database.challengeFor(req.account, req.body.provider, req.body.challengeId);
    const verified = await identity.verify(req.body.provider, req.body.idToken, challenge.nonce);
    if (verified.provider === 'apple') {
      requireValue(lifecycle?.ready('apple'), 503, 'apple_account_not_configured');
      verified.authorization = await lifecycle.apple.exchange(req.body.authorizationCode, verified.subject, challenge.nonce);
    }
    res.json(await database.linkIdentity(req.account, verified, challenge.id));
  });
  app.delete('/v1/account', rateLimit({ windowMs: 60000, limit: 5 }), async (req, res) => {
    requireValue(req.body?.confirm === true && database.requestDeletion && lifecycle, 400, 'deletion_confirmation_required');
    const providers = await database.providers(req.account);
    let verified;
    if (providers.length && !await database.deletionJob(req.account)) {
      const challenge = await database.challengeFor(req.account, req.body.provider, req.body.challengeId);
      verified = await identity.verify(req.body.provider, req.body.idToken, challenge.nonce);
      requireValue(Number.isSafeInteger(verified.issuedAt) && verified.issuedAt >= Date.now() / 1000 - 300 && verified.issuedAt <= Date.now() / 1000 + 60,
        401, 'recent_sign_in_required');
    }
    await database.requestDeletion(req.account, verified, req.body.challengeId);
    const deleted = await lifecycle.finishDeletion(req.account);
    res.status(deleted ? 200 : 202).json({ status: deleted ? 'deleted' : 'deletion_pending' });
  });
  app.get('/v1/progress', async (req, res) => res.json(await database.progress(req.account)));
  app.put('/v1/progress', async (req, res) => res.json(await database.saveProgress(req.account, req.body)));
  app.post('/v1/purchases/verify', rateLimit({ windowMs: 60000, limit: 15 }), async (req, res) => {
    requireValue(req.body && typeof req.body === 'object', 400, 'invalid_body');
    const verified = await verifier.verify(req.account, req.body);
    if (vault) verified.proof = vault.seal({ platform: req.body.platform, productId: req.body.productId, transactionId: req.body.transactionId, token: req.body.token });
    res.json(await database.credit(req.account, verified));
  });
  app.post('/v1/spends', async (req, res) => res.json(await database.spend(req.account, req.body ?? {})));
  app.post('/v1/spends/:id/ack', async (req, res) => { await database.acknowledge(req.account, req.params.id); res.json({ ok: true }); });
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 503;
    // Do not log tokens, receipts, account credentials, request bodies or upstream errors.
    res.status(status).json({ error: err.code && err.status ? err.code : 'service_unavailable' });
  });
  return app;
}
