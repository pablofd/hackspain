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

function summarise(list) {
  const closed = list.filter((c) => !c.live);
  const durations = closed.map((c) => seconds(c.duration)).filter(Boolean);
  return {
    total: list.length,
    booked: list.filter((c) => c.booked).length,
    missed: list.filter((c) => c.missed).length,
    escalated: list.filter((c) => c.outcome === "escalated").length,
    automation: pct(closed.filter((c) => c.outcome === "resolved").length, closed.length),
    avgSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
  };
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
    },
  };
}
