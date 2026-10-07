// Phase 8: fixed assets. The register, categories, monthly depreciation runs
// (one journal a month), disposals, the reconciliation to the ledger, and
// adding assets from bill lines posted to fixed asset accounts. Tax treatment
// is recorded for the accountant only. Writes go through SQL functions that
// re-check assets.manage and audit.
import { httpError, rpc } from "../_shared/http.ts";
import { attachmentsFor, date, has, lookups, names, optDate, optUuid, text, uuid, type Actor, type Client, type Handler } from "./docs.ts";
import { todaySydney } from "./ledger.ts";

const READ = ["assets.manage", "reports.view"];
const num = (v: unknown) => (v == null ? null : Number(v));
const nextMonthEnd = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
};

const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const lastMonthEnd = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);

async function accumulated(admin: Client, ids: string[], asAt: string) {
  const out = new Map<string, number>();
  await Promise.all(ids.map(async id => out.set(id, Number(await rpc(admin, "asset_accumulated", { p_asset: id, p_as_at: asAt })))));
  return out;
}

async function list(admin: Client, actor: Actor, body: any) {
  const [cats, assets, runs] = await Promise.all([
    admin.from("asset_categories").select("id,name,method,useful_life_months,tax_effective_life_years,active,asset_account_id,accumulated_account_id,expense_account_id")
      .eq("organization_id", actor.organization_id).order("name"),
    admin.from("assets").select("id,number,name,category_id,purchase_date,in_service_date,cost,status,disposal_date,location,custodian_id,method,useful_life_months,serial_number")
      .eq("organization_id", actor.organization_id).order("number"),
    admin.from("asset_depreciation_runs").select("id,period_end,total,status,journal_id,created_by,created_at,journal_entries(number)")
      .eq("organization_id", actor.organization_id).order("period_end", { ascending: false }).limit(36)
  ]);
  const rows = assets.data || [];
  const lastPosted = (runs.data || []).find((r: any) => r.status === "posted")?.period_end || "";
  const today = todaySydney();
  // Book values as at today, or the last depreciation run if that's later.
  const asAt = optDate(body.asAt) || (lastPosted > today ? lastPosted : today);
  const acc = await accumulated(admin, rows.map((a: any) => a.id), asAt);
  const custodians = new Map<string, string>();
  const cids = [...new Set(rows.map((a: any) => a.custodian_id).filter(Boolean))];
  if (cids.length) for (const e of (await admin.from("employees").select("id,full_name").in("id", cids)).data || []) custodians.set(e.id, e.full_name);
  const posted = (runs.data || []).filter((r: any) => r.status === "posted");
  const last = posted[0]?.period_end || null;
  const who = await names(admin, (runs.data || []).map((r: any) => r.created_by));
  return {
    asAt,
    categories: (cats.data || []).map((c: any) => ({ id: c.id, name: c.name, method: c.method, lifeMonths: c.useful_life_months, taxLife: num(c.tax_effective_life_years), active: c.active,
      assetAccountId: c.asset_account_id, accumulatedAccountId: c.accumulated_account_id, expenseAccountId: c.expense_account_id })),
    assets: rows.map((a: any) => ({ id: a.id, number: a.number, name: a.name, categoryId: a.category_id, purchaseDate: a.purchase_date, inService: a.in_service_date,
      cost: Number(a.cost), accumulated: acc.get(a.id) || 0, bookValue: a.status === "disposed" ? 0 : Math.round((Number(a.cost) - (acc.get(a.id) || 0)) * 100) / 100,
      status: a.status, disposalDate: a.disposal_date, location: a.location, custodian: custodians.get(a.custodian_id) || null, serial: a.serial_number,
      method: a.method, lifeMonths: a.useful_life_months })),
    runs: (runs.data || []).map((r: any) => ({ id: r.id, periodEnd: r.period_end, total: Number(r.total), status: r.status, journal: r.journal_entries?.number || null,
      journalId: r.journal_id, by: who.get(r.created_by) || null, at: r.created_at })),
    nextRun: last ? nextMonthEnd(last) : lastMonthEnd(todaySydney()),
    lastRun: last,
    can: { manage: has(actor, "assets.manage") },
    options: has(actor, "assets.manage") ? await options(admin, actor) : null
  };
}

/** What the forms choose from: accounts, sale tax codes, suppliers, staff, projects. */
async function options(admin: Client, actor: Actor) {
  const [lk, sup, emp] = await Promise.all([
    lookups(admin, actor),
    admin.from("suppliers").select("id,name").eq("organization_id", actor.organization_id).eq("status", "active").order("name").limit(1000),
    admin.from("employees").select("id,full_name").in("status", ["active", "on_leave"]).order("full_name").limit(1000)
  ]);
  return {
    accounts: lk.accounts.filter((a: any) => a.status === "active").map((a: any) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype })),
    taxCodes: lk.taxCodes.filter((t: any) => t.active && ["sales", "both"].includes(t.applies_to)).map((t: any) => ({ id: t.id, code: t.code, name: t.name, rate: Number(t.rate) })),
    projects: lk.projects.filter((x: any) => !["closed", "cancelled"].includes(x.status)).map((x: any) => ({ id: x.id, label: `${x.number} ${x.name}` })),
    suppliers: (sup.data || []).map((x: any) => ({ id: x.id, name: x.name })),
    staff: (emp.data || []).map((x: any) => ({ id: x.id, name: x.full_name }))
  };
}

async function get(admin: Client, actor: Actor, body: any) {
  const id = uuid(body.id, "Asset");
  const { data: a } = await admin.from("assets").select("*,asset_categories(name),suppliers(name),bills(number),projects(number,name)")
    .eq("id", id).eq("organization_id", actor.organization_id).maybeSingle();
  if (!a) throw httpError(404, "Asset not found.");
  const [dep, files, cust, disp] = await Promise.all([
    admin.from("asset_depreciation").select("period_start,period_end,amount,journal_id,run_id,asset_depreciation_runs(status),journal_entries(number)").eq("asset_id", id).order("period_end"),
    attachmentsFor(admin, actor, "asset", id),
    a.custodian_id ? admin.from("employees").select("full_name").eq("id", a.custodian_id).maybeSingle() : Promise.resolve({ data: null }),
    a.disposal_journal_id ? admin.from("journal_entries").select("id,number").eq("id", a.disposal_journal_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  // Everything posted so far (a run to month end counts once it's posted).
  const accNow = Number(await rpc(admin, "asset_accumulated", { p_asset: id, p_as_at: a.disposal_date || "9999-12-31" }));
  return {
    asset: { id: a.id, number: a.number, name: a.name, description: a.description, categoryId: a.category_id, category: a.asset_categories?.name,
      purchaseDate: a.purchase_date, inService: a.in_service_date, supplierId: a.supplier_id, supplier: a.suppliers?.name || null, billId: a.bill_id, bill: a.bills?.number || null,
      cost: Number(a.cost), gst: Number(a.gst), serial: a.serial_number, location: a.location, custodianId: a.custodian_id, custodian: cust.data?.full_name || null,
      projectId: a.project_id, project: a.projects ? `${a.projects.number} ${a.projects.name}` : null,
      method: a.method, lifeMonths: a.useful_life_months, residual: Number(a.residual_value), openingAccumulated: Number(a.opening_accumulated), openingDate: a.opening_date,
      taxMethod: a.tax_method, taxLife: num(a.tax_effective_life_years), taxNotes: a.tax_notes,
      status: a.status, disposalDate: a.disposal_date, proceeds: num(a.disposal_proceeds), disposalGst: num(a.disposal_gst), disposalReason: a.disposal_reason,
      disposalJournal: disp.data ? { id: disp.data.id, number: disp.data.number } : null,
      accumulated: accNow, bookValue: a.status === "disposed" ? 0 : Math.round((Number(a.cost) - accNow) * 100) / 100 },
    depreciation: (dep.data || []).filter((d: any) => !d.run_id || d.asset_depreciation_runs?.status === "posted")
      .map((d: any) => ({ from: d.period_start, to: d.period_end, amount: Number(d.amount), journal: d.journal_entries?.number || null, journalId: d.journal_id, disposal: !d.run_id })),
    attachments: files,
    can: { edit: a.status === "active" && has(actor, "assets.manage"), dispose: a.status === "active" && has(actor, "assets.manage"),
      locked: (dep.data || []).some((d: any) => !d.run_id || d.asset_depreciation_runs?.status === "posted") }
  };
}

function assetBody(body: any) {
  const n = (v: unknown, label: string) => {
    if (v === "" || v == null) return "";
    const x = Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(x) || x < 0) throw httpError(400, `${label} must be a positive number.`);
    return String(Math.round(x * 100) / 100);
  };
  const name = text(body.name, 160);
  if (name.length < 2) throw httpError(400, "Give the asset a name.");
  const method = ["straight_line", "diminishing_value", "none"].includes(body.method) ? body.method : "";
  const taxMethod = ["prime_cost", "diminishing_value", "instant_write_off", "small_business_pool", "not_depreciable"].includes(body.taxMethod) ? body.taxMethod : "";
  return {
    name, description: text(body.description, 2000), category_id: optUuid(body.categoryId) || "", purchase_date: date(body.purchaseDate, "The purchase date"),
    in_service_date: optDate(body.inService) || "", supplier_id: optUuid(body.supplierId) || "", bill_id: optUuid(body.billId) || "",
    cost: n(body.cost, "The cost"), gst: n(body.gst, "GST"), serial_number: text(body.serial, 80), location: text(body.location, 120),
    custodian_id: optUuid(body.custodianId) || "", project_id: optUuid(body.projectId) || "", method,
    useful_life_months: body.lifeMonths === "" || body.lifeMonths == null ? "" : String(Math.trunc(Number(body.lifeMonths))),
    residual_value: n(body.residual, "The residual value"), opening_accumulated: n(body.openingAccumulated, "Opening depreciation"), opening_date: optDate(body.openingDate) || "",
    tax_method: taxMethod, tax_effective_life_years: n(body.taxLife, "The tax effective life"), tax_notes: text(body.taxNotes, 1000)
  };
}

/** Bill lines posted to fixed asset accounts that aren't in the register yet. */
async function fromBills(admin: Client, actor: Actor) {
  const { data: accs } = await admin.from("accounts").select("id,code,name").eq("organization_id", actor.organization_id).eq("subtype", "fixed_asset");
  const ids = (accs || []).map((a: any) => a.id);
  if (!ids.length) return { lines: [] };
  const { data } = await admin.from("bill_lines").select("id,description,amount,gst,account_id,project_id,bills!inner(id,number,bill_date,status,kind,amounts_are,supplier_id,organization_id,suppliers(name))")
    .in("account_id", ids).eq("bills.organization_id", actor.organization_id).eq("bills.status", "approved").eq("bills.kind", "bill").limit(300);
  // An asset records its bill, not the line: a line counts as added when an
  // asset from the same bill has the same cost (each asset matches one line).
  const { data: used } = await admin.from("assets").select("bill_id,cost").eq("organization_id", actor.organization_id).not("bill_id", "is", null);
  const left = new Map<string, number[]>();
  for (const u of used || []) left.set(u.bill_id, [...(left.get(u.bill_id) || []), Math.round(Number(u.cost) * 100)]);
  const taken = (billId: string, cost: number) => {
    const costs = left.get(billId); const i = costs ? costs.indexOf(Math.round(cost * 100)) : -1;
    if (i < 0) return false; costs!.splice(i, 1); return true;
  };
  const accName = new Map((accs || []).map((a: any) => [a.id, `${a.code} ${a.name}`]));
  return {
    lines: (data || []).map((l: any) => {
      const gst = Number(l.gst);
      const net = l.bills.amounts_are === "inclusive" ? Number(l.amount) - gst : Number(l.amount);
      return { lineId: l.id, billId: l.bills.id, bill: l.bills.number, date: l.bills.bill_date, supplierId: l.bills.supplier_id, supplier: l.bills.suppliers?.name,
        description: l.description, cost: Math.round(net * 100) / 100, gst, accountId: l.account_id, account: accName.get(l.account_id), projectId: l.project_id };
    }).filter((l: any) => !taken(l.billId, l.cost)).sort((a: any, b: any) => b.date.localeCompare(a.date))
  };
}

async function preview(admin: Client, actor: Actor, body: any) {
  const to = date(body.periodEnd, "The month end");
  const { data: rows } = await admin.from("assets").select("id,number,name,in_service_date,opening_date,method").eq("organization_id", actor.organization_id).eq("status", "active").neq("method", "none")
    .lte("in_service_date", to).order("number");
  const { data: last } = await admin.from("asset_depreciation").select("asset_id,period_end,run_id,asset_depreciation_runs(status)").in("asset_id", (rows || []).map((r: any) => r.id));
  const lastBy = new Map<string, string>();
  for (const d of last || []) if (!d.run_id || d.asset_depreciation_runs?.status === "posted") if (!lastBy.get(d.asset_id) || d.period_end > lastBy.get(d.asset_id)!) lastBy.set(d.asset_id, d.period_end);
  const out = [];
  for (const a of rows || []) {
    const from = lastBy.get(a.id) ? dayAfter(lastBy.get(a.id)!) : (a.opening_date && a.opening_date >= a.in_service_date ? dayAfter(a.opening_date) : a.in_service_date);
    const amount = Number(await rpc(admin, "asset_depreciation_for", { p_asset: a.id, p_from: from, p_to: to }));
    if (amount > 0) out.push({ id: a.id, number: a.number, name: a.name, from, amount });
  }
  return { periodEnd: to, rows: out, total: Math.round(out.reduce((t, r) => t + r.amount * 100, 0)) / 100 };
}

export const assetActions: Record<string, { perm: string[] | null; run: Handler }> = {
  assets_list: { perm: READ, run: list },
  asset_get: { perm: READ, run: get },
  asset_save: { perm: ["assets.manage"], run: async (admin, actor, body) => ({ id: await rpc(admin, "asset_save", { p_actor: actor.id, p_id: optUuid(body.id), p: assetBody(body) }) }) },
  asset_from_bills: { perm: ["assets.manage"], run: fromBills },
  asset_category_save: { perm: ["assets.manage"], run: async (admin, actor, body) => ({
    id: await rpc(admin, "asset_category_save", { p_actor: actor.id, p_id: optUuid(body.id), p: {
      name: text(body.name, 80), asset_account_id: optUuid(body.assetAccountId) || "", accumulated_account_id: optUuid(body.accumulatedAccountId) || "",
      expense_account_id: optUuid(body.expenseAccountId) || "", method: ["straight_line", "diminishing_value", "none"].includes(body.method) ? body.method : "straight_line",
      useful_life_months: body.lifeMonths === "" || body.lifeMonths == null ? "" : String(Math.trunc(Number(body.lifeMonths))),
      tax_effective_life_years: body.taxLife === "" || body.taxLife == null ? "" : String(Number(body.taxLife)), active: body.active !== false } })
  }) },
  depreciation_preview: { perm: ["assets.manage"], run: preview },
  depreciation_run: { perm: ["assets.manage"], run: async (admin, actor, body) => ({ id: await rpc(admin, "asset_depreciation_run", { p_actor: actor.id, p_period_end: date(body.periodEnd, "The month end") }) }) },
  depreciation_undo: { perm: ["assets.manage"], run: async (admin, actor, body) => {
    await rpc(admin, "asset_depreciation_undo", { p_actor: actor.id, p_run: uuid(body.id, "Depreciation run"), p_reason: text(body.reason, 300) }); return { ok: true };
  } },
  asset_dispose: { perm: ["assets.manage"], run: async (admin, actor, body) => {
    const proceeds = body.proceeds === "" || body.proceeds == null ? 0 : Number(String(body.proceeds).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(proceeds) || proceeds < 0) throw httpError(400, "Enter the proceeds before GST (0 if written off).");
    return { journalId: await rpc(admin, "asset_dispose", { p_actor: actor.id, p_id: uuid(body.id, "Asset"), p_date: date(body.date, "The disposal date"),
      p_proceeds: proceeds, p_tax_code: optUuid(body.taxCodeId), p_received_into: optUuid(body.receivedInto), p_reason: text(body.reason, 300) }) };
  } },
  asset_reconciliation: { perm: READ, run: async (admin, actor, body) => ({
    asAt: optDate(body.asAt) || todaySydney(),
    rows: ((await rpc<any[]>(admin, "asset_reconciliation", { p_org: actor.organization_id, p_as_at: optDate(body.asAt) || todaySydney() })) || [])
      .map((r: any) => ({ ...r, registerCost: Number(r.registerCost), ledgerCost: Number(r.ledgerCost), registerAccumulated: Number(r.registerAccumulated), ledgerAccumulated: Number(r.ledgerAccumulated) }))
  }) }
};
