import { calls } from "./mock.js";

export const RANGES = [
  { id: "1d", label: "Hoy", days: 1, short: "hoy" },
  { id: "7d", label: "7 días", days: 7, short: "últimos 7 días" },
  { id: "30d", label: "30 días", days: 30, short: "últimos 30 días" },
  { id: "90d", label: "Trimestre", days: 90, short: "último trimestre" },
];

export const DEFAULT_RANGE = "7d";

export const rangeById = (id) => RANGES.find((r) => r.id === id) || RANGES.find((r) => r.id === DEFAULT_RANGE);

export const inRange = (c, rangeId) => c.daysAgo < rangeById(rangeId).days;

/* Mismo número de días justo antes del rango, para comparar tendencia */
const inPreviousRange = (c, rangeId) => {
  const { days } = rangeById(rangeId);
  return c.daysAgo >= days && c.daysAgo < days * 2;
};

export const callsInRange = (rangeId) => calls.filter((c) => inRange(c, rangeId));

/* Estados que comparten la lista de llamadas y el mapa */
export const STATES = [
  { id: "all", label: "Todas" },
  { id: "live", label: "En directo" },
  { id: "booked", label: "Con cita cerrada" },
  { id: "missed", label: "Reservas sin cerrar" },
  { id: "resolved", label: "Resueltas" },
  { id: "escalated", label: "Escaladas" },
  { id: "pending", label: "Pendientes" },
];

export function matchesState(c, state) {
  switch (state) {
    case "all":
      return true;
    case "live":
      return Boolean(c.live);
    case "booked":
      return Boolean(c.booked);
    case "missed":
      return Boolean(c.missed);
    default:
      return c.outcome === state;
  }
}

export const stateLabel = (id) => STATES.find((s) => s.id === id)?.label || "Todas";

const seconds = (d) => {
  const [, m, s] = d.match(/(\d+)m (\d+)s/) || [];
  return m ? Number(m) * 60 + Number(s) : 0;
};

const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

const change = (now, before) => (before ? Number((((now - before) / before) * 100).toFixed(1)) : null);

/* Telemetría de demo derivada del identificador: estable entre cargas y distinta por llamada */
export function callQuality(c) {
  const seed = [...c.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const pick = (min, max, salt) => min + ((seed * 7 + salt * 31) % (max - min + 1));
  const p50 = pick(320, 620, 2);
  return {
    first: pick(380, 760, 1),
    p50,
    p95: p50 + pick(180, 520, 3),
    mos: Number((3.6 + ((seed + 5) % 13) / 10).toFixed(1)),
    jitter: pick(6, 28, 4),
    loss: Number(((seed % 14) / 10).toFixed(1)),
    asr: pick(88, 98, 5),
    bargeIns: pick(0, 4, 6),
    silence: pick(2, 9, 7),
  };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function summarise(list) {
  const closed = list.filter((c) => !c.live);
  const durations = closed.map((c) => seconds(c.duration)).filter(Boolean);
  const q = list.map(callQuality);
  return {
    total: list.length,
    booked: list.filter((c) => c.booked).length,
    missed: list.filter((c) => c.missed).length,
    escalated: list.filter((c) => c.outcome === "escalated").length,
    automation: pct(closed.filter((c) => c.outcome === "resolved").length, closed.length),
    avgSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    latency: Math.round(mean(q.map((x) => x.p50))),
    latencyP95: Math.round(mean(q.map((x) => x.p95))),
    mos: Number(mean(q.map((x) => x.mos)).toFixed(1)),
    jitter: Math.round(mean(q.map((x) => x.jitter))),
    asr: Math.round(mean(q.map((x) => x.asr))),
    bargeIns: Number(mean(q.map((x) => x.bargeIns)).toFixed(1)),
    // El redondeo aplana la comparacion entre periodos: la tendencia usa el promedio exacto
    mosRaw: mean(q.map((x) => x.mos)),
    asrRaw: mean(q.map((x) => x.asr)),
  };
}

/* Serie diaria para cruzar resolución y latencia: si el agente tarda, se resuelve peor */
export function successVsLatency(rangeId) {
  const { days } = rangeById(rangeId);
  const step = Math.max(1, Math.ceil(days / 12));
  const buckets = [];

  for (let start = 0; start < days; start += step) {
    const slice = calls.filter((c) => c.daysAgo >= start && c.daysAgo < start + step && !c.live);
    if (!slice.length) continue;
    const q = slice.map(callQuality);
    buckets.push({
      label: start === 0 ? "Hoy" : step === 1 ? `-${start}d` : `-${start + step - 1}d`,
      success: pct(slice.filter((c) => c.outcome === "resolved").length, slice.length),
      latency: Math.round(mean(q.map((x) => x.p50))),
      calls: slice.length,
    });
  }
  return buckets.reverse();
}

export function metrics(rangeId) {
  const now = summarise(calls.filter((c) => inRange(c, rangeId)));
  const before = summarise(calls.filter((c) => inPreviousRange(c, rangeId)));
  const wanted = now.booked + now.missed;
  return {
    ...now,
    missedShare: pct(now.missed, wanted),
    avgHandle: `${Math.floor(now.avgSeconds / 60)}m ${String(now.avgSeconds % 60).padStart(2, "0")}s`,
    trend: {
      total: change(now.total, before.total),
      booked: change(now.booked, before.booked),
      missed: change(now.missed, before.missed),
      escalated: change(now.escalated, before.escalated),
      automation: change(now.automation, before.automation),
      avgSeconds: change(now.avgSeconds, before.avgSeconds),
      latency: change(now.latency, before.latency),
      mos: change(now.mosRaw, before.mosRaw),
      asr: change(now.asrRaw, before.asrRaw),
    },
  };
}
