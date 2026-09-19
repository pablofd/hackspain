import { context } from "@opentelemetry/api";
import { z } from "zod";
import { AppError } from "./errors.js";
import { withSpan } from "./telemetry.js";

export interface Point {
  latitude: number;
  longitude: number;
}

export interface GeographicLocation extends Point {
  id: string;
  name: string;
}

const pointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
const locationSchema = pointSchema.extend({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

export function validatePoint(value: unknown): Point {
  const parsed = pointSchema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_geography_coordinates");
  return parsed.data;
}

export function distanceMeters(a: Point, b: Point): number {
  const from = validatePoint(a);
  const to = validatePoint(b);
  const radians = Math.PI / 180;
  const haversine = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin((to.longitude - from.longitude) * radians / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
}

/** Geometry only: retain every API ID and input order for exact distance ties. */
export function rankLocations<T extends GeographicLocation>(
  origin: Point,
  locations: readonly T[],
): (T & { distanceMeters: number })[] {
  const point = validatePoint(origin);
  if (!z.array(locationSchema).safeParse(locations).success) {
    throw new AppError("invalid_geography_locations");
  }
  return locations
    .map((location, index) => ({ location, index, distance: distanceMeters(point, location) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map(({ location, distance }) => ({ ...location, distanceMeters: distance }));
}

export interface AddressCandidate extends Point {
  id: string;
  label: string;
  kind: "portal" | "landmark";
}

export type AddressClarificationReason =
  | "municipality_required"
  | "not_found"
  | "ambiguous"
  | "address_mismatch"
  | "insufficient_precision"
  | "outside_supported_region";

export type AddressResolution =
  | { status: "resolved"; source: "cartociudad"; candidates: [AddressCandidate]; truncated: false }
  | {
    status: "needs_clarification";
    source: "cartociudad";
    reason: AddressClarificationReason;
    candidates: AddressCandidate[];
    truncated: boolean;
  };

// Official contract: https://github.com/IDEESpain/Cartociudad
// candidates supplies point coordinates; find?q silently selects the first fuzzy match.
const GEOCODER_ORIGIN = "https://www.cartociudad.es";
const GEOCODER_PATH = "/geocoder/api/geocoder/candidates";
const REQUEST_TIMEOUT_MS = 5_000;
const REQUEST_INTERVAL_MS = 1_000;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_LIMIT = 128;
const RESULT_LIMIT = 20;
// CartoCiudad caps portals independently within its mixed-type response.
const PORTAL_RESULT_LIMIT = 6;
const SHORTLIST_LIMIT = 5;
const MAX_RESPONSE_BYTES = 65_536;

const geocoderCandidateSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[\w.:-]+$/),
  address: z.string().trim().min(1).max(300).regex(/^[^\p{Cc}\p{Cf}<>{}]+$/u),
  type: z.string().min(1).max(64),
  lat: pointSchema.shape.latitude,
  lng: pointSchema.shape.longitude,
  provinceCode: z.string().max(2).nullable(),
  countryCode: z.string().max(3),
  muni: z.string().trim().min(1).max(100).nullable(),
  postalCode: z.string().max(64).regex(/^\d{5}(?:[ ,]+\d{5})*$/).nullable().optional(),
  portalNumber: z.number().int().min(0).max(99_999).nullable().optional(),
  noNumber: z.boolean().nullable().optional(),
  extension: z.string().max(10).nullable().optional(),
}).refine((candidate) => candidate.type !== "portal" || candidate.postalCode == null ||
  /^\d{5}$/.test(candidate.postalCode));
const geocoderResponseSchema = z.array(geocoderCandidateSchema).max(RESULT_LIMIT);
type GeocoderCandidate = z.infer<typeof geocoderCandidateSchema>;

interface GeographyState {
  nextRequestAt: number;
  cache: Map<string, { expiresAt: number; result: AddressResolution }>;
}

// Share only public geography and the request budget, including across call-local instances.
const states = new WeakMap<typeof fetch, GeographyState>();

function normalizeLabel(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/^c(?:\/|\.\s)/, "calle ")
    .replace(/^(?:avda|avd|av)\.?\s/, "avenida ")
    .replace(/^(?:pº|pso\.?)\s/, "paseo ")
    .replace(/^(?:pza|plz)\.?\s/, "plaza ")
    .replace(/^(?:ctra)\.?\s/, "carretera ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ")
    .replace(/^(calle|avenida|paseo|plaza|glorieta|ronda|camino|carretera|travesia|pasaje|cuesta|carrera) (?:de (?:la|las|los|el) |del |de )/, "$1 ");
}

interface ParsedAddress {
  query: string;
  place: string;
  portalNumber?: number;
  extension: string;
  municipality?: string;
  postalCode?: string;
}

const postalPrefix = "(?:(?:c\\.?\\s*p\\.?|c[oó]digo\\s+postal|postal\\s+code)\\s*)?";
const postalToken = new RegExp(`^${postalPrefix}(\\d{5})$`, "i");

function placeParts(value: string): Pick<ParsedAddress, "place" | "portalNumber" | "extension"> {
  const normalized = normalizeLabel(value);
  const numbered = /^(.*\S)\s+(\d{1,5})(?:\s*(bis|[a-z]))?$/.exec(normalized);
  return numbered
    ? { place: numbered[1]!, portalNumber: Number(numbered[2]), extension: numbered[3] ?? "" }
    : { place: normalized, extension: "" };
}

function parseAddress(address: string): ParsedAddress | undefined {
  const parts = address.split(",").map((part) => part.trim());
  if (parts.some((part) => !part) || parts.length > 4) return undefined;
  if (parts.length === 1) return { query: parts[0]!, ...placeParts(parts[0]!) };
  let postalCode: string | undefined;
  const takePostalCode = (value: string): boolean => {
    if (postalCode !== undefined || !/^(?:0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(value)) return false;
    postalCode = value;
    return true;
  };
  const trailingPostal = postalToken.exec(parts.at(-1)!);
  if (trailingPostal) {
    if (!takePostalCode(trailingPostal[1]!)) return undefined;
    parts.pop();
  }
  if (parts.length < 2) return undefined;
  let municipality = parts.pop()!;
  const localityPostal = new RegExp(`^(?:${postalPrefix}(\\d{5})\\s+(.+)|(.+?)\\s+${postalPrefix}(\\d{5}))$`, "i")
    .exec(municipality);
  if (localityPostal) {
    if (!takePostalCode(localityPostal[1] ?? localityPostal[4]!)) return undefined;
    municipality = (localityPostal[2] ?? localityPostal[3]!).trim();
  }
  if (!/^[\p{L}\p{M} .'-]+$/u.test(municipality)) return undefined;
  const separatePostal = parts.length > 1 ? postalToken.exec(parts.at(-1)!) : null;
  if (separatePostal) {
    if (!takePostalCode(separatePostal[1]!)) return undefined;
    parts.pop();
  }
  if (parts.length > 2) return undefined;
  const last = parts.at(-1)!;
  const portalPostal = (parts.length === 1
    ? /^(.*\s+\d{1,5}(?:\s*(?:bis|[a-z]))?)(?:\s+|\s*-\s*)(\d{5})$/i
    : /^(\d{1,5}(?:\s*(?:bis|[a-z]))?)(?:\s+|\s*-\s*)(\d{5})$/i).exec(last);
  if (portalPostal) {
    if (!takePostalCode(portalPostal[2]!)) return undefined;
    parts[parts.length - 1] = portalPostal[1]!;
  }
  if (parts.length === 2 && (!/^\d{1,5}(?:\s*(?:bis|[a-z]))?$/i.test(parts[1]!) ||
      placeParts(parts[0]!).portalNumber !== undefined)) return undefined;
  const place = parts.join(" ");
  return {
    query: `${place}, ${municipality}`, ...placeParts(place), municipality,
    ...(postalCode ? { postalCode } : {}),
  };
}

function publicAddress(value: unknown): ParsedAddress {
  const parsed = z.string().min(5).max(180).safeParse(value);
  if (!parsed.success) throw new AppError("invalid_public_address");
  const address = parsed.data.trim().normalize("NFC");
  const text = normalizeLabel(address);
  const sensitive = /\b(?:dni|nie|nif|pasaporte|paciente|patient|documento|telefono|phone|movil|email|correo|poliza|nacimiento|nacido|nacida|historial|diagnostico|me llamo|nombre|apellido|apellidos|soy|vivo|quiero|necesito|tengo|piso|planta|escalera|apartamento|apartment|flat|floor|unit|resident)\b/;
  const identityNumber = /\b(?:\d[ .-]*){8}[a-z]\b|\b[xyz](?:[ .-]*\d){7}[ .-]*[a-z]\b/i;
  const longNumber = /(?:\d[ ().+-]*){7,}/;
  const phoneNumber = /\b[6789](?:[ .()-]*\d){8}\b/;
  const spokenNumber = /\b(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)(?:\s+(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)){6,}\b/;
  const date = /\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/;
  const privateUnit = /\d\s*[ºª]|\b(?:puerta|bloque|atico|entresuelo|bajo)\s+(?:\d|[a-z]\b)/;
  const locationPrefix = /^(?:calle|avenida|paseo|plaza|glorieta|ronda|camino|carretera|travesia|pasaje|cuesta|carrera|gran via|puerta|parque|estacion|metro|museo|aeropuerto|teatro|mercado|biblioteca|hospital|palacio|universidad|colegio|estadio|centro cultural|centro comercial)(?:\s|$)/;
  const rawNormalized = address.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const structured = parseAddress(address);
  // Only a structurally identified postcode is removed from the long-number check.
  if (!/^[\p{L}\p{M}\p{N} ,.'’/ºª()-]+$/u.test(address) ||
      sensitive.test(text) || identityNumber.test(address) || phoneNumber.test(address) ||
      spokenNumber.test(text) || privateUnit.test(rawNormalized) || date.test(address) ||
      !structured || !locationPrefix.test(structured.place) || longNumber.test(structured.query)) {
    throw new AppError("invalid_public_address");
  }
  return structured;
}

function clarification(
  reason: AddressClarificationReason,
  candidates: AddressCandidate[] = [],
  truncated = false,
): AddressResolution {
  return { status: "needs_clarification", source: "cartociudad", reason, candidates, truncated };
}

function inSupportedRegion(candidate: GeocoderCandidate): boolean {
  if (candidate.countryCode !== "011" || candidate.provinceCode !== "28") return false;
  if (candidate.type !== "portal" && candidate.type !== "toponimo") return true;
  return candidate.lat >= 39.8 && candidate.lat <= 41.2 &&
    candidate.lng >= -4.6 && candidate.lng <= -3;
}

function exactAddress(address: ParsedAddress, candidate: GeocoderCandidate): boolean {
  const found = parseAddress(candidate.address);
  if (!found || !address.municipality || !found.municipality || !candidate.muni ||
      normalizeLabel(address.municipality) !== normalizeLabel(candidate.muni) ||
      normalizeLabel(found.municipality) !== normalizeLabel(candidate.muni) ||
      address.place !== found.place || address.portalNumber !== found.portalNumber ||
      address.extension !== found.extension) return false;
  const postalCodes = candidate.postalCode?.split(/[ ,]+/) ?? [];
  if (found.postalCode && postalCodes.length && !postalCodes.includes(found.postalCode)) return false;
  if (address.postalCode && ((found.postalCode && found.postalCode !== address.postalCode) ||
      (postalCodes.length && !postalCodes.includes(address.postalCode)))) return false;
  if (candidate.type === "toponimo") return address.portalNumber === undefined;
  return candidate.type === "portal" && address.portalNumber !== undefined &&
    address.portalNumber === candidate.portalNumber &&
    address.extension === normalizeLabel(candidate.extension ?? "");
}

function addressResult(address: ParsedAddress, data: GeocoderCandidate[]): AddressResolution {
  if (data.length === 0) return clarification("not_found");
  if (data.some((candidate) => !inSupportedRegion(candidate))) {
    return clarification("outside_supported_region");
  }
  const precise = data.filter((candidate) => candidate.type === "toponimo" ||
    (candidate.type === "portal" && candidate.portalNumber != null &&
      candidate.portalNumber > 0 && candidate.noNumber !== true));
  const seen = new Set<string>();
  // A fuzzy neighbor is not an alternative to the location the caller stated.
  const exact = precise.filter((candidate) => {
    if (!exactAddress(address, candidate)) return false;
    const key = JSON.stringify([candidate.id, candidate.type, candidate.lat, candidate.lng, candidate.postalCode]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const candidates: AddressCandidate[] = exact.slice(0, SHORTLIST_LIMIT).map((candidate) => ({
    id: candidate.id,
    label: candidate.address,
    latitude: candidate.lat,
    longitude: candidate.lng,
    kind: candidate.type === "portal" ? "portal" : "landmark",
  }));
  const truncated = data.length >= RESULT_LIMIT || exact.length > SHORTLIST_LIMIT ||
    data.filter((candidate) => candidate.type === "portal").length >= PORTAL_RESULT_LIMIT;
  if (candidates.length === 0) {
    return clarification(precise.length ? "address_mismatch" : "insufficient_precision", [], truncated);
  }
  if (exact.length !== 1) return clarification("ambiguous", candidates, truncated);
  return { status: "resolved", source: "cartociudad", candidates: [candidates[0]!], truncated: false };
}

async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = (): void => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new AppError("geocoder_cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancellation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = Number(response.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || length > MAX_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new AppError("geocoder_invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await untilAborted(reader.read(), signal);
      done = chunk.done;
      if (chunk.value) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new AppError("geocoder_invalid_response");
        chunks.push(chunk.value);
      }
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch {
      throw new AppError("geocoder_invalid_response");
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Pass ONLY a public street/landmark explicitly supplied for nearest-site lookup,
 * formatted "street and number, municipality" (or "landmark, municipality"), with an optional public postcode.
 * Never pass a transcript, identity, patient record, or private apartment details.
 * Supports Madrid province; only fully matching points are offered, with user choice for competing exact matches.
 * One GET per uncached lookup, five-second deadline, shared one-request/second budget.
 */
export class AddressResolver {
  private readonly state: GeographyState;

  constructor(private readonly request: typeof fetch = fetch) {
    let state = states.get(request);
    if (!state) {
      state = { nextRequestAt: 0, cache: new Map() };
      states.set(request, state);
    }
    this.state = state;
  }

  async resolve(address: string, signal: AbortSignal): Promise<AddressResolution> {
    if (signal.aborted) throw new AppError("call_cancelled");
    const query = publicAddress(address);
    const municipality = query.municipality;
    if (!municipality) return clarification("municipality_required");
    const key = JSON.stringify([
      query.place, query.portalNumber, query.extension, normalizeLabel(municipality), query.postalCode,
    ]);
    const cached = this.state.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.result);
    this.state.cache.delete(key);
    if (Date.now() < this.state.nextRequestAt) throw new AppError("geocoder_rate_limited");
    this.state.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;

    return withSpan("geography.resolve_address", {
      "geography.provider": "cartociudad",
      "http.request.method": "GET",
      "url.path": GEOCODER_PATH,
    }, context.active(), async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, deadline.signal]);
      try {
        const url = new URL(GEOCODER_PATH, GEOCODER_ORIGIN);
        url.search = new URLSearchParams({
          q: query.query,
          limit: String(RESULT_LIMIT),
          countrycodes: "es",
          provincia_filter: "Madrid",
          municipio_filter: municipality,
          ...(query.postalCode ? { cod_postal_filter: query.postalCode } : {}),
          no_process: "municipio,provincia,comunidad autonoma,poblacion,expendeduria,punto_recarga_electrica,ngbe",
        }).toString();
        const response = await untilAborted(this.request(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: combined,
        }), combined);
        if (response.redirected || (response.url && new URL(response.url).origin !== GEOCODER_ORIGIN)) {
          void response.body?.cancel().catch(() => {});
          throw new AppError("geocoder_redirect_refused");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 429 || response.status === 503) {
            const retry = response.headers.get("retry-after");
            const retryAt = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 :
              retry ? Date.parse(retry) : NaN;
            this.state.nextRequestAt = Math.max(this.state.nextRequestAt,
              Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : Date.now() + 30_000);
          }
          throw new AppError(response.status === 429 ? "geocoder_rate_limited" : `geocoder_http_${response.status}`);
        }
        const data = geocoderResponseSchema.safeParse(await responseJson(response, combined));
        if (!data.success) throw new AppError("geocoder_invalid_response");
        if (combined.aborted) throw new AppError("geocoder_cancelled");
        const result = addressResult(query, data.data);
        if (this.state.cache.size >= CACHE_LIMIT) {
          this.state.cache.delete(this.state.cache.keys().next().value!);
        }
        this.state.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
        return structuredClone(result);
      } catch (error) {
        if (signal.aborted) throw new AppError("call_cancelled");
        if (deadline.signal.aborted) throw new AppError("geocoder_timeout");
        if (error instanceof AppError) throw error;
        throw new AppError("geocoder_network_error");
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
