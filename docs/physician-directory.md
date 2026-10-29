# Physician directory and metrics

The app calls Kuvi; discovery and profile retrieval are replaceable backend providers.
No official Doctoralia API is implemented or implied. Public HTML is a temporary
adapter. PhysicianProvider is the boundary for a future negotiated integration.

## Routes (active authenticated patient or doctor)

POST /physicians/search
Body: {"query":"Arturo Delgado","city":"Ciudad de México","specialty":"Nefrólogo"}
Returns {result:"OK", value:[{directoryDoctorId?,name,specialties,city,provider,profileUrl}],
methods:[...], warnings:[...], requiresConfirmation:true}.
Combines previously verified directory entries, Doctoralia search, and optional web
discovery. Orders by term overlap, not medical suitability. URL deduplication; no
identity merging by name. The city is a ranking hint, not a verified restriction.
Results may include unrelated doctors: selection and office confirmation remain required.
An empty upstream page yields an empty list; blocked/unreadable pages yield a warning.
Partial results are retained if a provider fails. Warnings must be shown appropriately
by the app; an upstream outage must not be described as proof that no doctor exists.

POST /physicians/profile
Body: {"url":"https://www.doctoralia.com.mx/perfil/arturo-delgado-pesero"}
Returns {result:"OK",value:{directoryDoctorId,name,specialties,offices,provider,
profileUrl,externalId,fetchedAt}}. Only identity-verified profiles persist.
Offices have {name,address}; online appointment widgets are not consultation links.
Canonical provider/profile URL identifies the same doctor across concurrent imports.
Cached for 24 hours, then refreshed. Does not modify any appointment snapshot.
externalId is nullable until the source supplies a reliable identifier.

POST /appointments/me/operations: save.appointment may additionally include
directoryDoctorId (nullable). This identity is independent of doctorId, which is
the existing authenticated Kuvi doctor account. Importing does not create an
account, establish affiliation, confirm a booking or grant access to records.
Omitting directoryDoctorId preserves an existing association and legacy request
hashes. Once linked, changing/removing the physician requires a new appointment.
Free-text legacy appointments remain unlinked: never infer identity from names.
The app must persist and synchronize this new ID before its appointments contribute.
Do not send directoryDoctorId when the patient replaces the selected physician
with a different person before the initial save.

20 requests/user/minute, 8 concurrent operations/process, bounded responses and
15-second outbound timeout per provider request. POST avoids query terms in URL
logs. No patient credentials, notes or appointment data go to providers.
Rate limiting is per process; replace with a shared limiter before multi-instance deployment.

## Optional discovery

Serper is preferred when SERPER_API_KEY is set (server .env only). It sends a
bounded POST to https://google.serper.dev/search with X-API-KEY, gl=mx, hl=es,
and site:doctoralia.com.mx. Redirects are never followed with the key.
When both keys exist, only Serper is selected; otherwise Brave remains supported.
Restart the server after changing environment credentials.

Discovery now runs only if directory + Doctoralia have no candidate containing
all query words and the supplied specialty/city hints. This is a heuristic, not
identity verification. Selected profiles must still be reviewed. CDMX and
Ciudad de México are not normalized aliases yet, so spelling differences may
cause an extra fallback request. Provider outages retain existing results and
return serper_unavailable; missing credentials return web_search_not_configured.
No automatic paid upgrade, account registration or credit purchase is performed.
Tests use mocked Serper HTTP and no real credits. Live verification requires
the user's key. The app still needs connection to these backend endpoints.

Set BRAVE_SEARCH_API_KEY in the server environment to enable Brave Web Search.
Without either key discovery is disabled and warnings contains web_search_not_configured;
direct search, cached directory and profile import remain usable. Never place
the key in the app or source repository. This adapter is implemented and tested
with mocked HTTP; live search requires credentials. Discovery results are only
suggestions. Selected profiles are retrieved and verified by the profile provider.
No scraping of Google search result pages, paid account creation or automatic purchase.

## Internal aggregate report

npm run build
npm run report:physicians -- 2026-07-01T00:00:00Z

Default recent window: 90 days ending at execution time. Reports at most 100
physicians with linked appointments, ranked by recent distinct completed patients
then recent completions. Includes registered appointments, distinct patients,
completed/cancelled/no_show counts, recent completions, recent distinct patients,
repeat patients (at least two completed appointments), recent repeat patients and
latest completed appointment time. Archives remain counted; cancellation/no_show
are never completions. Future appointments are never completed counts. Metrics
derive from appointment rows, not events; retries, edits and reschedules do not
create extra consultations. Completed reflects recorded status, not independent
proof of attendance. No names/identifiers/notes of patients are in report output.
unlinkedAppointments exposes coverage gaps. No public metrics HTTP route exists.

Affiliation status defaults to external; candidate/contacted/affiliated are reserved
for controlled internal workflows. No automatic affiliation or contacting doctors.

## Validation

npm run test:physicians

Creates a random isolated PostgreSQL schema, applies all migrations, runs provider,
directory, metrics and appointment regression tests, and drops only that schema.
Uses the configured database connection without copying secrets.

## Profile photographs

Verified profile responses now include nullable photoUrl and photoSourceUrl (the
profile used as source). These fields are persisted in Physician and included in
local directory search results. External search suggestions may omit them until
profile import. The public adapter accepts only HTTPS portrait URLs on the observed
Doctoralia CDN, from the verified Physician JSON-LD image or profile og:image.
Generic site logos, gallery images and images from search snippets are not used.
The backend does not download/proxy the image. The app must handle null, loading
failure and placeholder rendering; no app change is included in this backend work.
photoCheckedAt distinguishes legacy cache entries from profiles checked with no photo.
Legacy profiles refresh once on the next profile request; subsequent refreshes use
the existing 24-hour policy. A verified refresh without an image clears the old URL.
No appointment snapshots, metrics or access permissions change.
