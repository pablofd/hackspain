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
const RESULT_LIMIT = 6;
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
  portalNumber: z.number().int().min(0).max(99_999).nullable().optional(),
  noNumber: z.boolean().nullable().optional(),
  extension: z.string().max(10).nullable().optional(),
});
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
    .replace(/^(?:pza|plz)\.?\s/, "plaza ")
    .replace(/^(?:ctra)\.?\s/, "carretera ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function publicAddress(value: unknown): string {
  const parsed = z.string().min(5).max(180).safeParse(value);
  if (!parsed.success) throw new AppError("invalid_public_address");
  const address = parsed.data.trim().normalize("NFC");
  const text = normalizeLabel(address);
  const sensitive = /\b(?:dni|nie|nif|pasaporte|paciente|patient|documento|telefono|phone|movil|email|correo|poliza|nacimiento|nacido|nacida|historial|diagnostico|me llamo|nombre|apellido|apellidos|soy|vivo|quiero|necesito|tengo|piso|planta|escalera|apartamento)\b/;
  const identityNumber = /\b(?:\d[ .-]*){8}[a-z]\b|\b[xyz](?:[ .-]*\d){7}[ .-]*[a-z]\b/i;
  const longNumber = /(?:\d[ ().+-]*){7,}/;
  const spokenNumber = /\b(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)(?:\s+(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)){6,}\b/;
  const date = /\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/;
  const privateUnit = /\d\s*[ºª]|\b(?:puerta|bloque|atico|entresuelo|bajo)\s+(?:\d|[a-z]\b)/;
  const locationPrefix = /^(?:calle|c\/|c\.|avenida|avda\.?|avd\.?|av\.?|paseo|plaza|pza\.?|plz\.?|glorieta|ronda|camino|carretera|ctra\.?|travesia|pasaje|cuesta|carrera|gran via|puerta|parque|estacion|metro|museo|aeropuerto|teatro|mercado|biblioteca|hospital|palacio|universidad|colegio|estadio|centro cultural|centro comercial)(?:\s|$)/;
  const rawNormalized = address.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (!/^[\p{L}\p{M}\p{N} ,.'’/ºª()-]+$/u.test(address) ||
      sensitive.test(text) || identityNumber.test(address) || longNumber.test(address) ||
      spokenNumber.test(text) || privateUnit.test(rawNormalized) || date.test(address) ||
      !locationPrefix.test(rawNormalized)) {
    throw new AppError("invalid_public_address");
  }
  const parts = address.split(",").map((part) => part.trim());
  // No free-form transcript or extra identity/address-unit fields after the locality.
  if (parts.some((part) => !part) || parts.length > 3 ||
      (parts.length === 3 && !/^\d{1,4}(?:\s?[a-z]| bis)?$/i.test(parts[1]!)) ||
      (parts.length > 1 && !/^[\p{L}\p{M} .'-]+$/u.test(parts.at(-1)!))) {
    throw new AppError("invalid_public_address");
  }
  return address;
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

function addressResult(address: string, data: GeocoderCandidate[]): AddressResolution {
  if (data.length === 0) return clarification("not_found");
  if (data.some((candidate) => !inSupportedRegion(candidate))) {
    return clarification("outside_supported_region");
  }
  const precise = data.filter((candidate) => candidate.type === "toponimo" ||
    (candidate.type === "portal" && candidate.portalNumber != null &&
      candidate.portalNumber > 0 && candidate.noNumber !== true));
  const candidates: AddressCandidate[] = precise.slice(0, SHORTLIST_LIMIT).map((candidate) => ({
    id: candidate.id,
    label: candidate.address,
    latitude: candidate.lat,
    longitude: candidate.lng,
    kind: candidate.type === "portal" ? "portal" : "landmark",
  }));
  const truncated = data.length >= RESULT_LIMIT || precise.length > SHORTLIST_LIMIT;
  if (candidates.length === 0) return clarification("insufficient_precision", [], truncated);
  if (data.length !== 1) return clarification("ambiguous", candidates, truncated);
  const found = precise[0]!;
  const hasNumber = /\d/.test(address);
  const normalized = normalizeLabel(address);
  // CartoCiudad's state=0 is NOT a confidence score. Require the whole label,
  // including the caller's municipality, and consistent portal metadata.
  const portalSuffix = normalizeLabel(
    `${found.portalNumber ?? ""} ${found.extension ?? ""} ${found.muni ?? ""}`,
  );
  const exact = normalized === normalizeLabel(found.address) &&
    found.muni !== null && normalized.endsWith(` ${normalizeLabel(found.muni)}`) &&
    (!hasNumber || found.type === "portal") &&
    (found.type !== "portal" || normalized.endsWith(` ${portalSuffix}`));
  if (!exact) return clarification("address_mismatch", candidates);
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
 * formatted "street and number, municipality" (or "landmark, municipality").
 * Never pass a transcript, identity, patient record, or private apartment details.
 * Supports Madrid province; requires user choice for every non-exact or ambiguous result.
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
    if (!query.includes(",")) return clarification("municipality_required");
    const key = normalizeLabel(query);
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
          q: query,
          limit: String(RESULT_LIMIT),
          countrycodes: "es",
          provincia_filter: "Madrid",
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
