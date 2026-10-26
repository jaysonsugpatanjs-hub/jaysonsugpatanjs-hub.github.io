import assert from "node:assert/strict";
import test from "node:test";
import { submitLeadPilotMirror } from "../src/leadpilot-h8-delivery.js";

const url = "https://example.invalid/webhook/leadpilot-inbound";

test("accepts 2xx response and preserves consent evidence in encoded body", async () => {
  let captured;
  const fetchImpl = async (endpoint, options) => {
    captured = { endpoint, options };
    return { ok: true, status: 200 };
  };
  const result = await submitLeadPilotMirror({
    email: "tester@example.com",
    contact_consent: "true",
    consent_version: "2026-09",
    consent_timestamp: "2026-10-20T00:00:00.000Z",
    leadpilot_submission_id: "test-001",
  }, { url, fetchImpl });
  assert.deepEqual(result, { accepted: true, httpStatus: 200, error: null });
  assert.equal(captured.endpoint, url);
  assert.equal(captured.options.method, "POST");
  const body = new URLSearchParams(captured.options.body);
  assert.equal(body.get("contact_consent"), "true");
  assert.equal(body.get("consent_version"), "2026-09");
  assert.equal(body.get("leadpilot_submission_id"), "test-001");
});

test("does not treat a 503 webhook response as successful delivery", async () => {
  let calls = 0;
  const result = await submitLeadPilotMirror({ email: "tester@example.com" }, {
    url,
    fetchImpl: async () => { calls++; return { ok: false, status: 503 }; },
  });
  assert.deepEqual(result, { accepted: false, httpStatus: 503, error: "HTTP_503" });
  assert.equal(calls, 1, "do not retry without server-side idempotency");
});

test("reports a network/CORS failure without throwing or duplicating", async () => {
  const result = await submitLeadPilotMirror({}, {
    url,
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.deepEqual(result, { accepted: false, httpStatus: null, error: "NETWORK_OR_CORS" });
});

test("reports a timeout and aborts the request", async () => {
  const result = await submitLeadPilotMirror({}, {
    url,
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  assert.deepEqual(result, { accepted: false, httpStatus: null, error: "TIMEOUT" });
});
