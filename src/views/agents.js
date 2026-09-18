import { el } from "../lib/dom.js";
import { pill, toggle } from "../components/ui.js";
import { openDrawer } from "../components/drawer.js";
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
    ),
    el("div", { class: "grid grid--3" }, ...agents.map(agentCard)),
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
      el("div", { class: `agent-card__avatar agent-card__avatar--${a.tone}` }, a.name[0]),
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
      { class: "row" },
      el("span", { class: "text-sm muted" }, a.calls ? `${a.calls} llamadas · ${a.resolution}%` : "Sin actividad"),
      el(
        "button",
        { class: "btn btn--sm ml-auto", onclick: () => editAgentDrawer(a) },
        "Editar agente",
      ),
    ),
  );
}

function editAgentDrawer(a) {
  openDrawer({
    title: a.name,
    sub: a.role,
    body: () => [
      el(
        "div",
        { class: "agent-card__metrics", style: { marginBottom: "22px", borderTop: "0", paddingTop: "0" } },
        metric("Llamadas", a.calls),
        metric("Resolución", `${a.resolution}%`),
        metric("Media", a.avgHandle),
      ),
      field("Nombre", el("input", { class: "input", value: a.name })),
      field("Rol", el("input", { class: "input", value: a.role })),
      field(
        "Voz",
        el(
          "select",
          { class: "select" },
          el("option", {}, a.voice),
          el("option", {}, "Sofía Neural"),
          el("option", {}, "Álvaro Neural"),
        ),
      ),
      field("Idiomas", el("input", { class: "input", value: a.language })),
      el("div", { class: "section-title" }, "Acciones habilitadas"),
      el(
        "div",
        { class: "chips", style: { marginBottom: "22px" } },
        ...a.skills.map((s) => el("span", { class: "chip" }, s)),
        el("button", { class: "btn btn--sm btn--ghost" }, "Añadir"),
      ),
      el("div", { class: "section-title" }, "Canales"),
      el(
        "div",
        { class: "chips", style: { marginBottom: "22px" } },
        ...a.channels.map((s) => el("span", { class: "chip" }, s)),
      ),
      el("div", { class: "section-title" }, "Comportamiento"),
      ...[
        ["Agente activo", "Atiende llamadas entrantes", a.status === "online"],
        ["Escalado automático", "Transfiere ante banderas rojas", true],
        ["Grabación", "Requerido para auditoría clínica", true],
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
    ],
    footer: (close) => [
      el("button", { class: "btn btn--primary", onclick: close }, "Guardar cambios"),
      el("button", { class: "btn btn--ghost" }, "Probar voz"),
      el("button", { class: "btn btn--ghost ml-auto", onclick: close }, "Cancelar"),
    ],
  });
}

export function openNewAgent() {
  openDrawer({
    title: "Nuevo agente",
    sub: "Cuatro datos y empieza a atender",
    body: () => [
      field("Nombre", el("input", { class: "input", placeholder: "Nora" })),
      field(
        "Plantilla",
        el(
          "select",
          { class: "select" },
          el("option", {}, "Recepción general"),
          el("option", {}, "Triaje clínico"),
          el("option", {}, "Resultados de pruebas"),
          el("option", {}, "Campaña saliente"),
        ),
      ),
      field(
        "Voz",
        el(
          "select",
          { class: "select" },
          el("option", {}, "Sofía Neural"),
          el("option", {}, "Álvaro Neural"),
          el("option", {}, "Lucía Neural"),
        ),
      ),
      field("Idiomas", el("input", { class: "input", value: "Español" })),
    ],
    footer: (close) => [
      el("button", { class: "btn btn--primary", onclick: close }, "Crear agente"),
      el("button", { class: "btn btn--ghost ml-auto", onclick: close }, "Cancelar"),
    ],
  });
}

function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}

function metric(label, value) {
  return el("div", { class: "agent-card__metric" }, el("span", {}, label), el("strong", {}, String(value)));
}
