# ARROW: THE LAST LANTERN — purchase backend

This directory is a standalone Node.js service, not part of the Flutter build. It verifies Apple/Google purchases, stores **purchased** coin balances and linked cloud saves in MongoDB, and supports Google/Apple account linking, recovery and deletion. Render runs the server; MongoDB holds persistent data independently. It has not been deployed, and checkout is OFF by default. No paid service/account was created.

Start with [SETUP.md](SETUP.md) for the owner checklist. The Flutter client is in `C:\CODE\Arrow`.

## Local checks

Requires Node 24.15+ (24.x). From this directory:

```powershell
npm ci --ignore-scripts
npm test
npm start
```

The default binds only `127.0.0.1:8080`; `/health` returns `{"status":"ok"}`. `/ready` checks the database. Without a MongoDB URI, SQLite is available for local sandbox development only; Render and production refuse that fallback. Tests launch an isolated local MongoDB replica set (first run downloads MongoDB) and never read `.env` or your existing database. There is deliberately **no fake-credit HTTP endpoint**. Test doubles and MongoDB test binaries are excluded from the Docker image.

Create `.env` from `.env.example` locally when configuring stores. Never commit `.env`, database files, private keys or Google credentials. The supplied ignore rules exclude them. Keep the receipt encryption key backed up in a secret manager; changing/losing it makes historical receipt rechecks unreadable.

## Design

- Native MongoDB driver, snapshot transactions and majority writes. Replica set/sharded MongoDB is mandatory; startup checks and commits a probe transaction before accepting requests. Unique indexes protect receipts, spends and identities. TTL indexes clean challenges/sessions, with explicit expiry checks before TTL cleanup. A dedicated database is required. Remote connections use validated TLS. All wallet/progress state lives outside Render's ephemeral disk. In-memory rate limiting assumes one web instance; add shared limits before scaling.
- Random wallet UUID plus 256-bit bearer recovery key. Only its SHA-256 hash is stored in the database. The app stores the key in platform secure storage. The UUID is bound to the Apple appAccountToken / Google obfuscated account ID at checkout.
- Exact product allowlist: `coins_1500` → 1500, `coins_4000` → 4000. Prices come from the store; the client cannot choose the credited amount.
- Apple: official App Store Server API + signed-response verification against configured Apple roots, exact bundle/environment, product, quantity, account token, transaction ID and revocation state. No decoded-but-unverified JWS grants.
- Google: authenticated Android Publisher API lookup under the configured package; validates purchased state, account, quantity and license-test/production environment. No credit for pending or cancelled payments.
- Ledger receipt keys are unique across accounts. Retries return the existing balance. Unknown already-consumed Android receipts cannot mint coins; a previously recorded purchase can be retried after consumption.
- Google consumption / Apple transaction finishing occurs in Flutter **after the backend durably commits the coins**. If either response is lost, the client retries. Pending purchases are checked at startup and on Retry / sync.
- Sandbox and production use separate deployments/databases. A database records its environment and refuses a different one. Production requires HTTPS behind a configured reverse proxy. There is no fallback from failed production validation to sandbox.
- Spending is an atomic debit with a UUID idempotency key. Permanent cosmetics/companions are recorded centrally. Consumable hint/revive deliveries remain queued until the phone saves the benefit and delivery ID together, then acknowledges. A revive recovered after the player restarts is a saved revive credit, not a revival of the wrong attempt.
- Monotonic wallet revisions keep older network responses from replacing newer balances.
- Encrypted receipt evidence supports `npm run reconcile`. Confirmed refunds reverse the grant once; if spent, the remainder is debt deducted from future purchased packs. Transient provider errors are deferred, never treated as refunds. Already-delivered items are not forcibly removed.
- No raw receipt, secret, credential or request-body logging. TLS, authentication, body limits, rate limiting and no-store headers are configured. Restrict reverse-proxy trust to your actual hosting topology.

## Important boundaries

**Cloud backup is not anti-cheat.** Guest earned/ad coins and progress remain local. Linked profiles upload game-progress snapshots, including earned/ad coins, stages, times, hints, story state, unlocks and delivery IDs. These snapshots are not trusted as purchased credit. A modified client could forge offline earnings/inventory, but cannot create server-backed purchased coins. The app spends earned coins first, requesting only the missing amount from the purchased wallet.

Linked profiles restore both earned-item unlocks in the game save and server-owned paid permanent items. Chapter progression is still enforced by the game, not simulated by this backend.

Google/Apple sign-in is the recommended recovery method. First linking preserves the current guest wallet; reinstalling with the same verified provider subject returns that wallet and its cloud progress. Different subjects cannot access each other's saves. Linking a paid guest wallet to a provider already associated with another wallet is refused, rather than abandoning/merging paid funds. Sessions are random hashed bearer credentials valid for 30 days; an expired session can reauthenticate. Original guest recovery keys remain bearer secrets. Linked session keys are not permanent recovery keys. The native platform-specific flow does not automatically join Google and Apple identities for cross-platform transfers.

Progress writes use a compare-and-swap revision. The client reconciles offline edits and requires a player choice if both devices changed. No automatic merging or summing coin balances. Consumable delivery state must be backed up before acknowledging a server delivery for linked players. Only successfully uploaded saves survive a reinstall. Use one active gameplay device at a time; this is not a real-time multiplayer inventory system.

**Account lifecycle is implemented but not live-tested with owner credentials.** Apple sign-in verifies the signed ID token and exchanges the authorization code; refresh tokens are encrypted server-side. Active Apple sessions are checked up to once daily, on access and through maintenance. Revoked grants invalidate sessions; transient failures never delete data. Verified Apple consent/account-deletion notifications initiate cleanup. Configure the Apple server notification URL before launch.

In-app deletion requires confirmation and a recent provider sign-in for linked accounts. Guest wallets can be deleted without creating a login. Deletion immediately blocks access and removes the cloud snapshot. Apple revocation cleanup is durably queued and retries after restarts; only after it completes are identities, sessions, purchases, spends and the wallet removed. Only irreversible receipt/event fingerprints and temporary credential hashes (30 days, to tell returning phones to clear deleted data) remain. No provider identity or receipt evidence remains in those markers. The public `/delete-account` page lets Android users verify Google ownership and delete without reinstalling; it requires the Render origin authorized in the Web OAuth client. Backups and retention disclosures still need owner configuration. Do not call the game publicly launch-ready until native/device, hosted and store checks pass.

Refund checking is a polling job, not real-time store notification handling. It must be scheduled and monitored when hosted. Offline rewards/ad callbacks are not server-verified. Add store notifications, device attestation and signed gameplay rewards before expanding those guarantees.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no secrets |
| GET | `/ready` | MongoDB readiness |
| GET | `/delete-account` | Browser Google account-deletion page |
| POST | `/v1/public-deletion/challenge` | Expiring browser Google nonce; no wallet created |
| POST | `/v1/public-deletion/confirm` | Nonce-verified Google deletion; does not reveal whether a profile exists |
| POST | `/v1/apple/notifications` | Cryptographically verified Apple account-change notification |
| GET | `/v1/config` | Checkout readiness and store environment |
| POST | `/v1/accounts` | New anonymous wallet; returns recovery key once |
| GET | `/v1/wallet` | Authenticated balance, debt, revision, entitlements and outstanding deliveries |
| POST | `/v1/auth/challenge` | Short-lived, account-bound provider challenge |
| POST | `/v1/auth/link` | Verify a provider ID token; link or restore the wallet and issue a session |
| GET | `/v1/progress` | Read linked game-save snapshot and revision |
| PUT | `/v1/progress` | Save linked snapshot only if its expected revision is current |
| DELETE | `/v1/account` | Confirmed account/progress deletion with linked-owner reauthentication |
| POST | `/v1/purchases/verify` | Validate store evidence and credit once |
| POST | `/v1/spends` | Debit an allowlisted item once (`id`, `sku`, `amount`) |
| POST | `/v1/spends/:id/ack` | Acknowledge a durably saved local delivery |

Wallet, native linking, progress, purchase, spend and in-app deletion routes require `Authorization: Bearer <wallet-key>`. Public deletion uses Google's signed identity plus an expiring one-use nonce; Apple notifications require Apple's signed payload. The HTTP API has no administrative credit, bank, card or payment-processing endpoint. Apple and Google handle money.

## Operations

The supplied `render.yaml` explicitly selects a **free sandbox Docker web service**, HTTPS, readiness checks and MongoDB secrets. No paid disk/database or deployment is created by this file. Use `MONGODB_URI` and `MONGODB_DATABASE` in Render's server environment, never Flutter. Give the database user read/write permissions only on its dedicated Arrow database; allow Render's outbound IP ranges, not unrestricted internet access. Existing SQLite files are preserved but are **not automatically imported**. Do not point an existing paid deployment at a blank MongoDB ledger: arrange a verified migration/backup first.

The owner's initial hosting plan is one free Render web service in a dedicated workspace, MongoDB Atlas, and external UptimeRobot checks every five minutes. Monitor `https://YOUR-SERVICE.onrender.com/ready` using HTTP(S) with downtime and recovery email alerts. GET and HEAD return 200 only after a successful database check; a database outage returns 503 with `{"status":"not_ready"}` and never exposes credentials. Checks require no wallet token and never create accounts, credit/spend coins or change saves. Use a keyword monitor requiring the exact text `"status":"ready"` if you also want to reject an intermediary loading page. `/health` only confirms the process is alive, not database connectivity.

External checks can normally prevent idle sleep, but do not guarantee uptime, fix outages, run receipt reconciliation or create backups. The app retains cold-start handling. No monitor, external ping loop, paid cron or service account has been created automatically; the owner must configure monitoring and alerts. Render's free-hours allowance is shared per workspace, so keep unrelated services outside this workspace and review actual usage.

Run `npm run reconcile` daily and `npm run maintenance` on a scheduled, monitored runner with the same MongoDB/secrets. Maintenance also runs while the server is awake, but free Render can still restart, sleep or be unavailable, so its timer alone is not a reliable schedule. Commands report counts, never tokens. Monitoring does not replace this scheduling decision.

Atlas Free has no managed backups. Set up encrypted exports (for a consistent manual dump, stop API writes and scheduled workers first), keep the receipt encryption key separately, and test restoration in an isolated database. Production data and sandbox data must be separate. Free hosting has capacity/cold-start limits and no production availability guarantee. Configure backup expiry/deletion policies and monitoring before public purchases. The Dockerfile packages the service only; provider key files belong in Render Secret Files, not the image.

## References

- [Flutter in-app purchase lifecycle](https://pub.dev/packages/in_app_purchase)
- [Apple's official server library](https://github.com/apple/app-store-server-library-node)
- [Google purchase verification](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products)
- [Google billing security](https://developer.android.com/google/play/billing/security)
