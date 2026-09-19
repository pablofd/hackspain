import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ConfirmationGate, hasUnresolvedQualification } from "../src/confirmation.js";

test("qualified acceptances and alternative checks are not unqualified confirmation", () => {
  for (const text of [
    "Yes, that appointment is fine, but could you check outside working hours?",
    "Actually, I meant Thursday.",
    "Could you see if there is another time?",
    "Sí, pero puedes mirar otro día?",
    "D'acord, però pots mirar a la tarda?",
    "No, don't book that one.",
  ]) assert.equal(hasUnresolvedQualification(text), true, text);
  for (const text of ["Yes, that works. Please book it.", "Sí, perfecto.", "D'acord, endavant.", "No problem, go ahead."]) {
    assert.equal(hasUnresolvedQualification(text), false, text);
  }
});

test("an ordinary final turn passes the stability guard", async () => {
  const gate = new ConfirmationGate(() => 2, new AbortController().signal);
  gate.observe(2, "Yes, please book that appointment.");
  await gate.review(2);
});

test("a newer caller turn invalidates a confirmation that is waiting to commit", async () => {
  let turn = 2;
  const gate = new ConfirmationGate(() => turn, new AbortController().signal);
  gate.observe(2, "Yes.");
  const reviewed = gate.review(2);
  await delay(20);
  turn = 3;
  await assert.rejects(reviewed, { code: "stale_turn" });
});

test("a delayed old transcript cannot stand in for the current caller turn", async () => {
  const gate = new ConfirmationGate(() => 3, new AbortController().signal);
  gate.observe(2, "Yes, go ahead.");
  const reviewed = gate.review(3);
  gate.observe(3, "Yes, but check a different time first.");
  await assert.rejects(reviewed, { code: "confirmation_needs_clarification" });
});

test("missing transcription fails explicitly rather than approving from an old turn", { timeout: 4000 }, async () => {
  const gate = new ConfirmationGate(() => 2, new AbortController().signal);
  await assert.rejects(gate.review(2), { code: "confirmation_transcript_pending" });
});

test("disconnect during confirmation review never turns into consent", async () => {
  const controller = new AbortController();
  const gate = new ConfirmationGate(() => 2, controller.signal);
  gate.observe(2, "Yes.");
  const reviewed = gate.review(2);
  controller.abort();
  await assert.rejects(reviewed, { code: "call_cancelled" });
});
