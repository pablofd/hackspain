# maio · Recepción agéntica

Interfaz de **maio**, importada de la rama `platform` (`b5cdcfa`) e integrada
con el backend Cachopo en modo **solo lectura para la clínica**. Conserva el
diseño original, distingue datos reales de una demo visual explícita y añade
una prueba de voz aislada, sin envíos clínicos.

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

No existe proxy genérico ni escritura en el EHR. El botón opcional de micrófono
se describe más abajo; no admite llamadas de Prosper. Los fallos se muestran;
una respuesta vacía no se sustituye automáticamente por mocks.
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
otra llamada ni una sesión nueva. La consulta de registros no envía texto a ningún
modelo o servicio. En **Datos reales** no se inventan ondas, turnos ni indicadores
de que alguien habla. Sentimiento, intenciones, MOS, exactitud ASR, personalidad,
NPS y riesgo clínico no se presentan como mediciones reales. La configuración del
agente continúa exclusivamente en el backend.

El contenedor de transcripción conserva sus nodos entre actualizaciones.
Si el lector estaba a menos de 40 px del final, sigue los nuevos fragmentos;
si está leyendo arriba, conserva un ancla visible, incluso al crecer un parcial
o eliminar entradas antiguas por el límite. Un error de fuente mantiene la
última lectura con aviso explícito de que está desactualizada. Este mismo
componente se utiliza en la llamada de micrófono.

## Datos reales y demo visual

El selector de la cabecera es explícito y solo vive en memoria:

- **Datos reales** mantiene las llamadas, recibos, transcripciones y consultas
  autenticadas existentes. No cambia a datos simulados si falla una API.
- **Demo visual** usa pacientes, teléfonos, citas, conversaciones, sentimientos,
  señales, latencias, MOS, ASR, NPS y ondas **locales y simulados**. Las series
  ilustrativas de volumen, motivos, tendencias y sparklines proceden del diseño
  original `platform` (`b5cdcfa`); no son métricas del servidor ni veredictos.
  Los filtros de llamadas/mapa siguen compartiendo el mismo conjunto de ejemplos.
  La búsqueda de pacientes en este modo es local y no consulta Prosper.

La marca, fuentes del sistema, paleta, sidebar, hero, seis tarjetas KPI, gráficos,
mapa y jerarquía de chat conservan los estilos originales. Los avisos y fuentes
se compactan en la cabecera, sin ocultar los errores. El estado de conexión y
del agente en el sidebar sigue siendo **real**, también en demo visual. En
Configuración, Demo visual reproduce los datos ficticios del mockup y Datos
reales muestra el perfil del backend y su prompt completo de solo lectura,
sin consultar Foundry. No se solicitan avatares,
fuentes, analítica o códecs a terceros. Los controles sin implementación real,
como reproducción de grabaciones o edición del agente, continúan deshabilitados.

## Llamada fake con micrófono

Solo aparece cuando el snapshot real publica `demoCall.enabled: true`.
**La voz usa Azure de pago**: no es audio gratuito ni una grabación simulada.
El diálogo explica el coste y el máximo de tres minutos antes de iniciar.
No hay puntuación, admisión de llamadas de Prosper ni envíos clínicos.

Tras pulsar **Iniciar llamada**, se solicita micrófono con cancelación de eco,
supresión de ruido y audio mono. Solo después de obtenerlo y preparar Web Audio,
`POST /api/dashboard/demo-call` (sin cuerpo) solicita un ticket con el token del
dashboard en su cabecera. Se abre el WebSocket del mismo origen usando
`['maio-demo', ticket]` como subprotocolos: ni el ticket ni el token se ponen en
la URL o en almacenamiento persistente. El servidor es dueño del ID y la capacidad.

Un AudioWorklet remuestrea la frecuencia real del AudioContext a 8 kHz con filtro
anti-alias y forma bloques de 160 muestras. La tabla de 256 muestras proporcionada
por el servidor sirve tanto para decodificar como para codificar por búsqueda
binaria del vecino más cercano; el silencio usa `0xff`. No se envía audio antes de
`ready`. Solo se emiten `media` (160 bytes, 20 ms, G.711 mu-law) y `stop`, nunca
`start`/`connected` de Twilio ni IDs inventados.
El puente puede adelantar texto o audio de saludo mientras el proveedor termina
de iniciar. El frontend valida y muestra/reproduce ese contenido sin habilitar
el micrófono hasta `ready`; recibir un saludo no autoriza enviar audio.

La reproducción usa AudioBuffer a 8 kHz y una cola de hasta dos segundos. `clear`
detiene el audio actual y pendiente. Colgar, cerrar, navegar, desconectar, caducar
la sesión, recibir un error o alcanzar el límite libera pistas, worklets, contexto,
fuentes, temporizadores y WebSocket. Los permisos tardíos se descartan y sus pistas
se detienen: no reabren una sesión cancelada. Los errores de permiso, capacidad,
conexión y contrapresión son visibles; no se reintenta automáticamente.

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

`test/dashboard-demo.browser.ts` añade micrófono falso de Chromium y
WebSockets/tickets locales interceptados, sin acceso a Azure. Comprueba frames,
remuestreo 8/44,1/48 kHz, filtro anti-alias, tabla mu-law, reproducción/clear,
desconexión, expiración, límites y carreras. `test/dashboard.browser.ts` compara
geometría y tipografía con una referencia pública de `b5cdcfa` servida solo en
loopback, además de probar scroll, filtros y separación real/demo.
Una regresión de navegador usa también el puente nativo con un proveedor de voz
falso: POST 201, ticket/Origin reales del servidor local, saludo anterior a
`ready`, captura, reproducción, `clear` y cierre, sin Azure ni grabaciones.
`DASHBOARD_VISUAL_CAPTURE=1` guarda capturas sintéticas opcionales bajo
`dashboard/.local/visual-captures/`; no contiene grabaciones o pacientes reales.
