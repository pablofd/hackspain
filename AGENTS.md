# Cachopo: agent engineering guide

Read this file before changing the voice agent. It summarizes the Prosper
documentation supplied on **2026-09-18** and the failures actually observed.
It is a contributor guide, not the runtime system prompt: update
`src/receptionist.ts` and regression tests when changing the agent's behavior.

## Goal and sources

Build a reliable voice receptionist for Clinica Arenal: identify the patient,
resolve the request using the clinic API, and submit the exact final action.
A plausible conversation without a submitted record always fails.

Authoritative references:

- [Problem set](https://hackspain.getprosperapp.com/leaderboard/docs/problems)
- [Scoring](https://hackspain.getprosperapp.com/leaderboard/docs/rules)
- [Clinic](https://hackspain.getprosperapp.com/leaderboard/docs/clinic-api)
- [Call contract](https://hackspain.getprosperapp.com/leaderboard/docs/contract)
- [Quickstart](https://hackspain.getprosperapp.com/leaderboard/docs/quickstart)
- [Normalization](https://hackspain.getprosperapp.com/leaderboard/docs/scoring)
- [Live OpenAPI](https://hackspain.getprosperapp.com/api/openapi.json)

The official pages can change during the event. Reconcile changes explicitly;
do not silently retain obsolete rules or infer missing deadlines/weights.
Never embed a public case's patient identifiers or expected answer in production
code. Use synthetic fixtures and normal API lookups instead.

## Repository map and workflow

| File | Responsibility |
| --- | --- |
| `src/azure-realtime.ts` | Azure OpenAI Realtime connection, audio, turns, transcription and tool dispatch. |
| `src/azure-live.ts`, `src/live-transcript.ts` | Isolated experimental GPT-Live connection, Responses delegation and conservative fragment-based confirmation guards. |
| `src/voice-provider.ts` | Explicit connector selection and independent model/gain profiles; no automatic fallback. |
| `src/prosper-runs.ts`, `scripts/prosper-runs.ts` | Explicit problem-specific scored admission, read-only console monitoring and sanitized private run snapshots. |
| `src/prosper-dashboard.ts`, `src/score-automation*.ts`, `scripts/prosper-auto.ts` | Opt-in score selection, protected dashboard reads, persistent single-owner admission and public diagnostic batches with an explicit review barrier. |
| `src/receptionist.ts` | Runtime instructions, tool schemas, verified patients, slots, proposals, confirmations and outcomes. |
| `src/prosper.ts`, `src/prosper-types.ts` | Authenticated clinic/submission requests, runtime schemas, receipts and normalization. |
| `src/scheduling.ts` | Deterministic Madrid date phrases, date windows, age, closures and site openings. |
| `src/clinic-routing.ts` | Catalogue-based doctor/specialty resolution and published complaint/red-flag mapping. |
| `src/confirmation.ts` | Current-turn transcription/stability checks rejecting explicit qualifications before confirmed writes. |
| `src/registration.ts` | Call-local incremental registration fields, missing/invalid-field guidance and correction revisions. |
| `src/geography.ts` | Validated public-address lookup and straight-line site ranking; no patient data to geocoding services. |
| `src/server.ts`, `src/protocol.ts`, `src/audio.ts` | Authenticated `/ws`, authoritative call ID, isolated sessions, bounded queues and interruption playback. |
| `src/config.ts`, `.env.example` | Configuration without exposing secret values. |
| `src/call-records.ts`, `src/call-audio.ts`, `src/telemetry.ts` | Private local transcripts/optional WAV recordings versus sanitized operational telemetry. |
| `src/dashboard/`, `scripts/dashboard.ts`, `dashboard/` | Independent authenticated clinic-read-only adapter, platform UI and opt-in isolated browser voice demo; no production call or submission changes. |
| `test/` | Offline Node tests with synthetic patients and fake upstream responses. |

- Keep TypeScript strict; use Zod for untrusted tool arguments and API responses.
  Reuse `AppError` for safe error codes and `withSpan` for explicit traces.
- The runtime is Node.js 24+, ESM, Azure OpenAI Realtime. Jev/AI Gateway is not
  enabled in live calls. `scripts/check-jev.ts` is an opt-in synthetic benchmark
  only; do not introduce a live provider merely to fix a deterministic workflow.
- `VOICE_CONNECTOR=live` is a separately authorized GPT-Live experiment, not a
  modification of `src/azure-realtime.ts`. Its voice deployment and Responses
  backend use the same Azure resource with independent configuration.
- Preserve the working Azure protocol and mu-law audio configuration. Do not
  mix preview and GA event schemas without an explicit integration change.
  `VOICE_OUTPUT_GAIN_DB` is an optional 0-12 dB output-only level adjustment;
  default 0 preserves bytes. It must preserve 160-byte frames, silence, polarity,
  pacing and truncation timing. Use `npm run configure -- --output-gain-db N` only for a
  measured receiver-compatibility experiment; it is not proof of a harness defect.
- Run the smallest relevant tests, then `npm run typecheck` and `npm run build`.
  `npm test` runs the complete offline suite.
- `npm run check:connections -- --voice` invokes paid Azure inference but must
  never submit actions to Prosper. Intercept every POST when evaluating model
  behavior with synthetic call IDs; never send invented IDs to the real API.
- Do not launch Practice or scored calls without the user's request. Debug with
  synthetic/offline cases first, then one requested public practice case.
  `npm run prosper:score -- --problem ID` requests one private scored call;
  the old Run All batch command is no longer supported. Read-only
  `npm run prosper -- list|status|watch` never admits a run. Honor the single
  queued/active team slot and global 5-minute scored cooldown after completion.
  A lost admission response is uncertain: inspect the run list, never
  automatically repeat the POST. Stopping a watcher does not cancel its run.
- `npm run prosper:auto -- run` is separately opt-in and admits real calls.
  Its dashboard session must remain private (`0600`) and match the API key's team.
  On a scored failure, finish the whole public category before reviewing the
  local evidence. The coordinator exits at `review_required`; it does not
  autonomously modify or deploy the voice agent. Resume only with the matching
  failure ID and an explicit reviewed/deployed revision, or a justified
  `no_local_change` decision. Preserve uncertain admission journals and do not
  steal another coordinator's lease or adopt/cancel external runs.
- Before restarting the active server, check `/healthz` and wait for calls to
  finish. Building `dist/` does not reload an already-running `npm start`.
  Preserve the tunnel and token; do not reset unrelated VM processes.
- Browser voice demos must use the independent authenticated dashboard bridge,
  server-generated `demo-...` IDs, `allowSubmissions: false` and its GET-only
  Prosper transport. Never expose the production voice token or forward a
  browser-controlled `start`/call ID to the production `/ws`. Tickets are
  short-lived, one-use and origin-bound; one demo at a time and three minutes
  maximum. No model runs on page load and no demo enters real records/scoring.
  Ordered `clear` is opt-in for browser playback; keep production defaults.
  Distinguish real observations, explicitly illustrative UI data and paid
  Azure voice. Do not hide a live source error behind unlabelled sample data.
- Update **Error history and lessons learned** below for each investigated
  failure. Record evidence, cause, correction, regression and remaining limits.
  Distinguish a local fix, an accepted API receipt and a passing judge verdict.

### Experimental GPT-Live profile

- `npm run start:live` selects the Live connector explicitly.
  `npm run start:realtime-1.5` restores the original deployment; the
  `start:realtime-2` preset is a later, separate deployment experiment.
  None of these commands stops an existing process. Check zero active calls,
  stop only the voice server and preserve the tunnel and endpoint token.
- `npm run configure -- --voice-connector live|realtime` persists selection for
  `npm start`. Defaults are `gpt-live-1`, backend `gpt-5.4-mini`, voice `coral`.
  Live output gain is independently configured by `VOICE_LIVE_OUTPUT_GAIN_DB`
  (default 0); do not carry a measured Realtime gain into Live by assumption.
- The Live WebSocket uses `/openai/v1/live/sessions` without the preview query.
  Native PCMU/8000 and coral were accepted by the deployed Azure model despite
  an older Azure guide describing PCM-only input. Validate `session.started`;
  never forward a different codec as mu-law or silently fall back to Realtime.
- Send real-time input silence between caller frames. There is no Live
  audio-done or authoritative caller-turn-completed event. Preserve caption
  fragments, repetition and timestamp ranges privately; do not deduplicate words.
  New captions invalidate stale work. Confirmations require a later known Live
  delegation, stable explicit approval and the existing receptionist guards.
- Read functions from nested `response.output_item.done`, not terminal
  `response.output` (which is empty). Azure continuations can begin with
  `response.in_progress` without another `response.created`. Correlate lifecycle,
  delegation and call IDs, return each result and explicitly continue once.
- Backend completion is not spoken completion. The existing bounded audio queue
  and silence tail remain; Live interruption notices are not authoritative
  provider-audio truncation. Do not send preview cancel/truncate events to Live.
- Close with `session.close`, wait up to 15 seconds for `session.closed` and final
  cumulative usage, and explicitly report missing finalization. Already-confirmed
  POSTs may finish; disconnects must never authorize new writes.

## Scoring: current rules, not the earlier 49-point version

The latest supplied rules use:

```text
points = sum(min(4, pooled passed scored calls for each problem) * that problem's weight)
```

There are 18 problems, 17 scored, at most four credited passes per problem.
Weights are 1-5. Full-roster maximum: **196 points** across 68 credited passes.
The old pass-fraction formula and maximum of 49 are obsolete.
The former best-Run-All rule was replaced during 19 September: scored calls
now pool across all runs. Historical observations below retain their original
run results; do not recompute or mislabel them as the current scoring rule.

- A case is binary: its complete action list must match an acceptable outcome.
  No partial credit for correct fields, nearly-correct IDs or one of two actions.
- Multiple tied earliest providers can be valid. Do not invent tie-break rules
  that override the patient's constraints.
- The board pools judged scored calls, capped at four credited passes per
  problem. A new failure cannot remove already banked points.
  Public practice never scores. Public answers move with the day's date anchor.
- Problems open progressively; one scored run targets one open scored problem.
  Scored cooldown is 5 minutes after completion and global across problems;
  this replaced the earlier 12-minute value during 19 September. Practice has
  a separate 30-second cooldown, but both lanes share one active team slot.
  The supplied snapshot had problems 1-6 open (2 remains unscored).
- Maximum three minutes per call. Slow connection or no audible agent audio
  can end it sooner. Streaming silence is not an answer. Do not raise the
  time limit to disguise conversational loops.
- Private-case answers are never published. While scoring is open, private
  feedback is limited; use public practice for transcript/field-level debugging.
- Freeze: 2026-09-20 06:00 Europe/Madrid; the run must have finished by then.
  Private recordings reveal: 2026-09-21 00:00 Europe/Madrid.
- Jury evaluation is separate: experience, personalization, platform,
  boundaries, languages and engineering. Do not assume an unpublished 50/50
  split or that a chosen model earns points by itself.
- A spoiled harness call may be redialled once with a NEW call ID before
  judging. Treat it as a new independent call. Confirmed harness/mixed failures
  void individual cases; a whole run is void only when all cases are void.
  Do not attribute a fault to Prosper without concrete evidence.

## Transport, authentication and submission contract

Prosper connects to our public WebSocket; no Twilio account or phone number is
needed. An SSH local forward is only for the user's PC, not the evaluator.

- Messages arrive as `connected`, `start`, `media`, `stop`.
- Use **exactly `start.callSid`** for every submitted `call_id`. Do not let the
  model invent it. `start.customParameters.call_id` is a redundant copy.
- `from_number` is a lookup hint, not identity: the caller may be a relative,
  or caller ID may be absent. Verify the patient independently.
- Audio: mono G.711 mu-law, 8 kHz, 20 ms / 160-byte frames, base64 payloads.
  Twilio keys are camelCase; sequence/chunk/timestamp fields are strings.
  Submission bodies use snake_case.
- A fresh conversation, tool state, recording, queues and call ID belong to
  each socket. Legacy batch runs used concurrent sockets; current scored runs
  dial one private case. Switchboard still exercises up to 20 independent calls.
- Barge-in is ours to implement. `clear` currently has no effect at Prosper:
  discard local queued audio and keep model context aligned with sent audio.
- `VOICE_ENDPOINT_TOKEN` protects inbound calls. `PROSPER_API_KEY` authenticates
  outbound requests via `X-Api-Key`. Azure credentials are a third, separate role.
- Saving Prosper Integration replaces BOTH endpoint and headers. Header values
  are write-only: paste the real Authorization line again when saving; an empty
  box removes it. Runs snapshot the endpoint/config at admission.
- Dashboard login is distinct from the clinic API key. Never infer that a
  successful clinic request grants run-management access.
  The separately verified programmatic `GET /api/v1/runs`, run-detail and
  `POST /api/v1/runs` accept the team key; new scored requests select
  `{"lane":"scored","problem_id":"..."}` rather than a batch. Legacy
  authenticated `/leaderboard/api/*` routes use a browser
  session. The current clinic OpenAPI omits the run routes, so reconcile the
  published quickstart and actual authorized responses rather than inventing
  endpoints or reusing dashboard credentials.

The EHR is read-only. `/submit/*` reports a proposed write; it does not reserve
a shared slot or create a patient ID that can then be booked.

| POST suffix under `/api/v1/submit/` | Body besides the authoritative `call_id` |
| --- | --- |
| `book` | `patient_id`, `provider_id`, `location_id`, `appointment_type_id`, `slot`, `policy_id` |
| `reschedule` | `appointment_id`, `provider_id`, `location_id`, `slot`, `policy_id` |
| `cancel` | `appointment_id` |
| `register` | `given_name`, `first_surname`, `second_surname`, `national_id`, `date_of_birth`, `phone`, `email`, `insurer` |
| `no-action` | `reason` |
| `escalate` | `reason` |

One POST is one action. Multiple actions accumulate. Unconfirmed proposals may
change; accepted actions cannot be replaced or undone through this API.
Register demographics are flat in the POST, nested under `new_patient` in the
record readback. The model's internal tool-control fields must not leak into
the submission body.

The window closes 30 seconds after the socket closes. `200` means received,
not correct; `409` means the identical action was already accepted; `404`
means an unknown/other-team call; `410` means too late; `422` means invalid.
Retry uncertain delivery only with the identical payload. Surface errors,
never return a success-shaped fallback. Do not submit default outcomes on
hang-up or infer consent from a disconnected caller.

Prosper requests have a 60-second timeout; reads still abort with the call.
An already-confirmed submission shares one 60-second budget across its initial
attempt and identical retry. Call abort or cleanup additionally caps that
operation at 28 seconds after the first close notification, never extending its
original deadline. This is not permission to start an unconfirmed write, reset
the grace period or extend the 180-second voice call.

## Clinic invariants

- The fixed catalogue has 3 sites, 12 providers, 6 specialties, 11 appointment
  types and 10 plans. Cache catalogue data; do not share conversation state.
- `/directory` exact fields filter rather than downrank. Full name plus one
  corroborating DNI/NIE, phone or birth date is sufficient for our lookup.
  A near-miss DNI can identify someone else; never rely on it alone.
  If an unverified lookup lacks a usable full name, clarify that name before
  cycling through more identifiers. Reuse a supplied corroborator; never supply
  the stored name as the caller's answer. This guidance does not relax verification.
- Use API IDs, not a caller's guessed name or the model's recollection.
  Ask about ambiguous provider names instead of guessing a specialty.
- Availability applies eligibility only with the verified `patient_id`.
  `blocked` provides actual refusal reasons, even when there are no slots.
  Empty `slots` plus empty `blocked` means full calendar, not lack of coverage.
- Use each slot's exact `appointment_type_id`. Specialty-specific types outrank
  universal `first_visit`/`review`; matching duration does not imply matching ID.
- Only upcoming IDs from `/patients/{id}/appointments` can be cancelled/moved.
  `when=past`/`all` is useful context, not permission to modify history.
- Primary insurer is on file. A second plan can only be learned from the caller.
  Query it explicitly with repeated `insurer` parameters and submit the correct
  `policy_id`. `privado` is a held plan, NEVER a suggested/default fallback.
- Adeslas does not cover gynaecology. ASISA cannot satisfy physiotherapy's
  combined specialty/site constraints. DKV can redirect from Iglesias to Vilar.
  Use current API evidence, not hard-coded exceptions in production.
- Requena's published leave is 14-30 September. Saez/Saenz and
  Iglesias/Iglesia are ambiguous pairs. Alvaro Cid is a physiotherapist, not Dr.
- The age boundary for general practice versus paediatrics is the 14th birthday,
  expressed in months. Referrals and plan-specific allowances matter.
- The bookable calendar is 2026-09-07 through 2026-10-16; each availability query
  spans at most 14 days. Slot grid: 15 minutes. No same-day bookings.
- Resolve dates against call start in Europe/Madrid, not the machine's zone.
  A weekday phrase means the next such weekday strictly after the call date.
  Morning is before 14:00; afternoon starts at 14:00.
- Only Centro opens Saturday, none open Sunday, Sur shuts Friday lunchtime,
  and all sites close 12 October. Negotiate the next open day while preserving
  stated site/time preferences.
- Notes/history personalize a call but never override the caller's explicit
  request for the earliest slot or another doctor/site.

### Runtime workflow controls

- Use `resolve_request` for names and complaints. Ambiguous/uncertain names
  must be clarified; emergency results block appointment preparation and
  confirmation. The symptom mapping is deliberately bounded to the challenge:
  an unsupported routine complaint must not lock a patient's explicit named
  specialty/provider request. Only unresolved possible emergencies create a
  safety block; actual eligibility still comes from the clinic API.
- Send colloquial dates as `date_phrase`; do not precompute them in the model.
  A location's published `hours` lists OPEN weekdays, so missing weekdays are
  closed when the hours field is present. Absent hours are unknown, not a
  license to invent opening times.
- A request has its own `request_id`, patient and constraints. Reuse that ID
  for corrections, alternatives and insurer changes. `relax_constraints` lists
  only caller-approved changes. `new_request:true` is an additional intent,
  never a replacement for an accepted action.
  Relaxation removes the old value only when no replacement was supplied;
  an explicitly requested new provider/site/date/time/weekday/language wins.
- `revise_request` discards unconfirmed slots/proposals; an identity correction
  uses `find_patient.replaces_patient_id`. `get_call_state` recovers known
  patients and outcomes without repeated interrogation.
- Prepare before reading the final offer. `confirm_actions` can submit multiple
  proposals after a new caller turn explicitly agrees to ALL their details.
  Every proposal is checked before starting the first POST; a later network
  failure can still leave a partial multi-action record because the API is not
  transactional. Never hide that failure or resend a different payload.
- For a later RESCHEDULE, choose a verified upcoming appointment from
  `list_appointments` and use its `later_search`/`after_appointment_id`.
  The anchor supplies the actual doctor/site and excludes slots at or before
  the original instant. Do not invent a first-search request ID or reinterpret
  an unanchored "later" from today. Reuse the returned request ID after a
  correction; preserve doctor/site unless the caller explicitly changes them.
  These slots cannot prepare BOOK or move a different appointment. Earlier
  moves remain ordinary RESCHEDULE searches without the later-only anchor.
- For a BOOK search, `prepare_booking:true` can return an unsubmitted
  `booking_proposal` for the earliest slot with one eligible held plan. Read that
  exact proposal, then confirm after the caller's later agreement; do not prepare
  it again merely because the caller said yes. Ordinary/RESCHEDULE searches and
  multi-plan choices retain explicit preparation. Identical still-proposed
  payload/scope/revision reuse is idempotent, not permission to backdate a new,
  changed, re-searched or separate-intent offer.
  If no proposal was requested, `recommended_slot_id` still identifies the
  earliest eligible option. Offer that one first instead of an unsolicited menu;
  a caller's explicit different-time preference must still be honored.
- Wait for the complete latest caller turn before confirming. A "yes, but..."
  or an unresolved price question or request to check other times is not final consent. Audio transcriptions
  are associated with their VAD item/turn; an old transcript cannot approve a
  newer turn. This is a conservative rejection guard, not a consent oracle.
  An affirmative followed by "Does the clinic have appointments outside working
  hours?" is still an unresolved availability question even without "but/check".
- Explicit new registration starts `collect_registration`, not repeated
  existing-patient verification. Retain caller-provided fields, ask only the
  next short missing-field group, and never default the insurer. A ready draft
  is prepared before its final readback; corrections invalidate its old proposal.
  Duplicate detection still occurs before preparation, and REGISTER still
  requires a later consenting turn and never creates a bookable patient ID.
  After a correction, repeat the changed/unclear fields and acknowledge that the
  others are unchanged, rather than restarting the whole summary. An unfinished
  correction is not a reason to recite a menu of all possible fields.
  Ask for the held insurer, not a spoken enumeration of the plan catalogue.
- For an empty exact-date search, `next_day_search`/`advance_day` moves relative
  to that searched date. Do not reuse "tomorrow" against a different anchor or
  claim to have checked the following day when the resolved window is unchanged.
  A pure calendar gap can also return `next_window_search`, requiring approval
  to broaden to later dates while retaining all other constraints. This is not
  proof that other dates/sites are full and not an insurance exclusion. Never
  execute that alternative automatically or ask for a second plan merely
  because the requested window has no slots.
  Empty results may include bounded, request-scoped `previous_options`. They
  are historical observations, not usable slot/proposal IDs: recheck a selected
  option with its explicit date/filter arguments, match its exact time/type and
  obtain fresh confirmation. A later empty day cannot justify refusing a caller
  who selected an earlier known offer.
- Coverage evidence and held plans are scoped to their patient/request. Scope
  `report_outcome` with `request_id` in multi-intent calls; a different patient's
  earlier successful action must not erase a genuine refusal for this request.
- `locate_origin` resolves a public street/place plus municipality through
  CartoCiudad, then issues call-local candidates/origin IDs. Never send names,
  DNI, phones, full conversations or apartment/resident details. Ambiguity is
  clarified; no geocoder failure becomes a guessed location or a booking refusal.
  The geocoder currently covers Madrid province and enforces rate/time limits.
- Generated output from interrupted response generations is discarded. Keep
  output pacing and truncation tied to actual sent audio, not generated bytes.
  A completed speech item gets at most four seconds of paced mu-law silence so
  a downstream VAD can finish its audio-clock turn. This is not an endless idle
  stream or audible speech, and must not increase Azure's truncation offset.
  New speech preempts that tail; interruption discards it.
  Buffered nonzero samples alone are not proof that the caller is speaking:
  startup noise gets a single bounded 500 ms VAD grace, not indefinite greeting
  suppression. An actual speech-start event still cancels the opening.
  A first playback-buffer overflow cancels/truncates the excessive response and
  permits one concise recovery in that caller turn; repeated overflow still
  fails explicitly. Do not raise the queue bound or the call deadline. Truncate
  every discarded audio item, including wholly unheard queued items at zero,
  and preserve already accepted actions rather than replacing them on retry.
  The caller may pause eight seconds; do not introduce a short local silence
  deadline or lengthen the overall three-minute limit.

### Refusals are actions

Never end a final refusal with only spoken text.

1. Verify the relevant patient/request and obtain the actual clinic restriction.
2. Check a viable redirect or second held plan where relevant. Ask once, not
   repeatedly. "I only have this plan" resolves the second-policy question.
3. Call `report_outcome` with `NO_ACTION` and the actual reason BEFORE the final
   refusal/goodbye. For unresolved single-plan insurance refusals, include
   `no_other_policy:true` only after the caller explicitly rules out another plan.
   That answer resolves only the policy question: a same-turn request for
   another provider, site or time must be resolved before an immutable refusal.
4. Wait for `accepted`/`duplicate`, then explain briefly and close politely.
   Do not invent private payment, insurer authorization or external coverage.

`search_availability.no_booking` provides the candidate reasons and next tool,
not an automatically submitted outcome. New lookups invalidate old refusal
evidence. A successful alternative must book rather than reuse a stale reason.
Refusals do not require the booking-style extra confirmation turn.
Fresh refusals do check the completed current turn for unresolved changes;
identical accepted/pending/uncertain retries and urgent escalation do not gain
a new confirmation requirement. Published coverage is not a copayment quote:
the current catalogue/slot API supplies no monetary amount. Do not promise
zero cost or relabel voluntary price-related deferral as lack of authorization.

Reason vocabulary (keep aligned with OpenAPI):

```text
not_eligible_age, referral_required, provider_not_in_network,
specialty_not_covered, location_not_covered, insurer_referral_required,
allowance_exhausted, provider_on_leave, location_hours, type_not_offered,
patient_history, no_availability, clinic_closed, patient_not_found,
provider_not_found, caller_not_authorised, out_of_scope, medical_emergency
```

## Problem-by-problem reference

| # | `problem_id` | Weight | Required behavior / common trap |
| --- | --- | --- | --- |
| 1 | `simple_booking` | 1 | Earliest eligible BOOK from tomorrow; obey site/weekday/time constraints; use API visit type. |
| 2 | `switchboard` | none | 5/10/20 independent calls; diagnostic only, refused by the scored lane. |
| 3 | `doctor_and_site` | 2 | Resolve doctor ambiguity/leave/nonexistence; a fallback must preserve specialty AND site. BOOK or justified NO_ACTION. |
| 4 | `the_new_patient` | 2 | REGISTER only, all demographics correct; never append BOOK without a patient ID. |
| 5 | `when_exactly` | 2 | Resolve the documented relative dates, openings and closure day; BOOK at the exact minute. |
| 6 | `the_rules` | 3 | Actual age/referral/coverage rule determines NO_ACTION or a valid redirected BOOK. Includes an eligible control case. |
| 7 | `no_slot_free` | 2 | Negotiate allowed alternatives; otherwise explicitly submit NO_ACTION(no_availability). |
| 8 | `change_and_cancel` | 2 | Look up upcoming IDs; RESCHEDULE or CANCEL; two cancellations mean two requests. |
| 9 | `third_party` | 3 | Identify and book the patient, not the relative who calls and supplies their own details first. |
| 10 | `triage` | 3 | Map published complaints to specialty; published red flags require ESCALATE(medical_emergency), no booking. |
| 11 | `languages` | 3 | Follow language switches; apply requested provider-language constraint. Private cases include more Catalan. |
| 12 | `noise` | 3 | Same booking logic under noisy audio; confirm uncertain names/digits instead of guessing. |
| 13 | `difficult_caller` | 4 | Respect the FINAL request, corrections, interruptions and long pauses; do not submit stale drafts. |
| 14 | `adversarial` | 4 | NO_ACTION(out_of_scope) and no protected DNI/phone disclosure, including digit-by-digit speech. |
| 15 | `nearest_site` | 3 | Nearest site that can SERVE the request, using straight-line distance and published coordinates. |
| 16 | `the_questions` | 3 | Ground clinic answers in the catalogue; wrong facts alter what the caller requests and can make BOOK impossible. |
| 17 | `second_policy` | 4 | Ask for another held plan if needed; use it in availability and `policy_id`. Never invent one; includes a primary-plan control. |
| 18 | `the_real_call` | 5 | Multiple difficulties and intents; submit the complete correct multi-action list with isolated patient state. |

Triage is the published challenge mapping, not general clinical decision-making:
ankle/arm/knee/wrist injury -> orthopaedics; child fever/cough/ear/tummy complaints
-> paediatrics; persistent fatigue/headache/throat/dizziness -> general practice;
heavy/irregular periods, intermenstrual bleeding or persistent low pelvic pain
-> gynaecology. Do not invent additional medical advice.

Published emergency patterns: chest pain with breathlessness; sudden facial
droop/arm weakness/slurred speech; sudden severe breathlessness; bleeding that
does not stop after pressure; head injury followed by confusion/vomiting.
Escalate rather than schedule these.

## Privacy and observability

- `.env.local`, `.env.lang`, `.local/` and `.tools/` stay outside Git. Never print
  secrets or add raw patient transcripts to this file, fixtures or public issues.
- Local NDJSON records may contain patient data. They are private Linux files
  with protected paths, mode 0600, secret redaction and conservative retention.
  Raw files are not served by HTTP or exported as telemetry. At the user's
  explicit request (19 Sep), the independently authenticated dashboard may
  project a selected synthetic challenge call's transcript: speaker, text,
  event timestamp, item ID and recorded partial/model timing fields only.
  Keep it out of bulk snapshots; bound it to the recent 200-file/history window,
  500 entries and 256 KiB of projected entries. Preserve credential redaction,
  same-origin/no-store controls and text-node rendering. NDJSON/WAV downloads,
  raw paths/tool bodies and unapproved third-party transcript analysis remain prohibited.
  Cancel pending reads on selection changes/disposal/disconnect and reject
  stale responses; display missing records and source errors without synthesis.
- At the user's subsequent explicit request, real-mode selected-call signals
  may use bounded, identifier-filtered text with the existing Azure resource.
  Keep this separate from the voice path: on-demand authenticated POST only,
  no tools/clinical writes, no background history sweep, finite input/output/
  deadline/cache/concurrency limits, and no automatic paid retry loop.
  Strictly validate caller evidence references; label scores as textual
  estimates and unknowns as null. Never claim measured emotions, calibrated
  confidence, audio quality, medical judgments or judge outcomes.
- Audio recording is separately opt-in via `CALL_AUDIO_RECORDING_ENABLED`.
  Companion WAV files preserve caller input and actually sent agent output on
  separate channels; they cannot redact spoken secrets. Keep them local/private,
  bounded, and under the same retention policy. Never treat local recordings as
  access to Prosper's private answer keys or publish them as test fixtures.
- Transcript snippets are not exact acoustic timing. Assistant text is generated
  audio; check interruption records before assuming all of it was heard.
  Interrupted assistant fragments can carry `partial:true` and are bounded to
  8,000 characters; correlate their item IDs with any later complete transcript.
  Interruption reasons distinguish caller speech, provider cancellation and local
  output-limit recovery. None of these text records proves remote playback.
  Failed search diagnostics retain only bounded, whitelisted date/filter fields
  in private records, never a raw argument dump or console/span export.
- Distinguish speech-to-text mistakes from actual spoken mistakes. Insurer-name
  misspellings in a machine transcript alone do not establish a model error.
- Application Insights export is separate from Azure inference. Console-only
  tracing does not mean model requests fail to reach Azure.
- To investigate runs, correlate UTC run/call IDs and API receipts. Health 200,
  WebSocket 101 and a POST receipt prove different things; none proves a pass.

## Error history and lessons learned

Add entries by problem/type. Keep them short and anonymized, with the evidence
and current validation status. Do not manufacture observations for untested
problems or promote a synthetic evaluation to a Prosper judge result.

| Problem/type | Observed failure and cause | Correction / regression / status |
| --- | --- | --- |
| Browser demo / proxy body framing (19 Sep) | Local admission passed, but the HTTPS preview returned dashboard_invalid_demo_request: the initial check rejected transfer-encoded requests even when their body was empty. | Validate the actual empty request body while still rejecting nonempty content, rather than rejecting a valid proxy framing mode. Empty/nonempty chunked regressions retain authentication, origin and no-inference-before-WebSocket checks. No production voice or clinic-write change. |
| Browser demo / repeated WebSocket upgrade (offline, 19 Sep) | Admission/reconnect tests exposed an upgrade listener accidentally registered once per HTTP request. A later connection received a second HTTP 401 after its 101 upgrade, causing an invalid WebSocket frame. No production or Azure call was used for this reproducer. | Register upgrade handling once per server. Tests cover repeated/replayed/expired tickets, concurrent admission, origin checks, forged IDs, audio bounds, ordered clear and cleanup. A separate short synthetic Azure greeting loopback then produced both generated voice and recognized input with zero clinic writes, zero real call records and no Prosper run. This is demo transport evidence, not a judge verdict. |
| Dashboard / requested transcript display (19 Sep) | The metadata-only dashboard intentionally showed a private-transcript placeholder, preventing the user's explicitly requested inspection of synthetic challenge conversations. This was a UI policy choice, not a voice or Prosper failure. | Added a separate authenticated, bounded selected-call transcript projection and safe text view, with credential redaction, partial/generated-text caveats, live refresh and stale-response cancellation. Synthetic API/browser regressions cover auth, unsafe/malformed sources, bounds, XSS text, updates and selection/session races; snapshots remain metadata-only and raw NDJSON/WAV stay private. No inference, submitted action, server restart or judge verdict is involved. |
| Dashboard metadata / inherited ACLs (19 Sep) | A first read rejected the existing owner-controlled records because the shared workspace adds named ACLs and expands permission-mask bits. The untouched backend's two exact-mode fixtures also fail under that inherited ACL, not because of the integration. | Read only a bounded whitelisted projection, retain owner/no-follow/link checks, surface additional source permissions and never chmod the voice process's files. Synthetic ACL coverage and real metadata reads succeed; the existing 28 recording regressions pass in an isolated fixture directory without inherited ACLs. No recording writer or voice behavior changed. |
| Dashboard integration / simulated observability (19 Sep) | The uploaded platform generated patients, sentiment, response timings, MOS and ASR scores, and offered controls with no backend implementation. Treating these as telemetry would misrepresent actual calls; a name-based map could also join unrelated patients. | Replaced demo imports with a separately authenticated read-only adapter, exact BOOK patient-ID links, source/error states and explicit unavailable metrics. Raw NDJSON/WAV and structured registration demographics remain private; selected transcript display was subsequently authorized as documented above. No new model inference or clinic writes. Offline projection/authentication/Monitor and synthetic browser coverage; a read-only Azure query returned real audio/token usage, while missing latency samples remain unavailable. No agent change or judge result is claimed. |
| `nearest_site` / exact address and postcode handling (private run, 19 Sep 20:36 UTC) | The updated flow passed two of four cases. Both remaining failures reached 180 seconds before consent/submission: one was offered different portal numbers and later rejected a postcode-bearing address; another was made to choose from fuzzy results despite an exact address being present. No provider failure was recorded in these two; passing calls also carried connection_lost. | Resolve only a unique fully matching address from validated point metadata, filter wrong-street/number distractors, preserve genuine ambiguity and normalize public postcode/municipality fields without weakening identifier/privacy guards. Synthetic regressions cover postal separators, metadata conflicts, bounds/cancellation and negative identities; controlled public-address reads resolve exact points without patient identifiers. No nearby-house/centroid substitution or unverified Find fallback; absent exact upstream coverage remains a limit. New judge validation is pending. |
| Identification / identifier field confusion (nearest-site follow-up, 19 Sep) | A failed call spent an extra exchange correcting the agent's claim that a supplied DNI was an incomplete phone. The old tool arguments are unavailable, but a synthetic reproduction confirms that a complete DNI in the phone field loses the usable lookup and is not verified. | Only checksum-valid DNI/NIE-shaped phone values are retyped as national_id without changing their value. Conflicting explicit IDs and bad letters fail before network; a repeated ID never becomes two factors, and normal phone/name verification remains. Correction diagnostics are value-free. Synthetic regressions pass; no private-case identity or guessed value is embedded. |
| `the_questions` / correct facts, no subsequent action (private run, 19 Sep 19:31 UTC) | One of four cases ended with missing_record. The caller asked which site opens Saturday; both successful catalogue reads and the generated answer identify the correct site/hours. The emitted agent channel contains the complete answer before the caller interrupts; an independent ASR check of only this public-facts audio corroborates it. The caller nevertheless abandoned without identity, a booking request or consent. No submission was attempted or failed. | No local factual defect is demonstrated, and remote hearing/private caller criteria remain unknown. Do not invent a default NO_ACTION or a booking to manufacture a record. Preserve the evidence and reproduce with a public case before attributing a platform/recognition fault. No patient audio or identifiers were sent in the isolated, write-disabled audio audit. |
| `nearest_site` / unfinished location-to-booking flow (private runs, 19 Sep 19:10 and 19:47 UTC) | The first four calls reached the three-minute limit with speech and a proposed BOOK but no confirmation/submission. One re-search invalidated its old offer without preparing a replacement; others stalled on address clarification or rejected candidate selections. Three later calls repeated those loops; a fourth independently failed with Azure output_timeout at 41 seconds. No geocoder transport error was recorded, and old logs lack exact failed arguments. | Candidates now return exact selection_arguments; edited query and missing/stale ID errors have distinct recovery guidance without relaxed binding. A nearest re-search invalidating an unconfirmed BOOK returns conditional fresh-offer guidance, never submission or consent reuse. Origin diagnostics are booleans/counts only. The catalogue has no entrances/floors/routes: do not invent them or re-geocode access questions. Synthetic regressions preserve read-only/reschedule behavior, held-policy choice and stale-offer rejection. The separate provider timeout is not fixed by this workflow change; new public validation remains required. |
| `wild_card` / extra refusal after cancellation (private run, 19 Sep 17:01 UTC) | The run passed three of four cases. The failed call explicitly confirmed an upcoming CANCEL, then asked about availability, declined the offered slot and deferred booking. The agent appended NO_ACTION(out_of_scope) to the accepted cancellation. Its availability lookup had slots; the courteous deferral was not an unsupported request. The private expected record remains withheld. | Extended the existing voluntary-deferral guard for common EN/ES/CA closings and clarified that an availability follow-up/declined offer must not create a farewell action after CANCEL. A synthetic regression first reproduced CANCEL plus the extra NO_ACTION, then requires exactly one cancel POST. Genuine separate unbookable intents retain request-scoped evidence rules; no call/patient/provider/slot IDs are hardcoded. Offline validation, not a new judge pass. |
| `adversarial` / privacy refusal reason (private runs, 19 Sep 16:06 and 16:38 UTC) | The first run had one record_mismatch and the second had two. All three failures accepted NO_ACTION(caller_not_authorised) for requests about another person's appointments/doctor or stored identifiers, without a scheduling operation. No clinic-read tool ran. One conversation also repeated identifier requests until the three-minute cap; its transport attribution remains inconclusive. | Shared prompt/reason-schema guidance and a conservative EN/ES/CA pre-submit guard distinguish privacy-only out_of_scope from genuine scheduling authorization failures. Recent disclosure context survives name/missing-ID follow-ups; new legitimate scheduling and accepted-action retries retain their behavior. Synthetic regressions reproduce the wrong POST and check the exact corrected payload; local transcript-window replay blocks all three observed wrong submissions without network writes. No private expected answer was accessed, no patient values were hardcoded, and a new public judge verdict is still required. |
| `no_slot_free` / approved alternative constraints (offline, 19 Sep) | A synthetic reproducer showed that combining relax_constraints with an explicit replacement erased the NEW doctor/site/date/time/weekday/language, widening the search instead of honoring the agreed alternative. The historical private failures cannot be attributed to this exact argument combination without their missing raw arguments. | Explicit replacements now survive relaxation; omission still removes the old constraint. Pure calendar gaps expose a permission-gated broader-window query and concise current-evidence no_availability guidance, without changing coverage/closure handling or anchored rescheduling. Regressions cover exact payloads, retained filters, fresh consent and stale-refusal rejection. No real call or judge result claimed. |
| `no_slot_free` / later-move closure (33/36 legacy run, 19 Sep) | Three final failures had no action receipt: two BOOK negotiation paths and one RESCHEDULE path. A direct agreement arrived around 175 s without confirm_action before the cap; another final offer arrived too late for a reply. The move used an invented request ID and unsupported relative dates, then re-asked known site information after a correction. Tool paths do not establish a private problem label or hidden expected answer. | Narrow change only: concise revised offers, confirmation dispatch before additional chatter, and opt-in later_search anchored to a verified upcoming appointment. Synthetic regressions preserve caller constraints, new consent after corrections, refusal evidence, normal BOOK, one/two cancellations with one grouped approval, and no new writes on hang-up. No model, audio, global confirmation/registration rules or 60s/28s limits changed. Validation is offline; no new judged or acoustic result is claimed. |
| Realtime 2.1 / call budget (local cohort, 19 Sep 09:42-10:21 UTC) | Of 23 recorded calls, 12 reached the local 180-second limit; five of those already had an API receipt. All 23 had incoming and outgoing signal, and every time-limited call had audio activity near the deadline. Five registration calls yielded two receipts at 179.9/183.5 seconds and three without a final receipt. | Dialogue/WAV/trace review completed privately; no judge mapping or model-controlled comparison is available. Propose shorter registration/correction readbacks and a remaining-time budget without skipping consent or extending the call. No runtime fix deployed by this review. A confirmed POST finishing in the post-close grace window is not itself invalid. |
| Clinic transport / slow responses (same local cohort) | Eleven requests expired at the client's approximately eight-second deadline: seven GET and four POST attempts. Two BOOK retries returned duplicate, proving prior receipt despite the lost/late acknowledgment; another action remained unknown. The original network exception was not retained, so server versus network/egress cause is not established. | Correlated UTC windows and call IDs remain only in private reports. The subsequent user-authorized trial raises requests and the total confirmed-submit budget to 60 seconds, capped at 28 seconds after close. Mock-clock regressions cover long successful waits, exact deadlines, immediate read cancellation, shared retry budgets, close/abort ordering and call isolation. No new judge result or other dialogue fix is claimed. |
| Outcome classification after API errors (same local cohort) | Two ordinary booking requests were incorrectly mapped to NO_ACTION(out_of_scope) after availability errors. One was accepted and the other had uncertain delivery. Technical unavailability did not justify the business reason. | Confirmed dialogue/state defect, not a justified clinic refusal. Extend current-request evidence checks to prevent technical-error reason substitution; retain uncertainty and never replace an uncertain payload with another action. Correction and synthetic regression remain pending; no private patient values belong in fixtures. |
| Azure voice failure after receipt (same local cohort) | A booking was accepted at about 133 seconds, followed by azure_response_failed_output_timeout at about 146 seconds. The transcript supports the booking confirmation; the subsequent voice failure does not establish a missing record or Prosper failure. | Record delivery and voice completion separately. Consider bounded voice-only recovery without repeating writes; no recovery change deployed. The API receipt is not an official case verdict. |
| GPT-Live protocol / isolated adapter (synthetic Azure, 19 Sep) | The Live deployment rejected the Realtime operation. On its own endpoint, the first real delegated tool succeeded, but a continuation omitted response.created and the adapter rejected its terminal ID as unknown. | Separate Live endpoint/profile leaves the Realtime connector unchanged. Track response.in_progress as well as response.created, with an offline continuation regression. A real Live read-only conversation completed a fake catalogue lookup, backend continuation, nonzero audio and confirmed close; no Prosper request or judge result. |
| GPT-Live booking / delegated intent (synthetic Azure, 19 Sep) | A spoken appointment request with name and birth date incorrectly entered collect_registration without any request to register. The delegated backend selected the wrong workflow; this was not a clinic API refusal or Prosper failure. | Explicit booking-versus-registration guidance in both Live and backend instructions; shared receptionist/identity checks unchanged. Replaying the same synthetic audio through the real local /ws pipeline produced the exact intercepted BOOK after spoken readback, later approval and a new delegation; final speech and session close completed in about 69 seconds. One invented request ID was explicitly rejected and recovered. All clinic routes were fake; this is not a Prosper judge pass or full case coverage. |
| `the_rules` - single-plan coverage (practice, 18 Sep 21:30 UTC) | Expected NO_ACTION(specialty_not_covered), submitted nothing. The agent explained the exclusion, heard that there was no second plan, then offered speculative private payment and ended. Local metadata shows successful find_patient/get_clinic/search_availability but NO report_outcome call. | Structured no_booking guidance; mandatory report before farewell; explicit single-plan answer; no private-pay fallback; current-query evidence only. Regressions are in `test/receptionist.test.ts`. Two synthetic Azure refusal conversations and one second-policy booking produced the expected intercepted actions, with no real Prosper requests. A new Prosper verdict is still required. |
| `simple_booking` - original skeleton | Conversation worked, but Missing record because the read-only prototype had no submission tools. | Separate lookup, proposal and confirmed POST; use authoritative callSid. Exact payload and no-early-submit regressions exist. API acknowledgement is not a judge pass. |
| Identification / tool arguments | The voice model asked for a third identifier despite name + DNI, and emitted lowercase action verbs that failed the tool schema. | Name plus ONE corroborating field is enough; retry the lookup before asking more. Normalize verbs only, never IDs. Covered by lookup/action-case regressions. |
| `when_exactly` - coverage gap found in code review | Relative-date interpretation was left to the model. A first implementation treated omitted weekday rows as unknown, but the actual catalogue omits closed days. No judge failure is attributed to this without a practice verdict. | Deterministic EN/ES/CA date parsing and caller-approved closed-day movement. Scheduling regressions cover Madrid midnight/DST, same-weekday +7, closure dates and exhaustive open-weekday arrays. |
| `doctor_and_site` / `triage` - coverage gaps | Names and complaints previously relied only on prompt text. Integration tests caught two near-verbatim published symptom phrasings missed by the initial parser. | Catalogue-only name/specialty resolution, ambiguous short surnames, leave/site-preserving alternatives, and tested positive/negated/uncertain symptom routing. Synthetic Azure emergency dialogue submitted an intercepted ESCALATE, not a real judge result. |
| `the_real_call` / `difficult_caller` - shared intent state | Code inspection found patient-wide draft invalidation and a call-wide refusal gate, which could interfere with separate intents. | Request-scoped proposals/evidence; corrected identities and constraints invalidate the appropriate draft; grouped confirmation; per-patient held plans. Synthetic tests cover separate patients, corrections and two cancellations; Azure dialogue produced two intercepted CANCEL actions. |
| `nearest_site` - missing workflow | No deterministic origin resolution or eligibility-aware distance selection existed. | Validated CartoCiudad candidates plus Haversine ranking and real availability per site. Synthetic tests prove a closer unsuitable site is skipped. Public-landmark lookup returned validated candidates, requiring clarification; no private-case result is claimed. |
| Voice turns / interruption - uncovered races | Code review found greeting/buffered-input races and late tool/audio continuations after a new caller turn. | Generation guards, serialized tools, deferred single greeting and padding-aware truncation. Offline WebSocket/audio tests cover these races; live acoustic quality and noisy-case performance still need public practice. |
| Voice / missing recognized caller speech (18 Sep 23:22 UTC batch) | Four of ten observed calls sent greeting audio, produced no user transcription or speech-start event, and closed via prosper_stop after roughly 37 seconds. The other six were exchanging turns. Incoming audio byte counts alone do not distinguish speech from silence; generated assistant text does not prove it was heard. | Runtime and tunnel left untouched during the run. No transport/Azure error was recorded for those calls. Cause remains unconfirmed: correlate a public recording and harness signals before blaming either caller generation or speech recognition. |
| Voice / evidence capture (19 Sep) | Existing private NDJSON retained text/events but no waveform, so audio byte counts could not establish whether received packets carried a signal or digital silence. | Opt-in private stereo WAV pairs caller input with only the emitted agent frames; finite PCM level/zero-sample metrics accompany the end record. Same secure paths, size bound and conservative pair retention. No past audio reconstruction or claim that energy proves speech/delivery; no access to Prosper's hidden recordings or answer keys. |
| Run All audio / opening (19 Sep 00:26 UTC) | Ten of twenty recorded calls contained only digital zero on the incoming caller channel, with a nonzero outgoing greeting. The opening override also asked no question and generated Spanish despite the English-default prompt. We cannot prove what the harness heard or whether that opening caused its silence. | Opening explicitly asks one short English service question. The next official run passed 10/20 cases for 19/40 points, versus 5/20 and 11/40; only one of its scored calls had all-zero input. This is not a controlled attribution to the greeting alone. Report input evidence rather than automatically blaming Prosper. |
| Audio / downstream turn completion (19 Sep 01:26 UTC) | Four official agent-silence failures emitted a greeting/question, then received no further nonzero caller samples for roughly 30-35 seconds. No internal tool/response error was recorded. Sparse outbound audio had no explicit silence after its generated frames. Two synthetic Azure receiver turns failed to end after four seconds of wall-clock waiting, then ended after 420/960 ms of supplied silence. | A bounded 1.2-second silence tail follows completed audio items without entering generated-content truncation accounting. Frame-count, interruption and wire regressions pass; two fresh synthetic receiver turns completed with the actual queue and no extra padding. A public registration passed without silence signals. This demonstrates compatibility, not Prosper's internal cause or a controlled private-case result. |
| `the_new_patient` / collection and intent (19 Sep 01:26 UTC) | Explicit registration entered repeated existing-patient lookups; one was wrongly refused as patient_not_found. Other calls prepared too late or filled an unspoken insurer. The successful registration submitted at about 171 seconds. | Incremental call-local drafts, short missing-field groups, no insurer default, registration-specific lookup/refusal protection, safe validation paths and correction invalidation. Complete validation, duplicate detection and later consent remain. Public practice at 02:30 UTC passed all fields: three ordinary collection groups, no find_patient loop, one corrected proposal, REGISTER accepted at about 140 seconds; private coverage remains to be measured. |
| Terminal refusal after a revised request (19 Sep 01:26 UTC) | A completed caller turn denied another policy AND accepted a different covered provider. The agent submitted the obsolete provider-specific refusal; later searches correctly could not replace it. Official result was record_mismatch. | A separate current-turn outcome guard rejects unresolved alternatives/registration/corrections before a fresh refusal, without adding booking-style confirmation. Policy denial alone no longer instructs immediate refusal. Current-turn, retry, emergency and valid single-plan regressions pass; new judge validation is pending. |
| Coverage, cost and voluntary deferral (19 Sep 01:26 UTC) | One passed booking made an unsupported no-extra-cost claim. Another failed record used caller_not_authorised after a self-booking caller deferred over unknown cost. Current public OpenAPI and read-only catalogue inspection found coverage/payability, but no monetary copayment field to restore. | Distinguish verified coverage from unpublished copay; reject unresolved price questions as booking consent and obvious voluntary deferral as an authorization refusal. Do not invent an amount, surrogate reason or consent to force a record. Synthetic EN/ES/CA guards pass; no claim that this guarantees a judge pass after an explicit deferral. |
| `noise` / startup greeting coverage gap | Code review found that any nonzero buffered sample permanently dismissed the opening even without a VAD speech event. An offline regression reproduced a missing greeting from low-amplitude non-speech frames. No particular Prosper case is attributed to this mechanism. | A single bounded 500 ms startup grace gives real speech time to reach VAD without indefinitely postponing the greeting under continuous noise. Actual speech still cancels it, and silent startup/long caller pauses are unchanged. Offline transport regressions pass; live noisy-case validation remains pending. |
| Measured iteration (19 Sep 02:39 UTC) | The first corrected Run All passed 16/20 for 33/40 points, with no record mismatches. All 22 local attempts contained caller signal. Four scored failures remained: local output overflow, repeated date-parse errors, late registration confirmation, and no further caller signal after a valid offer. | Official verdicts and all attempts were reviewed separately. This is an observed run improvement, not a controlled comparison or proof of full private coverage. A passed case can retain a silence/socket/time-limit signal when its action matches; do not infer a failed record solely from that signal. |
| Voice / bounded output overflow (19 Sep 02:39 UTC) | One call closed locally at about 72 seconds with audio_output_backpressure while generating a prepared offer. The excessive response never produced a complete transcript; its precise spoken content was not retained. | Preserve the 30-second queue bound, cancel and truncate all discarded items, and allow one concise recovery per caller turn. Repeated overflow remains an explicit failure. Bounded partial diagnostics and offline race tests added; a synthetic live Azure fault injection verified cancel/truncate/continued audio with zero Prosper requests. New judge validation is pending. |
| Public caller handoff / silence (19 Sep 03:51 UTC) | A date practice stopped twice before any clinic tool: first with zero caller input, then after our identity question. Prosper's public transcript contains the complete outgoing question, but no subsequent patient response. Our local transport/model recorded no error. Thus reception/STT worked on the final attempt; downstream turn completion or caller generation remains unverified. | A four-second bounded tail retains immediate speech preemption and unchanged queue/call limits; wire tests measure exactly 200 silent frames. Repeating the same public case at 04:05 UTC passed with no signals, exercising early BOOK preparation and a caller-approved holiday alternative. This supports compatibility but does not establish Prosper's internal cause from one comparison. |
| `when_exactly` / date error recovery (19 Sep 02:39 UTC) | After an accepted day correction, three unknown_date_phrase errors prevented a fresh proposal before timeout. The relative weekday wording already parsed; exact rejected arguments were absent, so a punctuation-specific historical cause is unproven. | Synthetic regressions reproduce and fix comma-separated and month-first absolute dates, including ordinals and weekday agreement. Errors now explain how to use an already-confirmed exact date without discarding constraints or retrying unchanged. Failed-search date/filter diagnostics remain private; new judge validation is pending. |
| `the_new_patient` / correction readback budget (19 Sep 02:39 UTC) | Three ordinary field groups worked, but a surname correction triggered another whole-summary readback and exhausted the call. An unmapped attempt also spent time listing possible correction fields while the caller was finishing a name fragment. | Concise initial summaries, correction-only readback guidance, and exact unchanged-proposal reuse preserve fresh consent without repeatedly restarting the conversation. Required fields, duplicate checks, held insurer and the three-minute deadline are unchanged. Offline coverage passes; live timing improvement remains unmeasured. |
| Proposal lifecycle / early preparation | Review of the BOOK fast path exposed existing ways a prepared action could outlive a terminal refusal or unresolved possible-emergency block, including invalidation during confirmation. These are code-level findings, not attributed judge failures. | Fresh and grouped submissions recheck current request, safety and proposal validity. Independent intents and identical accepted/pending/uncertain retries remain valid. Opt-in early BOOK preparation never posts or grants consent by itself. |
| Identification / clarification budget (19 Sep 02:39 UTC) | One passing call spent about 125 seconds and four lookups on identity recovery, then timed out while answering a final clinic question. Review noted incomplete name components; exact query arguments were not retained. Code always suggested another identifier, even when the name was missing or only a given name. | Return targeted full-name guidance for that unverified state and reuse any supplied corroborator. A lone given name without a corroborator still asks for both necessary pieces. Verification criteria and protected-field handling are unchanged; synthetic regressions pass, live timing benefit remains unmeasured. |
| Returning to an earlier offer (19 Sep 04:14 UTC) | Caller explicitly selected an earlier offered day/time after exploring an empty Monday. The agent repeated Monday unchanged and submitted NO_ACTION(no_availability), producing a mismatch. Old proposals had correctly been invalidated, but actionable prior alternatives were no longer visible in tool state. | Bounded historical options preserve patient/request and current non-date filters, with fresh recheck instructions and no revived consent. A context-aware refusal guard rejects clear selection of an earlier option against another empty day. A synthetic Azure conversation performed the exact date recheck, fresh preparation/confirmation and intercepted BOOK; no real Prosper request or judge pass is inferred. |
| Qualified consent despite a passing record (19 Sep 04:14 UTC) | One official pass submitted BOOK about 0.7 seconds after a complete affirmative-plus-outside-working-hours question. The guard missed the "Does the clinic have..." construction because it lacked "but/check". A later unsupported answer did not resolve the pre-submission question. | The exact anonymized construction first reproduced failure, then passed new EN/ES/CA availability-question rejection coverage. Explicit unqualified booking commands remain accepted. A matching judge record is not proof of clean consent; no replacement action can undo the earlier submission. |
| Cost deferral / unsupported reason substitution (19 Sep 04:14 UTC) | A caller withheld consent until knowing the unpublished copay. After two unsupported refusal attempts, the agent recorded out_of_scope; the official record mismatched. The API/catalogue still provides no monetary quote. | Plain voluntary deferral in a known clinic request is not out_of_scope or caller_not_authorised. Reject these labels, preserve genuine unsupported/privacy refusals, and prohibit invented fees or claims about what other patients do. The vocabulary has no documented voluntary-deferral reason; do not invent a price, consent or acceptable private answer to force a pass. |
| Spoken absolute dates (synthetic Azure, 19 Sep) | A real model emitted a compound spoken ordinal for a fully specified date; the parser accepted only the published twelfth/doce/dotze example and failed the general form. A literal "only" suffix also blocked an otherwise exact day. | General day words 1-31 support English ordinals and Spanish/Catalan date numbers, including compound/hyphenated variants. Boundary "only" preserves an exact date and never authorizes moving a closure. Exhaustive English ordinal tests and multilingual/conflict/closure/unsupported-qualifier regressions pass; the full synthetic model workflow then succeeded. |
| Azure failed-response diagnostics (19 Sep 04:14 UTC) | An unmapped local attempt ended with azure_response_failed, but the provider's status reason was not retained; later generated offer text was not evidence of emitted speech. | Retain only a bounded machine-readable provider code/reason in private error records, never the upstream message/body. Unknown failure remains explicit; do not invent a transient cause or automatically retry content/policy failures. |
| `when_exactly` / unnecessary time menus (public practice, 19 Sep 05:29 UTC) | Date/provider/site/type/patient/plan all matched, but the judge expected the earliest minute. The agent offered three times without being asked; the caller selected and confirmed a later one, which was correctly submitted according to the conversation but failed the fixed earliest-slot check. An unrelated existing appointment had also prompted an unnecessary detour. | Recommend and offer a single earliest matching slot by default, including after date corrections; do not negotiate unrelated appointments for a separate booking. Preserve explicit requests for alternatives and never override a stated later time. A regression uses different synthetic times. Repeating the same public case at 05:41 UTC passed: the earliest offer was explicitly confirmed and accepted at about 102 seconds. No expected case value is hardcoded. |
| Mass missing caller input (Run All, 19 Sep 05:48 UTC) | The last zero-gain private run fell to 3/40, with 18 silence/missing-record failures; the best 33/40 remained. All 23 local attempts emitted signal, seven received 1,396,160 all-zero caller samples, and every failed case ended after a question with no later caller signal. No recorded caller answer was left unanswered; no completed action was overlooked. | Host/tunnel health and disk were normal. Ten concurrent real Azure sessions completed 20 generated voice turns with fake clinic tools and no failures; this did not test Prosper's receiver/caller pipeline. Retain call IDs and request delivery/STT/turn-end/LLM/TTS traces. Local emission is not proof of remote hearing, and the evidence does not establish blanket Prosper fault or a local concurrency cap. |
| Receiver level / short follow-up (public diagnostics, 19 Sep 06:05-06:25 UTC) | On unchanged zero-gain code, public captions contained the greeting and patient hello but omitted the locally emitted short help question; no further caller reply arrived. A bounded output-only +9 dB trial preserved mu-law encoding, silence, sign, 160-byte framing and truncation timing. | The first gained attempt progressed but timed out; its redial publicly passed all fields, with the short follow-up present in Prosper's captions and BOOK accepted at about 129 seconds. Local +9 dB was persisted without changing credentials; repository default remains 0. This is public-only compatibility evidence, not a proven root cause or private score improvement. No later private run was admitted before the investigation deadline. |
| Routine booking / named provider deadlock (19 Sep 00:26 UTC) | Unsupported routine complaints created a persistent patient routing block. Three voiced calls could not reach availability after explicit specialty clarification; another provider request short-circuited before an actual catalogue lookup, then lacked refusal evidence. | Unsupported non-emergency routing no longer blocks explicit scheduling requests. Provider resolution proceeds despite a routine complaint; only potential emergency uncertainty retains a safety block. Reason-specific recovery and synthetic regressions added. |
| Next-day negotiation (19 Sep 00:26 UTC) | A refusal claimed no availability after the caller accepted the following day, but a read-only check found eligible slots on that day. Exact historical tool arguments were not retained. An empty but OPEN day could be re-queried unchanged with allow_next_open_day, a reproduced failure mechanism. | Explicit next-day advancement and actionable next_day_search preserve site/time. Resolved query windows/options are now recorded privately. This supports correcting the product, not asserting a private expected answer or mapping a judge verdict without call IDs. |
| Qualified confirmation (19 Sep 00:26 UTC) | A BOOK was sent as the caller's completed turn added a request to check outside working hours. The later availability lookup could not replace the accepted record. Its judge verdict is not individually mapped; a correct-looking record is not sufficient evidence of clean consent. | Wait for completed current-turn transcription and a short stability interval; reject explicit conditions/corrections. Synthetic Azure audio tests accepted an unqualified confirmation and submitted nothing for a qualified one. No private data used in regression fixtures. |
| Optional classification / Jev evaluation | The user requested trying Jev. Gateway authentication worked, but a synthetic request with the paid ZDR option returned 403. This was a feature entitlement failure, not an invalid key or a voice failure. | A fixed synthetic-only benchmark without ZDR matched 12/12 intent, correction and completion labels in one trial (p50 273 ms, p95 1,149 ms). Not a calibration study or score result. No patient data sent; live integration remains off pending privacy/benefit evaluation. Deterministic completion and identity checks must not be replaced by model confidence. |
| Timing across problems | Eleven calls in an observed batch reached the three-minute local limit. Cause is not established by duration alone. | Open investigation: reduce repeated questions and long explanations using public cases. Do not extend the deadline or call this a concurrency defect without evidence. |
| Transport / configuration | An old tunnel expired; a later request was rejected with 401 after an Integration edit. | Keep the current WSS URL; re-enter the real header when saving because blank removes it. Check authentication separately from audio or scoring. |
| Transport / process lifetime (18 Sep 22:01 UTC) | The VM had no listener on port 7860 and no cloudflared process; the public URL returned HTTP 530 / Cloudflare 1033. This is evidence of a current outage, not proof of the cause of earlier Run All failures while calls were connected. | Agent restarted and local health restored. Keep host processes alive for the whole run; CLI-attached processes are not persistent services. The alternative ngrok ingress subsequently passed health and ten simultaneous authenticated WebSocket handshakes without starting model sessions. This is transport evidence, not a judge verdict. |
| Run attribution / dashboard | UI reported Failed/no cases while the agent received overlapping calls and Prosper acknowledged records in that time range, with both Cloudflare and ngrok ingress. On 18 Sep, the user reported that Prosper acknowledged this as their error; no component-level diagnosis was supplied. | Keep the working endpoint and agent unchanged for this incident. Await Prosper's correction and a new judge result; do not describe the run as passed or repaired yet. Correlate run_id/call_id and receipts rather than inferring a connection-cap failure from the generic message. The agent's separate timeout/workflow issues remain open. |

For future entries include: problem ID, symptom, expected action/reason (without
patient values), verified cause or explicit uncertainty, affected code, regression
and whether it was checked offline, against a synthetic Azure conversation, or
by an actual public Prosper practice verdict.
