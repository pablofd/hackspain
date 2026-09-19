import { context, SpanStatusCode, trace, type Attributes, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { shutdownAzureMonitor, useAzureMonitor } from "@azure/monitor-opentelemetry";
import { errorCode } from "./errors.js";
import type { Config } from "./config.js";

export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function startTelemetry(config: Config): {
  mode: "azure" | "console";
  shutdown: () => Promise<void>;
} {
  const resource = resourceFromAttributes({
    "service.name": config.OTEL_SERVICE_NAME,
    "service.version": "0.1.0",
  });
  if (config.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    useAzureMonitor({
      resource,
      azureMonitorExporterOptions: {
        connectionString: config.APPLICATIONINSIGHTS_CONNECTION_STRING,
        disableOfflineStorage: true,
      },
      samplingRatio: 1,
      tracesPerSecond: 0,
      enableLiveMetrics: true,
      enableStandardMetrics: true,
      instrumentationOptions: {
        // Record only our explicit spans, never HTTP query strings or request bodies.
        http: { enabled: false },
        azureSdk: { enabled: false },
        mongoDb: { enabled: false },
        mySql: { enabled: false },
        postgreSql: { enabled: false },
        redis: { enabled: false },
        redis4: { enabled: false },
        bunyan: { enabled: false },
        winston: { enabled: false },
        console: { enabled: false },
      },
    });
    return { mode: "azure", shutdown: shutdownAzureMonitor };
  }
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
  log("warn", "telemetry.console_only", {
    scope: "observability_only",
    reason: "Application Insights export is not configured; traces are printed locally. Azure model requests are unaffected.",
  });
  return { mode: "console", shutdown: () => provider.shutdown() };
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  parent: Context,
  operation: () => Promise<T>,
): Promise<T> {
  const span = trace.getTracer("hackspain-cachopo").startSpan(name, { attributes }, parent);
  try {
    const result = await context.with(trace.setSpan(parent, span), operation);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode(error) });
    throw error;
  } finally {
    span.end();
  }
}
