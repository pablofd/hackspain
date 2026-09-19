import assert from "node:assert/strict";
import { test } from "node:test";
import { jevExamples, receiptsComplete } from "../scripts/check-jev.js";

test("Jev evaluation uses only a fixed synthetic corpus and does not execute at import", () => {
  assert.equal(jevExamples.length, 12);
  assert.equal(new Set(jevExamples.map((example) => example.id)).size, jevExamples.length);
  assert.ok(jevExamples.every((example) => example.requiredActionKeys.length > 0));
});

test("workflow completion is decidable from accepted receipts, without trusting a model or spoken confirmation", () => {
  assert.equal(receiptsComplete({ requiredActionKeys: ["one", "two"], acceptedActionKeys: ["one"], uncertainActionKeys: [] }), false);
  assert.equal(receiptsComplete({ requiredActionKeys: ["one"], acceptedActionKeys: ["one"], uncertainActionKeys: ["one"] }), false);
  assert.equal(receiptsComplete({ requiredActionKeys: ["one"], acceptedActionKeys: ["one"], uncertainActionKeys: [] }), true);
  assert.equal(receiptsComplete({ requiredActionKeys: [], acceptedActionKeys: [], uncertainActionKeys: [] }), false);
});
