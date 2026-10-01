// Stand-in for npm:@supabase/server: injects the PostgREST-backed client and
// takes the signed-in user from a test header.
import { createClient } from "./client.ts";

export function withSupabase(_opts: unknown, handler: (request: Request, context: any) => Promise<Response>) {
  const client = createClient();
  return (request: Request) => handler(request, { userClaims: { sub: request.headers.get("x-test-user") }, supabaseAdmin: client });
}
