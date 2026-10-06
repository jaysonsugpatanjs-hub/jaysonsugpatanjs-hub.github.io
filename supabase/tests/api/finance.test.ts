// End-to-end tests for finance-api (Panalo Accounts, Phase 1), against
// PostgREST over the fully migrated database. Fixtures come from the database
// tests (people under @fin.test with roles, @panalo.test staff).
import { storageCalls } from "./client.ts";

const BASE = Deno.env.get("POSTGREST_URL") || "http://127.0.0.1:3999";
const fns = new URL("../../functions/", import.meta.url);
const financeApi = (await import(new URL("finance-api/index.ts", fns).href)).default;
const { sessionAal } = await import(new URL("finance-api/index.ts", fns).href);

async function rest(path: string) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}
const profile = async (email: string) => (await rest(`training_profiles?select=id&email=eq.${encodeURIComponent(email)}`))[0].id;

async function call(user: string, body: Record<string, unknown>, aal = "aal2") {
  const res = await financeApi.fetch(new Request("https://x.test/fn", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jaysonsugpatanjs-hub.github.io", "x-test-user": user, "x-test-aal": aal },
    body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function expectStatus(r: { status: number; body: any }, expected: number, label: string) {
  if (r.status !== expected) throw new Error(`${label}: expected ${expected}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}
const ok = async (user: string, body: Record<string, unknown>, aal = "aal2") => expectStatus(await call(user, body, aal), 200, String(body.action));

const SYS = await profile("sysadmin@fin.test");
const FIN = await profile("finance@fin.test");
const DIR = await profile("director@fin.test");
const PAY = await profile("payroll@fin.test");
const STAFF = await profile("staff@fin.test");

Deno.test("aal is read from the verified token", () => {
  const token = (payload: unknown) => `x.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.y`;
  const req = (t: string) => new Request("https://x.test", { headers: { authorization: `Bearer ${t}` } });
  if (sessionAal(req(token({ aal: "aal2" })), {}) !== "aal2") throw new Error("aal2 not read");
  if (sessionAal(req(token({ sub: "x" })), {}) !== "aal1") throw new Error("missing aal should be aal1");
  if (sessionAal(new Request("https://x.test"), { aal: "aal2" }) !== "aal2") throw new Error("claims fallback");
});

Deno.test("access: who can open Panalo Accounts, and MFA", async () => {
  expectStatus(await call(STAFF, { action: "whoami" }), 403, "staff without finance keys");
  const me = await ok(SYS, { action: "whoami" }, "aal1");
  if (!me.mfa.required || me.mfa.satisfied) throw new Error(`system admin must need MFA: ${JSON.stringify(me.mfa)}`);
  if (me.permissions.includes("payroll.sensitive")) throw new Error("system admin must not hold payroll.sensitive");
  const blocked = expectStatus(await call(SYS, { action: "dashboard" }, "aal1"), 403, "no MFA, no data");
  if (blocked.code !== "mfa_required") throw new Error("expected mfa_required code");
  const mfaOk = await ok(SYS, { action: "whoami" }, "aal2");
  if (!mfaOk.mfa.satisfied) throw new Error("aal2 satisfies MFA");
  await ok(SYS, { action: "dashboard" });
  expectStatus(await call(FIN, { action: "nope" }), 400, "unknown action");
});

Deno.test("permissions: each role stays in its area", async () => {
  expectStatus(await call(FIN, { action: "company_save", patch: { phone: "02 9000 0001" } }), 403, "finance admin cannot edit company settings");
  expectStatus(await call(FIN, { action: "users_list" }), 403, "finance admin cannot manage users");
  expectStatus(await call(PAY, { action: "audit_list" }, "aal2"), 200, "payroll admin can read the audit log");
  expectStatus(await call(PAY, { action: "bank_account_request", nickname: "x", accountName: "x", bsb: "062000", accountNumber: "12345678" }), 403, "payroll cannot add bank accounts");
  const company = await ok(FIN, { action: "company_get" });
  if (company.canEdit) throw new Error("finance admin should see read-only company settings");
});

Deno.test("company settings, numbering and setup", async () => {
  expectStatus(await call(SYS, { action: "company_save", patch: { abn: "12 345 678 901" } }), 409, "invalid ABN refused");
  expectStatus(await call(SYS, { action: "company_save", patch: { hacked: true } }), 400, "unknown setting refused");
  expectStatus(await call(SYS, { action: "company_save", patch: { business_address: { street: "1 Way", postcode: "21" } } }), 400, "bad postcode refused");
  const saved = await ok(SYS, { action: "company_save", patch: { trading_name: "Panalo Pipes", website: "https://panalo.test", workers_comp: [{ state: "NSW", insurer: "icare", policyNumber: "WC-1", expiresOn: "2027-06-30" }] } });
  if (saved.settings.workers_comp[0].insurer !== "icare") throw new Error("workers comp not saved");
  expectStatus(await call(SYS, { action: "numbering_save", kind: "quote", prefix: "Q-", nextNumber: 1, padding: 4 }), 409, "numbers never go backwards");
  await ok(SYS, { action: "numbering_save", kind: "quote", prefix: "Q-", nextNumber: 5000, padding: 4 });
  await ok(SYS, { action: "company_complete" });
  // Logo upload goes to the private finance bucket.
  const prep = await ok(SYS, { action: "logo_prepare_upload", fileName: "panalo.png", size: 2000 });
  expectStatus(await call(SYS, { action: "logo_prepare_upload", fileName: "panalo.exe", size: 2000 }), 400, "logo must be an image");
  await ok(SYS, { action: "logo_attach", path: prep.path, fileName: "panalo.png", size: 2000 });
  const after = await ok(FIN, { action: "company_get" });
  if (!after.logoUrl) throw new Error("logo link missing");
  if (!storageCalls.some(c => c.startsWith("upload finance-documents/org/"))) throw new Error("logo not in finance bucket");
});

Deno.test("bank account: request, second-person approval, masking", async () => {
  const req = await ok(SYS, { action: "bank_account_request", nickname: "Payroll account", accountName: "Panalo Pipes & Structurals", bsb: "062-001", accountNumber: "10203040", purpose: "payroll", apcaUserId: "123456" });
  if (req.status !== "pending") throw new Error("new account should be pending");
  const mine = await ok(SYS, { action: "approvals_list" });
  const a = mine.mine.find((x: any) => x.status === "pending");
  if (!a || mine.toDecide.some((x: any) => x.id === a.id)) throw new Error("requester must not be offered their own approval");
  expectStatus(await call(SYS, { action: "approval_decide", approvalId: a.id, approve: true }), 403, "cannot approve own request");
  const finList = await ok(FIN, { action: "approvals_list" });
  if (!finList.toDecide.some((x: any) => x.id === a.id)) throw new Error("finance admin should be asked to approve");
  const notes = await ok(FIN, { action: "notifications_list" });
  if (!notes.items.some((n: any) => n.kind === "approval_requested")) throw new Error("approver not notified");
  await ok(FIN, { action: "notifications_read" });
  if ((await ok(FIN, { action: "notifications_list" })).unread !== 0) throw new Error("notifications not marked read");
  await ok(FIN, { action: "approval_decide", approvalId: a.id, approve: true, comment: "Called the bank" });
  const company = await ok(DIR, { action: "company_get" });
  const acct = company.bankAccounts.find((b: any) => b.nickname === "Payroll account");
  if (acct.status !== "active" || acct.accountNumber !== "10203040") throw new Error(`director with banking sees the active account: ${JSON.stringify(acct)}`);
  const masked = (await ok(PAY, { action: "company_get" })).bankAccounts.find((b: any) => b.nickname === "Payroll account");
  if (masked.accountNumber !== "•••• 040" || masked.apcaUserId !== null) throw new Error("other users see masked bank numbers");
});

Deno.test("users and roles, audit log", async () => {
  const users = await ok(SYS, { action: "users_list" });
  if (!users.users.find((u: any) => u.id === FIN).roles.includes("finance_admin")) throw new Error("roles not listed");
  expectStatus(await call(SYS, { action: "role_set", profileId: SYS, role: "director", on: true }), 403, "cannot change own roles");
  const set = await ok(SYS, { action: "role_set", profileId: STAFF, role: "accountant", on: true });
  if (!set.permissions.includes("audit.view")) throw new Error("role permissions not applied");
  await ok(STAFF, { action: "whoami" }, "aal1");
  await ok(SYS, { action: "role_set", profileId: STAFF, role: "accountant", on: false });
  const cat = await ok(SYS, { action: "roles_catalogue" });
  if (cat.roles.length !== 7 || !cat.permissions.some((p: any) => p.key === "payroll.sensitive")) throw new Error("catalogue incomplete");
  const log = await ok(DIR, { action: "audit_list", entityType: "company_bank_account" });
  if (!log.events.length) throw new Error("audit list empty");
  const saved = await ok(DIR, { action: "audit_list", event: "company_settings" });
  if (!saved.events.some((e: any) => e.oldValue && e.newValue)) throw new Error("old/new values missing from audit");
  expectStatus(await call(FIN, { action: "audit_list" }), 200, "finance admin reads audit");
  expectStatus(await call(PAY, { action: "roles_catalogue" }), 403, "payroll admin cannot see role admin");
});
