# Set up real coin purchases

The code is implemented locally. **Do not publish a payment-enabled build until the sandbox end-to-end checks below pass.** Apple/Google accounts, products, keys, HTTPS hosting and backups are still required. AdMob settings do not configure purchases.

## 1. Create the coin packs in both stores

| Product ID (exact spelling) | Coins | Intended India price |
| --- | ---: | ---: |
| `coins_1500` | 1,500 | ₹49 |
| `coins_4000` | 4,000 | ₹99 |

Use **Consumable** products in Apple; **one-time products consumed after purchase** in Google Play. Select the corresponding available India price points in each console. Configure other storefront prices there; the game displays the store's localized price, not a hardcoded rupee label. Do not enable multi-quantity purchases for these packs.

### Apple / TestFlight

1. In App Store Connect, select ARROW: THE LAST LANTERN. The checked-in iOS bundle ID is currently `com.cleanchops.arrowthelastlantern`; confirm it matches your existing listing and signing profile. Do not create a different ID for the same app.
2. Complete the Paid Apps Agreement, tax and banking setup under Business.
3. Under the app's monetization/In-App Purchases area, create both consumables. Add their names, descriptions, pricing, availability and review screenshots.
4. Create an **In-App Purchase key** in App Store Connect (Users and Access / Integrations / In-App Purchase). Keep its `.p8` private; record its key ID and issuer ID. This is for server purchase verification, not the AdMob IDs or a public Flutter key.
5. Record the numeric Apple app ID from App Information. Obtain Apple's root certificates from [Apple PKI](https://www.apple.com/certificateauthority/), not from a client-supplied certificate or an arbitrary website.
6. Enable In-App Purchase capability for the app as needed in your Apple configuration. The project now includes the Keychain entitlement used for the wallet recovery key; keep automatic signing in Codemagic. iOS purchase support in this integration requires StoreKit 2 (iOS 15+).
7. Create sandbox testers as needed and use TestFlight to test. First in-app products must be submitted with the app version for review when you launch; adding their IDs in code does not approve them.

### Google Play / Android

1. Both platforms now use `com.cleanchops.arrowthelastlantern`, matching the existing iPhone identifier. Use this exact package for Play products, OAuth and backend verification. The Android upload signing key still needs configuration; the old development app's local save does not migrate to this different package automatically.
2. Configure the Play payments profile. Create/activate the two one-time products and their purchase options.
3. Enable the Google Play Android Developer API in a Google Cloud project. Create a dedicated service account and grant the minimum Play Console app permissions needed to view/verify purchases. Store its JSON credential only on the backend.
4. Build a signed AAB for the internal testing track, using the same package as the products. Add your test Google account to **License testing**, as well as the internal-test list.
5. Install through the testing opt-in link with the licensed account. The native payment screen must offer a test payment method. **An internal test build alone does not prevent real charges.** Our sandbox flag controls receipt acceptance, not Google's payment method.

## 2. Configure and host the sandbox backend

Deploy this directory as a Render **Docker Web Service**, selecting **Free**, using the supplied Dockerfile or sandbox `render.yaml`. This backend folder needs its own repository (not uploaded by this change). Create a MongoDB Atlas replica-set database separately; do not reuse another project's database or user permissions. No local SQLite volume is used on Render.

In Atlas create a dedicated user with read/write access only to `arrow_lantern_sandbox`. In Render → Connect → Outbound, copy all service IP ranges into Atlas Network Access. Store the Atlas driver URI as Render `MONGODB_URI` and set `MONGODB_DATABASE=arrow_lantern_sandbox`. Never put the URI in Flutter/Codemagic or paste its password in chat. Keep TLS validation enabled. This service refuses standalone MongoDB without transaction support.

Create an environment configuration from `.env.example`. Required for enabled checkout:

- `STORE_ENVIRONMENT=sandbox`
- `PURCHASES_ENABLED=true`
- `MONGODB_URI` and `MONGODB_DATABASE` pointing to the dedicated hosted database
- `RECEIPT_ENCRYPTION_KEY`: a cryptographically random 32-byte secret encoded as 64 hexadecimal characters, saved only in the hosting secret manager
- `REQUIRE_HTTPS=true` and the correct `TRUST_PROXY_HOPS` for your host
- Apple: `APPLE_BUNDLE_ID`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY_PATH`, `APPLE_ROOT_CERT_PATHS`; include `APPLE_APP_ID` too, mandatory in production
- Android: `ANDROID_PACKAGE_NAME` and `GOOGLE_APPLICATION_CREDENTIALS` (path to the mounted service-account JSON)

You can enable one platform first. Do not paste private `.p8` contents, service-account JSON, wallet recovery keys or encryption keys into chat, GitHub, Flutter source or Codemagic build arguments. These provider secrets belong on the server only.

Start with `npm ci --ignore-scripts`, `npm test`, then `npm start`, or use the supplied Dockerfile. Confirm `/health`, `/ready` and `/v1/config` at your HTTPS URL. Set `HOST=0.0.0.0`, `REQUIRE_HTTPS=true` and `TRUST_PROXY_HOPS=1` for this Render deployment. Upload private provider files through Render Secret Files; paths are `/etc/secrets/FILENAME`. Configure scheduled reconciliation (`npm run reconcile`), account maintenance (`npm run maintenance`), backups and failure alerts. Free Render sleeps when idle; its local filesystem/timers are not reliable persistent storage or scheduling. Atlas Free has no managed backups, so encrypted export/restore checks are required. No paid resource is enabled automatically.

### Free-service monitoring

For the owner's initial plan, keep just this web service in its dedicated Render workspace. After deploying, add an UptimeRobot HTTP(S) monitor for `https://YOUR-SERVICE.onrender.com/ready`, choose five-minute checks, and enable both downtime and recovery email alerts. No authentication header, URI, encryption key or other secret belongs in the monitor. Optionally use a keyword monitor requiring `"status":"ready"` to reject a hosting loading page. The endpoint checks MongoDB and returns 503 on failure; it does not change any player data. Do not monitor `/robots.txt` or rely solely on `/health`.

No Flutter change is needed for the monitoring interval. Keep existing reconnect/cold-start handling: checks cannot guarantee availability or replace database backups, receipt reconciliation or account-maintenance scheduling. No external monitor or paid resource is created by the code.

## 3. Connect the Flutter / Codemagic testing build

### Account protection testing

1. Use your existing Google Cloud account but create app-specific OAuth clients in a suitable project. Configure Google Auth Platform branding/audience and add your test Google accounts while in testing mode. Create Android clients for `com.cleanchops.arrowthelastlantern` and each applicable signing SHA-1 (debug, upload, Play App Signing). Also create a Web client for the server audience.
2. Set that public Web client ID as backend `GOOGLE_SIGN_IN_CLIENT_ID` and Flutter `--dart-define=ARROW_GOOGLE_WEB_CLIENT_ID=YOUR_WEB_CLIENT_ID`. The client secret is not needed by this token-verification implementation. Do not confuse these credentials with the Google Play purchase service-account file.
3. In Apple Developer, open the existing `com.cleanchops.arrowthelastlantern` App ID, enable Sign in with Apple, then regenerate/refresh provisioning profiles used by Codemagic. Keep the existing App Store Connect app and bundle ID. Create a Sign in with Apple-enabled developer key, record its Key ID and your Team ID, and upload its `.p8` only as a backend Secret File. Set `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_PRIVATE_KEY_PATH`, `APPLE_SIGN_IN_BUNDLE_ID`, and a backed-up `RECEIPT_ENCRYPTION_KEY`. This is separate from the App Store purchase key/issuer ID. Configure your primary App ID's server notification URL to `https://YOUR-HOST/v1/apple/notifications`. No browser/Android Apple Service ID flow is implemented.
4. Host on HTTPS with MongoDB and the correct sandbox/production environment. Confirm `/v1/config` reports each configured sign-in provider. Linking preserves the guest wallet rather than minting a new paid balance. For Google's external deletion page, add your backend HTTPS origin to the Web OAuth client's Authorized JavaScript origins. Put `https://YOUR-HOST/delete-account` in Play Console's account-deletion URL field. Do not reset or replace an existing paid ledger with an empty database.
5. Test first linking and actual reinstall recovery with the same provider. Verify earned/ad coins, hints, stage/story progress, unlocks and paid wallet separately. Test cancellation, offline changes, simultaneous-device conflicts and session expiry before enabling real payments.

Account deletion, Apple code exchange, encrypted refresh-token storage, daily validation, revocation cleanup and signed notifications are coded. Test them using your own native sign-in and store accounts before public release; Google/Apple identities are not automatically the same profile across operating systems. Publish the privacy policy, support contact and deletion/backup-retention disclosures yourself. An account deletion erases its paid balance, does not issue a refund, and retains only irreversible transaction fingerprints plus temporary credential hashes for cleanup. Verify both in-app deletion and the browser Google deletion page, including outages/retries, recreated accounts and revoked Apple consent.

Keep Release mode for TestFlight, your existing signing setup, Flutter 3.44.4-compatible tooling and a fresh build number. Add these build arguments, substituting your actual HTTPS sandbox URL:

```text
--build-name=1.0.0 --build-number=NEXT_UNUSED_NUMBER --dart-define=ARROW_TEST_ADS=true --dart-define=ARROW_PURCHASES_ENABLED=true --dart-define=ARROW_STORE_ENVIRONMENT=sandbox --dart-define=ARROW_BACKEND_URL=https://YOUR-SANDBOX-HOST
```

Do not paste the placeholders literally. These settings are separate from AdMob test mode. Plain environment variables are not a substitute for Dart defines. Default builds leave purchases disabled if you omit the enable flag or URL. Admin-testing builds deliberately keep their simulated packs; use non-admin TestFlight or `--dart-define=PATH_OUT_ADMIN=false` on Android to exercise actual store purchases.

## 4. Required device tests before launch

- Shop shows the two real store prices. Missing products stay disabled, not replaced by a fake price.
- Save the Wallet recovery key privately. Buy each pack with a store test account. The purchased balance increases by exactly 1,500 / 4,000.
- Cancel payment; decline a test payment; test a pending purchase. None should grant coins before verification.
- Retry after a network interruption and reopen after killing the app during purchase. A successful transaction must credit once, never twice. Use Retry / sync for unfinished purchases, not a second purchase.
- Spend purchased coins on hints, revives, a skin, a board and an eligible companion chapter. Earned coins should be used first.
- Disconnect during spending; reconnect and sync. No double debit or duplicate hint. If you already restarted a lost level, a paid revive is saved for the next loss.
- As a guest, the saved wallet key restores unused purchased coins and paid permanent items, not guest level progress. As a linked player, sign in with the same provider on a clean installation and verify earned coins, stages, hints, story state, unlocks and purchased wallet return from the latest successful backup. Test cancelling sign-in, expired sessions, offline changes and conflicting saves.
- Refund a sandbox purchase and run reconciliation. Unspent coins are removed once; already-spent coin debt is visible and settled by future paid packs.
- Verify both platforms separately. Automated tests and an Android compilation do not establish that your signing, store accounts, keys or product setup work.

## 5. Production is a separate deployment

Only after testing: provision a fresh production database and separate secret configuration with `STORE_ENVIRONMENT=production`, confirm Apple numeric app ID and production credentials, use HTTPS, and build against its URL with `ARROW_STORE_ENVIRONMENT=production`. Keep the sandbox deployment for TestFlight testers. The backend rejects test receipts in production and real receipts in sandbox; never reuse a sandbox database.

Update privacy disclosures for the wallet service and purchases, publish a support contact and privacy policy, and verify store review requirements. Keep AdMob test ads on until its separate live-ad readiness checklist is complete. No code change has published the game or activated billing in a store.

### Official setup references

- [Apple purchase setup and agreements](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases/)
- [Apple sandbox testing](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox)
- [Google Play billing tests](https://developer.android.com/google/play/billing/test)
- [Play internal testing and license testers](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)
