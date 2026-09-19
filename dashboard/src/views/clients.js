import { el, mount, initials } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { card, stat, emptyState } from "../components/ui.js";
import { api, snapshot, clients, calls, setPatients, formatDate } from "../data/api.js";

export const meta = { title: "Clientes", sub: "Consulta autorizada y de solo lectura al directorio de Prosper" };

export function render(param) {
  let selectedId = clients.some((client) => client.id === param) ? param : clients[0]?.id;
  let appointments = null;
  let appointmentStatus = "Selecciona un paciente.";
  let searchController;
  let appointmentController;
  let disposed = false;
  const tbody = el("tbody", {});
  const detail = el("div", { class: "stack stack--lg" });
  const stats = el("div", { class: "grid grid--4" });
  const message = el("p", { class: "text-sm secondary", role: "status" },
    "Busca por nombre o teléfono. No se descarga el directorio completo.");
  const input = el("input", { type: "search", class: "input", placeholder: "Nombre o teléfono",
    minLength: 2, maxLength: 200, autocomplete: "off", "aria-label": "Nombre o teléfono del paciente" });
  const searchButton = el("button", { class: "btn btn--primary", type: "submit" }, "Buscar");

  function paint() {
    const selected = clients.find((client) => client.id === selectedId);
    mount(stats,
      stat({ label: "Pacientes en catálogo", value: snapshot.clinic?.patientCount, foot: "Recuento publicado por Prosper" }),
      stat({ label: "Coincidencias", value: clients.length, foot: "Última búsqueda explícita" }),
      stat({ label: "Citas próximas seleccionadas", value: appointments?.length, foot: "Solo el paciente de la ficha" }),
      stat({ label: "Riesgo clínico", value: "—", foot: "No evaluado por esta integración" }));
    mount(tbody, ...clients.map((client) =>
      el("tr", { class: client.id === selectedId ? "is-selected" : "", onclick: () => {
        selectedId = client.id;
        void loadAppointments();
      } },
      el("td", {}, el("div", { class: "row-flex" }, el("span", { class: "avatar" }, initials(client.name)),
        el("div", {}, el("div", { class: "cell-main" }, client.name), el("div", { class: "cell-sub mono" }, client.id)))),
      el("td", { class: "mono" }, client.phone), el("td", {}, client.insurer),
      el("td", { class: "muted" }, "No evaluado"))));
    if (!clients.length) mount(tbody, el("tr", {}, el("td", { colspan: 4, class: "empty" }, "No hay pacientes cargados.")));
    if (!selected) {
      mount(detail, card({}, emptyState("Sin paciente seleccionado", "Realiza una búsqueda en Prosper para consultar su ficha.")));
      return;
    }
    const history = calls.filter((call) => call.patientIds.includes(selected.id));
    mount(detail,
      card({ title: selected.name, sub: `${selected.id} · ${selected.insurer}` },
        el("dl", { class: "kv" },
          el("dt", {}, "Teléfono"), el("dd", { class: "mono" }, selected.phone),
          el("dt", {}, "Fuente"), el("dd", {}, "Directorio Prosper"),
          el("dt", {}, "Riesgo clínico"), el("dd", {}, "No evaluado")),
        el("p", { class: "card__sub" }, "DNI/NIE, fecha de nacimiento y notas clínicas no se envían al navegador."),
        el("button", { class: "btn btn--sm", disabled: true, title: "El backend solo recibe llamadas entrantes" }, "Llamar")),
      card({ title: "Próximas citas", sub: "EHR de solo lectura; los envíos /submit no modifican esta agenda" },
        appointments === null ? el("p", { class: "text-sm", role: "status" }, appointmentStatus) :
          appointments.length ? el("div", { class: "timeline" }, ...appointments.map((appointment) =>
            el("div", { class: "timeline__item" },
              el("div", { class: "timeline__title" }, formatDate(appointment.start)),
              el("div", { class: "timeline__desc" },
                `${snapshot.clinic?.providers.find((provider) => provider.id === appointment.providerId)?.name ?? appointment.providerId} · ${snapshot.clinic?.locations.find((location) => location.id === appointment.locationId)?.name ?? appointment.locationId}`))))
            : emptyState("Sin citas próximas", "La consulta del paciente no devuelve citas próximas.")),
      card({ title: "Historial observado", sub: "Asociación por patient_id de recibos BOOK; no identifica al familiar que llama" },
        history.length ? el("div", { class: "timeline" }, ...history.slice(0, 12).map((call) =>
          el("div", { class: "timeline__item" }, el("div", { class: "timeline__time" }, call.time),
            el("div", { class: "timeline__title" }, call.reason))))
          : emptyState("Sin llamadas asociadas", "No se infieren vínculos por nombre o número de teléfono.")),
      card({ title: "Contexto para el agente" },
        emptyState("Edición no disponible", "El dashboard no añade notas, modifica instrucciones ni cambia el comportamiento del agente.")));
  }

  async function loadAppointments() {
    appointmentController?.abort();
    const controller = new AbortController();
    appointmentController = controller;
    appointments = null;
    appointmentStatus = "Consultando citas…";
    paint();
    if (!selectedId) return;
    try {
      const result = await api(`/api/dashboard/patients/${encodeURIComponent(selectedId)}/appointments`, controller.signal);
      if (controller.signal.aborted || disposed) return;
      appointments = result.appointments;
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      appointmentStatus = `No se pudieron consultar las citas: ${error.message}`;
    }
    paint();
  }

  const form = el("form", { class: "row row--wrap", onsubmit: async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 2) { message.textContent = "Escribe al menos dos caracteres."; return; }
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searchButton.disabled = true;
    message.textContent = "Consultando Prosper…";
    try {
      const parameter = /^[+0-9 ()-]{6,20}$/.test(query) ? "phone" : "name";
      const result = await api(`/api/dashboard/patients?${new URLSearchParams({ [parameter]: query })}`, controller.signal);
      if (controller.signal.aborted || disposed) return;
      setPatients(result.patients);
      selectedId = clients[0]?.id;
      message.textContent = `${clients.length} coincidencias devueltas por Prosper.`;
      void loadAppointments();
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      message.textContent = `Error en la búsqueda: ${error.message}. Las fichas anteriores no se han actualizado.`;
    } finally {
      if (!controller.signal.aborted && !disposed) searchButton.disabled = false;
    }
  } },
  el("div", { class: "search", style: { width: "320px" } }, icon("search", "nav__icon"), input),
  searchButton,
  el("button", { class: "btn ml-auto", type: "button", disabled: true, title: "La integración no crea pacientes" }, "Nuevo paciente"));

  const root = el("div", { class: "view" }, stats, form, message,
    el("div", { class: "grid grid--split" },
      card({ flush: true }, el("div", { class: "table-wrap" }, el("table", { class: "data" },
        el("thead", {}, el("tr", {}, ...["Paciente", "Teléfono", "Aseguradora", "Riesgo"].map((label) => el("th", {}, label)))), tbody))),
      detail));
  root.update = paint;
  root.dispose = () => { disposed = true; searchController?.abort(); appointmentController?.abort(); };
  paint();
  if (selectedId) void loadAppointments();
  return root;
}
