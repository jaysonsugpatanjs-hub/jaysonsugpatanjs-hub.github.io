// People, competency matrix and practical verification actions for admin-api.
// Every write goes through an atomic SQL function that records its own audit row.
import { competencyStatus, licenceStatus, sydneyDate } from "../_shared/competency.ts";
import { httpError, rpc } from "../_shared/http.ts";

type Client = any;
type Handler = (admin: Client, administrator: any, body: any) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function uuid(value: unknown, label: string, required = true): string | null {
  const text = String(value ?? "").trim();
  if (!text && !required) return null;
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}

function text(value: unknown, label: string, max = 100, required = true): string {
  const clean = String(value ?? "").trim().replace(/\s+/g, " ");
  if (required && !clean) throw httpError(400, `${label} is required.`);
  if (clean.length > max) throw httpError(400, `${label} is too long.`);
  return clean;
}

function date(value: unknown, label: string, required = false): string | null {
  const clean = String(value ?? "").trim();
  if (!clean && !required) return null;
  if (!DATE.test(clean) || Number.isNaN(Date.parse(clean))) throw httpError(400, `${label} must be a date.`);
  return clean;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

async function reference(admin: Client) {
  const [positions, sites, modules, requirements, groups] = await Promise.all([
    admin.from("positions").select("id,code,title,department,safety_critical,active").order("title"),
    admin.from("sites").select("id,code,name,active").order("name"),
    admin.from("training_modules").select("id,code,title,status,practical_required,current_version_id").neq("status", "retired").order("code"),
    admin.from("position_requirements").select("position_id,module_id,refresher_months,required_before_start"),
    admin.from("ims_groups").select("key,name,implicit").order("name")
  ]);
  for (const result of [positions, sites, modules, requirements, groups]) {
    if (result.error) throw httpError(500, "Reference data could not be loaded.");
  }
  return {
    positions: positions.data.map((p: any) => ({ id: p.id, code: p.code, title: p.title, department: p.department, safetyCritical: p.safety_critical, active: p.active })),
    sites: sites.data.map((s: any) => ({ id: s.id, code: s.code, name: s.name, active: s.active })),
    modules: modules.data.map((m: any) => ({ id: m.id, code: m.code, title: m.title, status: m.status, practicalRequired: m.practical_required, released: Boolean(m.current_version_id) })),
    requirements: requirements.data.map((r: any) => ({ positionId: r.position_id, moduleId: r.module_id, refresherMonths: r.refresher_months, requiredBeforeStart: r.required_before_start })),
    groups: groups.data.map((g: any) => ({ key: g.key, name: g.name, implicit: g.implicit }))
  };
}

async function peopleList(admin: Client) {
  const today = sydneyDate(new Date());
  const [employees, licences, members] = await Promise.all([
    admin.from("employees")
      .select("id,employee_number,full_name,email,employment_type,status,position_id,site_id,supervisor_id,start_date,end_date,profile_id")
      .order("full_name").limit(2000),
    admin.from("licences").select("id,employee_id,licence_type,licence_number,issuer,issued_on,expires_on,verified_at").limit(10000),
    admin.from("ims_group_members").select("group_key,profile_id")
  ]);
  if (employees.error || licences.error || members.error) throw httpError(500, "The employee register could not be loaded.");
  const byEmployee = new Map<string, any[]>();
  for (const licence of licences.data) {
    if (!byEmployee.has(licence.employee_id)) byEmployee.set(licence.employee_id, []);
    byEmployee.get(licence.employee_id)!.push({
      id: licence.id, type: licence.licence_type, number: licence.licence_number, issuer: licence.issuer,
      issuedOn: licence.issued_on, expiresOn: licence.expires_on, verified: Boolean(licence.verified_at),
      status: licenceStatus(licence.expires_on, today)
    });
  }
  const groupsByProfile = new Map<string, string[]>();
  for (const member of members.data) {
    if (!groupsByProfile.has(member.profile_id)) groupsByProfile.set(member.profile_id, []);
    groupsByProfile.get(member.profile_id)!.push(member.group_key);
  }
  return {
    today,
    truncated: employees.data.length === 2000,
    employees: employees.data.map((e: any) => ({
      id: e.id, employeeNumber: e.employee_number, fullName: e.full_name, email: e.email,
      employmentType: e.employment_type, status: e.status, positionId: e.position_id, siteId: e.site_id,
      supervisorId: e.supervisor_id, startDate: e.start_date, endDate: e.end_date, profileId: e.profile_id,
      licences: byEmployee.get(e.id) || [],
      groups: e.profile_id ? groupsByProfile.get(e.profile_id) || [] : []
    }))
  };
}

async function employeeSave(admin: Client, administrator: any, body: any) {
  const employee = {
    id: uuid(body.id, "Employee", false),
    employeeNumber: text(body.employeeNumber, "Employee number", 30),
    fullName: text(body.fullName, "Full name", 100),
    email: text(body.email, "Email", 254, false).toLowerCase() || null,
    employmentType: oneOf(body.employmentType, ["employee", "applicant", "contractor"] as const, "employee"),
    status: oneOf(body.status, ["applicant", "active", "on_leave", "terminated"] as const, "active"),
    positionId: uuid(body.positionId, "Position", false),
    siteId: uuid(body.siteId, "Site", false),
    supervisorId: uuid(body.supervisorId, "Supervisor", false),
    startDate: date(body.startDate, "Start date"),
    endDate: date(body.endDate, "End date")
  };
  if (employee.email && !/^\S+@\S+\.\S+$/.test(employee.email)) throw httpError(400, "Enter a valid email address.");
  if (employee.supervisorId && employee.supervisorId === employee.id) throw httpError(400, "A person cannot supervise themselves.");
  const id = await rpc<string>(admin, "employee_save", { p_actor: administrator.id, p_employee: employee });
  return { id };
}

async function licenceSave(admin: Client, administrator: any, body: any) {
  const licence = {
    id: uuid(body.id, "Licence", false),
    employeeId: uuid(body.employeeId, "Employee"),
    licenceType: text(body.licenceType, "Licence type", 120),
    licenceNumber: text(body.licenceNumber, "Licence number", 60, false),
    issuer: text(body.issuer, "Issuer", 120, false),
    issuedOn: date(body.issuedOn, "Issue date"),
    expiresOn: date(body.expiresOn, "Expiry date"),
    verified: body.verified === true
  };
  const id = await rpc<string>(admin, "admin_save_licence", { p_actor: administrator.id, p_licence: licence });
  return { id };
}

async function licenceDelete(admin: Client, administrator: any, body: any) {
  await rpc(admin, "admin_delete_licence", { p_actor: administrator.id, p_licence: uuid(body.id, "Licence") });
  return { deleted: true };
}

async function positionSave(admin: Client, administrator: any, body: any) {
  const position = {
    id: uuid(body.id, "Position", false),
    code: text(body.code, "Position code", 30),
    title: text(body.title, "Position title", 100),
    department: text(body.department, "Department", 100, false),
    safetyCritical: body.safetyCritical === true,
    active: body.active !== false
  };
  return { id: await rpc<string>(admin, "admin_save_position", { p_actor: administrator.id, p_position: position }) };
}

async function siteSave(admin: Client, administrator: any, body: any) {
  const site = { id: uuid(body.id, "Site", false), code: text(body.code, "Site code", 30), name: text(body.name, "Site name", 100), active: body.active !== false };
  return { id: await rpc<string>(admin, "admin_save_site", { p_actor: administrator.id, p_site: site }) };
}

async function requirementSet(admin: Client, administrator: any, body: any) {
  const months = body.refresherMonths === null || body.refresherMonths === "" || body.refresherMonths === undefined
    ? null : Number(body.refresherMonths);
  if (months !== null && (!Number.isInteger(months) || months < 1 || months > 120)) throw httpError(400, "Refresher interval must be 1 to 120 months.");
  await rpc(admin, "admin_set_requirement", {
    p_actor: administrator.id,
    p_position: uuid(body.positionId, "Position"),
    p_module: uuid(body.moduleId, "Module"),
    p_required: body.required !== false,
    p_refresher_months: months,
    p_before_start: body.requiredBeforeStart === true
  });
  return { saved: true };
}

async function groupMemberSet(admin: Client, administrator: any, body: any) {
  await rpc(admin, "admin_set_group_member", {
    p_actor: administrator.id,
    p_group: text(body.group, "Group", 40),
    p_profile: uuid(body.profileId, "Person"),
    p_member: body.member !== false
  });
  return { saved: true };
}

async function competencyMatrix(admin: Client, actor: any) {
  const today = sydneyDate(new Date());
  const ref = await reference(admin);
  let query = admin.from("employees")
    .select("id,employee_number,full_name,employment_type,status,position_id,site_id,supervisor_id,start_date,profile_id")
    .neq("status", "terminated");
  // Supervisors without the "everyone" permission see their direct reports only.
  const teamOnly = !(actor?.permissions || []).includes("competency.all");
  if (teamOnly) {
    const me = await admin.from("employees").select("id").eq("profile_id", actor.id).maybeSingle();
    if (me.error) throw httpError(500, "Your register entry could not be loaded.");
    if (!me.data) return { today, columns: [], rows: [], summary: { required: 0, competent: 0 }, positions: ref.positions, sites: ref.sites, teamOnly };
    query = query.eq("supervisor_id", me.data.id);
  }
  const employees = await query.order("full_name").limit(2000);
  if (employees.error) throw httpError(500, "The employee register could not be loaded.");
  const profileIds = employees.data.map((e: any) => e.profile_id).filter(Boolean);
  const assignments = profileIds.length
    ? await admin.from("training_assignments")
      .select("id,learner_id,status,theory_passed_at,expires_at,training_module_versions(module_id),practical_verifications(outcome,assessed_on)")
      .in("learner_id", profileIds)
    : { data: [], error: null };
  if (assignments.error) throw httpError(500, "Training records could not be loaded.");

  const requirementKey = (positionId: string, moduleId: string) => `${positionId}:${moduleId}`;
  const requirementMap = new Map(ref.requirements.map((r: any) => [requirementKey(r.positionId, r.moduleId), r]));
  const recordsBy = new Map<string, any[]>();
  for (const assignment of assignments.data) {
    const moduleId = assignment.training_module_versions?.module_id;
    if (!moduleId) continue;
    const key = `${assignment.learner_id}:${moduleId}`;
    if (!recordsBy.has(key)) recordsBy.set(key, []);
    recordsBy.get(key)!.push({
      id: assignment.id,
      status: assignment.status,
      theoryPassedAt: assignment.theory_passed_at,
      expiresAt: assignment.expires_at,
      practicals: (assignment.practical_verifications || []).map((p: any) => ({ outcome: p.outcome, assessedOn: p.assessed_on }))
    });
  }
  // Only modules that some position requires get a column.
  const requiredModuleIds = [...new Set(ref.requirements.map((r: any) => r.moduleId))];
  const columns = ref.modules.filter((m: any) => requiredModuleIds.includes(m.id));

  let required = 0;
  let competent = 0;
  const rows = employees.data.map((e: any) => {
    const cells = columns.map((module: any) => {
      const requirement: any = e.position_id ? requirementMap.get(requirementKey(e.position_id, module.id)) : null;
      const records = e.profile_id ? recordsBy.get(`${e.profile_id}:${module.id}`) || [] : [];
      const result = competencyStatus({
        required: Boolean(requirement),
        released: module.released,
        practicalRequired: module.practicalRequired,
        refresherMonths: requirement?.refresherMonths ?? null
      }, records, today);
      if (requirement) {
        required += 1;
        if (result.status === "competent" || result.status === "expiring") competent += 1;
      }
      const practicalCandidate = result.status === "practical_pending"
        ? records.filter((r: any) => r.status === "theory_passed").sort((a: any, b: any) => String(b.theoryPassedAt).localeCompare(String(a.theoryPassedAt)))[0]?.id ?? null
        : null;
      return { moduleId: module.id, ...result, practicalAssignmentId: practicalCandidate };
    });
    return {
      id: e.id, employeeNumber: e.employee_number, fullName: e.full_name, employmentType: e.employment_type,
      status: e.status, positionId: e.position_id, siteId: e.site_id, supervisorId: e.supervisor_id,
      startDate: e.start_date, linked: Boolean(e.profile_id), cells
    };
  });
  return { today, columns, rows, summary: { required, competent }, positions: ref.positions, sites: ref.sites, teamOnly };
}

async function practicalRecord(admin: Client, administrator: any, body: any) {
  const id = await rpc<string>(admin, "training_record_practical", {
    p_actor: administrator.id,
    p_assignment: uuid(body.assignmentId, "Assignment"),
    p_assessor_employee: uuid(body.assessorEmployeeId, "Assessor", false),
    p_assessor_name: text(body.assessorName, "Assessor name", 100),
    p_assessed_on: date(body.assessedOn, "Assessment date", true),
    p_site: uuid(body.siteId, "Site", false),
    p_outcome: oneOf(body.outcome, ["competent", "not_yet_competent"] as const, "competent"),
    p_notes: text(body.notes, "Notes", 2000, false)
  });
  return { id };
}

export const peopleActions: Record<string, Handler> = {
  people_reference: admin => reference(admin),
  people_list: admin => peopleList(admin),
  employee_save: employeeSave,
  licence_save: licenceSave,
  licence_delete: licenceDelete,
  position_save: positionSave,
  site_save: siteSave,
  requirement_set: requirementSet,
  group_member_set: groupMemberSet,
  competency_matrix: (admin, actor) => competencyMatrix(admin, actor),
  practical_record: practicalRecord
};
