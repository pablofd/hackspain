import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, toggle, bar } from "../components/ui.js";
import { agents, statusLabels } from "../data/mock.js";

export const meta = {
  title: "Agentes",
  sub: "Recepcionistas virtuales, su voz, sus permisos y sus acciones",
};

export function render() {
  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "row row--wrap" },
      el(
        "div",
        { class: "segmented" },
        el("button", { class: "is-active" }, "Todos"),
        el("button", {}, "En línea"),
        el("button", {}, "En pausa"),
        el("button", {}, "Borradores"),
      ),
      el("button", { class: "btn btn--primary ml-auto" }, icon("plus", "nav__icon"), "Crear agente"),
    ),

    el("div", { class: "grid grid--3" }, ...agents.map(agentCard)),

    el(
      "div",
      { class: "grid grid--aside" },
      card(
        { title: "Plantillas", sub: "Arranca desde un rol preconfigurado", tint: "accent" },
        el(
          "div",
          { class: "list" },
          ...[
            ["Recepción general", "Citas, horarios e información de sedes"],
            ["Triaje clínico", "Árbol de síntomas con escalado a enfermería"],
            ["Resultados de pruebas", "Entrega segura con verificación de identidad"],
            ["Campaña saliente", "Revisiones anuales y recordatorios"],
          ].map(([t, d]) =>
            el(
              "div",
              { class: "list__item" },
              el(
                "span",
                { class: "avatar" },
                icon("sparkle", "nav__icon"),
              ),
              el(
                "div",
                { class: "list__body" },
                el("div", { class: "list__title" }, t),
                el("div", { class: "list__meta" }, d),
              ),
              el("button", { class: "btn btn--sm btn--ghost" }, "Usar"),
            ),
          ),
        ),
      ),
      card(
        { title: "Configuración rápida", sub: "Se aplica a todos los agentes activos" },
        el(
          "div",
          {},
          ...[
            ["Grabación de llamadas", "Requerido para auditoría clínica", true],
            ["Aviso de IA al inicio", "Informa de que habla con un asistente virtual", true],
            ["Escalado automático", "Transfiere a humano ante banderas rojas", true],
            ["Modo fuera de horario", "Buzón inteligente con devolución de llamada", false],
            ["Anonimizar datos en transcripción", "Enmascara identificadores personales", true],
          ].map(([t, d, on]) =>
            el(
              "div",
              { class: "toggle-row" },
              el(
                "div",
                { class: "toggle-row__body" },
                el("div", { class: "toggle-row__title" }, t),
                el("div", { class: "toggle-row__desc" }, d),
              ),
              toggle(on),
            ),
          ),
        ),
      ),
    ),
  );
}

function agentCard(a) {
  const status = statusLabels[a.status];
  return el(
    "article",
    { class: "agent-card grain" },
    el(
      "div",
      { class: "agent-card__top" },
      el("div", { class: `agent-card__avatar agent-card__avatar--${a.tone} grain` }, a.name[0]),
      el(
        "div",
        { style: { minWidth: "0" } },
        el("div", { class: "agent-card__name" }, a.name),
        el("div", { class: "agent-card__role truncate" }, a.role),
      ),
      el(
        "div",
        { class: "ml-auto" },
        pill(status.text, status.pill.replace("pill--", ""), a.status === "online"),
      ),
    ),
    el(
      "div",
      { class: "agent-card__metrics" },
      metric("Llamadas", a.calls),
      metric("Resolución", `${a.resolution}%`),
      metric("Media", a.avgHandle),
    ),
    el(
      "div",
      { class: "stack stack--sm" },
      el("div", { class: "section-title", style: { margin: "0" } }, "Acciones habilitadas"),
      el("div", { class: "chips" }, ...a.skills.map((s) => el("span", { class: "chip" }, s))),
    ),
    el(
      "div",
      { class: "stack stack--sm" },
      el(
        "div",
        { class: "row text-sm muted" },
        el("span", {}, `Voz · ${a.voice}`),
        el("span", { class: "ml-auto" }, a.language),
      ),
      bar(a.resolution || 4, a.status === "online" ? "" : "bar__fill--muted"),
    ),
    el(
      "div",
      { class: "row" },
      el("button", { class: "btn btn--sm" }, "Configurar"),
      el("button", { class: "btn btn--sm btn--ghost" }, "Probar voz"),
      el("div", { class: "ml-auto" }, toggle(a.status === "online")),
    ),
  );
}

function metric(label, value) {
  return el("div", { class: "agent-card__metric" }, el("span", {}, label), el("strong", {}, String(value)));
}
