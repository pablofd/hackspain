import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill, barChart, donut, legend, comboChart, emptyState } from "../components/ui.js";
import { sourcesCard, cloudCard } from "../components/sources.js";
import { snapshot, calls, outcomeLabels, actionLabels, formatDate } from "../data/api.js";
import { RANGES, DEFAULT_RANGE, metrics, rangeById, successVsLatency, callsInRange } from "../data/insights.js";

export const meta = { title: "Inicio", sub: "Actividad observada del agente · Prosper y Azure" };
const rounded = (value) => Number.isFinite(value) ? Math.round(value) : "—";

export function render() {
  let range = snapshot.historyDays < 7 ? "1d" : DEFAULT_RANGE;
  const body = el("div", { class: "stack stack--lg" });
  const rangeBar = el("div", { class: "segmented" }, ...RANGES.filter((item) => item.days <= snapshot.historyDays).map((item) =>
    el("button", { class: item.id === range ? "is-active" : "", onclick: (event) => {
      range = item.id;
      rangeBar.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
      event.currentTarget.classList.add("is-active");
      paint();
    } }, item.label)));

  function paint() {
    const m = metrics(range);
    const list = callsInRange(range);
    const when = rangeById(range).short;
    const hour = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" });
    const volume = Array.from({ length: 24 }, (_, index) => ({
      label: String(index).padStart(2, "0"),
      value: list.filter((call) => call.startedAt && Number(hour.format(new Date(call.startedAt))) === index).length,
    }));
    const verbs = list.flatMap((call) => call.actions.length ? snapshot.calls.find((item) => item.id === call.id).actions : []);
    const colours = ["var(--pitch-black)", "var(--dusty-denim)", "var(--blue-slate)", "var(--lipstick-red)", "#adb4ba", "#d5d9dd"];
    const reasons = Object.entries(actionLabels).flatMap(([action, label], index) => {
      const count = verbs.filter((item) => item.action === action).length;
      return count ? [{ label, value: count / verbs.length * 100, color: colours[index] }] : [];
    });
    const series = successVsLatency(range);
    const events = calls.flatMap((call) => call.events.map((event) => ({ ...event, callId: call.id })))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 6);
    mount(body,
      el("section", { class: "hero" },
        el("div", { class: "hero__art brand-wash" }),
        el("div", { class: "hero__body" },
          el("p", { class: "hero__eyebrow" }, "Recepción agéntica · solo lectura"),
          el("h2", { class: "hero__title" }, snapshot.clinic?.name ?? "Clínica no disponible"),
          el("p", { class: "hero__text" }, "Actividad real del backend. Un recibo confirma que Prosper recibió una acción; no prueba una reserva en el EHR ni un acierto del juez."),
          el("a", { class: "btn btn--primary", href: "#/llamadas" }, icon("phone", "nav__icon"), "Ver llamadas"))),
      el("div", { class: "grid grid--3" },
        stat({ label: "Llamadas observadas", value: m.total, foot: when }),
        stat({ label: "Con reserva comunicada", value: m.booked, foot: "BOOK o RESCHEDULE recibido", tint: "ok" }),
        stat({ label: "Sin acción registrada", value: m.missed, foot: "NO_ACTION recibido", onClick: () => {
          location.hash = `#/llamadas/mapa?estado=missed&rango=${range}`;
        } }),
        stat({ label: "Con recibo de acción", value: m.receivedShare, unit: "%", foot: "Sobre la muestra observada, no tasa de éxito" }),
        stat({ label: "Duración media del registro", value: m.avgHandle, foot: "Solo registros con inicio y cierre" }),
        stat({ label: "Escalados comunicados", value: m.escalated, foot: "ESCALATE, no transferencia telefónica" })),
      el("div", { class: "grid grid--main" },
        card({ title: "Volumen por franja horaria", sub: `${when} · inicios conocidos, hora de Madrid` },
          list.some((call) => call.startedAt) ? barChart(volume) : emptyState("Sin inicios de llamada", "Los recibos no indican cuándo comenzó una llamada.")),
        card({ title: "Acciones recibidas", sub: "Una llamada puede tener varias acciones" },
          reasons.length ? donut(reasons, { center: String(verbs.length) }) : emptyState("Sin acciones", "No hay recibos observados en este rango."),
          legend(reasons))),
      el("div", { class: "grid grid--main" },
        card({ title: "Últimas llamadas", flush: true, actions: el("a", { class: "btn btn--sm", href: "#/llamadas" }, "Ver todas") },
          el("div", { class: "table-wrap" }, el("table", { class: "data" },
            el("thead", {}, el("tr", {}, ...["Llamada / paciente", "Acción", "Registro", "Duración"].map((label) => el("th", {}, label)))),
            el("tbody", {}, ...list.slice(0, 6).map((call) => el("tr", { onclick: () => {
              location.hash = `#/llamadas?llamada=${encodeURIComponent(call.id)}`;
            } },
            el("td", {}, el("div", { class: "cell-main" }, call.caller), el("div", { class: "cell-sub" }, call.time)),
            el("td", {}, call.reason), el("td", {}, pill(outcomeLabels[call.outcome].text)), el("td", { class: "mono" }, call.duration))))))),
        card({ title: "Actividad del sistema", sub: "Eventos técnicos; no transcripciones" },
          events.length ? el("div", { class: "timeline" }, ...events.map((event) =>
            el("div", { class: "timeline__item" },
              el("div", { class: "timeline__time" }, formatDate(event.timestamp)),
              el("div", { class: "timeline__title" }, event.code),
              el("div", { class: "timeline__desc" }, event.callId)))) : emptyState("Sin eventos", "Consulta el estado de la fuente de metadatos locales."))),
      el("div", { class: "grid grid--3" },
        stat({ label: "Duración media de respuesta backend", value: rounded(m.latency), unit: "ms", foot: "Spans chat; no latencia del turno de voz" }),
        stat({ label: "Calidad MOS / jitter", value: "—", foot: "El backend no mide estas magnitudes" }),
        stat({ label: "Exactitud de transcripción", value: "—", foot: "No hay referencia ni confianza ASR disponible" })),
      card({ title: "Registros recibidos frente a duración de respuesta", sub: "Solo días con spans correlacionados; no implica causalidad" },
        series.length ? comboChart(series) : emptyState("Sin trazas correlacionadas", "Configura Application Insights / Log Analytics para esta gráfica."),
        legend([{ label: "Con recibo (%)", color: "var(--pitch-black)" }, { label: "Respuesta backend (ms)", color: "var(--lipstick-red)" }])),
      el("div", { class: "grid grid--2" }, cloudCard("openAi"), cloudCard("speech")),
      el("div", { class: "grid grid--2" },
        sourcesCard(),
        card({ title: "Indicadores no implementados" },
          emptyState("Sentimiento, NPS y riesgo clínico: no disponibles",
            "No se calculan puntuaciones ni se deducen del resultado de una llamada. Costes y cumplimiento tampoco se infieren."))));
  }
  const root = el("div", { class: "view" }, rangeBar, body);
  root.update = paint;
  paint();
  return root;
}
