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
| `src/receptionist.ts` | Runtime instructions, tool schemas, verified patients, slots, proposals, confirmations and outcomes. |
| `src/prosper.ts`, `src/prosper-types.ts` | Authenticated clinic/submission requests, runtime schemas, receipts and normalization. |
| `src/scheduling.ts` | Deterministic Madrid date phrases, date windows, age, closures and site openings. |
| `src/clinic-routing.ts` | Catalogue-based doctor/specialty resolution and published complaint/red-flag mapping. |
| `src/confirmation.ts` | Current-turn transcription/stability checks rejecting explicit qualifications before confirmed writes. |
| `src/geography.ts` | Validated public-address lookup and straight-line site ranking; no patient data to geocoding services. |
| `src/server.ts`, `src/protocol.ts`, `src/audio.ts` | Authenticated `/ws`, authoritative call ID, isolated sessions, bounded queues and interruption playback. |
| `src/config.ts`, `.env.example` | Configuration without exposing secret values. |
| `src/call-records.ts`, `src/call-audio.ts`, `src/telemetry.ts` | Private local transcripts/optional WAV recordings versus sanitized operational telemetry. |
| `test/` | Offline Node tests with synthetic patients and fake upstream responses. |

- Keep TypeScript strict; use Zod for untrusted tool arguments and API responses.
  Reuse `AppError` for safe error codes and `withSpan` for explicit traces.
- The runtime is Node.js 24+, ESM, Azure OpenAI Realtime. Jev/AI Gateway is not
  enabled in live calls. `scripts/check-jev.ts` is an opt-in synthetic benchmark
  only; do not introduce a live provider merely to fix a deterministic workflow.
- Preserve the working Azure protocol and mu-law audio configuration. Do not
  mix preview and GA event schemas without an explicit integration change.
- Run the smallest relevant tests, then `npm run typecheck` and `npm run build`.
  `npm test` runs the complete offline suite.
- `npm run check:connections -- --voice` invokes paid Azure inference but must
  never submit actions to Prosper. Intercept every POST when evaluating model
  behavior with synthetic call IDs; never send invented IDs to the real API.
- Do not launch Practice or Run All without the user's request. Debug with
  synthetic/offline cases first, then one public practice case, not Run All.
- Before restarting the active server, check `/healthz` and wait for calls to
  finish. Building `dist/` does not reload an already-running `npm start`.
  Preserve the tunnel and token; do not reset unrelated VM processes.
- Update **Error history and lessons learned** below for each investigated
  failure. Record evidence, cause, correction, regression and remaining limits.
  Distinguish a local fix, an accepted API receipt and a passing judge verdict.

## Scoring: current rules, not the earlier 49-point version

The latest supplied rules use:

```text
points = sum(passed private cases for each problem * that problem's weight)
```

There are 18 problems, 17 scored, four private cases per open scored problem.
Weights are 1-5. Full-roster maximum: **196 points** across 68 calls.
The old pass-fraction formula and maximum of 49 are obsolete.

- A case is binary: its complete action list must match an acceptable outcome.
  No partial credit for correct fields, nearly-correct IDs or one of two actions.
- Multiple tied earliest providers can be valid. Do not invent tie-break rules
  that override the patient's constraints.
- The board uses the team's best Run All, not the last or cumulative runs.
  Public practice never scores. Public answers move with the day's date anchor.
- Problems open progressively; a run uses the roster open at admission.
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
  each socket. Run All uses 10 concurrent sockets; Switchboard reaches 20.
- Barge-in is ours to implement. `clear` currently has no effect at Prosper:
  discard local queued audio and keep model context aligned with sent audio.
- `VOICE_ENDPOINT_TOKEN` protects inbound calls. `PROSPER_API_KEY` authenticates
  outbound requests via `X-Api-Key`. Azure credentials are a third, separate role.
- Saving Prosper Integration replaces BOTH endpoint and headers. Header values
  are write-only: paste the real Authorization line again when saving; an empty
  box removes it. Runs snapshot the endpoint/config at admission.
- Dashboard login is distinct from the clinic API key. Never infer that a
  successful clinic request grants run-management access.

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

## Clinic invariants

- The fixed catalogue has 3 sites, 12 providers, 6 specialties, 11 appointment
  types and 10 plans. Cache catalogue data; do not share conversation state.
- `/directory` exact fields filter rather than downrank. Full name plus one
  corroborating DNI/NIE, phone or birth date is sufficient for our lookup.
  A near-miss DNI can identify someone else; never rely on it alone.
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
- `revise_request` discards unconfirmed slots/proposals; an identity correction
  uses `find_patient.replaces_patient_id`. `get_call_state` recovers known
  patients and outcomes without repeated interrogation.
- Prepare before reading the final offer. `confirm_actions` can submit multiple
  proposals after a new caller turn explicitly agrees to ALL their details.
  Every proposal is checked before starting the first POST; a later network
  failure can still leave a partial multi-action record because the API is not
  transactional. Never hide that failure or resend a different payload.
- Wait for the complete latest caller turn before confirming. A "yes, but..."
  or a request to check other times is not final consent. Audio transcriptions
  are associated with their VAD item/turn; an old transcript cannot approve a
  newer turn. This is a conservative rejection guard, not a consent oracle.
- For an empty exact-date search, `next_day_search`/`advance_day` moves relative
  to that searched date. Do not reuse "tomorrow" against a different anchor or
  claim to have checked the following day when the resolved window is unchanged.
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
4. Wait for `accepted`/`duplicate`, then explain briefly and close politely.
   Do not invent private payment, insurer authorization or external coverage.

`search_availability.no_booking` provides the candidate reasons and next tool,
not an automatically submitted outcome. New lookups invalidate old refusal
evidence. A successful alternative must book rather than reuse a stale reason.
Refusals do not require the booking-style extra confirmation turn.

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
| 2 | `switchboard` | none | 5/10/20 independent calls; diagnostic only, not included in Run All. |
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
  They are not served by HTTP or exported as telemetry.
- Audio recording is separately opt-in via `CALL_AUDIO_RECORDING_ENABLED`.
  Companion WAV files preserve caller input and actually sent agent output on
  separate channels; they cannot redact spoken secrets. Keep them local/private,
  bounded, and under the same retention policy. Never treat local recordings as
  access to Prosper's private answer keys or publish them as test fixtures.
- Transcript snippets are not exact acoustic timing. Assistant text is generated
  audio; check interruption records before assuming all of it was heard.
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
| Run All audio / opening (19 Sep 00:26 UTC) | Ten of twenty recorded calls contained only digital zero on the incoming caller channel, with a nonzero outgoing greeting. The opening override also asked no question and generated Spanish despite the English-default prompt. We cannot prove what the harness heard or whether that opening caused its silence. | Opening now explicitly asks one short English service question. Synthetic Azure generation verifies that question; no Prosper rerun yet. Report the zero-input evidence and request caller STT/LLM/TTS/delivery traces, not automatic attribution to Prosper. |
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
