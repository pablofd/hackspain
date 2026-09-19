import assert from "node:assert/strict";
import { test } from "node:test";
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { z } from "zod";
import { AppError } from "../src/errors.js";
import { startTelemetry, withSpan } from "../src/telemetry.js";
import { config } from "./helpers.js";

test("missing Application Insights is reported as observability-only, not an Azure connection failure", async (t) => {
  const messages: string[] = [];
  t.mock.method(console, "log", (value: unknown) => {
    if (typeof value === "string") messages.push(value);
  });
  const telemetry = startTelemetry(config());
  try {
    assert.equal(telemetry.mode, "console");
    assert.equal(messages.length, 1);
    const warning = z.object({
      event: z.literal("telemetry.console_only"),
      scope: z.literal("observability_only"),
      reason: z.string(),
    }).parse(JSON.parse(messages[0] ?? ""));
    assert.match(warning.reason, /Azure model requests are unaffected/);
  } finally {
    await telemetry.shutdown();
    trace.disable();
    context.disable();
  }
});

test("connection-check spans explicitly distinguish success from sanitized failure", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  try {
    await withSpan("successful_check", {}, ROOT_CONTEXT, async () => 1);
    await assert.rejects(withSpan("failed_check", {}, ROOT_CONTEXT, async () => {
      throw new AppError("safe_failure_code", "private upstream detail");
    }));
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[0]?.status.code, SpanStatusCode.OK);
    assert.deepEqual(spans[1]?.status, { code: SpanStatusCode.ERROR, message: "safe_failure_code" });
  } finally {
    await provider.shutdown();
    trace.disable();
    context.disable();
  }
});
