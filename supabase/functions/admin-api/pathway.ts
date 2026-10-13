// Role pathways: from an employee's position, suggest the training modules and the IMS
// documents (with the processes they belong to) that the role needs, then apply what an
// administrator ticks. Nothing is granted automatically.
import { httpError, rpc } from "../_shared/http.ts";

type Client = any;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP = new Set(["and", "the", "of", "for", "officer", "manager"]);

function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}

function words(title: string): string[] {
  return title.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !STOP.has(w));
}

export async function pathwayGet(admin: Client, _actor: any, body: any) {
  const employeeId = uuid(body.employeeId, "Employee");
  const emp = await admin.from("employees").select("id,full_name,email,profile_id,position_id,positions(id,title)").eq("id", employeeId).maybeSingle();
  if (emp.error || !emp.data) throw httpError(404, "Employee not found.");
  if (!emp.data.position_id) return { employee: { id: emp.data.id, fullName: emp.data.full_name, position: "" }, needsPosition: true, processes: [], modules: [] };
  const positionId = emp.data.position_id;
  const title = String(emp.data.positions?.title || "");

  const [mapped, allProcesses, requirements, documents] = await Promise.all([
    admin.from("position_processes").select("process_code").eq("position_id", positionId),
    admin.from("ims_processes").select("code,area,title,responsible_role,approver_role,read_docs,fill_docs").order("code"),
    admin.from("position_requirements").select("module_id,refresher_months,required_before_start,training_modules(code,title,current_version_id)").eq("position_id", positionId),
    admin.from("ims_documents").select("id,doc_number,title,folder_id,status")
  ]);
  if (mapped.error || allProcesses.error || requirements.error || documents.error) throw httpError(500, "The role pathway could not be loaded.");

  const savedCodes = new Set((mapped.data || []).map((m: any) => m.process_code));
  const saved = savedCodes.size > 0;
  const keys = words(title);
  const suggested = (p: any) => {
    const role = `${p.responsible_role} ${p.approver_role}`.toLowerCase();
    return keys.some(k => role.includes(k));
  };
  const processes = (allProcesses.data || [])
    .filter((p: any) => saved ? savedCodes.has(p.code) : suggested(p))
    .map((p: any) => ({ code: p.code, area: p.area, title: p.title, responsible: p.responsible_role, approver: p.approver_role, docs: [...new Set([...(p.read_docs || []), ...(p.fill_docs || [])])] }));

  const docByNumber = new Map((documents.data || []).map((d: any) => [d.doc_number, d]));
  const folderIds = new Set<string>();
  for (const p of processes) for (const n of p.docs) { const d: any = docByNumber.get(n); if (d?.status === "approved") folderIds.add(d.folder_id); }
  const folders = new Map<string, any>();
  if (folderIds.size) {
    const rows = await admin.from("ims_folders").select("id,name").in("id", [...folderIds]);
    for (const f of rows.data || []) folders.set(f.id, f);
  }
  const profileId = emp.data.profile_id;
  const levels = new Map<string, string>();
  if (profileId) for (const id of folderIds) levels.set(id, String(await rpc(admin, "ims_level_name", { p_rank: await rpc(admin, "ims_folder_level", { p_folder: id, p_profile: profileId }) })));
  for (const p of processes as any[]) {
    p.documents = p.docs.map((n: string) => {
      const d: any = docByNumber.get(n);
      if (!d) return { docNumber: n, inIms: false };
      const level = levels.get(d.folder_id) || "none";
      return { docNumber: n, title: d.title, inIms: true, approved: d.status === "approved", folderId: d.folder_id, folder: folders.get(d.folder_id)?.name || "", hasAccess: level !== "none" };
    });
    delete p.docs;
  }

  let assignments: any[] = [];
  const versionIds = (requirements.data || []).map((r: any) => r.training_modules?.current_version_id).filter(Boolean);
  if (profileId && versionIds.length) {
    const found = await admin.from("training_assignments").select("id,module_version_id,status,expires_at").eq("learner_id", profileId).in("module_version_id", versionIds).in("status", ["assigned", "theory_passed"]);
    assignments = found.data || [];
  }
  const modules = (requirements.data || []).map((r: any) => {
    const a = assignments.find(x => x.module_version_id === r.training_modules?.current_version_id);
    return { code: r.training_modules?.code, title: r.training_modules?.title, published: !!r.training_modules?.current_version_id,
      assignmentId: a?.id || null, requiredBeforeStart: r.required_before_start, enabled: !!a && new Date(a.expires_at).getTime() > Date.now(), passed: a?.status === "theory_passed" };
  });
  return { employee: { id: emp.data.id, fullName: emp.data.full_name, email: emp.data.email, hasLogin: !!profileId, position: title },
    positionId, saved, processes, modules };
}

export async function pathwaySaveMap(admin: Client, actor: any, body: any) {
  const positionId = uuid(body.positionId, "Position");
  const codes = Array.isArray(body.codes) ? body.codes.map((c: unknown) => String(c)).filter((c: string) => /^P\d{3}$/.test(c)) : [];
  await rpc(admin, "admin_set_position_processes", { p_actor: actor.id, p_position: positionId, p_codes: codes });
  return { saved: codes.length };
}

// Applies ticked items: module assignments through the normal assignment function, and Viewer
// access on each ticked document folder. Each item reports its own result.
export async function pathwayApply(admin: Client, actor: any, body: any) {
  const employeeId = uuid(body.employeeId, "Employee");
  const expiresAt = new Date(String(body.expiresAt || ""));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000) throw httpError(400, "Choose a future access end date.");
  if (expiresAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw httpError(400, "Access cannot exceed one year.");
  const moduleCodes: string[] = Array.isArray(body.moduleCodes) ? body.moduleCodes.slice(0, 50).map(String) : [];
  const folderIds: string[] = Array.isArray(body.folderIds) ? body.folderIds.slice(0, 100).map((id: unknown) => uuid(id, "Folder")) : [];
  const emp = await admin.from("employees").select("id,full_name,email,employee_number,profile_id").eq("id", employeeId).maybeSingle();
  if (emp.error || !emp.data) throw httpError(404, "Employee not found.");
  if (!emp.data.profile_id) throw httpError(409, "This employee has no training login yet. Enable a sign-in under Sign-in and access first.");
  const results: { item: string; ok: boolean; message?: string }[] = [];
  for (const code of moduleCodes) {
    try {
      const mod = await admin.from("training_modules").select("current_version_id,status").eq("code", code).maybeSingle();
      if (!mod.data?.current_version_id || mod.data.status === "retired") throw new Error("Module is not published.");
      await rpc(admin, "training_assign", { p_actor: actor.id, p_learner: emp.data.profile_id, p_email: emp.data.email, p_full_name: emp.data.full_name,
        p_external_id: emp.data.employee_number, p_learner_type: "employee", p_version: mod.data.current_version_id, p_expires_at: expiresAt.toISOString(), p_invited: false });
      results.push({ item: code, ok: true });
    } catch (error) { results.push({ item: code, ok: false, message: (error as Error).message }); }
  }
  for (const folderId of folderIds) {
    try {
      await rpc(admin, "ims_set_grant", { p_actor: actor.id, p_folder: folderId, p_group: null, p_profile: emp.data.profile_id, p_level: "viewer" });
      results.push({ item: folderId, ok: true });
    } catch (error) { results.push({ item: folderId, ok: false, message: (error as Error).message }); }
  }
  return { results };
}
