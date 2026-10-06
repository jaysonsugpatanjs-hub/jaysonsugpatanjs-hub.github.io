// Users and roles: assign the role bundles from the permission matrix.
// Position defaults and per-person allow/deny stay in the portal's People area.
import { call, chip, flash, friendlyError, safe } from "../lib/ui.js";

export async function renderUsers(view) {
  const [cat, list] = await Promise.all([call("roles_catalogue"), call("users_list")]);
  let query = "";
  const permName = new Map(cat.permissions.map(p => [p.key, p.name]));

  const draw = () => {
    const q = query.toLowerCase();
    const users = list.users.filter(u => !q || `${u.name} ${u.email} ${u.position || ""}`.toLowerCase().includes(q));
    view.innerHTML = `
      <header class="page-head"><div><p class="eyebrow">ADMINISTRATION</p><h1>Users and roles</h1>
        <p class="muted">Roles add permissions on top of a person's position. Changes apply at their next page load and are recorded in the audit log. You can't change your own roles.</p></div></header>
      <section class="panel">
        <div class="toolbar"><div class="fld"><label for="u-search">Find a person</label><input id="u-search" type="search" value="${safe(query)}" placeholder="Name, email or position"></div>
          <a class="btn" href="../training/admin/?view=people-management">People register, logins and personal overrides</a></div>
        <div class="tbl-wrap"><table class="tbl roles"><thead><tr><th scope="col">Person</th>
          ${cat.roles.map(r => `<th scope="col" class="c" title="${safe(r.description)}">${safe(r.name)}</th>`).join("")}</tr></thead><tbody>
          ${users.map(u => `<tr class="${u.active ? "" : "inactive"}"><th scope="row">${safe(u.name)}<small>${safe(u.email)}${u.position ? ` · ${safe(u.position)}` : ""}</small>
              ${u.systemAdmin ? chip("System admin", "info") : ""}${u.active ? "" : chip("Sign-in disabled", "bad")}</th>
            ${cat.roles.map(r => `<td class="c"><input type="checkbox" aria-label="${safe(r.name)} for ${safe(u.name)}" data-user="${safe(u.id)}" data-role="${safe(r.key)}"
              ${u.roles.includes(r.key) ? "checked" : ""} ${u.self ? 'disabled title="Someone else must change your roles"' : ""}></td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cat.roles.length + 1}" class="muted">No one matches.</td></tr>`}
        </tbody></table></div>
        <p class="msg" data-msg role="status" aria-live="polite"></p>
      </section>
      <section class="panel"><h2>What each role includes</h2>
        <div class="role-cards">${cat.roles.map(r => `<div class="role-card"><h3>${safe(r.name)}</h3><p class="muted small">${safe(r.description)}</p>
          <ul>${r.permissions.map(k => `<li>${safe(permName.get(k) || k)}</li>`).join("")}</ul></div>`).join("")}</div>
        <p class="muted small">System administrators automatically hold every permission except payroll pay, tax and bank details, which need the Payroll admin role. Anyone holding finance or payroll permissions must use two-step sign-in in Panalo Accounts.</p>
      </section>`;
    view.querySelector("#u-search").addEventListener("input", e => {
      query = e.target.value;
      const pos = e.target.selectionStart;
      draw();
      const box = view.querySelector("#u-search");
      box.focus();
      box.setSelectionRange(pos, pos);
    });
  };
  draw();

  view.addEventListener("change", async e => {
    const box = e.target.closest("[data-role]");
    if (!box) return;
    box.disabled = true;
    try {
      await call("role_set", { profileId: box.dataset.user, role: box.dataset.role, on: box.checked });
      const u = list.users.find(x => x.id === box.dataset.user);
      u.roles = box.checked ? [...u.roles, box.dataset.role] : u.roles.filter(r => r !== box.dataset.role);
      flash(view, `${box.checked ? "Added" : "Removed"} ${cat.roles.find(r => r.key === box.dataset.role).name} for ${u.name}.`, "good");
    } catch (error) {
      box.checked = !box.checked;
      flash(view, friendlyError(error), "bad");
    } finally {
      box.disabled = false;
    }
  });
}
