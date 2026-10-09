const mod = await import("file:///tmp/repo/supabase/functions/finance-api/index.ts");
const api = mod.default;
Deno.serve({ port: 8787 }, async (req) => {
  const headers = new Headers(req.headers);
  headers.set("origin", "https://jaysonsugpatanjs-hub.github.io");
  if (!headers.get("x-test-aal")) headers.set("x-test-aal", "aal2");
  const r = new Request("https://x.test/fn", { method: req.method, headers, body: req.method === "POST" ? await req.text() : undefined });
  const res = await api.fetch(r);
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  return new Response(await res.text(), { status: res.status, headers: h });
});
