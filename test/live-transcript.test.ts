import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { LiveTranscriptState, type LiveTranscriptFragment } from "../src/live-transcript.js";

function state(settleMs = 0): LiveTranscriptState {
  return new LiveTranscriptState(new AbortController().signal, settleMs);
}

function fragment(text: string, startMs = 0, endMs = 100, eventId?: string): LiveTranscriptFragment {
  return { text, startMs, endMs, ...(eventId === undefined ? {} : { eventId }) };
}

test("input preserves spaces, repeated words and overlapping fragments in arrival order", async () => {
  const transcript = state();
  assert.equal(transcript.generation, 0);
  assert.equal(transcript.text, "");
  assert.deepEqual(transcript.input(fragment("Yes", 0, 100)), {
    generation: 1, newUtterance: true, duplicate: false,
  });
  transcript.input(fragment(" ", 80, 110));
  transcript.output(fragment("Mm-hm", 85, 120));
  transcript.input(fragment("yes", 110, 150));
  transcript.input(fragment(" yes.", 140, 200));
  assert.equal(transcript.generation, 4);
  assert.equal(transcript.text, "Yes yes yes.");
  await transcript.reviewConfirmation(4);
});

test("only event IDs deduplicate; identical text without an ID or with different IDs stays", () => {
  const transcript = state();
  const first = fragment("yes ", 0, 100, "input-1");
  transcript.input(first);
  assert.deepEqual(transcript.input(first), {
    generation: 1, newUtterance: false, duplicate: true,
  });
  transcript.input(fragment("yes ", 0, 100, "input-2"));
  transcript.input(fragment("yes ", 0, 100));
  transcript.input(fragment("yes ", 0, 100));
  assert.equal(transcript.generation, 4);
  assert.equal(transcript.text, "yes yes yes yes ");
});

test("assistant captions are not caller text and cannot suppress an input with a reused ID", () => {
  const transcript = state();
  transcript.output(fragment("Yes, please book it.", 0, 100, "shared-id"));
  assert.equal(transcript.generation, 0);
  assert.equal(transcript.text, "");
  transcript.input(fragment("Only this plan.", 200, 300, "shared-id"));
  transcript.output(fragment("Yes, please book it.", 0, 100, "shared-id"));
  assert.equal(transcript.generation, 1);
  assert.equal(transcript.text, "Only this plan.");
});

test("a long pause without assistant speech retains the caller's qualification", async () => {
  const transcript = state();
  transcript.input(fragment("Yes, ", 0, 100));
  assert.deepEqual(transcript.input(fragment("but could you check another site?", 8100, 8500)), {
    generation: 2, newUtterance: false, duplicate: false,
  });
  assert.equal(transcript.text, "Yes, but could you check another site?");
  await assert.rejects(transcript.reviewConfirmation(2), { code: "confirmation_needs_clarification" });
});

test("overlapping assistant backchannels do not separate a caller group, even after a pause", async () => {
  const transcript = state();
  transcript.input(fragment("Yes, ", 0, 200));
  transcript.output(fragment("Mm", 100, 200));
  transcript.output(fragment("-hm", 200, 300));
  assert.equal(transcript.input(fragment("but check the price first.", 8200, 8400)).newUtterance, false);
  assert.equal(transcript.text, "Yes, but check the price first.");
  await assert.rejects(transcript.reviewConfirmation(2), { code: "confirmation_needs_clarification" });
});

test("a real assistant interval and a sufficient timestamp gap start a new group", async () => {
  const transcript = state();
  transcript.input(fragment("But could you check another time?", 0, 300));
  transcript.output(fragment("Here are the final details.", 500, 900));
  assert.deepEqual(transcript.input(fragment("Yes.", 1800, 1900)), {
    generation: 2, newUtterance: true, duplicate: false,
  });
  assert.equal(transcript.text, "Yes.");
  await transcript.reviewConfirmation(2);
});

test("grouping requires a gap over 1200ms and assistant speech entirely between caller ranges", () => {
  for (const [output, start, expected] of [
    [fragment("Details", 400, 600), 1500, false],
    [fragment("Details", 400, 600), 1501, true],
    [fragment("Details", 200, 600), 2000, false],
    [fragment("Details", 400, 2100), 2000, false],
    [fragment("", 400, 600), 2000, false],
    [fragment(" ", 400, 600), 2000, false],
    [fragment("Details", 400, 400), 2000, false],
  ] as const) {
    const transcript = state(1);
    transcript.input(fragment("Yes, ", 0, 300));
    transcript.output(output);
    assert.equal(transcript.input(fragment("yes.", start, start + 100)).newUtterance, expected);
  }
});

test("out-of-order assistant fragments are merged without using their text as evidence", () => {
  const transcript = state();
  transcript.input(fragment("Yes, ", 0, 300));
  transcript.output(fragment("second fragment", 500, 700));
  transcript.output(fragment("overlapping backchannel", 200, 550));
  assert.equal(transcript.input(fragment("but not yet.", 2000, 2200)).newUtterance, false);
});

test("a late assistant fragment invalidates a grouping boundary it contradicts", async () => {
  const transcript = state();
  transcript.input(fragment("Please check another time.", 0, 200));
  transcript.output(fragment("Final details", 300, 500));
  transcript.input(fragment("Yes.", 1500, 1700));
  transcript.output(fragment("continued details", 400, 1800));
  assert.equal(transcript.generation, 2);
  await assert.rejects(transcript.reviewConfirmation(2), { code: "live_transcript_uncertain" });
});

test("late input remains uncertain through forward fragments until a genuinely fresh group", async () => {
  const transcript = state();
  transcript.input(fragment("Yes", 0, 1000));
  transcript.input(fragment(", yes", 0, 800));
  assert.equal(transcript.text, "Yes, yes");
  await assert.rejects(transcript.reviewConfirmation(2), { code: "live_transcript_uncertain" });
  transcript.input(fragment(".", 900, 1300));
  await assert.rejects(transcript.reviewConfirmation(3), { code: "live_transcript_uncertain" });
  await assert.rejects(transcript.reviewOutcome(3, "specialty_not_covered"), {
    code: "live_transcript_uncertain",
  });
  transcript.output(fragment("Please confirm the final details.", 1500, 2000));
  assert.equal(transcript.input(fragment("Sí.", 3000, 3200)).newUtterance, true);
  assert.equal(transcript.text, "Sí.");
  await transcript.reviewConfirmation(4);
});

test("a late input cannot roll the timestamp high-water mark back to manufacture a group", async () => {
  const transcript = state();
  transcript.input(fragment("Yes", 0, 5000));
  transcript.input(fragment(", yes", 0, 100));
  transcript.output(fragment("Backchannel", 200, 300));
  assert.equal(transcript.input(fragment(".", 2000, 2500)).newUtterance, false);
  await assert.rejects(transcript.reviewConfirmation(3), { code: "live_transcript_uncertain" });
});

test("a duplicate old event does not taint a fresh group", async () => {
  const transcript = state();
  const old = fragment("But check another date.", 0, 200, "old-input");
  transcript.input(old);
  transcript.output(fragment("Final details", 300, 700));
  transcript.input(fragment("Yes.", 1600, 1800, "new-input"));
  assert.equal(transcript.input(old).duplicate, true);
  assert.equal(transcript.generation, 2);
  assert.equal(transcript.text, "Yes.");
  await transcript.reviewConfirmation(2);
});

test("typed messages always replace the group and version, including repeated and empty text", async () => {
  const transcript = state();
  transcript.input(fragment("Yes", 0, 1000));
  transcript.input(fragment(", yes", 0, 500));
  assert.equal(transcript.typed("Sí."), 3);
  await transcript.reviewConfirmation(3);
  assert.equal(transcript.typed("Sí."), 4);
  assert.equal(transcript.text, "Sí.");
  assert.equal(transcript.typed(""), 5);
  assert.equal(transcript.text, "");
  assert.equal(transcript.input(fragment("Yes.", 2000, 2200)).newUtterance, true);
  assert.equal(transcript.text, "Yes.");
});

test("typed recovery preserves enough timing history to reject a subsequent late audio fragment", async () => {
  const transcript = state();
  transcript.input(fragment("Yes.", 0, 1000));
  transcript.typed("Yes.");
  transcript.input(fragment("Yes.", 0, 500));
  await assert.rejects(transcript.reviewConfirmation(3), { code: "live_transcript_uncertain" });
});

test("empty deltas are deduplicated but do not advance caller evidence or timing", () => {
  const transcript = state();
  const empty = fragment("", 10_000, 11_000, "empty");
  assert.deepEqual(transcript.input(empty), {
    generation: 0, newUtterance: false, duplicate: false,
  });
  assert.equal(transcript.input(empty).duplicate, true);
  assert.equal(transcript.input(fragment(" ", 0, 100)).newUtterance, true);
  assert.equal(transcript.generation, 1);
  assert.equal(transcript.text, " ");
  transcript.input(fragment("Yes", 100, 200));
  assert.equal(transcript.text, " Yes");
});

test("unrelated text and identifiers are not booking confirmation", async () => {
  await Promise.all([
    "My name is Synthetic Caller.",
    "The identifier is TEST-123.",
    "Tomorrow morning.",
    "I only have that plan.",
    "My surname is Yes.",
    "Yes, my identifier is TEST-123.",
    "Sí, soy la persona que llama.",
    "Potser.",
    "Yes?",
    "Yes, please?",
    "If the price is right.",
    "Thanks.",
    "Si us plau.",
  ].map(async (text) => {
    const transcript = state();
    const turn = transcript.typed(text);
    await assert.rejects(transcript.reviewConfirmation(turn), {
      code: "confirmation_needs_clarification",
    }, text);
  }));
});

test("short EN, ES and CA assents and explicit action approvals pass the extra rejection screen", async () => {
  await Promise.all([
    "Yes.",
    "Yes, please.",
    "Yes, that works. Please book it.",
    "Please register me with those details.",
    "Please cancel my appointment.",
    "Move that appointment to the new time, please.",
    "Could you book that appointment, please?",
    "I confirm the registration.",
    "Sí.",
    "Sí, perfecto.",
    "Sí, reserva esa cita.",
    "Deme de alta, por favor.",
    "Cancélala, por favor.",
    "Sí, cambia la cita.",
    "Confirmo el cambio.",
    "D’acord.",
    "D'acord, endavant.",
    "D'acord, reservem aquesta cita.",
    "Registreu-me, si us plau.",
    "Sí, cancel·la la cita.",
    "Canvieu la cita, si us plau.",
    "Sí, les dades són correctes.",
  ].map(async (text) => {
    const transcript = state();
    const turn = transcript.typed(text);
    await assert.doesNotReject(transcript.reviewConfirmation(turn), text);
  }));
});

test("the shared price, qualification and alternative-question checks still run", async () => {
  await Promise.all([
    "Yes, but check another date first.",
    "Yes, how much will it cost?",
    "Yes, please book it. Does the clinic have appointments after work?",
    "Yes, that is fine. Does the clinic have any appointments outside working hours, though?",
    "Sí. ¿Cuánto cuesta la cita?",
    "Sí, pero puedes mirar otra fecha?",
    "D'acord. Quin preu té?",
    "D'acord, però pots mirar una altra hora?",
  ].map(async (text) => {
    const transcript = state();
    const turn = transcript.typed(text);
    await assert.rejects(transcript.reviewConfirmation(turn), {
      code: "confirmation_needs_clarification",
      message: /condition, correction, unresolved price question or request to check an alternative/,
    }, text);
  }));
});

test("a positive historical offer cannot become false NO_ACTION when previous options exist", async () => {
  await Promise.all([
    "Thursday at ten, then. Yes, book it.",
    "Yes, reserve that appointment.",
    "Sí, reserva esa cita.",
    "D'acord, reservem aquesta cita.",
  ].map(async (text) => {
    const transcript = state();
    const turn = transcript.typed(text);
    await assert.rejects(transcript.reviewOutcome(turn, "no_availability", {
      hasClinicalRequest: true, hasPreviousOptions: true,
    }), { code: "outcome_request_unresolved" }, text);
  }));
});

test("single-policy refusals need stable captions but no extra positive affirmation", async () => {
  await Promise.all([
    "I only have that policy. Thank you anyway.",
    "No, I don't have any other insurance. Thank you anyway.",
    "Solo tengo ese seguro y no quiero otro médico.",
    "Només tinc aquesta assegurança i no vull un altre metge.",
  ].map(async (text) => {
    const transcript = state();
    const turn = transcript.typed(text);
    await transcript.reviewOutcome(turn, "specialty_not_covered", {
      hasClinicalRequest: true, hasPreviousOptions: false,
    });
  }));
});

test("outcome context and unresolved alternatives are still delegated to the shared guard", async () => {
  const transcript = state();
  let turn = transcript.typed("I'll hold off then.");
  await assert.rejects(transcript.reviewOutcome(turn, "out_of_scope", {
    hasClinicalRequest: true, hasPreviousOptions: true,
  }), { code: "outcome_reason_not_supported" });
  turn = transcript.typed("I only have this policy and any dermatologist who accepts it is fine.");
  await assert.rejects(transcript.reviewOutcome(turn, "provider_not_in_network"), {
    code: "outcome_request_unresolved",
  });
});

test("emergency outcomes bypass captions and settling, but not stale versions or disconnects", async () => {
  const controller = new AbortController();
  const transcript = new LiveTranscriptState(controller.signal, 10_000);
  await transcript.reviewOutcome(0, "medical_emergency");
  transcript.input(fragment("Help", 0, 1000));
  transcript.input(fragment(" now", 0, 500));
  await transcript.reviewOutcome(2, "medical_emergency");
  await assert.rejects(transcript.reviewOutcome(1, "medical_emergency"), { code: "stale_turn" });
  controller.abort();
  await assert.rejects(transcript.reviewOutcome(2, "medical_emergency"), { code: "call_cancelled" });
});

test("every new caller fragment or typed message invalidates in-flight reviews", async () => {
  await Promise.all([0, 1200].flatMap((settleMs) => (["confirmation", "outcome"] as const).map(async (kind) => {
    const transcript = state(settleMs);
    const turn = transcript.typed("Yes.");
    const reviewed = kind === "confirmation"
      ? transcript.reviewConfirmation(turn) : transcript.reviewOutcome(turn, "specialty_not_covered");
    const rejected = assert.rejects(reviewed, { code: "stale_turn" });
    await delay(20);
    if (kind === "confirmation") transcript.input(fragment("Yes.", 0, 100));
    else transcript.typed("Yes.");
    await rejected;
    await assert.rejects(transcript.reviewConfirmation(turn), { code: "stale_turn" });
  })));
});

test("disconnect during either stability layer always surfaces call_cancelled", async () => {
  await Promise.all([0, 1200].flatMap((settleMs) => (["confirmation", "outcome"] as const).map(async (kind) => {
    const controller = new AbortController();
    const transcript = new LiveTranscriptState(controller.signal, settleMs);
    const turn = transcript.typed("Yes.");
    const rejected = assert.rejects(kind === "confirmation"
      ? transcript.reviewConfirmation(turn) : transcript.reviewOutcome(turn, "specialty_not_covered"), {
      code: "call_cancelled",
    });
    await delay(20);
    controller.abort(new Error("synthetic disconnect"));
    await rejected;
  })));
});

test("default settling uses monotonic receipt time, not fragment timestamps or Date.now", async (t) => {
  t.mock.method(Date, "now", () => -1_000_000);
  const transcript = new LiveTranscriptState(new AbortController().signal);
  transcript.input(fragment("Yes.", 90_000, 91_000));
  const started = performance.now();
  let finished = false;
  const reviewed = transcript.reviewConfirmation(1).then(() => { finished = true; });
  await delay(550);
  assert.equal(finished, false);
  await reviewed;
  assert.ok(performance.now() - started >= 1190);
});

test("duplicate events and assistant output do not invalidate a settling caller version", async () => {
  const transcript = state();
  const caller = fragment("Yes.", 0, 100, "caller");
  transcript.input(caller);
  const reviewed = transcript.reviewConfirmation(1);
  await delay(20);
  transcript.input(caller);
  transcript.output(fragment("Acknowledgement", 50, 90));
  await reviewed;
  assert.equal(transcript.generation, 1);
});

test("missing, blank and excessively unsettled captions fail within a bounded review", { timeout: 8000 }, async () => {
  const missing = state();
  const blank = state();
  blank.typed("   ");
  const empty = state();
  empty.typed("");
  const unsettled = state(10_000);
  unsettled.typed("I only have that policy.");
  const started = performance.now();
  await Promise.all([
    assert.rejects(missing.reviewConfirmation(0), { code: "confirmation_transcript_pending" }),
    assert.rejects(blank.reviewConfirmation(1), { code: "confirmation_transcript_pending" }),
    assert.rejects(empty.reviewOutcome(1, "specialty_not_covered"), { code: "outcome_transcript_pending" }),
    assert.rejects(unsettled.reviewOutcome(1, "specialty_not_covered"), {
      code: "outcome_transcript_pending", message: /do not ask for an extra refusal confirmation/,
    }),
  ]);
  assert.ok(performance.now() - started >= 2900);
  assert.ok(performance.now() - started < 6000);
});

test("timestamp, fragment text and event ID bounds fail with safe AppErrors", () => {
  const invalid = [
    fragment("Yes", -1, 100),
    fragment("Yes", 0, -1),
    fragment("Yes", 200, 100),
    fragment("Yes", Number.NaN, 100),
    fragment("Yes", 0, Number.POSITIVE_INFINITY),
    fragment("Yes", Number.NEGATIVE_INFINITY, 100),
    fragment("x".repeat(32_001)),
    fragment("Yes", 0, 100, ""),
    fragment("Yes", 0, 100, " "),
    fragment("Yes", 0, 100, "id\n"),
    fragment("Yes", 0, 100, "x".repeat(257)),
    { ...fragment("Yes"), text: 42 },
    { ...fragment("Yes"), eventId: null },
    { ...fragment("Yes"), startMs: "0" },
    null,
  ];
  for (const value of invalid) {
    const transcript = state();
    for (const method of ["input", "output"] as const) {
      assert.throws(() => transcript[method](value as LiveTranscriptFragment), (error: unknown) =>
        error instanceof AppError && error.code === "invalid_live_transcript_fragment");
    }
    assert.equal(transcript.generation, 0);
    assert.equal(transcript.text, "");
  }
  const transcript = state();
  transcript.input(fragment("x".repeat(32_000), 0.5, 0.5, "x".repeat(256)));
  assert.equal(transcript.text.length, 32_000);
});

test("group text is bounded without truncation, partial mutation or reuse as approval", async () => {
  const transcript = state();
  transcript.input(fragment("Yes."));
  assert.throws(() => transcript.input(fragment(" ".repeat(32_000), 100, 200)), {
    code: "live_transcript_too_large",
  });
  assert.equal(transcript.text, "Yes.");
  assert.equal(transcript.generation, 1);
  await assert.rejects(transcript.reviewConfirmation(1), { code: "live_transcript_uncertain" });
  transcript.output(fragment("Please confirm.", 200, 300));
  assert.equal(transcript.input(fragment("Yes.", 2000, 2100)).newUtterance, true);
  await transcript.reviewConfirmation(2);
});

test("a rejected fragment before the first caption cannot silently become a complete approval", async () => {
  const transcript = state();
  assert.throws(() => transcript.input(fragment("but check another date", 0, Number.NaN)), {
    code: "invalid_live_transcript_fragment",
  });
  transcript.input(fragment("Yes."));
  await assert.rejects(transcript.reviewConfirmation(1), { code: "live_transcript_uncertain" });
  const turn = transcript.typed("Yes.");
  await transcript.reviewConfirmation(turn);
});

test("event IDs have a hard 4096-entry bound without forgetting old duplicates", () => {
  const transcript = state();
  for (let index = 0; index < 4096; index += 1) transcript.input(fragment("", 0, 0, `event-${index}`));
  assert.equal(transcript.input(fragment("Yes.", 0, 100, "event-0")).duplicate, true);
  assert.equal(transcript.generation, 0);
  assert.throws(() => transcript.input(fragment("Yes.", 0, 100, "event-overflow")), {
    code: "live_transcript_event_limit",
  });
  assert.throws(() => transcript.output(fragment("Details.", 0, 100, "output-overflow")), {
    code: "live_transcript_event_limit",
  });
  assert.equal(transcript.input(fragment("", 0, 0, "event-4095")).duplicate, true);
});

test("typed text and constructor bounds also fail with AppErrors", () => {
  for (const settle of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => state(settle), { code: "invalid_live_transcript_settle_ms" });
  }
  const transcript = state();
  for (const text of ["x".repeat(32_001), null, 42]) {
    assert.throws(() => transcript.typed(text as string), { code: "invalid_live_transcript_text" });
  }
  assert.equal(transcript.generation, 0);
  assert.equal(transcript.typed("x".repeat(32_000)), 1);
  assert.equal(transcript.text.length, 32_000);
});

test("already cancelled calls reject mutation and review with call_cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const transcript = new LiveTranscriptState(controller.signal, 0);
  assert.throws(() => transcript.input(fragment("Yes.")), { code: "call_cancelled" });
  assert.throws(() => transcript.output(fragment("Details.")), { code: "call_cancelled" });
  assert.throws(() => transcript.typed("Yes."), { code: "call_cancelled" });
  await assert.rejects(transcript.reviewConfirmation(0), { code: "call_cancelled" });
  await assert.rejects(transcript.reviewOutcome(0, "specialty_not_covered"), { code: "call_cancelled" });
});
