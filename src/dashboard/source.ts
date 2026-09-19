import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import { AppError, errorCode } from "../errors.js";
import { log, withSpan } from "../telemetry.js";

export type Source<T> =
  | { status: "ok"; checkedAt: string; code: null; data: T }
  | { status: "error" | "not_configured" | "not_used"; checkedAt: string; code: string; data: null };

export function unavailable<T>(status: "not_configured" | "not_used", code: string): Source<T> {
  return { status, code, checkedAt: new Date().toISOString(), data: null };
}

export async function observe<T>(name: string, operation: () => Promise<T>): Promise<Source<T>> {
  try {
    const data = await operation();
    return { status: "ok", checkedAt: new Date().toISOString(), code: null, data };
  } catch (error) {
    const code = errorCode(error);
    log("warn", "dashboard.source_failed", { source: name, code });
    return { status: "error", checkedAt: new Date().toISOString(), code, data: null };
  }
}

export function cached<T>(milliseconds: number, operation: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let expires = 0;
  let pending: Promise<T> | undefined;
  return () => {
    if (value !== undefined && Date.now() < expires) return Promise.resolve(value);
    pending ??= operation().then((next) => {
      value = next;
      expires = Date.now() + milliseconds;
      return next;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export async function requestJson<T>(
  request: typeof fetch,
  url: URL,
  schema: z.ZodType<T>,
  source: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  return withSpan(`dashboard.${source}`, { "dashboard.source": source }, ROOT_CONTEXT, async () => {
    let response: Response;
    try {
      response = await request(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
      });
    } catch {
      throw new AppError(signal.aborted ? "dashboard_request_timeout" : `${source}_network_error`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(`${source}_http_${response.status}`);
    }
    if (!response.body) throw new AppError(`${source}_invalid_response`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 4 * 1024 * 1024) throw new AppError(`${source}_response_too_large`);
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel();
      if (error instanceof AppError) throw error;
      throw new AppError(signal.aborted ? "dashboard_request_timeout" : `${source}_response_interrupted`);
    } finally {
      reader.releaseLock();
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AppError(`${source}_invalid_json`); }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AppError(`${source}_invalid_response`);
    return parsed.data;
  });
}
