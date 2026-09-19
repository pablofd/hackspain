# maio · Recepción agéntica

Interfaz de **maio**, importada de la rama `platform` (`b5cdcfa`) e integrada
con el backend Cachopo en modo **solo lectura**. Se conservan el diseño y las
vistas, pero se retiran los datos simulados y las puntuaciones inventadas.

## Ejecutar

Los ES modules siguen siendo nativos, sin build del frontend. Ejecutar desde la
raíz del repositorio, no desde esta carpeta:

```bash
npm run dashboard
# http://127.0.0.1:4321/
```

La configuración y el token independiente se describen en el
[README principal](../README.md#read-only-dashboard-integration). El antiguo
`serve.py` de demostración se retira: un servidor estático no conecta las APIs
ni sustituye el adaptador autenticado.
El token permanece en memoria del navegador, nunca en almacenamiento persistente.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `index.html` | Punto de entrada |
| `src/main.js` | Shell, menú lateral y router por hash |
| `src/views/` | Inicio, Llamadas, Clientes, Configuración |
| `src/components/` | Tarjetas, KPIs, gráficos SVG, mapa y estado de fuentes |
| `src/styles/tokens.css` | Variables de diseño (paleta, radios, blur, grano, tipografía) |
| `src/data/api.js` | Cliente autenticado, estado real y adaptación a las vistas |
| `src/data/insights.js` | Agregados de la muestra observada, sin telemetría inventada |
| `design/palette.json` | Paleta canónica |
| `design/brand/` | Logo, icono y normas de marca |

## Marca

**maio**. Wordmark en Space Grotesk Medium en minúsculas con tracking cerrado; el símbolo es una
burbuja de conversación con onda de voz trazada a mano. Especificaciones y variantes en
`design/brand/brand.json`.

## Tipografía

SF Pro Regular (400) para toda la interfaz; SF Pro Light (300) reservado a textos grandes
(títulos de vista y cifras de KPI).

## Paleta

Plataforma **blanca** con aristas vivas (radio 0) y hairlines de 1 px. El color entra con
moderación: el rojo queda reservado a lo crítico.

| Nombre | Hex | Uso |
| --- | --- | --- |
| Pitch Black | `#12100E` | Texto, marca, botones primarios, serie principal de gráficos |
| Parchment | `#F6F0ED` | Superficies suaves: hover, tarjetas tintadas, burbujas del paciente |
| Dusty Denim | `#748CAB` | Acento de datos: series secundarias, sparklines, avatares |
| Blue Slate | `#646E78` | Texto secundario y etiquetas |
| Lipstick Red | `#EC0B43` | Solo crítico: escalados, riesgo alto, cola de llamadas |
| White | `#FFFFFF` | Fondo y superficies de tarjeta |

Las paletas anteriores quedan archivadas en `design/palette.json` bajo `reserved`.

## Contrato de integración

El adaptador `../src/dashboard/` sirve estas lecturas con `Authorization: Bearer`
y respuestas `no-store`:

- `GET /api/dashboard/snapshot`: salud, catálogo, llamadas/recibos observados,
  metadatos técnicos y métricas Azure, con estado y fecha de cada fuente.
  Nunca incluye texto ni fragmentos de transcripción.
- `GET /api/dashboard/calls/{callId}/transcript`: proyección autenticada de
  **una llamada seleccionada**, solicitada explícitamente para los pacientes
  sintéticos del reto. Devuelve `{ callId, checkedAt, historyDays, entries,
  limited, limits }`; cada entrada contiene `speaker`, `text`, `timestamp`,
  `itemId` y, si existen, `partial`, `startMs` y `endMs`.
- `GET /api/dashboard/patients?name=...` o `?phone=...`: búsqueda explícita
  en Prosper; solo ID, nombre, teléfono y aseguradora.
- `GET /api/dashboard/patients/{id}/appointments`: citas próximas del EHR.

No existe proxy genérico, endpoint de escritura ni botón que lance una llamada
real. Los fallos se muestran; una respuesta vacía no se sustituye por mocks.
Las llamadas se relacionan por el `patient_id` de un BOOK recibido, nunca por
un parecido de nombres ni por un teléfono compartido. La lista y el mapa
mantienen los mismos filtros. No se consultan fotografías ni tipografías externas.

La vista de llamada actualiza sus eventos técnicos y la transcripción
seleccionada cada cinco segundos, sin descargar las demás conversaciones.
Muestra los últimos 500 fragmentos como máximo y hasta 256 KiB de entradas JSON
UTF-8, con aviso `limited` cuando no caben todos. Solo se consulta el último
archivo de la llamada dentro de los 200 registros recientes y la ventana
configurada (siete días por defecto). Se reutilizan las comprobaciones de
propietario, archivo regular, enlaces y límites de 8 MiB por archivo / 64 KiB
por evento. Los NDJSON crudos, las rutas, los detalles de herramientas y los WAV
siguen privados: no hay descarga ni proxy de archivos.

El texto se inserta con nodos DOM, nunca como HTML. Se preservan espacios,
repeticiones, credenciales ya ocultas y la redacción adicional de las claves
configuradas. Los datos sintéticos dichos por el interlocutor sí pueden aparecer
en esta vista autorizada; no se cambia la proyección del directorio ni de los
recibos. Los fragmentos parciales se etiquetan sin fingir turnos completos.
El texto del agente es **generado**, puede estar interrumpido y no prueba que se
haya oído. La hora del registro no es tiempo acústico exacto y los intervalos
del modelo no confirman reproducción.

Hay estados distintos de carga, sin transcripción, registro no encontrado y
error de fuente (`401` sin acceso, `400` ID/consulta inválidos, `404` fuera de la
muestra local, `503` fallo del registro). Cambiar de selección, abrir el mapa,
navegar o desconectar cancela las peticiones; las respuestas antiguas no repintan
otra llamada ni una sesión nueva. No se envía texto a ningún modelo o servicio.
No se inventan ondas de audio, turnos ni indicadores de que alguien habla.
Sentimiento, intenciones, MOS, exactitud ASR, personalidad, NPS y riesgo clínico
no están implementados y se muestran como no disponibles. La configuración del
agente continúa exclusivamente en el backend.

Un recibo de acción no es un pase del juez ni una modificación del EHR.
Los gráficos usan una muestra limitada y no afirman cobertura histórica completa.
Las métricas Azure de deployment o de un recurso Speech externo no se atribuyen
a una llamada individual. Las duraciones `chat` son del backend, no latencia
acústica de ida y vuelta.

## Comprobación

```sh
npx playwright install chromium
npm run test:dashboard
```

Las pruebas usan pacientes y respuestas sintéticas, directorios de fixtures
bajo `.local/`, un navegador local y ningún servicio de pago. Incluyen límites,
redacción, autenticación, texto XSS literal, fragmentos, actualización y carreras
de selección/desconexión. `npm test` incluye los contratos offline; el navegador se
ejecuta explícitamente mediante `test:dashboard`.
