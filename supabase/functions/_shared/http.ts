const DEFAULT_ORIGINS = [
  "https://jaysonsugpatanjs-hub.github.io",
  "https://training.panalopipesandstructurals.com.au",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

function allowedOrigins() {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map(value => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ORIGINS;
}

export function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = !origin || allowedOrigins().includes(origin.replace(/\/$/, ""));
  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowed && origin ? origin : DEFAULT_ORIGINS[0],
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Vary": "Origin"
    }
  };
}

export function json(request: Request, body: unknown, status = 200) {
  const cors = corsHeaders(request);
  return Response.json(body, { status, headers: cors.headers });
}

export function errorJson(request: Request, error: unknown, fallbackStatus = 500) {
  const value = error as { message?: string; status?: number; code?: string };
  const status = Number(value?.status) || fallbackStatus;
  if (status >= 500) console.error(error);
  return json(request, {
    message: status >= 500 ? "The secure training service could not complete the request." : value?.message || "Request failed.",
    code: value?.code
  }, status);
}

export function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, code });
}
