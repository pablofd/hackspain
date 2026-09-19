import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.js";
import { normalizeHumanText } from "./prosper-types.js";

export function hasUnresolvedQualification(text: string): boolean {
  const normalized = normalizeHumanText(text).replace(/[’‘]/g, "'");
  if (/\b(?:but|however|except|instead|actually|pero|sin embargo|en realidad|en vez|en canvi|en lloc)\b/.test(normalized)) return true;
  if (/\b(?:can|could|would|may)\s+(?:you|we|i)\s+(?:check|look|find|see|try|change|move)\b/.test(normalized)) return true;
  if (/\b(?:puedes|podrias|puede|podria|podries|pots)\s+(?:mirar|comprobar|buscar|canviar|cambiar|revisar|comprovar)\b/.test(normalized)) return true;
  if (/\b(?:don't|do not|no)\s+(?:book|cancel|move|proceed|register|reserve|reserves|canceles|reservis)\b/.test(normalized)) return true;
  return /^(?:no|not|wait|stop|espera|esperi)\b/.test(normalized) &&
    !/^(?:no problem|no worries|no hay problema|no tengo inconveniente)\b/.test(normalized);
}

/** A rejection guard, not a classifier that grants consent or authorizes a write. */
export class ConfirmationGate {
  private readonly transcripts = new Map<number, { text: string; receivedAt: number }>();

  constructor(
    private readonly currentTurn: () => number,
    private readonly signal: AbortSignal,
  ) {}

  observe(turn: number, text: string): void {
    if (!Number.isSafeInteger(turn) || turn < 1 || text.length > 32_000) throw new AppError("invalid_confirmation_transcript");
    this.transcripts.set(turn, { text, receivedAt: performance.now() });
    for (const known of this.transcripts.keys()) if (known < this.currentTurn() - 2) this.transcripts.delete(known);
  }

  async review(turn: number): Promise<void> {
    const deadline = performance.now() + 2000;
    const current = () => {
      if (this.signal.aborted) throw new AppError("call_cancelled");
      if (turn !== this.currentTurn()) throw new AppError("stale_turn", "The caller spoke again; review their latest request before submitting.");
    };
    current();
    while (!this.transcripts.has(turn)) {
      if (performance.now() >= deadline) {
        throw new AppError("confirmation_transcript_pending",
          "The current caller turn has not been transcribed yet. Nothing was submitted. Wait for the completed turn or ask a short confirmation of the final details.");
      }
      await delay(25);
      current();
    }
    let transcript = this.transcripts.get(turn);
    if (!transcript) throw new AppError("confirmation_transcript_pending");
    if (hasUnresolvedQualification(transcript.text)) {
      throw new AppError("confirmation_needs_clarification",
        "The caller's confirmation contains a condition, correction or request to check an alternative. Do not submit it. Resolve that condition and obtain unqualified confirmation of the final details.");
    }
    await delay(Math.max(0, transcript.receivedAt + 500 - performance.now()));
    current();
    transcript = this.transcripts.get(turn);
    if (!transcript || hasUnresolvedQualification(transcript.text)) {
      throw new AppError("confirmation_needs_clarification",
        "The completed caller turn changed or qualified the acceptance. Clarify the final request before submitting.");
    }
  }
}
