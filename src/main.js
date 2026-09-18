import { el, mount } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { clinic } from "./data/mock.js";

import * as dashboard from "./views/dashboard.js";
import * as calls from "./views/calls.js";
import * as agents from "./views/agents.js";
import * as appointments from "./views/appointments.js";
import * as clients from "./views/clients.js";
import * as actions from "./views/actions.js";
import * as reports from "./views/reports.js";
import * as knowledge from "./views/knowledge.js";
import * as settings from "./views/settings.js";

const ROUTES = {
  "/": { view: dashboard, icon: "home", label: "Inicio" },
  "/llamadas": { view: calls, icon: "phone", label: "Llamadas", badge: "12" },
  "/agentes": { view: agents, icon: "agents", label: "Agentes" },
  "/agenda": { view: appointments, icon: "calendar", label: "Agenda" },
  "/clientes": { view: clients, icon: "clients", label: "Clientes" },
  "/acciones": { view: actions, icon: "actions", label: "Acciones" },
  "/reportes": { view: reports, icon: "reports", label: "Reportes" },
  "/conocimiento": { view: knowledge, icon: "knowledge", label: "Conocimiento", badge: "3", soft: true },
  "/ajustes": { view: settings, icon: "settings", label: "Ajustes" },
};

const NAV = [
  { label: "General", items: ["/"] },
  { label: "Operación", items: ["/llamadas", "/agentes", "/agenda", "/clientes"] },
  { label: "Automatización", items: ["/acciones", "/conocimiento"] },
  { label: "Análisis", items: ["/reportes"] },
  { label: "Cuenta", items: ["/ajustes"] },
];

const contentHost = el("div", { class: "content", id: "content" });
const titleNode = el("h1", { class: "topbar__title" });
const subNode = el("p", { class: "topbar__sub" });
const navLinks = new Map();

function currentPath() {
  const path = location.hash.replace(/^#/, "") || "/";
  return ROUTES[path] ? path : "/";
}

function renderRoute() {
  const path = currentPath();
  const route = ROUTES[path];
  titleNode.textContent = route.view.meta.title;
  subNode.textContent = route.view.meta.sub;
  document.title = `${route.view.meta.title} · Aurea Health`;
  mount(contentHost, route.view.render());
  contentHost.scrollTop = 0;
  navLinks.forEach((link, key) => link.classList.toggle("is-active", key === path));
}

function sidebar() {
  return el(
    "aside",
    { class: "sidebar grain" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand__mark grain" }, icon("waveform", "nav__icon")),
      el(
        "div",
        {},
        el("div", { class: "brand__name" }, "Aurea Health"),
        el("div", { class: "brand__sub" }, `${clinic.name} · ${clinic.plan}`),
      ),
    ),
    el(
      "nav",
      { class: "nav" },
      ...NAV.map((group) =>
        el(
          "div",
          { class: "nav__group" },
          el("div", { class: "nav__label" }, group.label),
          ...group.items.map((path) => {
            const r = ROUTES[path];
            const link = el(
              "a",
              { class: "nav__item", href: `#${path}` },
              icon(r.icon),
              el("span", {}, r.label),
              r.badge && el("span", { class: `nav__badge${r.soft ? " nav__badge--soft" : ""}` }, r.badge),
            );
            navLinks.set(path, link);
            return link;
          }),
        ),
      ),
    ),
    el(
      "div",
      { class: "sidebar__footer grain" },
      el("h4", {}, "Recepción activa"),
      el("p", {}, "3 agentes atendiendo · 2 llamadas en curso"),
      el(
        "div",
        { class: "row" },
        el("span", { class: "pill pill--ok" }, el("span", { class: "dot dot--pulse" }), "En directo"),
        el("button", { class: "btn btn--sm btn--ghost ml-auto" }, "Pausar"),
      ),
    ),
    el(
      "div",
      { class: "user-chip" },
      el("span", { class: "user-chip__avatar" }, clinic.user.initials),
      el(
        "div",
        { style: { minWidth: 0 } },
        el("div", { class: "user-chip__name" }, clinic.user.name),
        el("div", { class: "user-chip__role truncate" }, clinic.user.role),
      ),
    ),
  );
}

function topbar() {
  const input = el("input", { type: "search", placeholder: "Buscar llamadas, pacientes, agentes" });
  const search = el("div", { class: "search" }, icon("search", "nav__icon"), input, el("kbd", {}, "⌘K"));

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
    }
  });

  return el(
    "header",
    { class: "topbar" },
    el("div", { class: "topbar__titles" }, titleNode, subNode),
    el(
      "div",
      { class: "topbar__actions" },
      search,
      el("button", { class: "btn btn--icon btn--ghost", title: "Notificaciones" }, icon("bell", "nav__icon")),
      el("button", { class: "btn btn--primary" }, icon("plus", "nav__icon"), "Nuevo agente"),
    ),
  );
}

mount(
  document.getElementById("app"),
  el("div", { class: "app-bg", "aria-hidden": "true" }),
  el("div", { class: "shell" }, sidebar(), el("main", { class: "main" }, topbar(), contentHost)),
);

window.addEventListener("hashchange", renderRoute);
renderRoute();
