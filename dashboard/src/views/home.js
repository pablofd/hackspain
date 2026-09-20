import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill, barChart, stackedBars, bar, donut, legend, comboChart, emptyState } from "../components/ui.js";
import { cloudCard } from "../components/sources.js";
import { outcomeLabels, actionLabels, formatDate } from "../data/api.js";
import { getPresentation, demoOverview } from "../data/presentation.js";
import { RANGES, DEFAULT_RANGE, metrics, rangeById, successVsLatency, callsInRange, callQuality } from "../data/insights.js";

export const meta = { title: "Inicio", sub: "Actividad y rendimiento de maio" };
const rounded = (value) => Number.isFinite(value) ? Math.round(value) : "—";

export function render() {
  const { snapshot } = getPresentation();
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
    const { snapshot, calls, simulated } = getPresentation();
    const m = metrics(range);
    const list = callsInRange(range);
    const when = rangeById(range).short;
    const hour = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" });
    const volume = simulated ? demoOverview.volume : Array.from({ length: 12 }, (_, index) => ({
      label: String(index * 2).padStart(2, "0"),
      value: list.filter((call) => call.startedAt && Math.floor(Number(hour.format(new Date(call.startedAt))) / 2) === index).length,
    }));
    const verbs = list.flatMap((call) => call.actions.length ? snapshot.calls.find((item) => item.id === call.id).actions : []);
    const colours = ["var(--pitch-black)", "var(--dusty-denim)", "var(--blue-slate)", "var(--lipstick-red)", "#adb4ba", "#d5d9dd"];
    const reasons = simulated ? demoOverview.reasons : Object.entries(actionLabels).flatMap(([action, label], index) => {
      const count = verbs.filter((item) => item.action === action).length;
      return count ? [{ label, value: count / verbs.length * 100, color: colours[index] }] : [];
    });
    const series = successVsLatency(range);
    const events = calls.flatMap((call) => call.events.map((event) => ({ ...event, callId: call.id })))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 6);
    const weekly = Array.from({ length: 7 }, (_, index) => {
      const day = list.filter((call) => call.daysAgo === 6 - index);
      const received = day.filter((call) => call.receiptSource).length;
      return { label: index === 6 ? "Hoy" : `-${6 - index}d`, automated: day.length ? received / day.length * 100 : 0,
        human: day.length ? (day.length - received) / day.length * 100 : 0 };
    });
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const quality = list.map(callQuality);
    const illustrative = (kind) => simulated ? demoOverview[kind] : {};
    mount(body,
      el("section", { class: "hero" },
        el("div", { class: "hero__art brand-wash" }),
        el("div", { class: "hero__body" },
          el("p", { class: "hero__eyebrow" }, `Recepción agéntica${simulated ? " · demo visual" : ""}`),
          el("h2", { class: "hero__title" }, simulated ? "Bienvenido a maio" : snapshot.clinic?.name ?? "Bienvenido a maio"),
          el("p", { class: "hero__text" }, simulated
            ? "Una recepción que escucha, organiza y acompaña. Explora conversaciones y analítica de ejemplo con el diseño original de la plataforma."
            : "Tu recepción, de un vistazo. Consulta las conversaciones del agente, las acciones comunicadas y la actividad de tu clínica."),
          el("div", { class: "row row--wrap" },
            el("a", { class: "btn btn--primary", href: "#/llamadas" }, icon("phone", "nav__icon"), "Ver llamadas"),
            el("a", { class: "btn", href: "#/configuracion" }, icon("settings", "nav__icon"), "Ver configuración")))),
      el("div", { class: "row row--wrap" }, rangeBar,
        el("span", { class: "text-sm muted ml-auto" }, simulated ? "Ejemplos locales · sin efectos reales" : "Muestra observada · recibos ≠ veredictos")),
      el("div", { class: "grid grid--3" },
        stat({ label: simulated ? "Llamadas atendidas" : "Llamadas observadas", value: m.total, foot: when, ...illustrative("calls") }),
        stat({ label: simulated ? "Citas de ejemplo" : "Con reserva comunicada", value: m.booked, foot: simulated ? "Escenario simulado" : "BOOK / RESCHEDULE recibido", tint: "ok", ...illustrative("bookings") }),
        stat({ label: "Sin acción registrada", value: m.missed, foot: simulated ? "Escenario simulado" : "NO_ACTION recibido", ...illustrative("escalations"), lowerIsBetter: true, onClick: () => {
          location.hash = `#/llamadas/mapa?estado=missed&rango=${range}`;
        } }),
        stat({ label: "Con recibo de acción", value: m.receivedShare, unit: "%", foot: simulated ? "Simulado" : "No es una tasa de éxito", ...illustrative("bookings") }),
        stat({ label: "Duración media", value: m.avgHandle, foot: "Por llamada con cierre", ...illustrative("duration"), lowerIsBetter: true }),
        stat({ label: "Escalados comunicados", value: m.escalated, foot: simulated ? "Escenario simulado" : "Acciones ESCALATE", ...illustrative("escalations"), lowerIsBetter: true })),
      el("div", { class: "grid grid--main" },
        card({ title: "Volumen por franja horaria", sub: simulated ? "Franjas ilustrativas · demo visual" : `${when} · franjas de 2 h, Madrid` },
          list.some((call) => call.startedAt) ? barChart(volume) : emptyState("Sin inicios de llamada", "Los recibos no indican cuándo comenzó una llamada.")),
        card({ title: simulated ? "Motivos de llamada" : "Acciones recibidas", sub: simulated ? "Distribución ilustrativa, no observada" : "Una llamada puede tener varias acciones" },
          reasons.length ? el("div", { class: "row", style: { justifyContent: "center" } }, donut(reasons, { center: String(simulated ? m.total : verbs.length) }))
            : emptyState("Sin acciones", "No hay recibos observados en este rango."),
          legend(reasons))),
      el("div", { class: "grid grid--main" },
        card({ title: "Con recibo vs. sin recibo", sub: simulated ? "Distribución de ejemplo por día" : "Proporción en la muestra; no automatización ni éxito" },
          list.length ? stackedBars(weekly) : emptyState("Sin llamadas en el periodo", "Los datos aparecerán al observar llamadas."),
          legend([{ label: "Con recibo", color: "var(--pitch-black)" }, { label: "Sin recibo", color: "var(--dusty-denim)" }])),
        card({ title: "Distribución de acciones", sub: simulated ? "Ejemplo visual" : "Acciones recibidas en el periodo" },
          reasons.length ? el("div", { class: "list" }, ...reasons.map((reason) =>
            el("div", { class: "list__item" }, el("div", { class: "list__body" },
              el("div", { class: "list__title" }, reason.label), bar(reason.value)),
            el("span", { class: "mono" }, `${Math.round(reason.value)}%`))))
            : el("p", { class: "text-sm muted" }, "Sin acciones observadas."))),
      el("div", { class: "grid grid--main" },
        card({ title: "Últimas llamadas", flush: true, actions: el("a", { class: "btn btn--sm", href: "#/llamadas" }, "Ver todas") },
          el("div", { class: "table-wrap" }, el("table", { class: "data" },
            el("thead", {}, el("tr", {}, ...["Llamada / paciente", "Acción", "Registro", "Duración"].map((label) => el("th", {}, label)))),
            el("tbody", {}, ...list.slice(0, 6).map((call) => el("tr", { onclick: () => {
              location.hash = `#/llamadas?llamada=${encodeURIComponent(call.id)}`;
            } },
            el("td", {}, el("div", { class: "cell-main" }, call.caller), el("div", { class: "cell-sub" }, call.time)),
            el("td", {}, call.reason), el("td", {}, pill(outcomeLabels[call.outcome].text)), el("td", { class: "mono" }, call.duration))))))),
        el("div", { class: "stack stack--lg" },
        card({ title: "Actividad del sistema", sub: simulated ? "Escenario visual" : "Eventos técnicos" },
          events.length ? el("div", { class: "timeline" }, ...events.map((event) =>
            el("div", { class: "timeline__item" },
              el("div", { class: "timeline__time" }, formatDate(event.timestamp)),
              el("div", { class: "timeline__title" }, event.code),
              el("div", { class: "timeline__desc" }, event.callId)))) : simulated
              ? el("div", { class: "timeline" }, ...calls.slice(2, 5).map((call) =>
                el("div", { class: "timeline__item" }, el("div", { class: "timeline__time" }, "Ejemplo"),
                  el("div", { class: "timeline__title" }, call.reason), el("div", { class: "timeline__desc" }, call.caller))))
              : el("p", { class: "text-sm muted" }, "Sin eventos recientes.")),
        card({ title: "maio ahora mismo", tint: "accent" },
          el("dl", { class: "kv" },
            el("dt", {}, "Llamadas activas"), el("dd", {}, snapshot.health?.activeCalls ?? "—"),
            el("dt", {}, "Acciones habilitadas"), el("dd", {}, snapshot.health?.capabilities.length ?? "—"),
            el("dt", {}, "Canal"), el("dd", {}, "Voz entrante"),
            el("dt", {}, "Fuente"), el("dd", {}, simulated ? "Demo visual" : "Salud del agente"))))),
      simulated ? el("div", { class: "grid grid--3" },
        card({ title: "Satisfacción · ejemplo", tint: "ok" },
          el("div", { class: "stat__value" }, "62"), el("p", { class: "card__sub" }, "NPS simulado · no hay encuestas reales")),
        card({ title: "Cumplimiento · ejemplo" },
          el("dl", { class: "kv" }, el("dt", {}, "Aviso de IA"), el("dd", {}, "Ejemplo"),
            el("dt", {}, "Consentimiento"), el("dd", {}, "No evaluado"),
            el("dt", {}, "Auditoría real"), el("dd", {}, "No realizada"))),
        card({ title: "Alertas del escenario", tint: "alert" },
          el("div", { class: "timeline" }, el("div", { class: "timeline__item" },
            el("div", { class: "timeline__title" }, "Pico de demanda · ejemplo"),
            el("div", { class: "timeline__desc" }, "Una muestra de cómo se visualizaría una alerta."))))) : null,
      el("div", { class: "row row--wrap" }, el("div", { class: "section-title" }, "Calidad técnica de las conversaciones"),
        el("a", { class: "btn btn--sm btn--ghost ml-auto", href: "#/llamadas" }, "Ver por llamada", icon("arrowUpRight", "nav__icon"))),
      el("div", { class: "grid grid--3" },
        stat({ label: "Respuesta del backend", value: rounded(m.latency), unit: "ms", foot: simulated ? "Latencia simulada" : "Spans chat; no latencia acústica" }),
        simulated ? stat({ label: "Calidad de audio", value: mean(quality.map((q) => q.mos)).toFixed(1), unit: "/5", foot: "MOS simulado" })
          : stat({ label: "Audio enviado", value: list.some((call) => Number.isFinite(call.technical.outputBytes))
            ? Math.round(list.reduce((sum, call) => sum + (call.technical.outputBytes ?? 0), 0) / 1024) : null,
            unit: "KiB", foot: "Bytes locales; no prueban recepción" }),
        simulated ? stat({ label: "Transcripción", value: Math.round(mean(quality.map((q) => q.asr))), unit: "%", foot: "Confianza simulada, no medida" })
          : stat({ label: "Interrupciones registradas", value: list.some((call) => Number.isFinite(call.technical.interruptions))
            ? list.reduce((sum, call) => sum + (call.technical.interruptions ?? 0), 0) : null,
            foot: "MOS y exactitud ASR no instrumentados" })),
      card({ title: "Registros recibidos frente a duración de respuesta", sub: "Solo días con spans correlacionados; no implica causalidad" },
        series.length ? comboChart(series) : emptyState("Sin trazas correlacionadas", "Configura Application Insights / Log Analytics para esta gráfica."),
        legend([{ label: "Con recibo (%)", color: "var(--pitch-black)" }, { label: "Respuesta backend (ms)", color: "var(--lipstick-red)" }])),
      !simulated ? el("details", { class: "technical-details" }, el("summary", {}, "Consumo y fuentes de Azure · detalles técnicos"),
        el("div", { class: "grid grid--2" }, cloudCard("openAi"), cloudCard("speech"))) : null);
  }
  const root = el("div", { class: "view" }, body);
  root.update = paint;
  paint();
  return root;
}
