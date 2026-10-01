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

// Calls an atomic SQL function. Database errors carry a SQLSTATE that maps to
// the HTTP status the caller should see; the message is written for people.
const SQLSTATE_STATUS: Record<string, number> = {
  "42501": 403, // insufficient privilege (access rules)
  "P0002": 404, // not found
  "22023": 409, // invalid parameter / state
  "23505": 409, // unique violation
  "23514": 400, // check constraint
  "23503": 409, // foreign key
  "22P02": 400, // invalid text representation (bad uuid/date)
  "22007": 400, // invalid date
  "22008": 400 // date out of range
};

export async function rpc<T = unknown>(client: any, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const status = SQLSTATE_STATUS[String(error.code)] || 500;
    let message = String(error.message || "The request could not be completed.");
    if (error.code === "23505") message = "That record already exists.";
    if (error.code === "23514") message = "One of the values is outside what is allowed.";
    if (error.code === "22P02" || error.code === "22007" || error.code === "22008") message = "One of the values is not in a valid format.";
    if (status >= 500) console.error(`${fn} failed`, error);
    throw httpError(status, message, error.code);
  }
  return data as T;
}
