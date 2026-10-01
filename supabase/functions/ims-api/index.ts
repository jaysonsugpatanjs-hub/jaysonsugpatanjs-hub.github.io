// IMS document control: folder browsing, documents, revisions, approvals and
// folder access. Any active signed-in profile may call it; every action is
// checked against that person's effective folder level in the database.
import { withSupabase } from "npm:@supabase/server@^1";
import { corsHeaders, errorJson, httpError, json, rpc } from "../_shared/http.ts";

type Client = any;

const BUCKET = "ims-documents";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELS = ["none", "viewer", "editor", "approver", "owner"] as const;
const GATES = ["technical", "whs", "ims"] as const;
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

function id(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!UUID.test(text)) throw httpError(400, `${label} is not valid.`);
  return text;
}

function text(value: unknown, label: string, max = 200, required = true): string {
  const clean = String(value ?? "").trim().replace(/\s+/g, " ");
  if (required && !clean) throw httpError(400, `${label} is required.`);
  if (clean.length > max) throw httpError(400, `${label} is too long.`);
  return clean;
}

async function requireProfile(admin: Client, userId: string) {
  const { data, error } = await admin.from("training_profiles").select("id,email,full_name,role,active").eq("id", userId).maybeSingle();
  if (error) throw httpError(500, "Profile lookup failed.");
  if (!data?.active) throw httpError(403, "This account is not active.");
  return data;
}

async function levelOf(admin: Client, folderId: string, profileId: string): Promise<number> {
  return Number(await rpc(admin, "ims_folder_level", { p_folder: folderId, p_profile: profileId })) || 0;
}

async function names(admin: Client, profileIds: string[]) {
  const ids = [...new Set(profileIds.filter(Boolean))];
  if (!ids.length) return new Map<string, string>();
  const { data, error } = await admin.from("training_profiles").select("id,full_name,email").in("id", ids);
  if (error) throw httpError(500, "People could not be loaded.");
  return new Map((data || []).map((p: any) => [p.id, p.full_name || p.email]));
}

async function treeFor(admin: Client, profileId: string) {
  const rows: any[] = await rpc(admin, "ims_folder_tree", { p_profile: profileId });
  return rows.map(row => ({
    id: row.id, parentId: row.parent_id, name: row.name, sortKey: row.sort_key,
    inherits: row.inherit_access, level: Number(row.access_level) || 0
  }));
}

function visibleDocument(doc: any, level: number) {
  if (level < 1) return false;
  return doc.status === "approved" || level >= 2;
}

async function folderView(admin: Client, me: any, body: any) {
  const tree = await treeFor(admin, me.id);
  if (!tree.length) return { root: null, canCreateRoot: me.role === "admin" };
  const byId = new Map(tree.map(f => [f.id, f]));
  const root = tree.find(f => !f.parentId)!;
  const folderId = body.folderId ? id(body.folderId, "Folder") : root.id;
  const folder = byId.get(folderId);
  if (!folder) throw httpError(404, "Folder not found.");

  const path = [];
  for (let current: any = folder; current; current = current.parentId ? byId.get(current.parentId) : null) path.unshift({ id: current.id, name: current.name });

  const docs = await admin.from("ims_documents")
    .select("id,folder_id,doc_number,title,doc_type,status,review_due,current_revision_id,owner_profile_id,required_gates")
    .order("doc_number");
  if (docs.error) throw httpError(500, "Documents could not be loaded.");
  const countFor = (fid: string) => docs.data.filter((d: any) => {
    let f: any = byId.get(d.folder_id);
    while (f) { if (f.id === fid) return visibleDocument(d, byId.get(d.folder_id)!.level); f = f.parentId ? byId.get(f.parentId) : null; }
    return false;
  }).length;

  // A locked folder reveals nothing about what is inside it, names included.
  const children = folder.level < 1 ? [] : tree.filter(f => f.parentId === folder.id).map(f => ({
    id: f.id, name: f.name, level: LEVELS[f.level], inherits: f.inherits,
    folderCount: tree.filter(x => x.parentId === f.id).length,
    documentCount: f.level ? countFor(f.id) : null
  }));

  const base = {
    folder: { id: folder.id, name: folder.name, level: LEVELS[folder.level], inherits: folder.inherits, isRoot: !folder.parentId },
    path,
    children
  };
  if (folder.level < 1) {
    const owners: any[] = await rpc(admin, "ims_effective_grants", { p_folder: folder.id });
    const ownerNames = await names(admin, owners.filter(o => o.level === "owner" && o.principal_profile).map(o => o.principal_profile));
    const groupNames = await groupNameMap(admin);
    return {
      ...base,
      documents: [],
      owners: owners.filter(o => o.level === "owner").map(o => o.principal_group ? groupNames.get(o.principal_group) || o.principal_group : ownerNames.get(o.principal_profile) || "Owner")
    };
  }

  const inFolder = docs.data.filter((d: any) => d.folder_id === folder.id);
  const visible = inFolder.filter((d: any) => visibleDocument(d, folder.level));
  const revIds = visible.map((d: any) => d.current_revision_id).filter(Boolean);
  const revs = revIds.length ? await admin.from("ims_document_revisions").select("id,revision").in("id", revIds) : { data: [], error: null };
  if (revs.error) throw httpError(500, "Revisions could not be loaded.");
  const revMap = new Map(revs.data.map((r: any) => [r.id, r.revision]));
  const open = visible.length
    ? await admin.from("ims_document_revisions").select("document_id,revision,ims_revision_approvals(gate)").in("document_id", visible.map((d: any) => d.id)).eq("status", "in_approval")
    : { data: [], error: null };
  if (open.error) throw httpError(500, "Revisions could not be loaded.");
  const openMap = new Map(open.data.map((r: any) => [r.document_id, r]));

  return {
    ...base,
    hiddenDrafts: inFolder.length - visible.length,
    documents: visible.map((d: any) => {
      const pending: any = openMap.get(d.id);
      return {
        id: d.id, docNumber: d.doc_number, title: d.title, type: d.doc_type, status: d.status,
        currentRevision: revMap.get(d.current_revision_id) || null,
        reviewDue: d.review_due,
        pending: pending ? { revision: pending.revision, approved: (pending.ims_revision_approvals || []).length, required: d.required_gates.length } : null
      };
    })
  };
}

async function groupNameMap(admin: Client) {
  const { data, error } = await admin.from("ims_groups").select("key,name");
  if (error) throw httpError(500, "Groups could not be loaded.");
  return new Map((data || []).map((g: any) => [g.key, g.name]));
}

async function accessView(admin: Client, me: any, body: any) {
  const folderId = id(body.folderId, "Folder");
  const level = await levelOf(admin, folderId, me.id);
  if (level < 1) throw httpError(403, "You don't have access to this folder.");
  const grants: any[] = await rpc(admin, "ims_effective_grants", { p_folder: folderId });
  const folders = await admin.from("ims_folders").select("id,name,inherit_access,parent_id").in("id", [...new Set([folderId, ...grants.map(g => g.source_folder)])]);
  if (folders.error) throw httpError(500, "Folder access could not be loaded.");
  const folderNames = new Map(folders.data.map((f: any) => [f.id, f.name]));
  const self = folders.data.find((f: any) => f.id === folderId);
  const groupNames = await groupNameMap(admin);
  const people = await names(admin, grants.map(g => g.principal_profile));
  const result: any = {
    folderId,
    level: LEVELS[level],
    inherits: self?.inherit_access ?? true,
    isRoot: !self?.parent_id,
    parentName: self?.parent_id ? (await admin.from("ims_folders").select("name").eq("id", self.parent_id).single()).data?.name : null,
    grants: grants.map(g => ({
      id: g.grant_id,
      principal: g.principal_group ? { type: "group", key: g.principal_group, name: groupNames.get(g.principal_group) || g.principal_group } : { type: "person", id: g.principal_profile, name: people.get(g.principal_profile) || "Unknown person" },
      level: g.level,
      inheritedFrom: g.inherited ? folderNames.get(g.source_folder) || "parent folder" : null
    }))
  };
  if (level === 4) {
    const [groups, profiles] = await Promise.all([
      admin.from("ims_groups").select("key,name").order("name"),
      admin.from("training_profiles").select("id,full_name,email").eq("active", true).order("full_name").limit(1000)
    ]);
    if (groups.error || profiles.error) throw httpError(500, "People and groups could not be loaded.");
    result.principals = {
      groups: groups.data.map((g: any) => ({ key: g.key, name: g.name })),
      people: profiles.data.map((p: any) => ({ id: p.id, name: p.full_name || p.email, email: p.email }))
    };
  }
  return result;
}

async function documentView(admin: Client, me: any, body: any) {
  const documentId = id(body.documentId, "Document");
  const doc = await admin.from("ims_documents")
    .select("id,folder_id,doc_number,title,doc_type,status,required_gates,review_months,review_due,current_revision_id,owner_profile_id,training_module_id")
    .eq("id", documentId).maybeSingle();
  if (doc.error) throw httpError(500, "Document could not be loaded.");
  if (!doc.data) throw httpError(404, "Document not found.");
  const level = await levelOf(admin, doc.data.folder_id, me.id);
  if (!visibleDocument(doc.data, level)) throw httpError(403, "You don't have access to this document.");

  const [revs, links] = await Promise.all([
    admin.from("ims_document_revisions")
      .select("id,revision,change_summary,f01_reference,file_path,status,author_profile_id,created_at,approved_at,effective_from,ims_revision_approvals(gate,approver_profile_id,comment,approved_at)")
      .eq("document_id", documentId).order("created_at", { ascending: false }),
    admin.from("ims_document_links").select("to_document_id,relation,ims_documents!ims_document_links_to_document_id_fkey(doc_number,title,folder_id,status)").eq("from_document_id", documentId)
  ]);
  if (revs.error) throw httpError(500, "Revisions could not be loaded.");
  const visibleRevs = revs.data.filter((r: any) => level >= 2 || ["approved", "superseded"].includes(r.status));
  const people = await names(admin, [doc.data.owner_profile_id, ...visibleRevs.flatMap((r: any) => [r.author_profile_id, ...(r.ims_revision_approvals || []).map((a: any) => a.approver_profile_id)])]);
  const linkRows = links.error ? [] : links.data;

  return {
    document: {
      id: doc.data.id, folderId: doc.data.folder_id, docNumber: doc.data.doc_number, title: doc.data.title, type: doc.data.doc_type,
      status: doc.data.status, requiredGates: doc.data.required_gates, reviewMonths: doc.data.review_months, reviewDue: doc.data.review_due,
      owner: people.get(doc.data.owner_profile_id) || null, controlsTrainingModule: Boolean(doc.data.training_module_id)
    },
    level: LEVELS[level],
    canRevise: level >= 2 && !visibleRevs.some((r: any) => r.status === "in_approval"),
    revisions: visibleRevs.map((r: any) => {
      const approvals = (r.ims_revision_approvals || []).map((a: any) => ({ gate: a.gate, approver: people.get(a.approver_profile_id) || "Unknown", comment: a.comment, approvedAt: a.approved_at }));
      const recorded = new Set(approvals.map((a: any) => a.gate));
      const isAuthor = r.author_profile_id === me.id;
      return {
        id: r.id, revision: r.revision, summary: r.change_summary, f01: r.f01_reference, status: r.status,
        hasFile: Boolean(r.file_path), fileName: r.file_path ? String(r.file_path).split("/").pop() : null,
        author: people.get(r.author_profile_id) || null, createdAt: r.created_at, approvedAt: r.approved_at, effectiveFrom: r.effective_from,
        approvals,
        gates: doc.data.required_gates.map((gate: string) => ({
          gate,
          recorded: recorded.has(gate),
          canApprove: r.status === "in_approval" && !recorded.has(gate) && level >= 3 && !isAuthor && Boolean(r.file_path)
        })),
        canUpload: r.status === "in_approval" && level >= 2 && approvals.length === 0,
        youAreAuthor: isAuthor
      };
    }),
    links: linkRows.map((l: any) => ({ documentId: l.to_document_id, relation: l.relation, docNumber: l.ims_documents?.doc_number, title: l.ims_documents?.title }))
  };
}

function safeFileName(value: unknown) {
  const raw = String(value ?? "").trim();
  const ext = raw.includes(".") ? raw.split(".").pop()!.toLowerCase() : "";
  if (!MIME[ext]) throw httpError(400, "Upload a PDF, Word, Excel, PowerPoint or image file.");
  const stem = raw.slice(0, raw.length - ext.length - 1).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "document";
  return { name: `${stem}.${ext}`, contentType: MIME[ext] };
}

async function prepareUpload(admin: Client, me: any, body: any) {
  const revisionId = id(body.revisionId, "Revision");
  const rev = await admin.from("ims_document_revisions").select("id,document_id,status,ims_documents(folder_id)").eq("id", revisionId).maybeSingle();
  if (rev.error || !rev.data) throw httpError(404, "Revision not found.");
  if (await levelOf(admin, rev.data.ims_documents.folder_id, me.id) < 2) throw httpError(403, "You need editor access to upload files.");
  if (rev.data.status !== "in_approval") throw httpError(409, "Only a revision awaiting approval can take a file.");
  // Once anyone has approved, the bytes they approved must not change.
  const approvals = await admin.from("ims_revision_approvals").select("id", { count: "exact", head: true }).eq("revision_id", revisionId);
  if (approvals.error) throw httpError(500, "Approvals could not be checked.");
  if ((approvals.count ?? 0) > 0) throw httpError(409, "The file cannot change after an approval has been recorded. Start a new revision instead.");
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 1 || size > MAX_FILE_BYTES) throw httpError(400, "Files must be between 1 byte and 50 MB.");
  const file = safeFileName(body.fileName);
  const path = `${rev.data.document_id}/${revisionId}/${file.name}`;
  // Each upload gets a unique name so an approved file can never be overwritten in place.
  const stamped = path.replace(/(\.[a-z]+)$/, `-${Date.now().toString(36)}$1`);
  const signed = await admin.storage.from(BUCKET).createSignedUploadUrl(stamped, { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A secure upload link could not be created.");
  return { path: stamped, signedUrl: signed.data.signedUrl, contentType: file.contentType };
}

async function attachFile(admin: Client, me: any, body: any) {
  const revisionId = id(body.revisionId, "Revision");
  const path = String(body.path || "");
  const folder = path.split("/").slice(0, -1).join("/");
  const listed = await admin.storage.from(BUCKET).list(folder, { limit: 100 });
  if (listed.error || !(listed.data || []).some((f: any) => f.name === path.split("/").pop() && Number(f?.metadata?.size ?? 1) > 0)) {
    throw httpError(409, "The uploaded file was not found. Upload it again.");
  }
  await rpc(admin, "ims_attach_revision_file", { p_actor: me.id, p_revision: revisionId, p_path: path });
  return { attached: true };
}

async function download(admin: Client, me: any, body: any) {
  const revisionId = id(body.revisionId, "Revision");
  const rev = await admin.from("ims_document_revisions").select("id,status,file_path,ims_documents(folder_id,doc_number)").eq("id", revisionId).maybeSingle();
  if (rev.error || !rev.data) throw httpError(404, "Revision not found.");
  if (!rev.data.file_path) throw httpError(404, "This revision has no file.");
  const level = await levelOf(admin, rev.data.ims_documents.folder_id, me.id);
  const allowed = rev.data.status === "approved" ? level >= 1 : level >= 2;
  if (!allowed) throw httpError(403, "You don't have access to this revision.");
  const signed = await admin.storage.from(BUCKET).createSignedUrl(rev.data.file_path, 300, { download: true });
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "A download link could not be created.");
  await rpc(admin, "ims_audit", { p_actor: me.id, p_event: "ims_revision_downloaded", p_details: { revisionId, docNumber: rev.data.ims_documents.doc_number } });
  return { url: signed.data.signedUrl, expiresIn: 300 };
}

const actions: Record<string, (admin: Client, me: any, body: any) => Promise<unknown>> = {
  folder: folderView,
  access: accessView,
  document: documentView,
  create_root: async (admin, me) => ({ id: await rpc(admin, "ims_create_folder", { p_actor: me.id, p_parent: null, p_name: "Panalo Asset File", p_sort_key: "" }) }),
  create_folder: async (admin, me, body) => ({
    id: await rpc(admin, "ims_create_folder", { p_actor: me.id, p_parent: id(body.parentId, "Parent folder"), p_name: text(body.name, "Folder name", 120), p_sort_key: null })
  }),
  create_document: async (admin, me, body) => {
    const gates = Array.isArray(body.requiredGates) ? body.requiredGates.filter((g: string) => (GATES as readonly string[]).includes(g)) : ["ims"];
    const months = Number(body.reviewMonths ?? 12);
    if (!Number.isInteger(months) || months < 1 || months > 60) throw httpError(400, "Review period must be 1 to 60 months.");
    const number = text(body.docNumber, "Document number", 50).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,49}$/.test(number)) throw httpError(400, "Use letters, numbers and hyphens for the document number.");
    return {
      id: await rpc(admin, "ims_create_document", {
        p_actor: me.id, p_folder: id(body.folderId, "Folder"), p_number: number, p_title: text(body.title, "Title", 200),
        p_type: text(body.docType, "Document type", 60), p_required_gates: gates.length ? gates : ["ims"], p_review_months: months, p_training_module: null
      })
    };
  },
  create_revision: async (admin, me, body) => {
    const revision = text(body.revision, "Revision", 40);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(revision)) throw httpError(400, "Use letters, numbers, spaces, dots or hyphens for the revision.");
    return {
      id: await rpc(admin, "ims_create_revision", {
        p_actor: me.id, p_document: id(body.documentId, "Document"), p_revision: revision,
        p_summary: text(body.summary, "Change summary", 1000, false), p_f01: text(body.f01, "F01 reference", 40, false) || null
      })
    };
  },
  prepare_upload: prepareUpload,
  attach_file: attachFile,
  download,
  approve: async (admin, me, body) => {
    const gate = String(body.gate || "");
    if (!(GATES as readonly string[]).includes(gate)) throw httpError(400, "Unknown approval gate.");
    return await rpc(admin, "ims_record_approval", { p_actor: me.id, p_revision: id(body.revisionId, "Revision"), p_gate: gate, p_comment: text(body.comment, "Comment", 500, false) });
  },
  set_grant: async (admin, me, body) => {
    const level = String(body.level || "");
    if (!["viewer", "editor", "approver", "owner"].includes(level)) throw httpError(400, "Unknown access level.");
    const group = body.group ? text(body.group, "Group", 40) : null;
    const profile = body.profileId ? id(body.profileId, "Person") : null;
    return { id: await rpc(admin, "ims_set_grant", { p_actor: me.id, p_folder: id(body.folderId, "Folder"), p_group: group, p_profile: profile, p_level: level }) };
  },
  remove_grant: async (admin, me, body) => {
    await rpc(admin, "ims_remove_grant", { p_actor: me.id, p_grant: id(body.grantId, "Access entry") });
    return { removed: true };
  },
  set_inherit: async (admin, me, body) => {
    await rpc(admin, "ims_set_inherit", { p_actor: me.id, p_folder: id(body.folderId, "Folder"), p_inherit: body.inherit === true });
    return { saved: true };
  },
  request_access: async (admin, me, body) => {
    const folderId = id(body.folderId, "Folder");
    await rpc(admin, "ims_audit", { p_actor: me.id, p_event: "ims_access_requested", p_details: { folderId, note: text(body.note, "Note", 300, false) } });
    return { requested: true };
  }
};

export default {
  fetch: withSupabase({ auth: "user" }, async (request: Request, context: any) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
    if (!cors.allowed) return json(request, { message: "This website is not permitted to call document control." }, 403);
    if (request.method !== "POST") return json(request, { message: "Method not allowed." }, 405);
    try {
      const userId = String(context.userClaims?.id || context.userClaims?.sub || "");
      if (!userId) throw httpError(401, "A verified session is required.");
      const me = await requireProfile(context.supabaseAdmin, userId);
      const body = await request.json().catch(() => ({}));
      const handler = actions[String(body.action)];
      if (!handler) throw httpError(400, "Unknown document control action.");
      return json(request, { ...(await handler(context.supabaseAdmin, me, body) as object), me: { name: me.full_name || me.email, isAdmin: me.role === "admin" } });
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
