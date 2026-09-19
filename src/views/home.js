import { el, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill, barChart, stackedBars, donut, legend, bar, comboChart } from "../components/ui.js";
import {
  kpis,
  volumeByHour,
  reasonsBreakdown,
  weeklyTrend,
  activity,
  agentProfile,
  calls,
  outcomeLabels,
} from "../data/mock.js";
import { RANGES, DEFAULT_RANGE, metrics, rangeById, successVsLatency } from "../data/insights.js";

export const meta = {
  title: "Inicio",
  sub: "Actividad y rendimiento de maio · hoy, 18 sep",
};

export function render() {
  let range = DEFAULT_RANGE;
  const statsHost = el("div", { class: "grid grid--3" });
  const qualityHost = el("div", { class: "grid grid--3" });
  const latencyHost = el("div", {});

  function renderStats() {
    const m = metrics(range);
    const when = rangeById(range).short;
    mount(
      latencyHost,
      card(
        {
          title: "Resolución frente a latencia",
          sub: "Barras: llamadas resueltas · línea: latencia media de respuesta",
        },
        comboChart(successVsLatency(range)),
        legend([
          { label: "Resueltas (%)", color: "var(--pitch-black)" },
          { label: "Latencia media (ms)", color: "var(--lipstick-red)" },
        ]),
      ),
    );
    mount(
      qualityHost,
      stat({
        label: "Latencia de respuesta",
        value: m.latency,
        unit: "ms",
        trend: m.trend.latency,
        lowerIsBetter: true,
        foot: `P95 ${m.latencyP95} ms · ${when}`,
      }),
      stat({
        label: "Calidad de audio",
        value: m.mos.toFixed(1),
        unit: "/5",
        trend: m.trend.mos,
        foot: `MOS medio · jitter ${m.jitter} ms`,
      }),
      stat({
        label: "Transcripción correcta",
        value: m.asr,
        unit: "%",
        trend: m.trend.asr,
        foot: `confianza media · ${m.bargeIns} interrupciones por llamada`,
      }),
    );
    mount(
      statsHost,
      stat({
        label: "Llamadas atendidas",
        value: m.total,
        trend: m.trend.total,
        foot: when,
        spark: kpis.callsToday.spark,
      }),
      stat({
        label: "Citas agendadas",
        value: m.booked,
        trend: m.trend.booked,
        foot: `${when} · cerradas por maio`,
        spark: kpis.automation.spark,
        tint: "ok",
      }),
      stat({
        label: "Reservas sin cerrar",
        value: m.missed,
        trend: m.trend.missed,
        lowerIsBetter: true,
        foot: `${m.missedShare}% de quien pedía cita · ver en el mapa`,
        spark: kpis.escalations.spark,
        tint: "alert",
        onClick: () => {
          location.hash = `#/llamadas/mapa?estado=missed&rango=${range}`;
        },
      }),
      stat({
        label: "Automatización",
        value: m.automation,
        unit: "%",
        trend: m.trend.automation,
        foot: "sin intervención humana",
        spark: kpis.automation.spark,
      }),
      stat({
        label: "Duración media",
        value: m.avgHandle,
        trend: m.trend.avgSeconds,
        lowerIsBetter: true,
        foot: "por llamada",
        spark: kpis.avgHandle.spark,
      }),
      stat({
        label: "Escalados a humano",
        value: m.escalated,
        trend: m.trend.escalated,
        lowerIsBetter: true,
        foot: when,
        spark: kpis.escalations.spark,
      }),
    );
  }

  const rangeBar = el(
    "div",
    { class: "segmented" },
    ...RANGES.map((r) =>
      el(
        "button",
        {
          class: r.id === range ? "is-active" : "",
          onclick: (e) => {
            range = r.id;
            rangeBar.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
            e.currentTarget.classList.add("is-active");
            renderStats();
          },
        },
        r.label,
      ),
    ),
  );

  renderStats();

  return el(
    "div",
    { class: "view" },
    el(
      "section",
      { class: "hero" },
      el("div", { class: "hero__art brand-wash" }),
      el(
        "div",
        { class: "hero__body" },
        el("p", { class: "hero__eyebrow" }, "Recepción agéntica"),
        el("h2", { class: "hero__title" }, "Bienvenido a maio, Vicente"),
        el(
          "p",
          { class: "hero__text" },
          "maio lleva 342 llamadas atendidas hoy y ha resuelto el 87% sin intervención humana. Nadie se ha quedado esperando al teléfono.",
        ),
        el(
          "div",
          { class: "row row--wrap" },
          el("a", { class: "btn btn--primary", href: "#/llamadas" }, icon("phone", "nav__icon"), "Ver llamadas de hoy"),
          el("a", { class: "btn", href: "#/configuracion" }, icon("settings", "nav__icon"), "Configurar maio"),
        ),
      ),
    ),
    el(
      "div",
      { class: "row row--wrap" },
      rangeBar,
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Exportar informe"),
    ),

    statsHost,

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Volumen por franja horaria", sub: "Llamadas atendidas por los agentes · últimas 24 h" },
        barChart(volumeByHour),
      ),
      card(
        { title: "Motivos de llamada", sub: "Distribución del día" },
        el(
          "div",
          { class: "row", style: { justifyContent: "center" } },
          donut(reasonsBreakdown, { center: "342" }),
        ),
        legend(reasonsBreakdown),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Automatizado vs. humano", sub: "Porcentaje de llamadas por día de la semana" },
        stackedBars(weeklyTrend),
        legend([
          { label: "Resuelto por maio", color: "var(--pitch-black)" },
          { label: "Escalado a humano", color: "var(--dusty-denim)" },
        ]),
      ),
      card(
        { title: "Resolución por motivo", sub: "En primera llamada, sin escalado" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Agendar cita", 97],
            ["Reprogramar", 94],
            ["Resultados", 91],
            ["Facturación", 79],
            ["Triaje clínico", 62],
          ].map(([label, value]) =>
            el(
              "div",
              { class: "list__item" },
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, label),
                el("div", { style: { marginTop: "6px" } }, bar(value)),
              ),
              el("span", { class: "mono" }, `${value}%`),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        {
          title: "Últimas llamadas",
          sub: "Registro en tiempo real",
          flush: true,
          actions: el(
            "a",
            { class: "btn btn--sm btn--ghost", href: "#/llamadas" },
            "Ver todas",
            icon("arrowUpRight", "nav__icon"),
          ),
        },
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "data" },
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", {}, "Paciente"),
                el("th", {}, "Motivo"),
                el("th", {}, "Estado"),
                el("th", {}, "Duración"),
              ),
            ),
            el(
              "tbody",
              {},
              ...calls.slice(0, 6).map((c) =>
                el(
                  "tr",
                  { onclick: () => (location.hash = "#/llamadas") },
                  el(
                    "td",
                    {},
                    el("div", { class: "cell-main" }, c.caller),
                    el("div", { class: "cell-sub" }, c.time),
                  ),
                  el("td", {}, c.reason),
                  el("td", {}, pill(outcomeLabels[c.outcome].text, outcomeLabels[c.outcome].pill.replace("pill--", ""))),
                  el("td", { class: "mono" }, c.duration),
                ),
              ),
            ),
          ),
        ),
      ),
      el(
        "div",
        { class: "stack stack--lg" },
        card(
          { title: "Actividad del sistema", sub: "Acciones ejecutadas por maio" },
          el(
            "div",
            { class: "timeline" },
            ...activity.map((a) =>
              el(
                "div",
                { class: `timeline__item${a.kind === "alert" ? " timeline__item--alert" : ""}` },
                el("div", { class: "timeline__time" }, a.time),
                el("div", { class: "timeline__title" }, a.title),
                el("div", { class: "timeline__desc" }, a.desc),
              ),
            ),
          ),
        ),
        card(
          { title: "maio ahora mismo", tint: "accent" },
          el(
            "div",
            { class: "list" },
            ...[
              ["Estado", "Atendiendo"],
              ["Llamadas en curso", "2"],
              ["En cola", "0"],
              ["Acciones habilitadas", `${agentProfile.skills.filter((s) => s[2]).length}`],
              ["Canales", agentProfile.channels.join(" · ")],
            ].map(([k, v]) =>
              el(
                "div",
                { class: "list__item" },
                el("div", { class: "list__body" }, el("div", { class: "list__title" }, k)),
                el("span", { class: "mono" }, v),
              ),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "grid grid--3" },
      card(
        { title: "Satisfacción (NPS)", tint: "ok" },
        el("div", { class: "stat__value", style: { fontSize: "38px" } }, "62"),
        el("p", { class: "card__sub" }, "Promotores 71% · Pasivos 20% · Detractores 9%"),
      ),
      card(
        { title: "Cumplimiento" },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Aviso de IA"),
          el("dd", {}, "100% de llamadas"),
          el("dt", {}, "Consentimiento"),
          el("dd", {}, "99,4% registrado"),
          el("dt", {}, "Retención"),
          el("dd", {}, "90 días"),
          el("dt", {}, "Incidencias"),
          el("dd", {}, "0 abiertas"),
        ),
      ),
      card(
        { title: "Alertas del periodo", tint: "alert" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Pico de abandono", "Viernes 12:00 · 14 llamadas en cola"],
            ["Latencia de mutua", "Adeslas API > 2 s en 37 consultas"],
            ["Intención sin cobertura", "«segunda opinión médica» × 23"],
          ].map(([t, d]) =>
            el(
              "div",
              { class: "list__item" },
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, t),
                el("div", { class: "list__meta" }, d),
              ),
            ),
          ),
        ),
      ),
    ),

    el(
      "div",
      { class: "row row--wrap" },
      el("div", { class: "section-title" }, "Calidad técnica de las conversaciones"),
      el(
        "a",
        { class: "btn btn--sm btn--ghost ml-auto", href: "#/llamadas" },
        "Ver por llamada",
        icon("arrowUpRight", "nav__icon"),
      ),
    ),
    qualityHost,
    latencyHost,
  );
}
