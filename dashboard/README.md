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
- `GET /api/dashboard/patients?name=...` o `?phone=...`: búsqueda explícita
  en Prosper; solo ID, nombre, teléfono y aseguradora.
- `GET /api/dashboard/patients/{id}/appointments`: citas próximas del EHR.

No existe proxy genérico, endpoint de escritura ni botón que lance una llamada
real. Los fallos se muestran; una respuesta vacía no se sustituye por mocks.
Las llamadas se relacionan por el `patient_id` de un BOOK recibido, nunca por
un parecido de nombres ni por un teléfono compartido. La lista y el mapa
mantienen los mismos filtros. No se consultan fotografías ni tipografías externas.

La vista de llamada actualiza los eventos técnicos cada cinco segundos. Las
transcripciones y el audio privados permanecen fuera de HTTP; no se inventan
ondas de audio, marcas de tiempo de turnos o indicadores de que alguien habla.
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

Las pruebas usan pacientes y respuestas sintéticas, un navegador local y ningún
servicio de pago. `npm test` incluye los contratos offline; el navegador se
ejecuta explícitamente mediante `test:dashboard`.
