/**
 * Attempt the secondary LeadPilot webhook handoff exactly once.
 * An accepted webhook response is not proof that HubSpot has processed the lead.
 * Retries belong in a durable server-side queue with idempotency enforcement.
 */
export async function submitLeadPilotMirror(
  payload,
  { url, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {},
) {
  if (!url) throw new Error("LeadPilot webhook URL is required");

  const body = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    body.set(key, String(value ?? ""));
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
      keepalive: true,
      signal: controller.signal,
    });
    return {
      accepted: response.ok,
      httpStatus: response.status,
      error: response.ok ? null : `HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      accepted: false,
      httpStatus: null,
      error: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_OR_CORS",
    };
  } finally {
    clearTimeout(timeout);
  }
}
