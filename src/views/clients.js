import { el, mount, initials } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, pill, stat } from "../components/ui.js";
import { openDrawer } from "../components/drawer.js";
import { clients, riskLabels, calls } from "../data/mock.js";

export const meta = {
  title: "Clientes",
  sub: "Pacientes, historial de contacto y contexto que usan los agentes",
};

export function render(param) {
  let query = "";
  const wanted = param ? decodeURIComponent(param).toLowerCase() : "";
  let selected =
    clients.find((c) => c.id.toLowerCase() === wanted || c.name.toLowerCase() === wanted) || clients[0];
  const tbody = el("tbody", {});
  const detailHost = el("div", { class: "stack stack--lg" });

  function renderRows() {
    const q = query.trim().toLowerCase();
    const rows = clients.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.id.toLowerCase().includes(q),
    );
    mount(
      tbody,
      ...rows.map((c) =>
        el(
          "tr",
          {
            class: c.id === selected?.id ? "is-selected" : "",
            onclick: () => {
              selected = c;
              renderRows();
              renderDetail();
            },
          },
          el(
            "td",
            {},
            el(
              "div",
              { class: "row-flex" },
              el("span", { class: "avatar" }, initials(c.name)),
              el(
                "div",
                {},
                el("div", { class: "cell-main" }, c.name),
                el("div", { class: "cell-sub mono" }, c.id),
              ),
            ),
          ),
          el("td", { class: "mono" }, c.phone),
          el("td", { class: "hide-md" }, c.insurer),
          el("td", { class: "hide-lg" }, el("div", { class: "chips" }, ...c.tags.map((t) => el("span", { class: "chip" }, t)))),
          el("td", { class: "cell-sub" }, c.lastContact),
          el("td", {}, c.nextAppt),
          el("td", {}, pill(riskLabels[c.risk].text, riskLabels[c.risk].pill.replace("pill--", ""))),
        ),
      ),
    );
    if (!rows.length) mount(tbody, el("tr", {}, el("td", { colspan: "7", class: "empty" }, "Sin resultados.")));
  }

  /* Al llegar desde el mapa, deja visible la fila del paciente enlazado */
  function revealSelected() {
    if (!wanted) return;
    requestAnimationFrame(() => {
      tbody.querySelector("tr.is-selected")?.scrollIntoView({ block: "center" });
    });
  }

  function renderDetail() {
    const c = selected;
    const history = calls.filter((k) => k.caller === c.name);
    mount(
      detailHost,
      card(
        {
          title: c.name,
          sub: `${c.id} · ${c.insurer}`,
          actions: el("button", { class: "btn btn--sm btn--primary" }, icon("phone", "nav__icon"), "Llamar"),
        },
        el(
          "dl",
          { class: "kv" },
          el("dt", {}, "Teléfono"),
          el("dd", { class: "mono" }, c.phone),
          el("dt", {}, "Último contacto"),
          el("dd", {}, c.lastContact),
          el("dt", {}, "Próxima cita"),
          el("dd", {}, c.nextAppt),
          el("dt", {}, "Llamadas totales"),
          el("dd", {}, String(c.calls)),
          el("dt", {}, "Riesgo clínico"),
          el("dd", {}, riskLabels[c.risk].text),
        ),
      ),
      card(
        { title: "Contexto para maio", sub: "Se inyecta en el prompt de la llamada", tint: "accent" },
        el(
          "div",
          { class: "chips", style: { marginBottom: "12px" } },
          ...c.tags.map((t) => el("span", { class: "chip" }, t)),
        ),
        el(
          "p",
          { class: "text-sm secondary" },
          "Paciente con seguimiento activo. Verificar identidad con fecha de nacimiento antes de compartir resultados. Prefiere citas en horario de mañana.",
        ),
        el(
          "button",
          {
            class: "btn btn--primary btn--sm",
            style: { marginTop: "14px" },
            onclick: () => contextDrawer(c),
          },
          icon("plus", "nav__icon"),
          "Añadir como contexto del agente",
        ),
      ),
      card(
        { title: "Historial de llamadas" },
        history.length
          ? el(
              "div",
              { class: "timeline" },
              ...history.map((h) =>
                el(
                  "div",
                  { class: `timeline__item${h.outcome === "escalated" ? " timeline__item--alert" : ""}` },
                  el("div", { class: "timeline__time" }, `${h.time} · ${h.duration}`),
                  el("div", { class: "timeline__title" }, h.reason),
                  el("div", { class: "timeline__desc" }, `Atendida por maio`),
                ),
              ),
            )
          : el("div", { class: "empty" }, "Sin llamadas registradas en el periodo."),
      ),
    );
  }

  renderRows();
  renderDetail();
  revealSelected();

  return el(
    "div",
    { class: "view" },
    el(
      "div",
      { class: "grid grid--4" },
      stat({ label: "Pacientes activos", value: "4.128", trend: 3.4, foot: "últimos 12 meses" }),
      stat({ label: "Nuevos este mes", value: "218", trend: 7.9, foot: "captados por agentes", tint: "ok" }),
      stat({ label: "Con cita pendiente", value: "1.042", trend: 2.2, foot: "próximos 30 días" }),
      stat({ label: "Riesgo alto", value: "37", trend: -1.8, foot: "seguimiento prioritario", tint: "alert" }),
    ),
    el(
      "div",
      { class: "row row--wrap" },
      el(
        "div",
        { class: "search", style: { width: "300px" } },
        icon("search", "nav__icon"),
        el("input", {
          type: "search",
          placeholder: "Buscar por nombre, teléfono o ID",
          oninput: (e) => {
            query = e.target.value;
            renderRows();
          },
        }),
      ),
      el("button", { class: "btn btn--ghost" }, icon("filter", "nav__icon"), "Filtros"),
      el("button", { class: "btn btn--ghost ml-auto" }, icon("download", "nav__icon"), "Exportar"),
      el("button", { class: "btn btn--primary" }, icon("plus", "nav__icon"), "Nuevo paciente"),
    ),
    el(
      "div",
      { class: "grid grid--split" },
      card(
        { flush: true },
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
                el("th", {}, "Teléfono"),
                el("th", { class: "hide-md" }, "Aseguradora"),
                el("th", { class: "hide-lg" }, "Etiquetas"),
                el("th", {}, "Último contacto"),
                el("th", {}, "Próxima cita"),
                el("th", {}, "Riesgo"),
              ),
            ),
            tbody,
          ),
        ),
      ),
      detailHost,
    ),
  );
}

/* Nota que maio leerá antes de hablar con este paciente */
function contextDrawer(c) {
  openDrawer({
    title: "Contexto para maio",
    sub: `${c.name} · ${c.id}`,
    body: () => [
      el(
        "p",
        { class: "text-sm secondary", style: { marginBottom: "18px" } },
        `Lo que escribas aquí se inyecta en el prompt cada vez que maio hable con ${c.name}. Úsalo para preferencias, avisos y acuerdos previos.`,
      ),
      el("div", { class: "section-title" }, "Nota de contexto"),
      el(
        "textarea",
        { class: "textarea", style: { minHeight: "160px" }, placeholder: "Prefiere citas de mañana. Acude acompañada. Evitar llamadas antes de las 10:00." },
      ),
      el("div", { class: "section-title", style: { marginTop: "22px" } }, "Añadir rápido"),
      el(
        "div",
        { class: "chips" },
        ...[
          "Prefiere mañanas",
          "Evitar llamadas en horario laboral",
          "Verificar identidad siempre",
          "Habla en català",
          "Requiere trato prioritario",
        ].map((t) => el("button", { class: "chip", type: "button" }, `+ ${t}`)),
      ),
      el("div", { class: "section-title", style: { marginTop: "22px" } }, "Etiquetas actuales"),
      el("div", { class: "chips" }, ...c.tags.map((t) => el("span", { class: "chip" }, t))),
    ],
    footer: (close) => [
      el("button", { class: "btn btn--primary", onclick: close }, "Guardar contexto"),
      el("button", { class: "btn btn--ghost ml-auto", onclick: close }, "Cancelar"),
    ],
  });
}
