# Explicit clinical access and operator onboarding — 2026-10-31

Backend only. No Flutter code, QR/.kuv format or external directory affiliation
is changed. Public `/auth/register-doctor` remains disabled.

## Two independent requirements

A medical account needs an active DoctorApproval recorded by a trusted local
operator. Historical doctor-role accounts are not automatically approved.
Approval records a reference to the operator's manual review; it does not perform
an external professional-license verification. Identity login alone is not clinical
approval. Doctor clinical role guards, including appointment routes, check approval.

Reading a patient's general record additionally requires an explicit, unrevoked,
unexpired PatientDoctorGrant for that exact doctor and requested scope. Grants
are made only by their authenticated active patient owner. Neither an external
directoryDoctorId, a clinical appointment nor a legacy bearer share grants general
record access. These IDs and authorizations are intentionally distinct.

## Patient API

All paths below start with `/sharing`. Patient role and active account required.

- GET `/doctor-grants`: paginated own grants, including revoked/expired entries,
  current version and recipient username. Query: limit 1–100 (default 25), cursor.
- POST `/doctor-grants`: strict JSON with doctorId, scopes, expiresAt (UTC ISO),
  expectedVersion. First grant uses version 0. Expiry must be future and at most
  90 days away. No permanent/default unlimited access. Duplicate scopes rejected.
- POST `/doctor-grants/:id/revoke`: strict JSON with expectedVersion. Owner only;
  wrong owner and unknown grant have the same 404. Revocation is idempotent.

There is one current grant per patient/doctor pair. Replacing scopes, renewing or
reactivating it requires its current version and increments that version. A stale
request returns 409/GRANT_VERSION_CONFLICT and cannot resurrect revoked consent.
Each change appends an audit event with grant metadata, not clinical contents.

Scopes are independent:

| Scope | Allows |
|---|---|
| summary | Counts of questionnaire answers and medical-history notes only |
| questionnaire | Stored individual questionnaire answers and question text |
| medical-history | Stored medical-history note texts, including section snapshots |

The medical-history scope includes JSON questionnaire snapshots stored as notes;
it is not a promise to exclude every questionnaire-derived fact. Neither scope
exposes passwords, profile telephone/sex, other recipients' permissions, operator
verification references, medication inventory or unrelated appointment records.
Client consent screens must accurately name the content before requesting scopes.

The recipient doctorId must be an approved active Kuvi account ID provided through
a trusted account-identification workflow. A Doctoralia directory identity is not
an account. Public physician search does not create clinical privileges.

## Doctor API

All paths start with `/doctor`. Active doctor role and current approval required.

- GET `/patients`: only patients with an active unexpired grant to that doctor;
  returns grant ID, scopes, expiry and minimal patient ID/username. No global list,
  contacts, latest note or answer snippets. Paginated by grant ID.
- GET `/patients/:id/summary`: requires summary; returns patient ID/username and
  counts. This intentionally differs from the old unsafe full-profile/snippet response.
- GET `/patients/:id/questionnaire`: requires questionnaire; paginated answers.
- GET `/patients/:id/medical-history`: requires medical-history; paginated notes.

Query pagination uses limit 1–100 (default 25), cursor=last returned row ID and
nextCursor in the response. Unknown query fields are rejected. Responses use
Cache-Control: no-store. Unapproved doctors get 403/DOCTOR_NOT_APPROVED. Missing
patient, no grant, wrong scope, revocation and expiry share a 404/PATIENT_ACCESS_NOT_FOUND.

Reads and permission changes serialize per doctor/patient with transaction locks.
After revocation completes, a subsequent read cannot use the earlier grant. A read
that completed before revocation may already have delivered a copy; revocation
cannot retract information already returned. Transactions recheck account and
approval rather than relying only on an earlier HTTP guard.

Appointment-scoped access still requires doctorId assignment and now approval,
including direct service functions. That access covers only the assigned
appointment and does not grant general history. Patients cannot select an
unapproved Kuvi doctor account for a new assigned appointment.

## Trusted local operator workflow

Build first. `KUVI_OPERATOR_CONFIRM=1 npm run doctor:onboard` reads one strict JSON
object from stdin (maximum 8192 bytes). Obtain input securely: do not put passwords
in command arguments, shell history, source files or logs. No HTTP endpoint exposes
this function. The operator identity comes from the OS account, not caller JSON.

Actions:

- create: username, password (12–72 characters and at most 72 UTF-8 bytes),
  verificationReference. Creates an active doctor and approval atomically. Existing
  usernames fail; this cannot promote a patient account.
- approve: userId, verificationReference. For an existing active doctor after review.
- revoke: userId, reason. Revokes approval, all current sessions and all currently
  unrevoked patient grants, with audit entries. Reapproving later does not reactivate
  any patient grant; each patient must explicitly grant again using the new version.

Success prints only result, userId and action. Errors print sanitized codes, never
input, password hashes, signing keys or raw database errors. The tool does not
contact professionals, verify external licenses or automatically affiliate them.

## Schema and signing key

Migration `20261031010000_clinical_grants` transactionally adds DoctorApproval,
DoctorApprovalEvent, PatientDoctorGrant and PatientDoctorGrantEvent, indexes and
foreign keys. Scope values and array cardinality are constrained in PostgreSQL.
Existing approvals and consent are not inferred or backfilled. No existing clinical
table is rewritten. Audit relationships use Restrict to prevent accidental deletion.

JWT_SECRET now requires at least 32 characters. This is a length floor, not an
entropy measurement: generate a cryptographically random secret. Activation uses
a fresh 64-byte random key and no previous-key verification fallback. Existing
access JWTs, including legacy tokens, stop working. Opaque refresh sessions are
independent of the signing key and may renew under the new key if still valid.
Current Flutter does not renew, so its user must log in again. Local records and
pending operations are not deleted. Preserve secrets only in restricted server
configuration/backups and never in Git or delivered patches.

The service imports `.env` through systemd EnvironmentFile; changing the file alone
does not replace the npm watch supervisor's inherited environment. Activation must
reload the supervisor and verify the active key without logging it. Take a private
database/configuration backup first, apply migration, update generated client and
compiled output, and confirm API health. Do not run seed/reset commands.

## Validation

Typecheck/build and disposable PostgreSQL 16 validation:

- General smoke/access/rate limits with database health: 53 passed.
- Session regression suite: 13 passed.
- Clinical grants/operator/rotation suite: 18 passed.
- Medication regression suite: 11 passed.
- Physician/appointment regression suite: 30 passed.

125 checks, no failures. No Kuvi volumes or patient data were used in tests.
Disposable containers were removed. An upgrade from the previous 11-migration
schema preserved a synthetic user and left approval/grant tables empty. The
clinical suite covers recipient/scope isolation, expiry, versions, revocation,
concurrency, audit, operator CLI, no implicit directory/appointment/bearer access,
approval revocation and JWT signing-key rotation with refresh compatibility.

## Remaining work

Flutter identity/refresh and consent screens, trusted doctor identification in UI,
clinical-read audit/monitoring beyond permission-change events, operational audit
retention, session cleanup, production deployment, shared rate limiting and review
of backup restoration/network exposure remain separate work. The older QR/.kuv
export still represents an offline copy and does not gain online revocation here.
