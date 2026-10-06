// Personnel (HR) files: each person's folder, sorted by category.
// Accepted onboarding items are filed automatically: uploads in place, typed
// answers as a generated PDF record. HR can add, view and archive documents.
// Nothing is deleted. Every view, filing and archive is audited.
import { describeAnswers } from "../_shared/onboarding-forms.ts";
import { createRecordPdf } from "../_shared/record-pdf.ts";
import { httpError, rpc } from "../_shared/http.ts";
import type { Actor } from "./accounts.ts";

type Client = any;
type Handler = (admin: Client, actor: Actor, body: any) => Promise<unknown>;

const BUCKET = "hr-documents";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic" };

function uuid(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}
const slug = (v: string) => v.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "record";

async function categories(admin: Client) {
  const { data, error } = await admin.from("personnel_categories").select("key,name,description,sensitive,sort").order("sort");
  if (error) throw httpError(500, "HR folder categories could not be loaded.");
  return data;
}

/**
 * Files every accepted onboarding item for a person that is not filed yet.
 * Safe to run repeatedly: the database refuses duplicates. Returns how many
 * records were added.
 */
export async function fileAcceptedOnboarding(admin: Client, actor: Actor, employeeId: string) {
  const { data, error } = await admin.from("onboarding_items")
    .select("id,doc_type,status,answers,submitted_at,reviewed_at,reviewed_by,onboarding_requests!inner(employee_id),hr_document_types(name,kind,personnel_category),onboarding_files(id,path,file_name,label,expires_on)")
    .eq("status", "accepted").eq("onboarding_requests.employee_id", employeeId);
  if (error) throw httpError(500, "Accepted onboarding items could not be read.");
  if (!data.length) return 0;
  const filed = await admin.from("personnel_documents").select("source_item_id,source_file_id,source").eq("employee_id", employeeId);
  if (filed.error) throw httpError(500, "The HR folder could not be read.");
  const filedFiles = new Set(filed.data.map((d: any) => d.source_file_id).filter(Boolean));
  const filedForms = new Set(filed.data.filter((d: any) => d.source === "onboarding_form").map((d: any) => d.source_item_id));
  const emp = await admin.from("employees").select("full_name,employee_number").eq("id", employeeId).maybeSingle();
  let added = 0;

  for (const item of data) {
    const type = item.hr_document_types || {};
    const category = type.personnel_category || "other";
    for (const file of item.onboarding_files || []) {
      if (filedFiles.has(file.id)) continue;
      await rpc(admin, "personnel_file_document", {
        p_actor: actor.id, p_employee: employeeId, p_category: category, p_title: file.label || type.name || item.doc_type,
        p_path: file.path, p_file_name: file.file_name, p_source: "onboarding_upload", p_item: item.id, p_file: file.id, p_expires: file.expires_on
      });
      added++;
    }
    if (type.kind === "form" && item.answers && !filedForms.has(item.id)) {
      const reviewer = item.reviewed_by
        ? (await admin.from("training_profiles").select("full_name,email").eq("id", item.reviewed_by).maybeSingle()).data
        : null;
      const bytes = await createRecordPdf({
        title: type.name || item.doc_type,
        personName: emp.data?.full_name || "", employeeNumber: emp.data?.employee_number || "",
        submittedAt: item.submitted_at, acceptedAt: item.reviewed_at, acceptedBy: reviewer?.full_name || reviewer?.email || null,
        rows: describeAnswers(item.doc_type, item.answers).map(r => ({ label: r.label, value: r.value }))
      });
      const path = `personnel/${employeeId}/${category}/${slug(type.name || item.doc_type)}-${Date.now().toString(36)}.pdf`;
      const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
      if (up.error) throw httpError(500, "The HR record could not be saved.");
      await rpc(admin, "personnel_file_document", {
        p_actor: actor.id, p_employee: employeeId, p_category: category, p_title: type.name || item.doc_type,
        p_path: path, p_file_name: path.split("/").pop(), p_source: "onboarding_form", p_item: item.id, p_file: null, p_expires: null
      });
      added++;
    }
  }
  return added;
}

async function personnelPeople(admin: Client) {
  const [people, docs] = await Promise.all([
    admin.from("employees").select("id,employee_number,full_name,employment_type,status").order("full_name").limit(2000),
    admin.from("personnel_documents").select("employee_id,archived_at,expires_on").limit(20000)
  ]);
  if (people.error || docs.error) throw httpError(500, "HR files could not be loaded.");
  const today = new Date().toISOString().slice(0, 10);
  const counts = new Map<string, { total: number; expired: number }>();
  for (const d of docs.data) {
    if (d.archived_at) continue;
    const c = counts.get(d.employee_id) || { total: 0, expired: 0 };
    c.total++;
    if (d.expires_on && d.expires_on < today) c.expired++;
    counts.set(d.employee_id, c);
  }
  return {
    people: people.data.map((p: any) => ({
      id: p.id, number: p.employee_number, name: p.full_name, type: p.employment_type, status: p.status,
      documents: counts.get(p.id)?.total || 0, expired: counts.get(p.id)?.expired || 0
    }))
  };
}

async function personnelView(admin: Client, actor: Actor, body: any) {
  const employeeId = uuid(body.employeeId, "Person");
  const emp = await admin.from("employees").select("id,employee_number,full_name,employment_type,status,profile_id").eq("id", employeeId).maybeSingle();
  if (emp.error) throw httpError(500, "The register could not be read.");
  if (!emp.data) throw httpError(404, "Person not found on the register.");
  // Catch up anything accepted but not yet filed (for example, accepted before this feature).
  let filedNow = 0;
  try { filedNow = await fileAcceptedOnboarding(admin, actor, employeeId); } catch (e) { console.error("personnel backfill", e); }

  const [cats, docs] = await Promise.all([
    categories(admin),
    admin.from("personnel_documents").select("id,category,title,file_name,source,expires_on,filed_at,filed_by,archived_at,archive_reason")
      .eq("employee_id", employeeId).order("filed_at", { ascending: false })
  ]);
  if (docs.error) throw httpError(500, "The HR folder could not be read.");
  const filers = [...new Set(docs.data.map((d: any) => d.filed_by).filter(Boolean))];
  const names = filers.length ? (await admin.from("training_profiles").select("id,full_name,email").in("id", filers)).data || [] : [];
  const nameMap = new Map(names.map((p: any) => [p.id, p.full_name || p.email]));

  // Training certificates issued by the portal appear in 09 Training, read-only.
  let training: any[] = [];
  if (emp.data.profile_id) {
    const certs = await admin.from("training_certificates")
      .select("id,certificate_number,status,issued_at,training_assessment_attempts!inner(training_assignments!inner(learner_id,training_module_versions(revision,training_modules(code,title))))")
      .eq("training_assessment_attempts.training_assignments.learner_id", emp.data.profile_id)
      .order("issued_at", { ascending: false });
    if (!certs.error) {
      training = certs.data.map((c: any) => {
        const v = c.training_assessment_attempts?.training_assignments?.training_module_versions;
        return { id: c.id, number: c.certificate_number, status: c.status, issuedAt: c.issued_at, module: v?.training_modules ? `${v.training_modules.code} ${v.training_modules.title}` : "Training module", revision: v?.revision };
      });
    }
  }

  await rpc(admin, "ims_audit", {
    p_actor: actor.id, p_event: "personnel_file_opened", p_details: { employeeId }, p_subject: emp.data.profile_id ?? null
  });
  return {
    person: { id: emp.data.id, number: emp.data.employee_number, name: emp.data.full_name, type: emp.data.employment_type, status: emp.data.status },
    filedNow,
    categories: cats.map((c: any) => ({
      key: c.key, name: c.name, description: c.description, sensitive: c.sensitive,
      documents: docs.data.filter((d: any) => d.category === c.key).map((d: any) => ({
        id: d.id, title: d.title, fileName: d.file_name, source: d.source, expiresOn: d.expires_on, filedAt: d.filed_at,
        filedBy: nameMap.get(d.filed_by) || null, archivedAt: d.archived_at, archiveReason: d.archive_reason
      }))
    })),
    training
  };
}

async function personnelOpen(admin: Client, actor: Actor, body: any) {
  const docId = uuid(body.documentId, "Document");
  const { data, error } = await admin.from("personnel_documents").select("id,path,title,category,employee_id,employees(profile_id)").eq("id", docId).maybeSingle();
  if (error) throw httpError(500, "The document could not be found.");
  if (!data) throw httpError(404, "Document not found.");
  const signed = await admin.storage.from(BUCKET).createSignedUrl(data.path, 120);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A viewing link could not be created.");
  await rpc(admin, "ims_audit", {
    p_actor: actor.id, p_event: "personnel_document_viewed",
    p_details: { documentId: docId, employeeId: data.employee_id, category: data.category, title: data.title }, p_subject: data.employees?.profile_id ?? null
  });
  return { url: signed.data.signedUrl, expiresIn: 120 };
}

async function personnelOpenCertificate(admin: Client, actor: Actor, body: any) {
  const certId = uuid(body.certificateId, "Certificate");
  const { data, error } = await admin.from("training_certificates").select("id,storage_path,certificate_number,status").eq("id", certId).maybeSingle();
  if (error || !data) throw httpError(404, "Certificate not found.");
  const signed = await admin.storage.from("training-certificates").createSignedUrl(data.storage_path, 120);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A viewing link could not be created.");
  await rpc(admin, "ims_audit", { p_actor: actor.id, p_event: "certificate_opened", p_details: { certificateNumber: data.certificate_number, via: "personnel_file" }, p_subject: null });
  return { url: signed.data.signedUrl, expiresIn: 120 };
}

async function personnelPrepareUpload(admin: Client, _actor: Actor, body: any) {
  const employeeId = uuid(body.employeeId, "Person");
  const category = String(body.category || "");
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(category)) throw httpError(400, "Choose a folder.");
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1 || size > 20 * 1024 * 1024) throw httpError(400, "Files must be under 20 MB.");
  const raw = String(body.fileName || "").trim();
  const ext = raw.includes(".") ? raw.split(".").pop()!.toLowerCase() : "";
  if (!TYPES[ext]) throw httpError(400, "Upload a PDF or a photo (JPG, PNG, WebP or HEIC).");
  const stem = raw.slice(0, raw.length - ext.length - 1).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "document";
  const path = `personnel/${employeeId}/${category}/${stem}-${Date.now().toString(36)}.${ext}`;
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A secure upload link could not be created.");
  return { path, signedUrl: signed.data.signedUrl, contentType: TYPES[ext] };
}

async function personnelAdd(admin: Client, actor: Actor, body: any) {
  const employeeId = uuid(body.employeeId, "Person");
  const category = String(body.category || "");
  const path = String(body.path || "");
  const folder = `personnel/${employeeId}/${category}`;
  if (!path.startsWith(`${folder}/`)) throw httpError(400, "Invalid upload path.");
  const listed = await admin.storage.from(BUCKET).list(folder, { limit: 1000 });
  if (listed.error || !(listed.data || []).some((f: any) => f.name === path.split("/").pop())) throw httpError(409, "The upload didn't arrive. Please try again.");
  const expires = body.expiresOn ? String(body.expiresOn) : null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw httpError(400, "The expiry date is not valid.");
  const id = await rpc<string>(admin, "personnel_file_document", {
    p_actor: actor.id, p_employee: employeeId, p_category: category, p_title: String(body.title || "").trim().slice(0, 160),
    p_path: path, p_file_name: String(body.fileName || "").slice(0, 200), p_source: "hr_upload", p_item: null, p_file: null, p_expires: expires
  });
  return { documentId: id };
}

async function personnelArchive(admin: Client, actor: Actor, body: any) {
  await rpc(admin, "personnel_archive_document", { p_actor: actor.id, p_document: uuid(body.documentId, "Document"), p_reason: String(body.reason || "").slice(0, 300) });
  return { archived: true };
}

export const personnelActions: Record<string, { perm: string | string[]; run: Handler }> = {
  personnel_people: { perm: "hr.manage", run: admin => personnelPeople(admin) },
  personnel_view: { perm: "hr.manage", run: personnelView },
  personnel_open: { perm: "hr.manage", run: personnelOpen },
  personnel_open_certificate: { perm: "hr.manage", run: personnelOpenCertificate },
  personnel_prepare_upload: { perm: "hr.manage", run: personnelPrepareUpload },
  personnel_add: { perm: "hr.manage", run: personnelAdd },
  personnel_archive: { perm: "hr.manage", run: personnelArchive }
};
