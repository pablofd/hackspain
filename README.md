**Acceso al dashboard:** por seguridad está protegido con un token privado. Contacta por WhatsApp al **658 709 642** para solicitar acceso. No publiques el token ni uses claves de Azure o Prosper para entrar.

# Cachopo - Foundry voice receptionist

## Evaluar el dashboard y el agente juntos

La rama `integration/dashboard-main` reúne el dashboard funcional de
`integration/dashboard-platform` y el backend actualizado de
`integration/dashboard`, incluida la configuración de voz Cedar. La rama
`platform` es únicamente el mockup; no es el submission integrado.

Desde la raíz del repositorio, con Node.js 24+:

```sh
npm ci
# Configurar las credenciales privadas siguiendo Setup, más abajo.
npm run build
npm start                         # Terminal 1: backend, 127.0.0.1:7860
npm run dashboard                 # Terminal 2: dashboard, 127.0.0.1:4321
```

Configura el token independiente en `.local/dashboard.env` siguiendo
[dashboard integration](#read-only-dashboard-integration). Ambos procesos
deben permanecer activos. El selector **Demo visual** muestra datos ficticios;
**Datos reales** consulta las fuentes autenticadas. La llamada con micrófono
usa Azure de pago, pero no envía acciones clínicas.

### Despliegue en Vercel

El frontend es estático (`dashboard/`), pero desplegar solo esa carpeta **no
despliega el backend**. El adaptador Node del dashboard necesita acceso a los
registros privados locales, credenciales y una conexión WebSocket persistente
para las llamadas. Mantén ambos procesos en la VM detrás de HTTPS/WSS.

Importa esta rama en Vercel con la raíz del repositorio y el preset **Other**.
`vercel.json` ejecuta `npm run build:dashboard` y genera Build Output API v3.
Configura en Vercel **solo** `DASHBOARD_BACKEND_ORIGIN`, por ejemplo
`https://dashboard-backend.example.com` (sin barra final), apuntando al
adaptador de `4321`, no al servidor de voz de `7860`.
En `.local/dashboard.env` de la VM configura
`DASHBOARD_PUBLIC_ORIGIN=https://tu-dashboard.vercel.app`, la URL exacta del
frontend sin barra final, y reinicia únicamente el dashboard cuando no tenga
llamadas demo activas. El proxy HTTPS del backend debe conservar Host, Origin,
Authorization y el upgrade WebSocket.

Las lecturas y el análisis NLP usan `/api/dashboard/*` mediante un rewrite HTTP
autenticado y sin caché. El audio conecta directamente por WSS al adaptador:
no depende de que Vercel haga proxy del upgrade. Los tickets siguen siendo de
un solo uso y ligados al origen exacto. Los previews con otro dominio no
autorizan llamadas ni análisis hasta configurar explícitamente ese origen.
Azure, Prosper, registros y token permanecen en la VM; nunca los añadas a las
variables del frontend ni al repositorio. El visitante introduce el token en
el formulario y este permanece solo en memoria.

Después del despliegue, comprueba login, Configuración, Señales y una llamada
con micrófono solicitada explícitamente. La preparación se prueba localmente;
no se afirma que se haya publicado o verificado una URL Vercel real.

A TypeScript backend for the Prosper HackSpain challenge. It adapts Prosper's
Twilio Media Streams protocol to Azure OpenAI Realtime in Foundry by default, following
the already-working WebSocket approach from the team's language-learning app.
An isolated, opt-in GPT-Live connector supports a separate voice-model experiment.
The voice runtime uses no Jev, Vercel AI Gateway, Twilio account or additional
speech provider. A separate, opt-in synthetic Jev benchmark is described below.

Contributor rules, the current scoring contract and problem-specific lessons
learned are maintained in [`AGENTS.md`](AGENTS.md).

## Current scope

- Authenticated `/ws` endpoint, with one Azure session per call.
- Bidirectional G.711 mu-law audio at 8 kHz. Outbound audio is paced in 160-byte,
  20 ms frames; interruption handling clears our own queue because Prosper
  does not implement Twilio's `clear`.
- Bounded buffers, up to 20 connections, a three-minute call limit, cancellation
  and shutdown cleanup.
- Verified patient lookup, real availability, upcoming/past appointments and
  the clinic catalogue from Prosper.
- Confirmed bookings, reschedules, cancellations and new-patient registration;
  explicit no-action/escalation outcomes with the published reason codes.
- Deterministic relative dates and site openings; provider-name disambiguation,
  published symptom routing, and nearest eligible site selection.
- Independent patient/intent state, explicit correction invalidation and
  batch confirmation for calls that require multiple actions.
- Private local transcripts, interruptions and proposed/submitted actions, with
  optional local stereo WAV recordings of received/sent audio.
- OpenTelemetry call, Azure connection, response and tool spans, including
  token counts and audio byte counts. No audio, transcripts, tool arguments,
  patient identifiers or credentials are added to telemetry.
- A separate, authenticated, read-only dashboard imported from `platform`.
  It consumes existing observations without changing the voice runtime.
  See [dashboard integration](#read-only-dashboard-integration).

The `/ws` agent can send `/submit/*` actions for the actual `start.callSid`.
These endpoints report what the agent would do; Prosper's underlying EHR is
read-only. HTTP 200 acknowledges an action, **not** a passing judging result.
Practice calls can be started from the Prosper dashboard. Connection
checks explicitly disable submissions, including when using `--voice`.

## Scored calls from the terminal

The programmatic run API uses the team's `PROSPER_API_KEY` in `X-Api-Key`;
it does not need a dashboard password or browser cookie. The live
`/api/v1/runs` routes are separate from the legacy cookie-authenticated dashboard
routes. The clinic OpenAPI snapshot supplied on 19 September omitted run
management even though its list/detail endpoints were live.

```sh
# Explicitly admit ONE private call for the selected problem and watch it:
npm run prosper:score -- --problem no_slot_free

# Read-only operations; they never start or cancel a run:
npm run prosper -- list
npm run prosper -- status --run-id RUN_ID
npm run prosper -- watch --run-id RUN_ID

# One final JSON object on stdout, progress on stderr:
npm --silent run prosper -- watch --run-id RUN_ID --json
```

Only run the admission command when a person requests a scored call. No build,
test, connection check or server startup invokes it. The API allows one queued
or active run per team, across both lanes. The current scored lane has a global
5-minute cooldown after the previous scored run finishes, not after admission
and not separately per problem; `--wait` observes it without repeated POSTs.
Practice has its own 30-second cadence and is not started by this command.
The scored run uses the registered integration; the CLI never overrides or
rewrites its endpoint or headers.

The platform changed scoring during 19 September: scored calls now pool across
runs, with at most four credited passes per problem. A scored run selects one
problem and dials one private case; the old `run-all` command is rejected
without admitting anything. Avoid spending a cooldown on a problem already
at its four-pass cap. Switchboard is unscored and rejected locally.

GET failures are displayed and retried while monitoring, honoring `Retry-After`.
An uncertain admission is **not** automatically retried: inspect `list` before
issuing another scored call. Once an ID is received it is printed and saved under
`.local/runs/` with mode `0600`, so `watch --run-id` can resume after an interruption.
Ctrl+C stops the local command, not an already admitted remote run.

The console separates PASS, FAIL, VOID and PENDING from failure signals. A case
can **pass with `wall_clock` or another signal**; the API's verdict is authoritative.
While a run is active the API may list only settled cases, so the console counts
published verdicts without inventing a total or claiming that zero cases remain.
The currently observed run endpoint does not expose weighted points or private
expected records, so the CLI reports case counts rather than inventing a score.
Snapshots omit unrecognized fields and redact credentials/query strings from
endpoint URLs; they contain no transcript, expected patient record or API key.
Admission receipt timestamps are retained separately from later observations,
and a scored admission followed by a different returned lane is an explicit
error, never silently treated as the requested scored call.

`wall_clock` is the **three-minute total call budget**, not the timeout of a
single clinic request. Increasing a request timeout does not extend the call.
Local API receipts and completed HTTP checks do not prove that a case passed.

### Opt-in score coordinator

The coordinator is separate from the voice server. It is not enabled by a
build, commit, server startup or configuration check. Start it only with the
team's explicit authorization to spend scored and practice calls:

```sh
# Read-only status; this is also the default when no command is supplied:
npm run prosper:auto -- status

# Keep this foreground command running in its own terminal:
npm run prosper:auto -- run
```

It selects an open, scored problem below four credited passes, preferring the
highest published weight and then problem number. It reads authoritative team
credits and eligibility, waits for any existing run, checks local voice health,
and observes the global five-minute scored / thirty-second practice cooldowns.
The five-minute rule replaced the earlier twelve-minute setting during
19 September. The registered endpoint, headers and voice model are never changed.
Once all currently open problems are capped, it waits for new published problems.
The public freeze flag or the published `2026-09-20T04:00:00Z` deadline stops
further admissions; remote cancellation and team withdrawal also pause it.

A failed or unresolved scored result queues every public case in that problem,
one at a time. After the batch, the process **exits for review**, leaving
`.local/score-automation/review.json` with run/call IDs, public case IDs and
verdicts. It does not guess a private expected answer, patch code or deploy by
itself. An assistant or operator must analyze the private local recordings,
make only evidence-backed changes, and deploy only with no active calls/runs.
If no local bug is established, preserve the voice agent and record that
uncertainty. Explicit review approval resumes the same category if it still
needs credits:

```sh
npm run prosper:auto -- resume --failure-run RUN_ID --revision COMMIT_SHA --outcome fix_deployed
# Or, after an actual review found no justified local change:
npm run prosper:auto -- resume --failure-run RUN_ID --revision COMMIT_SHA --outcome no_local_change
```

This tool additionally needs a legitimately authorized dashboard session in
`.local/prosper-dashboard-session.json` (owned regular file, mode `0600`).
It holds `origin`, `team_id`, `cookie` and `created_at`, **not a password**.
Dashboard access supplies published case IDs, progress and eligibility, while
the team API key admits runs. Both credentials must identify the same team.
Expired authorization pauses operation; it never becomes zero credits or
silently reauthenticates. Never commit or print the session file.

Private atomic checkpoints, admission journals and a single-owner lease live
under `.local/score-automation/`. Restarting `run` monitors a confirmed existing
admission rather than repeating it. A POST with uncertain delivery remains
blocked for explicit reconciliation against the remote run list. Never delete
its journal just to unblock another POST. An existing lease is not stolen:
verify the recorded process before recovering a genuinely stale lease.
Ctrl+C stops the coordinator, **not** an already admitted remote run. A CLI
background process remains attached to that CLI session; this is not a service.

## Booking safeguards

The tool layer keeps state per call, separate from the language model:

- `find_patient` requires a unique match on at least two supplied fields before
  allowing patient-specific operations. Full name plus DNI/NIE is sufficient.
  Stored national IDs, phone numbers and birth dates are not returned to the model.
  A checksum-valid DNI/NIE mistakenly supplied in `phone` is looked up using
  `national_id`, preserving its complete value rather than stripping the letter.
  This does not create a second identity factor. Conflicting explicit IDs and
  invalid check letters are rejected before lookup; ordinary phones and the
  caller's name still retain their normal verification requirements.
- `search_availability` searches from the day after the call in Europe/Madrid,
  paginating within the API's 14-day limit. `date_phrase` resolves the published
  English vocabulary and common Spanish/Catalan equivalents deterministically.
  It respects dates, site, doctor,
  weekday, morning/afternoon and explicitly requested language. It never offers
  same-day slots. A second insurance plan is used only when explicitly supplied
  from the caller's statement.
  An empty eligible calendar is labelled as an empty **requested window**, not
  an insurance exclusion. `next_window_search` is a ready query for a broader
  later window only after caller approval; it retains the other constraints.
  Relaxation flags remove old constraints but never erase explicitly supplied
  replacements, such as a newly agreed site, date or afternoon-only requirement.
- `prepare_action` builds the action from a returned slot or an upcoming
  appointment. It cannot invent a provider, appointment type, minute or plan.
  It does **not** submit anything.
- For a later move, `list_appointments` supplies an upcoming appointment's
  `later_search`. Its opt-in `after_appointment_id` keeps the original doctor
  and site by default, searches from the appointment's Madrid date and excludes
  slots at or before its exact start. Explicit caller changes remain possible.
  It supplies RESCHEDULE preparation, never an automatic BOOK; ordinary booking
  searches and earlier moves are unchanged.
- The agent reads the proposal aloud and waits for explicit caller confirmation.
  `confirm_action` is rejected in the proposal's own turn. New searches invalidate
  that request's unconfirmed booking proposals, not a different patient's or
  specialty's draft. `confirm_actions` validates a group of proposals before
  sending its individual actions. The voice path waits for the completed current
  caller transcription and a brief stable-turn interval; an explicit condition
  or request to check an alternative blocks submission. The model still interprets
  consent: this is a rejection guard, not proof of consent from a classifier.
  Revised offers should repeat only changed details when the rest was heard
  and is still valid. After explicit approval of the current BOOK/RESCHEDULE
  proposal, the next step is confirmation submission, not another explanation
  or repeated preparation. This is conversational guidance, not an automatic
  submission triggered by a transcript or disconnect.
- Accepted actions cannot be edited or replaced. An identical retry is safe:
  Prosper returns 409 if it already accepted it. Unknown outcomes only retry the
  same payload; 410/422 are errors, never success. One confirmed POST already in
  flight may finish after hang-up within the 30-second submission window;
  unconfirmed proposals are never automatically submitted on disconnect.
- Prosper requests may wait up to 60 seconds; reads still abort immediately on
  caller disconnect. Each confirmed submission has a 60-second total budget,
  including the 250 ms wait and at most one identical retry. If the call closes,
  its already-started submissions have at most 28 more seconds, never extending
  their original deadline or starting a different write. The 180-second call
  limit is unchanged.
- Registrations validate all demographics and the DNI/NIE check letter, check for
  an existing record, and send only `REGISTER`, not an invented booking.
- `report_outcome` sends explicit `NO_ACTION`/`ESCALATE` records. API restrictions
  require current lookup evidence; errors and disconnects never silently turn
  into a refusal. Empty availability returns a structured `no_booking` next step.
  When a single insurer blocks the request, the caller must be asked about another
  held plan; `no_other_policy:true` records their explicit negative answer before
  refusing. An accepted alternative clears old refusal evidence. Private payment
  is never suggested as a coverage workaround.
  Calendar-only refusals do not need an insurance detour or booking-style extra
  confirmation: after alternatives are declined or none remain, report the
  current request's `no_availability` before closing.
  Privacy-only requests for stored identifiers, patient lists or another
  person's appointment details use `out_of_scope`, not `caller_not_authorised`.
  A conservative EN/ES/CA guard checks recent caller text before the first
  submission, retains a disclosure request through identity-only follow-ups,
  and rejects that wrong reason with explicit recovery guidance. It never
  silently rewrites a payload or repairs an accepted action. Genuine
  third-party scheduling keeps its normal verification and authorization
  behavior; explicit new scheduling intent clears the older privacy context.
  Do not keep requesting identifiers as a way to unlock a privacy-only request.
  A caller leaving an available offer for another time is not `out_of_scope`
  or `caller_not_authorised`. This includes polite EN/ES/CA endings after an
  already accepted cancellation: keep the received `CANCEL`, rather than
  appending a farewell `NO_ACTION`. Actual restrictions on a separate booking
  still use the existing request-scoped evidence rules.

## Documented problem workflows

The implementation has explicit paths and synthetic regressions for all
18 problem categories, not a guarantee that every private conversation passes:

| Problems | Runtime behavior |
| --- | --- |
| Simple Booking / Switchboard | Verified API slots, exact types/plans, 10/20 isolated sockets, bounded audio queues. Tied earliest slots prefer the provider with more returned eligible slots before a stable ID tie-break. |
| Doctor and Site / Questions | `resolve_request` resolves only catalogue IDs. Near-miss doctor names require clarification. A routine complaint outside the triage table must not prevent resolving a named provider/specialty. Leave alternatives keep the same specialty/site; `get_clinic.section` returns grounded facts with less repeated catalogue text. |
| New Patient | Complete demographics, DNI/NIE check letter, normalized email/phone, duplicate lookup, REGISTER only after confirmation. |
| When Exactly / No Slot Free | Madrid call-day anchor, strict next weekday, no same-day bookings, typed date phrases, real site hours and closure dates. Moving a closed-day request requires `allow_next_open_day`; `advance_day`/`next_day_search` advances from an empty previously searched day, not from the call's date. Changing constraints requires explicit caller agreement. |
| The Rules / Second Policy | API-backed age/referral/coverage decisions. Held plans and an explicit single-plan answer are retained per patient. Later searches cannot borrow another patient's policy or an obsolete refusal reason. |
| Third Party / Real Call | Separate patient and request IDs. `confirm_actions` submits every confirmed intent; refusals can be attached to their own request without blocking an unrelated successful intent. |
| Triage | Published complaint families and red flags, verified chart age, and clarification on uncertainty. An established emergency blocks pending bookings and directs `ESCALATE(medical_emergency)`. No general medical diagnosis. |
| Languages / Noise / Difficult Caller | English/Spanish/Catalan dialogue, explicit provider-language filters, prompts to clarify uncertain identifiers, `revise_request` invalidation, bounded interruption playback and old-generation tool/audio suppression. |
| Adversarial and Privacy | No stored national ID/phone returned by patient lookup, including those embedded in chart notes. Tool arguments are schema-validated, proposals use API evidence, and out-of-scope outcomes remain explicit. |
| Nearest Site | Validated public-address coordinates, straight-line distance, then eligibility/availability checks in nearest-first site order. No guessed coordinates or hard-coded public-case origins. |

For an existing request, pass its `request_id` when supplying a second plan or
revising preferences. `relax_constraints` lists only changes the caller agreed
to (provider, location, date, weekday, time, language). `new_request:true` starts
a genuinely additional intent; it must never be used to replace an accepted
write. `get_call_state` reports verified identities and action statuses so the
model can recover without repeating questions or submissions.

### Nearest-site privacy and limits

`locate_origin` uses the official Spanish CartoCiudad public-address geocoder
over a fixed HTTPS endpoint. It sends only the public street/place and
municipality explicitly given for this purpose, not a patient ID, name, phone,
transcript or clinic chart. Do not include apartment/resident details.
It currently resolves Madrid-province locations; unknown/ambiguous addresses
require clarification. Candidate coordinates must come from validated geocoder
responses, never model inference or a city-centre approximation.

A fully matching street, portal, extension and municipality can resolve even
when the provider also returns phonetic distractors. Only genuinely competing
exact points need a choice; a different street or house number is never offered
as a substitute. Generic street abbreviations and leading Spanish articles are
normalized without erasing internal street-name words. Explicit five-digit
postal codes, including separated `portal-postcode` and CP forms, are parsed
as public address components and used with municipality filters. Available
postcode metadata must agree; DNI, phone, private-unit and transcript-like
inputs remain blocked before any external request.

Each ambiguous candidate carries `selection_arguments` with the exact original
public address and its call-local ID. Use that pair only after the caller selects
the candidate; a corrected address starts a fresh lookup without `candidate_id`.
Missing/stale candidates and edited address queries have distinct recovery
guidance. Origin diagnostics contain only booleans/counts, never raw addresses.

Public geography is cached and external requests are rate-limited. Timeouts,
malformed data and service limits are explicit errors; a geocoding outage is
not `no_availability`. The returned `origin_id` is local to the call and can be
used as `nearest_origin_id` in availability. A closer site without eligible
appointments is skipped; patient/provider/site/time/plan constraints still apply.
CartoCiudad's portal bucket can still omit a house even when a larger mixed
result limit is requested. If no validated exact point is available, the tool
remains unresolved: it does not use a nearby portal, a street centroid or
`find?q`'s first fuzzy match. Input-format rejection is reported separately from
evidence that an address could not be found.
If a nearest-site re-search invalidates a proposed BOOK, `booking_continuation`
guides preparation of a fresh matching offer (with arguments only when the held
policy is unambiguous). Answer location questions briefly and return to the
current booking request. Automatic preparation remains opt-in; old proposal IDs
and old consent cannot be reused, and reschedules/read-only searches do not
become automatic bookings.
Entrance, floor and turn-by-turn route details are not supplied by the current
catalogue. Do not invent them or treat an access question as a new caller
origin. Use the known street address, acknowledge missing details and return
to the fresh offer without skipping consent. A necessary unresolved access
condition must not be treated as agreement to book.

Natural-language interpretation, noisy speech recognition and explicit consent
remain model-dependent. Unsupported date or symptom wording must be clarified;
synthetic tests and accepted API receipts are not Prosper judge verdicts.
The three-minute limit is unchanged.

## Setup

Use Node.js 24 or later and npm:

```sh
npm ci
```

Keep `PROSPER_API_KEY` in `.env.local`. Azure settings can come directly from the
private `.env.lang` file:

```dotenv
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-realtime-1.5
# Optional: omit the key to use the VM's managed identity.
AZURE_OPENAI_API_KEY=
```

Only `AZURE_OPENAI_*` variables are imported from `.env.lang`: its old `PORT`,
speech service keys and application-specific settings do not affect this app.
Precedence is shell environment, then `.env.local`, then `.env.lang`.
A key from `.env.lang` is not borrowed for a different overridden Azure endpoint.
Both files are ignored by Git. The existing AI Gateway key is left untouched
and is not used.

`.env.example` is a template with placeholders, not a backup of a working
installation. Do not copy it over an existing `.env.local`. A private
`.env.local.save` can hold a recovery copy (mode `0600`); neither that backup nor
an editor's `env.local.save` is loaded by the app. The leading dot matters:
edit `.env.local` for Prosper, WebSocket authentication and local overrides,
and `.env.lang` for the inherited Azure settings. Never commit either file.

Generate a private token for our WebSocket endpoint:

```sh
npm run configure
# If the Azure endpoint is not in either environment file:
npm run configure -- --endpoint https://your-resource.openai.azure.com
# Select a built-in Realtime voice without exposing other local settings:
npm run configure -- --realtime-voice cedar
```

Configuration preserves existing secrets, prints no values and sets environment
file permissions to `600`. `.env.example` documents the remaining settings.
The Azure deployment name must match a deployed, compatible Realtime model.
The initial adapter deliberately uses the same preview protocol as the working
reference app rather than mixing it with the different GA event schema.

### Azure authentication

An explicit `AZURE_OPENAI_API_KEY` is used when configured. Otherwise,
`DefaultAzureCredential` uses a managed identity on an Azure VM or a developer
credential locally. The identity needs permission to invoke the resource's
Realtime deployment, for example the appropriate Cognitive Services OpenAI role.
Authentication is sent in a header, never in a WebSocket URL.

No cloud resource or role assignment is created or changed by this project.

## Run and connect

```sh
npm run dev
curl http://127.0.0.1:7860/healthz
```

For a compiled build:

```sh
npm run build
npm start
```

### Explicit voice-model selection

The existing `src/azure-realtime.ts` connector is unchanged. `VOICE_CONNECTOR`
defaults to `realtime`; the experimental `live` path lives in `src/azure-live.ts`.
There is no automatic fallback or model switching.

After `/healthz` reports `activeCalls: 0`, stop **only the voice server** before
running one of these commands. Keep the tunnel and Prosper integration unchanged;
starting another command does not stop the old process or free port 7860.

```sh
npm run start:live           # GPT-Live 1 + the configured Responses backend
npm run start:realtime-1.5   # Explicit return to the original Realtime 1.5 deployment
npm run start:realtime-2     # Separate Realtime 2 experiment, when ready
```

The Realtime 2 preset changes the deployment, not the existing Realtime protocol.
It is not activated or validated by testing Live; verify that deployment's
compatibility separately before comparing calls.

To persist the selected connector for ordinary `npm start`, use:

```sh
npm run configure -- --voice-connector live
# Restore the default connector:
npm run configure -- --voice-connector realtime
```

These switches preserve the endpoint token, tunnel, Realtime deployment, voice
and gain. Live uses separate `AZURE_OPENAI_LIVE_DEPLOYMENT` (default `gpt-live-1`),
`AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT` (default `gpt-5.4-mini`) and
`AZURE_OPENAI_LIVE_VOICE` (default `coral`) settings. Both deployments must be
available on the configured Azure resource. Live duration and Responses backend
tokens incur separate Azure usage. `VOICE_LIVE_OUTPUT_GAIN_DB` defaults to 0;
the existing `VOICE_OUTPUT_GAIN_DB` continues to apply only to Realtime.

Live uses `/openai/v1/live/sessions` with native PCMU at 8 kHz, not the Realtime
preview endpoint. Its delegated functions reuse the same call-local receptionist,
clinic validation, authoritative call ID and confirmation/submission safeguards.
Live captions are timestamped fragments, **not completed caller turns**. A fresh
write additionally requires stable, explicit caller approval in a later Live
delegation than the proposal. Text injection is read-only diagnostic input.
Backend completion does not mean spoken playback finished; local audio gaps only
flush the existing bounded playback queue and silence tail. Interruptions discard
local queued audio and notify Live, without sending Realtime truncation events.
This notification does not prove the provider or caller heard exactly the same
audio, and fragment stability alone never establishes consent.

The health endpoint reports process health, telemetry mode and the selected
non-secret voice profile, not a successful Azure invocation. `voiceConnector`,
`voiceDeployment`, `voiceOutputGainDb` and, for Live, `voiceBackendDeployment`
identify what the running process will use. It never returns credentials.

To receive calls from Prosper, expose the server through a TLS-enabled
WebSocket ingress. Keep the default loopback bind for local development; set
`HOST` explicitly if a deployment's reverse proxy requires it. In the Prosper
dashboard's **Settings > Integration**, configure:

- Endpoint: `wss://your-public-host/ws`.
- Header: `Authorization: Bearer <VOICE_ENDPOINT_TOKEN from .env.local>`.

Do not use the Prosper API key as this endpoint token. The API key authenticates
our outbound clinic requests; the separate token protects access to paid voice
sessions. Do not put either token in a URL.

### Public practice calls

An SSH local port-forward is accessible from your PC, not from Prosper's
evaluator. For a temporary public endpoint, this VM has an official
`cloudflared` binary installed in `.tools/` (excluded from Git). On another
machine, install the matching binary from the
[official releases](https://github.com/cloudflare/cloudflared/releases) at
`.tools/cloudflared` and verify its published checksum before running it.

With the voice server running on port 7860, start a tunnel:

```sh
npm run tunnel
```

The tunnel prints `https://<random>.trycloudflare.com`. Set Prosper's integration
endpoint to `wss://<random>.trycloudflare.com/ws` and configure the Authorization
header described above. Keep both the server and the tunnel running; restarting
the tunnel creates a different public URL. This is a development tunnel, not
a production deployment.

The clinic API key does not grant a dashboard session: the run-management
API requires dashboard login. Sign in with the credentials issued by Prosper,
then choose a published case under **Problems > The Simple Booking > Call**.
Do not start **scored calls** to debug connectivity. Start with one booking case and
inspect both the submitted record and conversation before broadening evaluation.
The implementation contains no public-case answers or fixed patient/slot IDs.

### Alternative ingress: ngrok

Prosper's protocol is still WebSocket: changing ingress does not mean switching
to an HTTP callback or WebRTC. To compare providers, use ngrok (recommended by
Prosper) in place of the temporary Cloudflare URL. It requires your own
[ngrok account and agent authtoken](https://dashboard.ngrok.com/get-started/your-authtoken).
The Azure identity and clinic API key cannot authenticate an ngrok agent.

The official Linux x64 binary is installed on this VM at `.tools/ngrok`, outside
Git. On another machine, download the correct architecture from
[ngrok's official downloads](https://ngrok.com/download/linux) to that path.
Add the following to your ignored `.env.local` using an editor, not a shell
command containing the literal token:

```dotenv
NGROK_AUTHTOKEN=your_ngrok_agent_authtoken
# Optional: an HTTPS URL already assigned to your ngrok account.
# NGROK_URL=https://your-assigned-domain.ngrok-free.app
```

With the agent running, start the alternative ingress:

```sh
npm run tunnel:ngrok
```

The launcher checks the local health endpoint first, disables local HTTP traffic
inspection, and passes only the ngrok token and required OS settings to the ngrok
process. It does not pass your Azure/Prosper keys or endpoint token. The ngrok
token stays out of command arguments and is redacted from its output.

Use the HTTPS URL announced by ngrok, changing the scheme to `wss://` and adding
`/ws`. In **Settings > Integration**, save that endpoint **and paste the existing
Authorization header again**; leaving Headers empty removes the stored header.
The ngrok authtoken is NOT the Authorization value for Prosper.

Keep the agent and tunnel processes running for the full call/run. A process
started in this CLI session is attached to it, not a persistent VM service.
For manual testing, keep both VM terminals open (`npm start` in one and
`npm run tunnel:ngrok` in the other). A stable domain alone does not keep either
process alive. No Azure firewall change or new model deployment is required.

Verify the new `/healthz` and authenticated `/ws` before one public practice.
Only consider scored calls after a successful practice; do not assume an alternate
tunnel repairs a run attribution/settlement failure. Do not change the voice
model, runtime instructions or concurrency limit during the ingress comparison.

## Private call records

On the Linux VM, call transcripts/actions are recorded by default under
`.local/calls/`, which is ignored by Git and never served as files over HTTP. The
authenticated dashboard can project a selected call's transcript as described
below; raw NDJSON and WAV remain private. Directories
use `0700` and files `0600`. Known credentials are redacted from the JSON records
before serialization. Audio recording is a separate, explicit opt-in. This
storage implementation uses Linux `/proc` for safe descriptor-based file access;
use the VM, or disable recording on non-Linux systems.

Each file is named `call-v1-<callId>-<timestamp>-<random UUID>.ndjson`. Every line
is a JSON event with `schemaVersion`, `callId`, ISO `timestamp`, `type` and the
event's fields. Events include:

- Recognized caller transcripts and generated assistant transcripts.
- Interruptions and the amount of assistant audio sent before the interruption.
- Tool success/failure codes and exact proposed/confirmed/accepted action bodies.
- Sanitized decision codes and the resolved availability window/options, so a
  repeated date or routing block can be audited without storing raw tool arguments.
- Call start/end with reason and input/output byte counts.

To enable private audio recording for future calls:

```sh
npm run configure -- --record-audio
```

This sets `CALL_RECORDING_ENABLED=true` and
`CALL_AUDIO_RECORDING_ENABLED=true` in `.env.local` without rotating any token.
Load the new configuration only after active calls have finished. `/healthz`
reports `localRecording` and `localAudioRecording` separately.

An audio-enabled call has a companion `.wav` with the same filename prefix as
its `.ndjson`. It is standard 8 kHz PCM16 stereo decoded from the phone's mu-law:
**left channel is caller audio received by our server; right channel is agent
audio sent by our server**. The tracks use a local monotonic call clock, including
silent gaps. Only output frames emitted after the playback queue are recorded:
generated audio discarded by an interruption is not included.

Audio activity metadata distinguishes received sample counts, digital zeros and
signal levels. Nonzero energy is not proof of speech; socket output is not proof
that the evaluator heard it. These observations can help diagnose missing voice,
but are not Prosper's own recording or judge evidence.
The start event's `audio.filename` links the WAV. The end event's `audio` field
adds `durationMs` and `caller`/`agent` metrics: `frames`, `samples`, `zeroSamples`,
`peakAmplitude`, `rms` and `dbfs` (`null` for no signal). Metrics count captured
samples, not the zero-filled gaps between received/sent frames.

**WAV audio cannot redact spoken secrets or patient details.** Keep it private
and do not send it to Jev, public issues, telemetry or other services. Audio is
bounded to approximately 6 MB per call; it is not kept in an unbounded in-memory
buffer. Set `CALL_AUDIO_RECORDING_ENABLED=false` to keep transcripts/actions
without audio. Only new calls are captured; earlier audio cannot be recovered.

Assistant text is labelled **generated audio**, not a guarantee that the caller
heard all of it; use the interruption records when reviewing it. Speech
recognition is also fallible. These files may contain patient details: keep them
on the VM and do not upload them to GitHub, public dashboards or Azure Monitor.
Live transcript fragments retain `partial:true` and their `startMs`/`endMs`
session intervals. Preserve spaces and repeated words; neither fragment arrival
nor a timestamp gap is an authoritative end-of-turn or playback acknowledgment.

To find a call, use your editor or list the private directory on the VM:

```sh
ls -lt .local/calls/
```

Set `CALL_RECORDING_ENABLED=false` to disable recording. Finished records older
than `CALL_RECORDING_RETENTION_DAYS` (default 7, maximum 30) are pruned on server
startup, together with their validated audio companion. Set
`CALL_AUDIO_RECORDING_ENABLED=false` too when disabling all recording.
Incomplete, orphaned, active or linked records are preserved conservatively and
need manual review/removal. Disk/serialization errors are explicit; recordings
are never silently truncated. The earlier read-only calls cannot be reconstructed
retroactively; their recording/transcript remains in Prosper's dashboard.

## Read-only dashboard integration

The frontend from `platform` commit `b5cdcfa` lives in `dashboard/`. Its design,
navigation, call list, relationship map and patient views use real data instead
of the original demo generator. `src/dashboard/` is a separate HTTP adapter;
`npm start`, the `/ws` protocol, model instructions and submission safeguards
are unchanged. Future backend commits can be merged from `main` without moving
the frontend into the voice implementation.

Start the dashboard from the repository/worktree root:

```sh
# Once, unless a private dashboard token is already configured:
mkdir -p .local
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(".local/dashboard.env", "DASHBOARD_TOKEN=" + randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });'

npm run dashboard
# http://127.0.0.1:4321
```

Enter `DASHBOARD_TOKEN` from the private file in the login form. It is a separate
operator credential, not the voice endpoint token or an Azure/Prosper key.
It remains in browser memory only; no URL, cookie, local storage or session
storage contains it. Disconnecting clears patient data. API responses are
`no-store`, same-origin and authenticated. The dashboard binds only to loopback;
use an SSH forward such as `ssh -L 4321:127.0.0.1:4321 your-vm` for remote access.
Do not expose an unauthenticated static file server at the repository root.

`npm run dashboard` loads `.local/dashboard.env` if present, then the normal
backend environment. In an isolated worktree, set `DASHBOARD_ENV_DIR` in that
private file to the existing backend checkout to reuse its configuration
read-only without copying credentials. Relative `DASHBOARD_RECORDS_DIR` is
resolved against that checkout. The integration never restarts the agent,
changes its tunnel/token, creates Azure resources, starts a Prosper call or
submits a clinic action. Loading the dashboard does not invoke a model. The
explicit browser voice demo and selected-call signal analysis below are the
only opt-in inference features.

| Source | Observations | Boundaries |
| --- | --- | --- |
| Local `/healthz` | Active call count, connector, deployment, recording and export status | Process health is not an inference success or a judge verdict. |
| Private call records | Start/end, byte counts, interruption counts, technical events, received action verbs; selected-call transcript through its own authenticated endpoint | Bulk snapshots contain metadata only. No raw NDJSON, action bodies, tool details, file paths or WAV downloads. A recent unclosed record is not proof that the caller is speaking. |
| Prosper `/clinic`, `/submissions` | Catalogue and the last 200 received records, correlated by `call_id` | A receipt is not a passing verdict. `/submit` does not update the EHR. |
| Prosper `/directory`, upcoming appointments | Explicit name/phone search and a selected patient's appointments | No bulk directory dump. DNI/NIE, birth date, clinical notes and registration demographics are excluded from these structured responses. A BOOK `patient_id` can link calls; a name/phone similarity cannot establish identity or a family relationship. |
| Azure Monitor | Supported token/audio-token usage, Realtime usage and gateway response metrics | Requires `AZURE_MONITOR_RESOURCE_ID` and the identity's metric-read permission. Scoped to the configured model deployment, not exclusively these calls. Missing samples are not zero. |
| Foundry / Application Insights | Correlated `chat` response durations and token usage via Log Analytics | Requires `AZURE_MONITOR_WORKSPACE_ID`, a linked/exporting Application Insights resource and workspace query permission. Span duration is not caller-to-first-audio latency. Console-only traces cannot be recovered from Azure. |
| Optional separate Speech resource | `AudioSecondsTranscribed`, `SynthesizedCharacters`, resource latency | The current agent does **not** use separate Azure Speech. An explicitly configured resource is labelled external, never attributed to voice calls. |

Azure queries use `DefaultAzureCredential`, not the inference API key. Typical
read-only roles are Monitoring Reader on the Cognitive Services resource and
Log Analytics Reader on the workspace. Granting roles, creating/linking resources
and enabling the agent's `APPLICATIONINSIGHTS_CONNECTION_STRING` are separate
deployment operations, not dashboard side effects.

The browser refreshes every five seconds. Metadata/health are cached for two
seconds, Prosper receipts for fifteen, and Azure data for sixty; requests are
coalesced rather than duplicated for each viewer. A source error stays visible
and is never replaced with demo values. Historical statistics are explicitly a
bounded observed sample (default seven days, up to 200 local files and 200
receipts), not a complete population; period-over-period trends are not invented.
The date ranges use Europe/Madrid calendar days.

### Agent configuration

In **Demo visual**, all four configuration tabs reproduce the original
`platform` mockup's profile, prompt, traits, policies, actions and compliance
examples. They are labelled fictional and read-only, never applied to Azure.
In **Datos reales**, the prompt textbox shows the backend's actual instruction
generator (`src/receptionist.ts`), with today's Madrid date as an example
anchor. Each actual call has its own date and submission permission. Live,
when explicitly selected, shows its voice and delegated backend instructions.
This is not a Foundry readback or proof of an already-running session's prompt.

### Browser voice demo

The **Llamada fake** control is an isolated browser conversation, not a Prosper
call. It uses the PC's microphone and the configured Azure voice model, so
**Azure inference is real and billable**. Microphone permission and an explicit
click are required; opening the page, looking at example data or issuing an
unused connection ticket does not start inference.

The authenticated, same-origin `POST /api/dashboard/demo-call` accepts no body.
An empty chunked request from a reverse proxy is valid; an actual body is rejected.
It returns a server-owned `demo-...` call ID, a one-use 30-second ticket, codec
metadata and `/api/dashboard/demo-call/ws`. The WebSocket uses the
`maio-demo` subprotocol plus that ticket; neither the dashboard token nor the
voice endpoint token belongs in its URL. The ticket is bound to the browser's
origin. One call/reservation is allowed at a time; the existing three-minute
voice deadline and bounded audio queues still apply.

The browser captures mono audio, resamples to 8 kHz and sends exact 160-byte
G.711 mu-law frames. The server supplies the existing decoder's lookup table,
so the browser does not need a separate codec service. Playback and microphone
resources are stopped on hangup, disconnect or error. Use HTTPS or a loopback
URL such as `http://127.0.0.1:4321`; ordinary HTTP on a remote VM IP is not a
secure microphone context. Headphones help avoid acoustic feedback.

The backend reuses the working voice bridge on an independent private loopback
port and forces `allowSubmissions: false` for every demo. A second, GET-only
Prosper transport rejects all submissions and run-management paths before any
request can leave the process. The demo may read the real clinic catalogue and
directory, but cannot book, cancel, move or register a patient. Do not replace
this with a browser connection to the production `/ws` using a fabricated ID.

Demo transcripts are projected and credential-redacted in memory, streamed only
to the authenticated demo socket, and bounded to 500 entries / 256 KiB. No demo
NDJSON/WAV is added to real call history or scoring; no extra model analyzes
the text. Azure's resource-level usage metrics do include the actual inference.
`clear` is opt-in on this private bridge and is sent in the same ordered stream
as its media frames; the production Prosper transport remains unchanged.

Real clinical data, explicit illustrative presentation data and the real Azure
voice demo are separate concepts. An example chart is not measured call quality,
a demo conversation is not a judge verdict, and no illustrative UI action
modifies the real agent or clinic.

### Person map

The map groups calls only through patient IDs already present in received
records, never by a similar name or telephone. Unlinked calls remain in the
call list rather than becoming invented people. It shows at most twelve
people per page, labelled by their resolved name or an explicit patient alias.
Stable radial slots surround the central maio logo at deliberately varied
distances, so the people remain dispersed rather than forming a crowded ring.
Paging discloses the total; the same state/date filters remain.

Hover, keyboard focus or click opens the person card. It includes available
profile information, actual call IDs/times/durations/results, and a targeted
read of that patient's upcoming EHR appointments. The last reported BOOK is
labelled separately from the read-only EHR agenda. A name not already resolved
through an explicit patient lookup is shown as an alias, not guessed from a
transcript; unavailable real profile fields remain explicit.

Demo portraits are locally served, CC0-labelled Pravatar placeholders documented
under `dashboard/design/portraits/LICENSE.txt`. They are illustrative, **not
photos of the represented patients**. Real profiles without an actual photo use
Phosphor's Finn the Human icon instead. No names, IDs or phone numbers are sent
to an avatar service. Demo-visual profiles and appointments remain simulated.

### Selected-call transcripts

At the user's explicit request for these synthetic challenge conversations,
`GET /api/dashboard/calls/{callId}/transcript` now returns a bounded text
projection behind the **same independent dashboard token**, same-origin checks
and `no-store` policy. This replaces the former transcript-hidden UI decision,
not the authentication or raw-recording privacy boundary.

The JSON shape is `{ callId, checkedAt, historyDays, entries, limited, limits }`.
Each entry contains only `speaker` (`user` or `assistant`), `text`, `timestamp`
and `itemId`, plus recorded `partial`, `startMs` and `endMs` when present.
`limits` is `{ entries: 500, bytes: 262144 }`: the newest 500 events at most,
within 256 KiB of projected UTF-8 JSON entries. `limited: true` explicitly warns
that older fragments were omitted. The latest matching record must be among
the same 200 recent local files and configured history window as the snapshot
(default seven days, maximum thirty). Source files remain capped at 8 MiB and
complete event lines at 64 KiB; unfinished appended lines are not invented.

No transcript is added to `/api/dashboard/snapshot` or fetched for every call.
Viewing a transcript alone does not send it to a model; the separately
requested signal-analysis feature below has its own bounded/redacted input.
Known configured credentials are
redacted again when projecting text and item IDs; existing redaction stays in
place. Synthetic patient statements, including identifiers spoken in them, may
appear in this explicitly authorized transcript view. Structured directory,
receipt and tool fields remain excluded as before.

The selected call refreshes with the existing five-second cycle. Selection
changes, hiding the detail in the map, navigation and disconnect abort pending
requests; late responses cannot replace another selection or session. Rendering
uses DOM text nodes, not HTML. Whitespace, repeated words and partial fragments
are preserved, not merged into invented turns. Speakers are labelled as the
interlocutor and agent; partial text may be incomplete/interrupted, and **agent
text is generated, not verified as heard**. Event timestamps are not exact
acoustic timings; optional model intervals do not prove playback either.

The UI distinguishes loading, an empty transcript, an unavailable local record
and source errors. The API returns `401` without a valid token, `400` for an
invalid call ID/query, `404` when no local record is in the bounded sample, and
`503` for unsafe/unreadable/invalid source records. A Prosper receipt without a
local record does not supply any conversation text.

The shared metadata/transcript reader requires owner-controlled, regular, unlinked files and
rejects symlinks. It never changes the voice process's source permissions.
Additional permission/ACL bits (including those installed by a shared workspace)
are surfaced as a warning, not mistaken for corrupt data. Review such access
locally; the writer's private `0700`/`0600` policy is unchanged.

Emotion, calibrated intent confidence, MOS, jitter, packet loss, ASR accuracy,
NPS, clinical risk and cost remain **unmeasured**, not zero. Explicit visual examples do not
turn them into real telemetry. Prompt edits, outbound telephone calls, SMS,
patient creation and historical WAV playback do not gain clinic write
implementations. Configuration remains read-only; the browser voice demo is
the separate, opt-in feature described above.
See [`dashboard/README.md`](dashboard/README.md) for frontend ownership.

### Real-mode textual signals

At the user's explicit request, opening **Señales** for a selected real call
can request `POST /api/dashboard/calls/{callId}/signals`. The endpoint requires
the independent dashboard token, same origin and an empty body; it never accepts
a client-supplied transcript or model instructions. GET does not trigger
inference. No analysis runs when the page loads, in visual-demo mode, or for
every row in the call list.

`DASHBOARD_SIGNALS_ENABLED=true` enables this feature.
`DASHBOARD_SIGNALS_DEPLOYMENT` defaults to the already deployed `gpt-5.4-mini`
on the same Azure OpenAI resource; it does not change the voice model. Requests
use the Responses API, no tools, `store:false`, a 20-second deadline and at most
2,500 output tokens. This is separate **paid text inference**, not an Azure
Monitor measurement or a clinic write.

The service uses at most 60 recent transcript entries and 12,000 characters,
with at most 1,600 characters per entry. Configured credentials and recognizable
direct identifiers, URLs and name sequences are filtered before inference.
This reduces identifying data; it is not a guarantee of complete anonymization.
The authorized input can still describe the conversation's clinical topic.
No audio, chart notes, demographics or raw tool arguments are added. Coverage
and truncation are explicit.

The response contains a perceived text tone, nullable calmness/satisfaction/
confusion indicators, qualitative intent confidence, conversation-pattern
tags and redacted evidence excerpts. All non-null indicators, intents and
patterns must cite supplied caller-entry IDs; invented or assistant-only
evidence is rejected. Outputs are strictly schema-validated and contain no
free-form medical advice. Transcript text is untrusted data, not instructions.

These are **textual estimates**, not actual emotional measurements, acoustic
quality, diagnoses, calibrated probabilities, booking authorization or judge
verdicts. Null means insufficient evidence, never zero. Assistant text is only
context: generated text and an accepted API receipt cannot establish what the
caller heard or whether they were satisfied.

Identical redacted input reuses an in-memory cached result. Changed input is
analyzed no more than once per 30 seconds per call; an older result is explicitly
marked stale during that interval. Concurrent viewers share the same request,
only one model analysis runs at a time, and the cache is capped at 128 calls.
Failures are explicit and are not retried by polling during the cooldown.
Closing a panel aborts its browser wait; an already issued bounded shared model
request may finish and populate the cache. No result is fed back into the
receptionist or used to submit actions. Browser demo conversations are ephemeral
and do not create the local real-call records this endpoint requires.

Authoritative metric and query contracts:

- [Cognitive Services / OpenAI / Speech metrics](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics)
- [Azure Monitor Metrics REST API](https://learn.microsoft.com/en-us/rest/api/monitor/metrics/list?view=rest-monitor-2023-10-01)
- [Log Analytics query API](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/request-format)

## Observability

Set `APPLICATIONINSIGHTS_CONNECTION_STRING` to export explicit spans and
standard process metrics to Azure Monitor Application Insights. Connect that
Application Insights resource to the relevant Foundry project to inspect its
telemetry there. Using a Foundry endpoint alone does **not** automatically send
the custom bridge's traces to the Foundry portal.

Without a connection string, startup emits `telemetry.console_only` and traces
are printed locally. This is explicit local tracing, not Azure observability.
The warning concerns **trace export only**: it does not mean the Azure model is
unreachable or that its credentials are invalid. Model inference still runs on
Azure, independently of where traces are exported.
At initial setup the VM identity could invoke Foundry, but there was no linked
Application Insights resource and it could not create one. A resource owner
must create/connect Application Insights and provide its connection string.
Do not confuse data-plane model access with permission to create Azure resources.

Find a call by its `prosper.call_id` on the `invoke_agent cachopo` span. Child
spans include `azure.realtime.connect`, `chat` and `execute_tool get_clinic`.
For Application Insights, a starting query is:

```kusto
union requests, dependencies
| where cloud_RoleName == "hackspain-cachopo"
| project timestamp, name, operation_Id, duration, success, customDimensions
| order by timestamp desc
```

Automatic HTTP and SDK instrumentation is disabled to avoid capturing
credential-bearing URLs or query parameters. Do not turn on raw WebSocket,
SDK debug or transcript logging when using patient information.

## Checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium  # Once, for the dashboard browser checks only
npm run test:dashboard           # Synthetic sources; no Azure/Prosper requests
npm run check:connections
# Invokes the model and incurs Azure usage:
npm run check:connections -- --voice
```

The first connection check only reads the clinic. `--voice` additionally opens
the explicitly configured connector, asks it to use `get_clinic`, checks that it
returns non-silent mu-law audio and completes its backend work, then closes it.
It does not create a Prosper call or submit a result; its HTTP wrapper also
blocks every POST even if a model attempts a write.
Unit and local WebSocket tests use fakes and require no cloud credentials.

Successful checks finish with `connection_check.completed`, separately reporting
Prosper connectivity, Azure voice connectivity, the authentication method and
the telemetry destination. Without `--voice`, Azure is explicitly `not_checked`.
This command generates audio but does not play it through your PC's speakers.
OpenTelemetry span status codes are `0` (unset), `1` (OK) and `2` (error);
an unset status is not a connection failure.

## Optional Jev evaluation (not enabled in calls)

`npm run check:jev` uses the existing `AI_GATEWAY_API_KEY` from `.env.local` to
evaluate **twelve fixed synthetic examples** with `typesafe-ai/jev`. It tests
intent classification, explicit corrections and completion judgments, including
English, Spanish, Catalan and a multiple-action request. It never reads real
transcripts or patient records, calls Prosper, or changes the voice agent.
This command incurs Gateway inference usage; the AI SDK is a dev dependency.

One trial matched all twelve labels in each category, with request latency
p50 273 ms and p95 1,149 ms (including a cold first request). This is a tiny
synthetic sample, not evidence of calibrated confidence, lower end-to-end call
latency or better Prosper scores. The benchmark reports selected probabilities
separately from TypeSafe's provider-specific confidence.

The account accepted Gateway authentication but rejected the paid
`zeroDataRetention` option with HTTP 403. The synthetic benchmark therefore does
not request ZDR; **no real patient data was sent**. Review retention/privacy and
account permissions before any live integration. Do not silently downgrade a
live-data request's privacy settings.

Jev may help classify short non-sensitive intent/correction signals, behind a
bounded optional decision layer. It must never replace exact patient matching,
API eligibility checks, confirmation guards or submission receipts. Whether all
required actions were accepted is already deterministic code; a probability
should not decide that. Jev produces typed decisions, not spoken responses or
free-form completions.
