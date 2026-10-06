// Minimal supabase-js stand-in that sends the Edge Functions' queries to a
// real PostgREST, so every select, filter, embed and RPC is checked for real.
const BASE = Deno.env.get("POSTGREST_URL") || "http://127.0.0.1:3999";

type Result = { data: any; error: any; count?: number | null };

class Query implements PromiseLike<Result> {
  private params = new URLSearchParams();
  private orders: string[] = [];
  private method = "GET";
  private body: unknown = undefined;
  private prefer: string[] = [];
  private mode: "many" | "single" | "maybe" = "many";
  private head = false;
  private countExact = false;
  constructor(private table: string) {}

  select(cols = "*", opts: { count?: string; head?: boolean } = {}) {
    this.params.set("select", cols.replace(/\s+/g, ""));
    if (opts.count === "exact") this.countExact = true;
    if (opts.head) this.head = true;
    if (this.method !== "GET") this.prefer.push("return=representation");
    return this;
  }
  private filter(col: string, op: string, val: unknown) { this.params.append(col, `${op}.${val}`); return this; }
  eq(c: string, v: unknown) { return this.filter(c, "eq", v); }
  neq(c: string, v: unknown) { return this.filter(c, "neq", v); }
  gt(c: string, v: unknown) { return this.filter(c, "gt", v); }
  gte(c: string, v: unknown) { return this.filter(c, "gte", v); }
  lte(c: string, v: unknown) { return this.filter(c, "lte", v); }
  ilike(c: string, v: unknown) { return this.filter(c, "ilike", v); }
  is(c: string, v: unknown) { return this.filter(c, "is", v === null ? "null" : v); }
  not(c: string, op: string, v: unknown) { return this.filter(c, `not.${op}`, v === null ? "null" : v); }
  in(c: string, vs: unknown[]) { return this.filter(c, "in", `(${vs.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`); }
  order(col: string, opts: { ascending?: boolean } = {}) { this.orders.push(`${col}.${opts.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n: number) { this.params.set("limit", String(n)); return this; }
  range(from: number, to: number) { this.params.set("offset", String(from)); this.params.set("limit", String(to - from + 1)); return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  insert(values: unknown) { this.method = "POST"; this.body = values; return this; }
  update(values: unknown) { this.method = "PATCH"; this.body = values; return this; }
  upsert(values: unknown, opts: { onConflict?: string } = {}) {
    this.method = "POST"; this.body = values; this.prefer.push("resolution=merge-duplicates");
    if (opts.onConflict) this.params.set("on_conflict", opts.onConflict);
    return this;
  }
  delete() { this.method = "DELETE"; return this; }

  async run(): Promise<Result> {
    if (this.orders.length) this.params.set("order", this.orders.join(","));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.countExact) this.prefer.push("count=exact");
    if (this.prefer.length) headers.Prefer = this.prefer.join(",");
    const method = this.head ? "HEAD" : this.method;
    const res = await fetch(`${BASE}/${this.table}?${this.params}`, { method, headers, body: this.body === undefined ? undefined : JSON.stringify(this.body) });
    const text = method === "HEAD" ? "" : await res.text();
    const range = res.headers.get("content-range");
    const count = range && range.includes("/") ? Number(range.split("/")[1]) : null;
    if (!res.ok) {
      const error = text ? JSON.parse(text) : { message: res.statusText, code: String(res.status) };
      return { data: null, error, count };
    }
    if (this.head) return { data: null, error: null, count };
    let data = text ? JSON.parse(text) : null;
    if (this.mode !== "many") {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (this.mode === "single" && rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${rows.length}` } };
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      data = rows[0] ?? null;
    }
    return { data, error: null, count };
  }
  then<A, B>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(ok, bad);
  }
}

// Storage: remembers uploaded paths so "list" reports them as present.
export const storageCalls: string[] = [];
const uploaded = new Set<string>();

async function rpcCall(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/rpc/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return res.ok ? { data, error: null } : { data: null, error: data };
}

export function createClient() {
  return {
    from: (table: string) => new Query(table),
    rpc: rpcCall,
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string) => {
          storageCalls.push(`list ${bucket}/${prefix}`);
          const names = [...uploaded].filter(p => p.startsWith(`${bucket}/${prefix}/`)).map(p => ({ id: p, name: p.split("/").pop(), metadata: { size: 10 } }));
          return { data: names, error: null };
        },
        createSignedUploadUrl: async (path: string) => {
          storageCalls.push(`upload ${bucket}/${path}`);
          uploaded.add(`${bucket}/${path}`);
          return { data: { signedUrl: `https://storage.test/${bucket}/${path}` }, error: null };
        },
        createSignedUrl: async (path: string) => { storageCalls.push(`sign ${bucket}/${path}`); return { data: { signedUrl: `https://storage.test/${path}` }, error: null }; },
        upload: async (path: string, _body: unknown) => {
          storageCalls.push(`store ${bucket}/${path}`);
          uploaded.add(`${bucket}/${path}`);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) { storageCalls.push(`remove ${bucket}/${path}`); uploaded.delete(`${bucket}/${path}`); }
          return { data: paths.map(name => ({ name })), error: null };
        },
        download: async () => ({ data: null, error: { message: "not in test" } })
      })
    },
    auth: {
      admin: {
        createUser: async (attrs: any) => {
          const r = await rpcCall("test_auth_create_user", { p_email: attrs.email, p_meta: attrs.user_metadata || {}, p_call: "create" });
          return r.error ? { data: null, error: r.error } : { data: { user: { id: r.data } }, error: null };
        },
        inviteUserByEmail: async (email: string, opts: any) => {
          const r = await rpcCall("test_auth_create_user", { p_email: email, p_meta: opts?.data || {}, p_call: "invite" });
          return r.error ? { data: null, error: r.error } : { data: { user: { id: r.data } }, error: null };
        },
        updateUserById: async (id: string, attrs: any) => {
          const r = await rpcCall("test_auth_update_user", { p_id: id, p_fields: Object.keys(attrs || {}) });
          return r.error ? { data: null, error: r.error } : { data: { user: { id } }, error: null };
        }
      }
    }
  };
}
