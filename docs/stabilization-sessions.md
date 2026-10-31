# Session and authentication limits — 2026-10-31

Backend only. Flutter has deliberately not been changed. The earlier clinical
access containment remains in force.

## Contract

Successful patient registration and login retain `result`, `message`, `token`
and `user`. They add `tokenType: "Bearer"`, `expiresIn` (seconds), `refreshToken`
and `refreshExpiresAt` (UTC ISO timestamp). Treat both credentials as secrets;
store the new response atomically in secure storage when the app is adapted.
Auth responses have Cache-Control: no-store and Pragma: no-cache.

Access tokens have `sub`, `sid`, `tokenUse: "access"`, `iat` and `exp`. Default
lifetime is 900 seconds. Each request checks that the session exists, belongs to
that subject, is not revoked or expired, and the current account is active.
The existing role guard continues to use the database role, not a token claim.

POST `/auth/refresh` accepts JSON `{ "refreshToken": "<opaque credential>" }`.
It does not require an access JWT. Success returns the same token/user contract
as login, rotating the refresh credential. It does not extend the session's
absolute deadline (default 30 days from login). Refresh credentials are random
256-bit values; only SHA-256 hashes are stored, never the plaintext credential.

A used refresh credential is invalid. Replaying one revokes its entire session,
including an access JWT returned by an earlier successful refresh. Refresh and
logout are serialized with PostgreSQL transaction locks, including across
processes. Clients must single-flight renewal and atomically replace both
credentials. Retrying an uncertain renewal with the old credential can trigger
replay protection; require login again rather than loop or discard local data.

POST `/auth/logout` takes the same JSON body and revokes that session immediately.
It returns 200 / result OK even for an unknown or already revoked credential.
Other sessions of that account are unaffected. No clinical data is deleted.
An invalid refresh yields 401 / INVALID_REFRESH_TOKEN; malformed bodies yield
400 / INVALID_PARAMETERS. Missing/revoked/expired access sessions yield 401.
Inactive accounts remain denied. A refresh credential cannot serve as an access JWT.

## Existing Flutter versions and legacy JWTs

Current Flutter ignores the added fields and does not call refresh or logout.
It will need login again after a new access token expires. Backend changes do not
erase local Hive records or pending synchronization operations. Automatic renewal
and coordinated UI handling remain a separate, unimplemented Flutter change.

Previously issued JWTs without sid/tokenUse are accepted only up to seven days
from their original signed iat, subject to existing JWT expiry and account status.
Missing or implausibly future iat is rejected. Service restart cannot reset that
window. Older tokens can therefore require login immediately after this update.
Legacy JWTs cannot be exchanged for refresh tokens: login is required to create
a new session. They are not covered by session-specific logout; the transition
is bounded by issue time. Set AUTH_LEGACY_MAX_AGE_SECONDS=0 when legacy support
can be removed. No new legacy tokens are issued by the auth routes.

## Configuration and attempt limits

| Setting | Default | Valid range |
|---|---|---|
| AUTH_ACCESS_TTL_SECONDS | 900 | 60–3600 |
| AUTH_SESSION_TTL_SECONDS | 2592000 | 3600–7776000 |
| AUTH_LEGACY_MAX_AGE_SECONDS | 604800 | 0–604800 |

Existing environment values and signing secret are preserved. Secret-strength
enforcement/rotation remains a coordinated follow-up; this does not claim that
JWT expiry compensates for a weak signing secret.

Limits count all attempts, including successes and malformed requests:

- Login: 20 per socket IP / 15 minutes; 10 per normalized username / 15 minutes.
- Registration (including disabled doctor registration): 10 per IP / hour.
- Refresh and logout: separate 60 per IP / minute limits.

429 / AUTH_RATE_LIMIT includes Retry-After in seconds. Username keys are hashed.
Storage is bounded to 10,000 live keys and expired keys are pruned; filling it
does not evict a blocked account to allow bypass. The server does not trust
arbitrary X-Forwarded-For. Limits are in memory per process and reset on restart;
use shared storage and reviewed proxy trust settings before scaling or placing
many users behind a proxy. Account-level limits also provide a denial-of-service
tradeoff: a targeted account may have to wait for the window to expire.

## Persistence and activation

Migration `20261031000000_auth_sessions` adds AuthSession and AuthRefreshToken,
indexes and foreign keys. No existing clinical table is rewritten or deleted.
The Prisma client must be regenerated. Apply migrations and update the generated
client before the running source starts using the new models; build dist too.
Take a restricted backup before migration. Do not run seed or reset commands.

Expired/revoked sessions and used hashes are retained for replay checks. An
operational cleanup policy can remove sessions only after their absolute expiry,
cascading their hashes; no cleanup task is installed in this increment.

## Validation

Typecheck and build passed. A disposable PostgreSQL 16 container with tmpfs,
loopback-only networking, synthetic credentials and no Kuvi volumes ran:

- npm test with database-health check: 53 passed.
- npm run test:sessions: 13 passed.
- npm run test:medications: 11 passed.
- npm run test:physicians including appointment regressions: 30 passed.

Total 107, zero failures. The container was removed. The suites cover persistence,
exact access expiry, token hashes, rotation across app instances, absolute expiry,
replay-family revocation, concurrent refresh/logout, device-session isolation,
inactive users, bounded legacy tokens and rate-limit recovery/capacity/header
spoofing. Existing medication, appointment and directory checks also pass.

No live user credentials or patient records are needed to validate this contract.

The final transactional migration was also tested as an upgrade from the previous
10-migration schema: a synthetic pre-existing user survived unchanged, the new
session tables were empty, and all 13 session checks passed again.
