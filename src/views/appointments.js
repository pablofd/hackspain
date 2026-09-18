import { el } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, pill } from "../components/ui.js";
import { appointments } from "../data/mock.js";

export const meta = {
  title: "Agenda",
  sub: "Huecos que los agentes pueden consultar, reservar y liberar",
};

const DAYS = ["Lun 15", "Mar 16", "Mié 17", "Jue 18", "Vie 19", "Sáb 20"];

export function render() {
  const free = appointments.filter((a) => a.state === "free").length;

  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "row row--wrap" },
      el("div", { class: "segmented" }, ...DAYS.map((d, i) => el("button", { class: i === 3 ? "is-active" : "" }, d))),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("filter", "nav__icon"), "Profesional"),
      el("button", { class: "btn btn--primary" }, icon("plus", "nav__icon"), "Bloquear franja"),
    ),

    el(
      "div",
      { class: "grid grid--4" },
      stat({ label: "Citas hoy", value: "48", trend: 6.1, foot: "32 creadas por agentes" }),
      stat({ label: "Huecos libres", value: String(free * 4), trend: -4.2, foot: "próximas 48 h", tint: "green" }),
      stat({ label: "Ocupación", value: "86", unit: "%", trend: 3.8, foot: "media de la sede" }),
      stat({ label: "No-shows", value: "4", trend: -12.5, foot: "recordatorios activos", tint: "flame" }),
    ),

    el(
      "div",
      { class: "grid grid--main" },
      card(
        { title: "Jueves 18 de septiembre", sub: "Selecciona un hueco para asignarlo a un agente" },
        el(
          "div",
          { class: "slots" },
          ...appointments.map((a) =>
            el(
              "button",
              { class: `slot ${a.state === "free" ? "is-free" : "is-busy"}`, type: "button" },
              el("strong", {}, a.time),
              el("small", {}, a.state === "free" ? "Libre" : a.patient),
              el("small", {}, a.doctor),
            ),
          ),
        ),
      ),
      el(
        "div",
        { class: "stack stack--lg" },
        card(
          { title: "Reglas de agenda", sub: "Qué puede hacer un agente sin supervisión", tint: "coffee" },
          el(
            "div",
            { class: "list" },
            ...[
              ["Ventana de reserva", "Hasta 60 días vista"],
              ["Antelación mínima", "2 horas"],
              ["Duración por defecto", "30 minutos"],
              ["Sobrecupo urgencias", "2 por día y profesional"],
              ["Cancelación", "Hasta 24 h antes sin coste"],
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
                el("button", { class: "btn btn--sm btn--ghost" }, "Editar"),
              ),
            ),
          ),
        ),
        card(
          { title: "Lista de espera", sub: "Se avisa automáticamente al liberarse un hueco" },
          el(
            "div",
            { class: "list" },
            ...[
              ["Rosa Calvo", "Pediatría · cualquier hora"],
              ["Iván Molina", "Traumatología · tardes"],
              ["Sara Lima", "Dermatología · mañanas"],
            ].map(([n, d]) =>
              el(
                "div",
                { class: "list__item" },
                el("span", { class: "avatar" }, n[0]),
                el(
                  "div",
                  { class: "list__body" },
                  el("div", { class: "list__title" }, n),
                  el("div", { class: "list__meta" }, d),
                ),
                pill("En espera", "neutral"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
