import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ConfirmationGate, type OutcomeReviewContext } from "./confirmation.js";
import { AppError } from "./errors.js";
import { normalizeHumanText } from "./prosper-types.js";

export type { OutcomeReviewContext } from "./confirmation.js";

export interface LiveTranscriptFragment {
  eventId?: string;
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_TEXT = 32_000;
const MAX_EVENTS = 4096;
const GROUP_GAP_MS = 1200;
const REVIEW_WAIT_MS = 3000;
const transcriptText = z.string().max(MAX_TEXT);
const fragmentSchema = z.strictObject({
  eventId: z.string().min(1).max(256)
    .refine((id) => id.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(id)).optional(),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  text: transcriptText,
}).refine((fragment) => fragment.endMs >= fragment.startMs);

interface Interval {
  startMs: number;
  endMs: number;
}

interface GroupBoundary {
  previousInputEnd: number;
  inputStart: number;
}

type ReviewKind = "confirmation" | "outcome";

const assentPhrase = String.raw`(?:yes|yeah|yep|okay|ok|sure|certainly|absolutely|correct|agreed|i agree|i confirm|that(?:'s| is) (?:fine|correct|right|perfect)|that works(?: for me)?|that appointment (?:is fine|works(?: for me)?)|(?:all|the) details are correct|everything is correct|go ahead|proceed|si|vale|de acuerdo|correcto|todo (?:esta |es )?correcto|perfecto|me parece bien|esta bien|adelante|confirmo|d'acord|correcte|tot (?:es )?correcte|perfecte|em va be|em sembla be|esta be|les dades son correctes|mis datos son correctos|endavant)`;
const courtesyPhrase = String.raw`(?:please|thank you|thanks|por favor|gracias|si us plau|gracies)`;
const assentOnly = new RegExp(String.raw`^${assentPhrase}(?:\s+(?:${assentPhrase}|${courtesyPhrase}))*$`);
const courtesyOnly = new RegExp(String.raw`^${courtesyPhrase}(?:\s+${courtesyPhrase})*$`);
const appointmentReference = String.raw`(?:it|that(?: one| appointment| slot| booking)?|this (?:appointment|slot|booking)|(?:the|my) (?:appointment|booking))`;
const actionPhrase = [
  String.raw`(?:book|reserve|schedule|confirm|cancel|move|reschedule|change)\s+${appointmentReference}(?:\s+to (?:that|the new) (?:time|date|slot))?`,
  String.raw`(?:register|enrol|enroll)\s+me(?:\s+(?:as a new patient|with (?:these|those|the) details))?`,
  String.raw`(?:go ahead|proceed)\s+with\s+(?:(?:the|my)\s+)?(?:booking|registration|cancellation|rescheduling|move|change)`,
  String.raw`i\s+(?:confirm|approve|authorise|authorize|accept)\s+(?:(?:the|my)\s+)?(?:appointment|booking|registration|cancellation|change|move|details)`,
  String.raw`(?:reserva|reserve|reservi|reserveu|reservem|reservar|confirma|confirme|confirmi|confirmeu|confirmar|cancela|cancele|cancelar|cancel[·]?(?:la|li|leu)|anul[·]?(?:la|li|leu)|cambia|cambie|cambiar|canvia|canvii|canvieu|canviar|mueve|mueva|mover|reprograma|reprograme|reprogrami)\s+(?:esa cita|esta cita|la cita|mi cita|aquesta cita|aquella cita|la meva cita|la reserva|aquesta hora)`,
  String.raw`(?:reservala|reservalo|reservela|reservelo|cancelala|cancelalo|cancelela|cancelelo|muevela|muevalo|cambiala|cambielo|confirmala|confirmalo|confirmela|confirmelo|reprogramala|reprogramela)`,
  String.raw`(?:registrame|registreme|inscribeme|inscribame|dame de alta|deme de alta|registra'm|registri'm|registreu-me|inscriu-me|inscriviu-me|dona'm d'alta|doni'm d'alta|doneu-me d'alta)`,
  String.raw`(?:confirmo|acepto|accepto|autorizo|autoritzo)\s+(?:la cita|la reserva|el registro|el registre|el alta|la inscripcion|la inscripcio|el cambio|el canvi|la cancelacion|la cancel[·]?lacio|els detalls|les dades|los datos|mis datos)`,
  String.raw`(?:adelante|endavant)\s+(?:con|amb)\s+(?:la cita|la reserva|el registro|el registre|la inscripcio|la cancelacion|el cambio|el canvi)`,
].join("|");
const actionApproval = new RegExp(
  String.raw`^(?:(?:${assentPhrase}|${courtesyPhrase})\s+)*(?:(?:can you|could you|would you|will you|i want you to|i would like you to|i'd like you to|puedes|puede|podrias|podria|pots|podeu|podries)\s+)?(?:please\s+)?(?:${actionPhrase})(?:\s+(?:${courtesyPhrase}|for me|as discussed|with those details))*\??$`,
);

/** A deliberately narrow lexical screen, not semantic consent or a turn boundary. */
function hasExplicitApproval(text: string): boolean {
  const clauses = normalizeHumanText(text).replace(/[’‘]/g, "'").replace(/¡/g, "")
    .split(/[.!;,]+/).map((clause) => clause.trim()).filter(Boolean);
  let approval = false;
  let action = false;
  for (const clause of clauses) {
    if (assentOnly.test(clause)) approval = true;
    else if (actionApproval.test(clause.replace(/^¿/, ""))) {
      approval = true;
      action = true;
    } else if (!courtesyOnly.test(clause) && !(action && courtesyOnly.test(clause.replace(/\?$/, "")))) {
      return false;
    }
  }
  return approval;
}

/**
 * Accumulates timed caller captions in arrival order, without normalizing their text.
 * Stability and grouping are rejection guards, NEVER authoritative turn completion.
 * A write still requires backend confirmed:true and the parent's fresh-delegation /
 * proposal guard. Only actual assistant audio captions belong in output().
 */
export class LiveTranscriptState {
  private version = 0;
  private caption = "";
  private updatedAt = 0;
  private inputEnd: number | undefined;
  private nextAudioStartsGroup = false;
  private uncertain = false;
  private boundary: GroupBoundary | undefined;
  private assistantIntervals: Interval[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly guard: ConfirmationGate;

  constructor(
    private readonly signal: AbortSignal,
    private readonly settleMs = 1200,
  ) {
    if (!Number.isFinite(settleMs) || settleMs < 0) throw new AppError("invalid_live_transcript_settle_ms");
    this.guard = new ConfirmationGate(() => this.version, signal);
  }

  get generation(): number { return this.version; }
  get text(): string { return this.caption; }

  input(fragment: LiveTranscriptFragment): { generation: number; newUtterance: boolean; duplicate: boolean } {
    this.validateFragment(fragment);
    const key = this.eventKey("input", fragment);
    if (key !== undefined && this.seenEventIds.has(key)) {
      return { generation: this.version, newUtterance: false, duplicate: true };
    }
    this.checkEventCapacity(key);
    // Empty deltas have no caller evidence or timing; whitespace deltas remain verbatim.
    if (fragment.text.length === 0) {
      if (key !== undefined) this.seenEventIds.add(key);
      return { generation: this.version, newUtterance: false, duplicate: false };
    }

    const previousEnd = this.inputEnd;
    const separated = previousEnd !== undefined && fragment.startMs - previousEnd > GROUP_GAP_MS &&
      this.hasAssistantBetween(previousEnd, fragment.startMs);
    const newUtterance = previousEnd === undefined || this.nextAudioStartsGroup || separated;
    if ((newUtterance ? 0 : this.caption.length) + fragment.text.length > MAX_TEXT) {
      this.uncertain = true;
      throw new AppError("live_transcript_too_large", "The live caller caption group exceeds 32000 characters. Nothing was truncated; request a short fresh reply.");
    }
    const late = previousEnd !== undefined && fragment.endMs < previousEnd;
    if (key !== undefined) this.seenEventIds.add(key);
    this.caption = newUtterance ? fragment.text : this.caption + fragment.text;
    this.uncertain = late || this.uncertain && !separated;
    if (newUtterance) {
      this.boundary = separated && previousEnd !== undefined
        ? { previousInputEnd: previousEnd, inputStart: fragment.startMs } : undefined;
    }
    // A late delta must not move the timeline backwards and manufacture a new group.
    this.inputEnd = previousEnd === undefined ? fragment.endMs : Math.max(previousEnd, fragment.endMs);
    this.nextAudioStartsGroup = false;
    this.observe();
    return { generation: this.version, newUtterance, duplicate: false };
  }

  output(fragment: LiveTranscriptFragment): void {
    this.validateFragment(fragment);
    const key = this.eventKey("output", fragment);
    if (key !== undefined && this.seenEventIds.has(key)) return;
    this.checkEventCapacity(key);
    if (fragment.text.trim() && fragment.endMs > fragment.startMs) {
      const ranges = [...this.assistantIntervals, { startMs: fragment.startMs, endMs: fragment.endMs }]
        .sort((a, b) => a.startMs - b.startMs);
      const merged: Interval[] = [];
      for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
        else merged.push({ ...range });
      }
      if (merged.length > MAX_EVENTS) {
        this.uncertain = true;
        throw new AppError("live_transcript_interval_limit", "Too many live assistant caption intervals; no timing evidence was discarded.");
      }
      this.assistantIntervals = merged;
      // Late output can reveal that the purported separating speech actually overlapped.
      if (this.boundary && !this.hasAssistantBetween(this.boundary.previousInputEnd, this.boundary.inputStart)) {
        this.uncertain = true;
      }
    }
    if (key !== undefined) this.seenEventIds.add(key);
  }

  /** An explicit diagnostic caller message; even an empty message invalidates the old version. */
  typed(text: string): number {
    this.assertConnected();
    if (!transcriptText.safeParse(text).success) {
      this.uncertain = true;
      throw new AppError("invalid_live_transcript_text", "Live caller text must be a string of at most 32000 characters.");
    }
    this.caption = text;
    this.uncertain = false;
    this.boundary = undefined;
    this.nextAudioStartsGroup = true;
    this.observe();
    return this.version;
  }

  async reviewConfirmation(turn: number): Promise<void> {
    await this.waitForStability(turn, "confirmation");
    await this.guard.review(turn);
    this.assertReviewable(turn, "confirmation");
    if (!hasExplicitApproval(this.caption)) {
      throw new AppError(
        "confirmation_needs_clarification",
        "The stable live captions do not contain a short explicit, unqualified approval. Nothing was submitted. Ask one short final confirmation of the prepared action in a fresh caller reply; an identifier or unrelated answer is not approval.",
      );
    }
  }

  async reviewOutcome(turn: number, reason: string, context?: OutcomeReviewContext): Promise<void> {
    this.assertCurrent(turn);
    if (reason !== "medical_emergency") await this.waitForStability(turn, "outcome");
    await this.guard.reviewOutcome(turn, reason, context);
    if (reason === "medical_emergency") this.assertCurrent(turn);
    else this.assertReviewable(turn, "outcome");
  }

  private observe(): void {
    this.version += 1;
    this.updatedAt = performance.now();
    this.guard.observe(this.version, this.caption);
  }

  private validateFragment(fragment: LiveTranscriptFragment): void {
    this.assertConnected();
    if (!fragmentSchema.safeParse(fragment).success) {
      this.uncertain = true;
      throw new AppError(
        "invalid_live_transcript_fragment",
        "Live captions require finite nonnegative ordered timestamps, text of at most 32000 characters, and an optional nonblank event ID of at most 256 characters without control characters.",
      );
    }
  }

  private eventKey(direction: "input" | "output", fragment: LiveTranscriptFragment): string | undefined {
    // An assistant event must never suppress caller evidence if IDs are reused by direction.
    return fragment.eventId === undefined ? undefined : `${direction}:${fragment.eventId}`;
  }

  private checkEventCapacity(key: string | undefined): void {
    if (key !== undefined && this.seenEventIds.size >= MAX_EVENTS) {
      this.uncertain = true;
      throw new AppError("live_transcript_event_limit", "The live caption event limit (4096) was reached. No deduplication IDs were evicted; do not rely on incomplete captions.");
    }
  }

  private hasAssistantBetween(inputEnd: number, nextStart: number): boolean {
    return this.assistantIntervals.some((interval) => interval.startMs >= inputEnd && interval.endMs <= nextStart);
  }

  private assertConnected(): void {
    if (this.signal.aborted) throw new AppError("call_cancelled");
  }

  private assertCurrent(turn: number): void {
    this.assertConnected();
    if (turn !== this.version) {
      throw new AppError("stale_turn", "The caller captions changed; review their latest request before submitting.");
    }
  }

  private assertReviewable(turn: number, kind: ReviewKind): void {
    this.assertCurrent(turn);
    if (this.uncertain) {
      throw new AppError("live_transcript_uncertain", kind === "confirmation"
        ? "Live captions arrived out of order or are incomplete. Nothing was submitted. Ask one short explicit final confirmation in a genuinely fresh caller reply; waiting alone does not clear this uncertainty."
        : "Live caller captions arrived out of order or are incomplete. Nothing was submitted. Obtain a genuinely fresh reply clarifying the request, not an extra refusal confirmation; waiting alone does not clear this uncertainty.");
    }
  }

  private async waitForStability(turn: number, kind: ReviewKind): Promise<void> {
    const deadline = performance.now() + REVIEW_WAIT_MS;
    for (;;) {
      this.assertReviewable(turn, kind);
      const now = performance.now();
      const remaining = this.settleMs - (now - this.updatedAt);
      if (this.caption.trim() && remaining <= 0) return;
      if (now >= deadline) {
        throw new AppError(`${kind}_transcript_pending`, kind === "confirmation"
          ? "Current live caller captions are missing or still settling. Nothing was submitted. Wait for stable captions or request one short explicit final confirmation; an idle gap does not prove turn completion."
          : "Current live caller captions are missing or still settling. Nothing was submitted. Wait for reliable captions or clarify the request; do not ask for an extra refusal confirmation.");
      }
      try {
        await delay(Math.max(1, Math.min(25, deadline - now, this.caption.trim() ? remaining : 25)), undefined, {
          signal: this.signal,
        });
      } catch (error) {
        this.assertConnected();
        throw error;
      }
    }
  }
}
