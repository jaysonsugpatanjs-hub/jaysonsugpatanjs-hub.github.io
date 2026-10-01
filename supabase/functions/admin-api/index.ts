import { withSupabase } from "npm:@supabase/server@^1";
import { corsHeaders, errorJson, httpError, json, rpc } from "../_shared/http.ts";
import { peopleActions } from "./people.ts";
import { accountActions, type Actor } from "./accounts.ts";
import { generateTemporaryPassword } from "../_shared/accounts.ts";
import { expectedModuleAssets, moduleSlug, validateAuthoringManifest } from "../_shared/module-authoring.ts";

type Client = any;

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_PPTX_BYTES = 25 * 1024 * 1024;
const MAX_SLIDE_BYTES = 10 * 1024 * 1024;

function cleanEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw httpError(400, "Enter a valid learner email address.");
  return email;
}

function cleanText(value: unknown, label: string, maxLength = 100, required = true) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (required && !text) throw httpError(400, `${label} is required.`);
  if (text.length > maxLength) throw httpError(400, `${label} is too long.`);
  return text;
}

function cleanModuleCode(value: unknown) {
  const code = cleanText(value, "Module code", 50).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,49}$/.test(code)) {
    throw httpError(400, "Use 3-50 letters, numbers or hyphens for the module code.");
  }
  return code;
}

function cleanContentVersion(value: unknown) {
  const version = cleanText(value, "Content version", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version)) {
    throw httpError(400, "Use letters, numbers, dots, underscores or hyphens for the content version.");
  }
  return version;
}

// Loads the signed-in person with their effective permissions. System
// administrators hold every permission; others get them from their position
// plus per-person overrides.
async function loadActor(admin: Client, userId: string): Promise<Actor & { mustChangePassword: boolean }> {
  const { data, error } = await admin
    .from("training_profiles")
    .select("id,email,full_name,role,active,must_change_password")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw httpError(500, "Profile lookup failed.");
  if (!data?.active) throw httpError(403, "This account is not active.");
  const permissions = await rpc<string[]>(admin, "app_permissions_for", { p_profile: userId });
  return { ...data, permissions: permissions || [], mustChangePassword: Boolean(data.must_change_password) };
}

function requirePermission(actor: Actor, needed: string | string[]) {
  const list = Array.isArray(needed) ? needed : [needed];
  if (!list.some(key => actor.permissions.includes(key))) {
    throw httpError(403, "Your access doesn't include this area. Ask an administrator if you need it.");
  }
}

const ACTION_PERMISSIONS: Record<string, string | string[]> = {
  dashboard: "training.manage",
  invite: "training.manage",
  revoke: "training.manage",
  module_catalog: "training.manage",
  module_save_draft: "training.manage",
  module_prepare_uploads: "training.manage",
  module_validate: "training.manage",
  module_publish: "training.manage",
  module_ims_revisions: "training.manage",
  module_link_ims: "training.manage",
  people_reference: ["people.view", "people.manage", "access.manage", "hr.manage", "competency.all", "competency.team"],
  people_list: ["people.view", "people.manage", "access.manage", "hr.manage"],
  employee_save: "people.manage",
  licence_save: "people.manage",
  licence_delete: "people.manage",
  position_save: "people.manage",
  site_save: "people.manage",
  requirement_set: "people.manage",
  group_member_set: "access.manage",
  competency_matrix: ["competency.all", "competency.team"],
  practical_record: ["competency.all", "competency.team"]
};

async function audit(admin: Client, values: Record<string, unknown>) {
  const { error } = await admin.from("training_audit_events").insert(values);
  if (error) {
    console.error("Audit insert failed", error.message);
    throw httpError(500, "The change was saved but its audit record failed. Contact the system administrator.");
  }
}

async function inspectVersionAssets(admin: Client, version: any) {
  const expectedPaths = expectedModuleAssets(version.storage_prefix, Number(version.slide_count));
  const expectedNames = expectedPaths.map(path => path.slice(version.storage_prefix.length + 1));
  const listed = await admin.storage.from("training-content").list(version.storage_prefix, {
    limit: Math.min(1000, expectedNames.length + 20),
    offset: 0,
    sortBy: { column: "name", order: "asc" }
  });
  if (listed.error) throw httpError(500, "Private module assets could not be inspected.");
  const present = new Set((listed.data || [])
    .filter((file: any) => file?.id && Number(file?.metadata?.size ?? 1) > 0)
    .map((file: any) => String(file.name)));
  const missing = expectedNames.filter(name => !present.has(name));
  return {
    expected: expectedNames.length,
    present: expectedNames.length - missing.length,
    missing,
    ready: missing.length === 0
  };
}

async function moduleCatalog(admin: Client) {
  const [modulesResult, versionsResult] = await Promise.all([
    admin.from("training_modules")
      .select("id,code,slug,title,description,status,practical_required,current_version_id,created_at,updated_at")
      .order("code"),
    admin.from("training_module_versions")
      .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published,created_at,ims_revision_id")
      .order("created_at", { ascending: false })
  ]);
  if (modulesResult.error || versionsResult.error) throw httpError(500, "The module register could not be loaded.");
  const moduleMap = new Map<string, any>((modulesResult.data || []).map((module: any) => [module.id, module]));
  const revisionIds = [...new Set((versionsResult.data || []).map((version: any) => version.ims_revision_id).filter(Boolean))];
  const revisionsResult = revisionIds.length
    ? await admin.from("ims_document_revisions").select("id,revision,status,document_id,ims_documents!ims_document_revisions_document_id_fkey(doc_number)").in("id", revisionIds)
    : { data: [], error: null };
  if (revisionsResult.error) throw httpError(500, "Linked IMS revisions could not be loaded.");
  const revisionMap = new Map<string, any>((revisionsResult.data || []).map((revision: any) => [revision.id, revision]));
  const versions = await Promise.all((versionsResult.data || []).map(async (version: any) => ({
    id: version.id,
    moduleId: version.module_id,
    code: moduleMap.get(version.module_id)?.code || "Unknown",
    revision: version.revision,
    contentVersion: version.content_version,
    slideCount: version.slide_count,
    passMark: version.pass_mark,
    published: version.published,
    current: moduleMap.get(version.module_id)?.current_version_id === version.id,
    createdAt: version.created_at,
    ims: version.ims_revision_id && revisionMap.get(version.ims_revision_id) ? {
      revisionId: version.ims_revision_id,
      docNumber: revisionMap.get(version.ims_revision_id).ims_documents?.doc_number,
      revision: revisionMap.get(version.ims_revision_id).revision,
      status: revisionMap.get(version.ims_revision_id).status
    } : null,
    // Published versions were validated at publication; only drafts need a storage listing.
    assets: version.published ? { expected: version.slide_count + 1, present: version.slide_count + 1, missing: [], ready: true } : await inspectVersionAssets(admin, version)
  })));
  return {
    modules: (modulesResult.data || []).map((module: any) => ({
      id: module.id,
      code: module.code,
      slug: module.slug,
      title: module.title,
      description: module.description,
      status: module.status,
      practicalRequired: module.practical_required,
      currentVersionId: module.current_version_id,
      createdAt: module.created_at,
      updatedAt: module.updated_at
    })),
    versions
  };
}

async function saveModuleDraft(admin: Client, administrator: any, body: any) {
  const code = cleanModuleCode(body.code);
  const slug = moduleSlug(code);
  const title = cleanText(body.title, "Module title", 200);
  const description = cleanText(body.description, "Module description", 1200, false);
  const revision = cleanText(body.revision, "Revision", 80);
  const contentVersion = cleanContentVersion(body.contentVersion);
  const passMark = Number(body.passMark ?? 80);
  if (!Number.isInteger(passMark) || passMark < 1 || passMark > 100) throw httpError(400, "Pass mark must be a whole number from 1 to 100.");
  const content = validateAuthoringManifest(body.authoringManifest);

  const existingModule = await admin.from("training_modules").select("id,status").eq("code", code).maybeSingle();
  if (existingModule.error) throw httpError(500, "The module record could not be checked.");
  if (existingModule.data?.status === "retired") throw httpError(409, "This module code is retired and cannot receive a new draft.");

  let moduleRecord: any;
  if (existingModule.data) {
    const updated = await admin.from("training_modules").update({
      slug,
      title,
      description,
      practical_required: body.practicalRequired !== false
    }).eq("id", existingModule.data.id).select("id,code,slug,title,status,current_version_id").single();
    if (updated.error) throw httpError(409, "The module details could not be updated. Check whether the code is unique.");
    moduleRecord = updated.data;
  } else {
    const inserted = await admin.from("training_modules").insert({
      code,
      slug,
      title,
      description,
      status: "draft",
      practical_required: body.practicalRequired !== false
    }).select("id,code,slug,title,status,current_version_id").single();
    if (inserted.error) throw httpError(409, "The module could not be created. Check whether the code is unique.");
    moduleRecord = inserted.data;
  }

  const storagePrefix = `${slug}/${contentVersion}`;
  const existingVersion = await admin.from("training_module_versions")
    .select("id,published")
    .eq("module_id", moduleRecord.id)
    .eq("content_version", contentVersion)
    .maybeSingle();
  if (existingVersion.error) throw httpError(500, "The draft version could not be checked.");
  if (existingVersion.data?.published) throw httpError(409, "Published versions are immutable. Use a new content version.");

  const values = {
    module_id: moduleRecord.id,
    revision,
    content_version: contentVersion,
    slide_count: content.slideCount,
    pass_mark: passMark,
    storage_prefix: storagePrefix,
    learner_manifest: content.learnerManifest,
    answer_key: content.answerKey,
    published: false
  };
  const versionResult = existingVersion.data
    ? await admin.from("training_module_versions").update(values).eq("id", existingVersion.data.id)
      .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published").single()
    : await admin.from("training_module_versions").insert(values)
      .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published").single();
  if (versionResult.error) throw httpError(409, "The secure module draft could not be saved.");

  await audit(admin, {
    actor_user_id: administrator.id,
    event_type: "module_draft_saved",
    details: { moduleId: moduleRecord.id, versionId: versionResult.data.id, code, revision, contentVersion, slideCount: content.slideCount }
  });
  return {
    module: moduleRecord,
    version: versionResult.data,
    answersStoredServerSide: true,
    assets: await inspectVersionAssets(admin, versionResult.data)
  };
}

async function getEditableVersion(admin: Client, versionId: unknown) {
  const id = String(versionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpError(400, "A valid module version is required.");
  const result = await admin.from("training_module_versions")
    .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published")
    .eq("id", id)
    .maybeSingle();
  if (result.error || !result.data) throw httpError(404, "The module version was not found.");
  if (result.data.published) throw httpError(409, "Published module assets are immutable. Create a new version instead.");
  return result.data;
}

async function prepareModuleUploads(admin: Client, versionId: unknown, rawAssets: unknown) {
  const version = await getEditableVersion(admin, versionId);
  if (!Array.isArray(rawAssets) || !rawAssets.length || rawAssets.length > Number(version.slide_count) + 1) {
    throw httpError(400, "Choose the PowerPoint and rendered slide files for this draft.");
  }
  const seen = new Set<string>();
  const assets = rawAssets.map((raw: any) => {
    const kind = String(raw?.kind || "");
    const size = Number(raw?.size);
    let filename: string;
    let contentType: string;
    if (kind === "source") {
      filename = "source.pptx";
      contentType = PPTX_MIME;
      if (!Number.isFinite(size) || size < 1 || size > MAX_PPTX_BYTES) throw httpError(400, "The PowerPoint must be between 1 byte and 25 MB.");
    } else if (kind === "slide") {
      const slideNumber = Number(raw?.slideNumber);
      if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > Number(version.slide_count)) {
        throw httpError(400, "A rendered slide number is invalid.");
      }
      filename = `slide-${String(slideNumber).padStart(2, "0")}.webp`;
      contentType = "image/webp";
      if (!Number.isFinite(size) || size < 1 || size > MAX_SLIDE_BYTES) throw httpError(400, `Rendered slide ${slideNumber} must be no larger than 10 MB.`);
    } else {
      throw httpError(400, "An upload asset type is invalid.");
    }
    if (seen.has(filename)) throw httpError(400, `Duplicate upload asset: ${filename}.`);
    seen.add(filename);
    return { filename, contentType, size };
  });

  const signedUploads = await Promise.all(assets.map(async asset => {
    const path = `${version.storage_prefix}/${asset.filename}`;
    const signed = await admin.storage.from("training-content").createSignedUploadUrl(path, { upsert: true });
    if (signed.error || !signed.data?.signedUrl) throw httpError(500, `A secure upload link could not be created for ${asset.filename}.`);
    return { ...asset, path, signedUrl: signed.data.signedUrl };
  }));
  return { versionId: version.id, uploads: signedUploads, expiresIn: 7200 };
}

async function validateModuleAssets(admin: Client, versionId: unknown) {
  const id = String(versionId || "");
  const result = await admin.from("training_module_versions")
    .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published")
    .eq("id", id)
    .maybeSingle();
  if (result.error || !result.data) throw httpError(404, "The module version was not found.");
  return { versionId: id, published: result.data.published, assets: await inspectVersionAssets(admin, result.data) };
}

async function publishModule(admin: Client, administrator: any, versionId: unknown) {
  const id = String(versionId || "");
  const versionResult = await admin.from("training_module_versions")
    .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published")
    .eq("id", id)
    .maybeSingle();
  if (versionResult.error || !versionResult.data) throw httpError(404, "The module version was not found.");
  const assets = await inspectVersionAssets(admin, versionResult.data);
  if (!assets.ready) throw httpError(409, `The draft cannot be published. Missing: ${assets.missing.join(", ")}.`);
  // Approval check, publication, current-version switch and audit row happen in one transaction.
  const result: any = await rpc(admin, "training_publish_version", { p_actor: administrator.id, p_version: id });
  return {
    published: true,
    module: { code: result.code, title: result.title, status: "active", currentVersionId: id },
    version: { id, revision: result.revision, contentVersion: result.contentVersion },
    assets
  };
}

async function imsTrainingRevisions(admin: Client) {
  const { data, error } = await admin.from("ims_documents")
    .select("id,doc_number,title,training_module_id,ims_document_revisions!ims_document_revisions_document_id_fkey(id,revision,status,created_at)")
    .eq("doc_type", "Training module")
    .neq("status", "archived")
    .order("doc_number");
  if (error) throw httpError(500, "IMS training documents could not be loaded.");
  return {
    documents: (data || []).map((doc: any) => ({
      id: doc.id,
      docNumber: doc.doc_number,
      title: doc.title,
      trainingModuleId: doc.training_module_id,
      revisions: (doc.ims_document_revisions || [])
        .filter((revision: any) => ["in_approval", "approved"].includes(revision.status))
        .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((revision: any) => ({ id: revision.id, revision: revision.revision, status: revision.status }))
    }))
  };
}

async function linkImsRevision(admin: Client, administrator: any, body: any) {
  await rpc(admin, "training_link_ims_revision", {
    p_actor: administrator.id,
    p_version: String(body.versionId || ""),
    p_revision: String(body.revisionId || "")
  });
  return { linked: true };
}

const PAGE_SIZE = 200;

async function dashboard(admin: Client, administrator: any, body: any = {}) {
  const page = Math.max(0, Math.min(1000, Number.parseInt(String(body.page ?? 0), 10) || 0));
  const from = page * PAGE_SIZE;
  const nowIso = new Date().toISOString();
  const [assignmentCount, activeLearners, openAssignments, theoryPassed] = await Promise.all([
    admin.from("training_assignments").select("id", { count: "exact", head: true }),
    admin.from("training_profiles").select("id", { count: "exact", head: true }).eq("active", true).eq("role", "learner"),
    admin.from("training_assignments").select("id", { count: "exact", head: true }).in("status", ["assigned", "theory_passed"]).gt("expires_at", nowIso),
    admin.from("training_assignments").select("id", { count: "exact", head: true }).eq("status", "theory_passed")
  ]);
  if (assignmentCount.error || activeLearners.error || openAssignments.error || theoryPassed.error) {
    throw httpError(500, "The training administration totals could not be loaded.");
  }
  const assignmentPage = await admin.from("training_assignments")
    .select("id,learner_id,module_version_id,status,assigned_at,expires_at,theory_passed_at,revoked_at,revoke_reason")
    .order("assigned_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (assignmentPage.error) throw httpError(500, "The training administration register could not be loaded.");
  const pageAssignmentIds = (assignmentPage.data || []).map((assignment: any) => assignment.id);
  const pageLearnerIds = [...new Set((assignmentPage.data || []).map((assignment: any) => assignment.learner_id))];
  const [profilesResult, modulesResult, attemptsResult] = await Promise.all([
    pageLearnerIds.length
      ? admin.from("training_profiles").select("id,email,full_name,external_id,learner_type,role,active,created_at").in("id", pageLearnerIds)
      : Promise.resolve({ data: [], error: null }),
    admin.from("training_modules").select("id,code,slug,title,status,practical_required,current_version_id").neq("status", "retired").order("code"),
    pageAssignmentIds.length
      ? admin.from("training_assessment_attempts").select("id,assignment_id,attempt_number,score,critical_passed,passed,submitted_at").in("assignment_id", pageAssignmentIds).order("submitted_at", { ascending: false })
      : Promise.resolve({ data: [], error: null })
  ]);
  const assignmentsResult = assignmentPage;
  if (profilesResult.error || modulesResult.error || attemptsResult.error) {
    throw httpError(500, "The training administration register could not be loaded.");
  }

  const versionIds = [...new Set([
    ...(modulesResult.data || []).map((module: any) => module.current_version_id),
    ...(assignmentsResult.data || []).map((assignment: any) => assignment.module_version_id)
  ].filter(Boolean))];
  const versionsResult = versionIds.length
    ? await admin.from("training_module_versions").select("id,module_id,revision,content_version,published,slide_count").in("id", versionIds)
    : { data: [], error: null };
  if (versionsResult.error) throw httpError(500, "Module versions could not be loaded.");

  const profileMap = new Map<string, any>((profilesResult.data || []).map((profile: any) => [profile.id, profile]));
  const versionMap = new Map<string, any>((versionsResult.data || []).map((version: any) => [version.id, version]));
  const moduleMap = new Map<string, any>((modulesResult.data || []).map((module: any) => [module.id, module]));
  const attemptsByAssignment = new Map<string, any[]>();
  for (const attempt of attemptsResult.data || []) {
    if (!attemptsByAssignment.has(attempt.assignment_id)) attemptsByAssignment.set(attempt.assignment_id, []);
    attemptsByAssignment.get(attempt.assignment_id)!.push(attempt);
  }

  const assignments = (assignmentsResult.data || []).map((assignment: any) => {
    const version = versionMap.get(assignment.module_version_id);
    const module = version ? moduleMap.get(version.module_id) : null;
    const attempts = attemptsByAssignment.get(assignment.id) || [];
    return {
      id: assignment.id,
      learner: profileMap.get(assignment.learner_id) || null,
      module: module ? { code: module.code, title: module.title, revision: version.revision } : null,
      status: assignment.status,
      assignedAt: assignment.assigned_at,
      expiresAt: assignment.expires_at,
      theoryPassedAt: assignment.theory_passed_at,
      revokedAt: assignment.revoked_at,
      revokeReason: assignment.revoke_reason,
      latestAttempt: attempts[0] ? {
        attemptNumber: attempts[0].attempt_number,
        score: attempts[0].score,
        criticalPassed: attempts[0].critical_passed,
        pass: attempts[0].passed,
        submittedAt: attempts[0].submitted_at
      } : null,
      attemptCount: attempts.length
    };
  });

  return {
    administrator: { email: administrator.email, fullName: administrator.full_name },
    modules: (modulesResult.data || []).map((module: any) => {
      const version = versionMap.get(module.current_version_id);
      return {
        code: module.code,
        title: module.title,
        status: module.status,
        practicalRequired: module.practical_required,
        currentVersionId: module.current_version_id,
        revision: version?.revision,
        published: Boolean(version?.published)
      };
    }),
    assignments,
    summary: {
      activeLearners: activeLearners.count ?? 0,
      openAssignments: openAssignments.count ?? 0,
      theoryPassed: theoryPassed.count ?? 0
    },
    paging: { page, pageSize: PAGE_SIZE, total: assignmentCount.count ?? 0, hasMore: from + PAGE_SIZE < (assignmentCount.count ?? 0) }
  };
}

async function invite(admin: Client, administrator: any, body: any) {
  const email = cleanEmail(body.email);
  const fullName = cleanText(body.fullName, "Full legal name", 100);
  const externalId = cleanText(body.externalId, "Employee or applicant ID", 50, false) || null;
  const learnerType = ["employee", "applicant", "contractor"].includes(body.learnerType) ? body.learnerType : "applicant";
  const moduleCode = cleanText(body.moduleCode, "Module", 50);
  const expiresAt = new Date(String(body.expiresAt || ""));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000) throw httpError(400, "Choose a future assignment expiry date.");
  if (expiresAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw httpError(400, "Assignment access cannot exceed one year.");

  const moduleResult = await admin
    .from("training_modules")
    .select("id,code,title,status,current_version_id")
    .eq("code", moduleCode)
    .maybeSingle();
  if (moduleResult.error || !moduleResult.data?.current_version_id || moduleResult.data.status === "retired") {
    throw httpError(400, "The selected module is not available for assignment.");
  }
  const versionResult = await admin
    .from("training_module_versions")
    .select("id,revision,published")
    .eq("id", moduleResult.data.current_version_id)
    .maybeSingle();
  if (versionResult.error || !versionResult.data?.published) throw httpError(400, "The selected module version has not been published to the secure service.");

  const mode = body.signIn === "password" ? "password" : "invite";
  let tempPassword: string | null = null;
  let profileResult = await admin.from("training_profiles").select("id,email,active").eq("email", email).maybeSingle();
  if (profileResult.error) throw httpError(500, "Learner lookup failed.");
  let userId = profileResult.data?.id;
  let invitationSent = false;

  if (!userId && mode === "password") {
    // Shown once to the administrator; the learner must change it at first sign-in.
    tempPassword = generateTemporaryPassword();
    const made = await admin.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true,
      user_metadata: { full_name: fullName, external_id: externalId, learner_type: learnerType }
    });
    if (made.error || !made.data?.user?.id) throw httpError(409, "The sign-in could not be created. Check the email address and try again.");
    userId = made.data.user.id;
  }

  if (!userId) {
    const redirectTo = `${Deno.env.get("TRAINING_APP_URL") || "https://jaysonsugpatanjs-hub.github.io/training/"}?welcome=1`;
    const invited = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { full_name: fullName, external_id: externalId, learner_type: learnerType }
    });
    if (invited.error || !invited.data?.user?.id) {
      throw httpError(409, "This email could not be invited. Check whether it already has an account or try again later.");
    }
    userId = invited.data.user.id;
    invitationSent = true;
  }

  // Profile, assignment and audit row are written in one transaction.
  const assignment: any = await rpc(admin, "training_assign", {
    p_actor: administrator.id,
    p_learner: userId,
    p_email: email,
    p_full_name: fullName,
    p_external_id: externalId,
    p_learner_type: learnerType,
    p_version: versionResult.data.id,
    p_expires_at: expiresAt.toISOString(),
    p_invited: invitationSent
  });
  if (tempPassword) await rpc(admin, "account_temp_password_issued", { p_actor: administrator.id, p_profile: userId, p_new_account: true });
  return {
    invitationSent,
    tempPassword,
    existingAccount: !invitationSent && !tempPassword,
    learner: { id: userId, email, full_name: fullName, external_id: externalId, learner_type: learnerType, active: true },
    assignment
  };
}

async function revoke(admin: Client, administrator: any, body: any) {
  const assignmentId = String(body.assignmentId || "");
  const reason = cleanText(body.reason, "Revocation reason", 240, false) || "Access ended by training administrator";
  return await rpc(admin, "training_revoke", { p_actor: administrator.id, p_assignment: assignmentId, p_reason: reason });
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request: Request, context: any) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
    if (!cors.allowed) return json(request, { message: "This website is not permitted to call training administration." }, 403);
    if (request.method !== "POST") return json(request, { message: "Method not allowed." }, 405);
    try {
      const userId = String(context.userClaims?.id || context.userClaims?.sub || "");
      if (!userId) throw httpError(401, "A verified session is required.");
      const administrator = await loadActor(context.supabaseAdmin, userId);
      if (administrator.mustChangePassword) throw httpError(403, "Change your temporary password before continuing.", "password_change_required");
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || "");
      const admin = context.supabaseAdmin;
      let result: unknown;
      if (action === "whoami") {
        if (!administrator.permissions.length) throw httpError(403, "Your account doesn't include any administration areas.");
        result = { name: administrator.full_name || administrator.email, email: administrator.email, systemAdmin: administrator.role === "admin", permissions: administrator.permissions };
      } else if (accountActions[action]) {
        requirePermission(administrator, accountActions[action].perm);
        result = await accountActions[action].run(admin, administrator, body);
      } else {
        const needed = ACTION_PERMISSIONS[action];
        if (!needed) throw httpError(400, "Unknown administration action.");
        requirePermission(administrator, needed);
        switch (action) {
          case "dashboard": result = await dashboard(admin, administrator, body); break;
          case "invite": result = await invite(admin, administrator, body); break;
          case "revoke": result = await revoke(admin, administrator, body); break;
          case "module_catalog": result = await moduleCatalog(admin); break;
          case "module_save_draft": result = await saveModuleDraft(admin, administrator, body); break;
          case "module_prepare_uploads": result = await prepareModuleUploads(admin, body.versionId, body.assets); break;
          case "module_validate": result = await validateModuleAssets(admin, body.versionId); break;
          case "module_publish": result = await publishModule(admin, administrator, body.versionId); break;
          case "module_ims_revisions": result = await imsTrainingRevisions(admin); break;
          case "module_link_ims": result = await linkImsRevision(admin, administrator, body); break;
          default: result = await peopleActions[action](admin, administrator, body);
        }
      }
      return json(request, result);
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
