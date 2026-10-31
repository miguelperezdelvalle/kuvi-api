# Access stabilization, 2026-10-31

This increment contains the unrestricted clinical access identified in the
2026-10-30 review. No database migration or patient-data change is required.

## Behavior changes

- `POST /auth/register-doctor` returns 403 / `DOCTOR_REGISTRATION_DISABLED`
  without looking up or creating an account. Public registration must not grant
  a clinical role. A reviewed onboarding workflow is still required.
- `GET /doctor/patients` and `GET /doctor/patients/:id/summary` require an active
  doctor and then return 403 / `PATIENT_ACCESS_NOT_CONFIGURED` without loading
  patient collections, questionnaire answers, notes or summaries. Existing
  SharedAccess records do not identify a recipient, so they cannot authorize a
  particular doctor. These general routes remain disabled until explicit
  patient authorization is implemented and tested. No appointment is treated
  as implicit consent to read an entire medical history.
- Existing appointment-scoped routes retain their doctorId authorization.
- The shared authentication guard rejects all non-active accounts with
  403 / `INACTIVE_USER`, including accounts whose token was issued before
  deactivation. Auth and patient profile routes now reuse that guard.
- Login rejects inactive accounts after password verification, without issuing
  a token. Invalid passwords still return the same 401 as unknown users.
- Invalid login/patient-registration fields return 400 / `INVALID_PARAMETERS`.
  Concurrent duplicate patient registration returns 409 instead of 500.
- Successful patient registration, login and active-user profile response
  shapes remain compatible with the existing Flutter clients. A caller-supplied
  registration role is ignored; the stored role is always patient.

## Validation

`npm run typecheck` checks application/configuration/seed without emitting.
`npm test` compiles and runs the existing smoke suite plus access regressions.
Access regressions use synthetic users and replace Prisma operations in memory;
forbidden clinical reads fail the tests instead of querying a database.

The medication, appointment and directory suites must use a disposable database.
Their runners create and drop schemas and are not read-only checks. Provider
requests in those tests are mocked; no real search credits are required.

## Recorded validation (2026-10-31)

- Typecheck and build passed.
- `npm test` with read-only database health: 47 passed, 0 failed.
- Medication suite: 11 passed, 0 failed.
- Physician suite including appointment regressions: 30 passed, 0 failed.
- Total: 88 checks, 0 failed. PostgreSQL 16 ran in a disposable tmpfs
  container, bound only to loopback, without production volumes or credentials.
  The container was removed after validation. Provider HTTP was mocked.
- Final source diff passed whitespace checks. No migration is required.

## Deliberately pending

JWT expiry/refresh and remote logout/revocation, stronger secret validation and
rotation, login rate limiting, uniform errors outside auth, verified doctor
onboarding, explicit recipient/scope/expiry/revocation authorization, production
deployment and Flutter integration are separate changes. Public patient
registration is still supported. This increment does not claim full backend
stabilization or complete consent management.

## Activation and rollback

Validate in a separate worktree before changing the running source checkout:
the current systemd service uses a development watcher. No migration is needed.
Keep unrelated Docker/Compose files and all existing environment values intact.
Rolling back these source changes restores the original access exposure;
prefer fixing forward or keeping the general clinical routes closed.
