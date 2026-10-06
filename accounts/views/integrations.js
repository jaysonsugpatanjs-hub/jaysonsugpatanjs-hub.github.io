// Integrations: an honest status of every outside connection. Nothing here
// claims ATO, STP or SuperStream approval (brief section 97).
import { call, chip, safe } from "../lib/ui.js";

export async function renderIntegrations(view) {
  const c = await call("company_get");
  const s = c.settings || {};
  const rows = [
    ["Single Touch Payroll (ATO)", chip("Export only", "info"), "Panalo Accounts will prepare and validate STP Phase 2 data from Phase 5. Sending it to the ATO needs an ATO-registered Sending Service Provider; transmission stays switched off until that arrangement exists."],
    ["Super contributions (Payday Super)", s.super_clearing_house ? chip("Provider named", "info") : chip("Not set", "pending"), `${s.super_clearing_house ? `Clearing house: ${safe(s.super_clearing_house)}. ` : ""}Contributions will be calculated and exported per pay run; the clearing house sends money and data to funds on the same day.`],
    ["Bank payments (ABA files)", c.bankAccounts.some(b => b.status === "active" && b.apcaUserId) ? chip("APCA ID recorded", "info") : chip("Not set", "pending"), "Pay runs and supplier payments will produce ABA files to upload to your bank. Add the APCA user ID to the paying account in Company settings › Banking."],
    ["Bank statements", chip("Phase 6", ""), "CSV and OFX import with matching suggestions. A paid bank feed is optional later."],
    ["Email", chip("Portal email", "pending"), "Emails currently use Supabase's built-in sender, which only reaches Panalo's Supabase team. Connect Panalo's own mail (Microsoft 365, Google Workspace or a sending service) in Supabase before invoices or payslip notices go out."],
    ["ABN Lookup", chip("Phase 3", ""), "Supplier ABNs will be checked when suppliers and bills are entered; ABN check digits are already validated."]
  ];
  view.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">ADMINISTRATION</p><h1>Integrations</h1>
      <p class="muted">What Panalo Accounts connects to, and what it deliberately does not do yet.</p></div></header>
    <section class="panel"><table class="tbl"><thead><tr><th scope="col">Connection</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead><tbody>
      ${rows.map(([name, status, text]) => `<tr><th scope="row">${safe(name)}</th><td>${status}</td><td class="muted">${text}</td></tr>`).join("")}
    </tbody></table></section>`;
}
