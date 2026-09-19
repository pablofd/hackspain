# Cachopo - Foundry voice receptionist

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

The `/ws` agent can send `/submit/*` actions for the actual `start.callSid`.
These endpoints report what the agent would do; Prosper's underlying EHR is
read-only. HTTP 200 acknowledges an action, **not** a passing judging result.
Practice runs still need to be started from the Prosper dashboard. Connection
checks explicitly disable submissions, including when using `--voice`.

## Booking safeguards

The tool layer keeps state per call, separate from the language model:

- `find_patient` requires a unique match on at least two supplied fields before
  allowing patient-specific operations. Full name plus DNI/NIE is sufficient.
  Stored national IDs, phone numbers and birth dates are not returned to the model.
- `search_availability` searches from the day after the call in Europe/Madrid,
  paginating within the API's 14-day limit. `date_phrase` resolves the published
  English vocabulary and common Spanish/Catalan equivalents deterministically.
  It respects dates, site, doctor,
  weekday, morning/afternoon and explicitly requested language. It never offers
  same-day slots. A second insurance plan is used only when explicitly supplied
  from the caller's statement.
- `prepare_action` builds the action from a returned slot or an upcoming
  appointment. It cannot invent a provider, appointment type, minute or plan.
  It does **not** submit anything.
- The agent reads the proposal aloud and waits for explicit caller confirmation.
  `confirm_action` is rejected in the proposal's own turn. New searches invalidate
  that request's unconfirmed booking proposals, not a different patient's or
  specialty's draft. `confirm_actions` validates a group of proposals before
  sending its individual actions. The voice path waits for the completed current
  caller transcription and a brief stable-turn interval; an explicit condition
  or request to check an alternative blocks submission. The model still interprets
  consent: this is a rejection guard, not proof of consent from a classifier.
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

Public geography is cached and external requests are rate-limited. Timeouts,
malformed data and service limits are explicit errors; a geocoding outage is
not `no_availability`. The returned `origin_id` is local to the call and can be
used as `nearest_origin_id` in availability. A closer site without eligible
appointments is skipped; patient/provider/site/time/plan constraints still apply.

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

Generate a private token for our WebSocket endpoint:

```sh
npm run configure
# If the Azure endpoint is not in either environment file:
npm run configure -- --endpoint https://your-resource.openai.azure.com
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
Do not start **Run All** to debug connectivity. Start with one booking case and
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
Only consider Run All after a successful practice; do not assume an alternate
tunnel repairs a run attribution/settlement failure. Do not change the voice
model, runtime instructions or concurrency limit during the ingress comparison.

## Private call records

On the Linux VM, call transcripts/actions are recorded by default under
`.local/calls/`, which is ignored by Git and never served over HTTP. Directories
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
