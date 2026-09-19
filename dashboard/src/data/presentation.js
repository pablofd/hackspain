import * as live from "./api.js";

export let presentation = "real";
export function setPresentation(value) {
  if (!["real", "demo"].includes(value)) throw new Error("dashboard_invalid_presentation");
  presentation = value;
}

const names = ["Lucía Demo", "Tomás Demo", "María Demo", "Jorge Demo", "Ana Demo", "Luis Demo",
  "Núria Demo", "Elena Demo", "Pablo Demo", "Marta Demo", "Sergio Demo", "Carla Demo"];
const reasons = ["Agendar cita", "Reprogramar cita", "Información de horarios", "Consultar disponibilidad", "Cancelar cita", "Verificar cobertura"];
const demoClients = names.map((name, index) => ({
  id: `visual-patient-${index + 1}`, name, phone: `+34 600 000 ${String(index + 1).padStart(3, "0")}`,
  insurer: "Plan de ejemplo", tags: ["Paciente simulado"], risk: "unavailable",
  lastContact: "Escenario visual", nextAppt: "Cita de ejemplo",
}));
const created = Date.now();
const demoCalls = Array.from({ length: 168 }, (_, index) => {
  const patient = demoClients[index % names.length];
  const daysAgo = Math.floor(index / 12);
  const outcome = index < 2 ? "pending" : index % 11 === 0 ? "escalated" : index % 7 === 0 ? "no_action" : "resolved";
  const booked = outcome === "resolved" && index % 3 !== 2;
  const action = booked ? "BOOK" : outcome === "escalated" ? "ESCALATE" : outcome === "no_action" ? "NO_ACTION" : "CANCEL";
  const startedAt = new Date(created - daysAgo * 86_400_000 - (index % 12) * 3_600_000 - 120_000).toISOString();
  const durationMs = 90_000 + (index * 17 % 90) * 1000;
  const p50 = 360 + index * 23 % 220;
  const reason = reasons[index % reasons.length];
  const transcript = [
    ["user", `Buenos días, soy ${patient.name}. Querría ${reason.toLocaleLowerCase("es")}.`],
    ["assistant", "Buenos días. Claro, vamos a revisar su solicitud."],
    ["user", "Por la mañana me viene mejor. ¿Hay alguna opción esta semana?"],
    ["assistant", "En este ejemplo tenemos una opción el jueves por la mañana. ¿Le encaja?"],
    ["user", "Sí, me encaja. Gracias por la ayuda."],
    ["assistant", "Perfecto. Esta conversación es una muestra visual, no se ha creado ninguna cita."],
  ].slice(0, index < 2 ? 4 : 6).map(([speaker, text], turn) => ({
    speaker, text, itemId: `visual-${index}-${turn}`, timestamp: new Date(Date.parse(startedAt) + turn * 14_000).toISOString(),
  }));
  return {
    id: `visual-call-${index + 1}`, simulated: true, caller: patient.name, phone: patient.phone,
    personKey: patient.id, patientIds: [patient.id], reason, outcome, booked, missed: outcome === "no_action",
    missReason: outcome === "no_action" ? "Sin hueco en el escenario de ejemplo" : null,
    live: index < 2, openRecord: index < 2, startedAt, endedAt: index < 2 ? null : new Date(Date.parse(startedAt) + durationMs).toISOString(),
    endReason: "Ejemplo visual", receiptSource: outcome === "pending" ? null : "simulado",
    durationMs, duration: live.formatDuration(durationMs), time: index < 2 ? "En curso · demo" : daysAgo ? `Hace ${daysAgo} días` : "Hoy · demo",
    daysAgo, direction: "Entrante", sentiment: index % 7 === 0 ? "negative" : index % 3 === 0 ? "neutral" : "positive",
    actions: outcome === "pending" ? ["Consultando agenda · ejemplo"] : [booked ? "Reserva simulada · sin envío" : `${reason} · ejemplo sin envío`],
    demoActions: outcome === "pending" ? [] : [{ action, reason: null }],
    transcript, events: [],
    technical: {
      inputBytes: 8000 * durationMs / 1000, outputBytes: 6000 * durationMs / 1000, interruptions: index % 3, transcriptEvents: transcript.length,
      trace: { responseDurationP50Ms: p50, responseDurationP95Ms: p50 + 280, responseDurationTotalMs: p50 * 6,
        responseCount: 6, inputTokens: 940 + index * 21, outputTokens: 350 + index * 9 },
    },
    visualQuality: { first: p50 + 60, p50, p95: p50 + 280, mos: 4.3 + (index % 3) / 10,
      jitter: 8 + index % 12, loss: 0.2, asr: 94 + index % 5, bargeIns: index % 3, silence: 2 + index % 3 },
  };
});

export const demoSentiments = {
  positive: { text: "Positivo", cls: "text-ok" }, neutral: { text: "Neutro", cls: "muted" },
  negative: { text: "Frustración", cls: "text-alert" },
};

// Illustrative chart series from platform b5cdcfa, never mixed into live observations.
export const demoOverview = {
  volume: [
    { label: "08", value: 26 }, { label: "09", value: 48 }, { label: "10", value: 61 },
    { label: "11", value: 54 }, { label: "12", value: 43 }, { label: "13", value: 31 },
    { label: "16", value: 38 }, { label: "17", value: 46 }, { label: "18", value: 35 }, { label: "19", value: 22 },
  ],
  reasons: [
    { label: "Agendar cita", value: 38, color: "var(--pitch-black)" },
    { label: "Reprogramar", value: 21, color: "var(--dusty-denim)" },
    { label: "Resultados", value: 16, color: "var(--blue-slate)" },
    { label: "Triaje clínico", value: 14, color: "var(--lipstick-red)" },
    { label: "Facturación", value: 11, color: "rgba(100, 110, 120, 0.32)" },
  ],
  calls: { trend: 12.4, spark: [18, 24, 21, 30, 27, 38, 34, 42, 39, 48, 52, 47] },
  bookings: { trend: 4.1, spark: [62, 66, 68, 71, 70, 75, 78, 80, 79, 83, 85, 87] },
  duration: { trend: -8.2, spark: [42, 40, 38, 39, 35, 34, 33, 31, 30, 29, 28, 26] },
  escalations: { trend: -3.6, spark: [12, 14, 11, 13, 10, 12, 9, 11, 8, 9, 7, 6] },
};

export function getPresentation() {
  if (presentation === "real") return { snapshot: live.snapshot, calls: live.calls, clients: live.clients, simulated: false };
  return {
    simulated: true, calls: demoCalls, clients: demoClients,
    snapshot: {
      ...live.snapshot, historyDays: 30,
      clinic: { name: "Clínica Demo", patientCount: names.length,
        providers: [{ id: "visual-provider", name: "Profesional de ejemplo" }],
        locations: [{ id: "visual-site", name: "Sede de ejemplo" }] },
      health: { activeCalls: 2, capabilities: ["voice", "clinic", "book", "reschedule", "cancel"], voiceDeployment: "Escenario visual" },
      calls: demoCalls.map((call) => ({ ...call, actions: call.demoActions })),
    },
  };
}
