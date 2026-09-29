import { withSupabase } from "npm:@supabase/server@^1";
import { corsHeaders, errorJson, httpError, json } from "../_shared/http.ts";
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

async function requireAdmin(admin: Client, userId: string) {
  const { data, error } = await admin
    .from("training_profiles")
    .select("id,email,full_name,role,active")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw httpError(500, "Administrator profile lookup failed.");
  if (!data?.active || data.role !== "admin") throw httpError(403, "Training administrator access is required.");
  return data;
}

async function audit(admin: Client, values: Record<string, unknown>) {
  const { error } = await admin.from("training_audit_events").insert(values);
  if (error) console.error("Audit insert failed", error.message);
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
      .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,published,created_at")
      .order("created_at", { ascending: false })
  ]);
  if (modulesResult.error || versionsResult.error) throw httpError(500, "The module register could not be loaded.");
  const moduleMap = new Map((modulesResult.data || []).map((module: any) => [module.id, module]));
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
    assets: await inspectVersionAssets(admin, version)
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
  const moduleResult = await admin.from("training_modules").select("id,code,title,status,current_version_id").eq("id", versionResult.data.module_id).maybeSingle();
  if (moduleResult.error || !moduleResult.data) throw httpError(404, "The parent module was not found.");
  const assets = await inspectVersionAssets(admin, versionResult.data);
  if (!assets.ready) throw httpError(409, `The draft cannot be published. Missing: ${assets.missing.join(", ")}.`);

  if (!versionResult.data.published) {
    const versionUpdate = await admin.from("training_module_versions").update({ published: true }).eq("id", id);
    if (versionUpdate.error) throw httpError(500, "The module version could not be published.");
  }
  const moduleUpdate = await admin.from("training_modules").update({ current_version_id: id, status: "active" }).eq("id", moduleResult.data.id);
  if (moduleUpdate.error) throw httpError(500, "The module release could not be activated.");
  await audit(admin, {
    actor_user_id: administrator.id,
    event_type: "module_published",
    details: { moduleId: moduleResult.data.id, versionId: id, code: moduleResult.data.code, revision: versionResult.data.revision }
  });
  return {
    published: true,
    module: { code: moduleResult.data.code, title: moduleResult.data.title, status: "active", currentVersionId: id },
    version: { id, revision: versionResult.data.revision, contentVersion: versionResult.data.content_version },
    assets
  };
}

async function dashboard(admin: Client, administrator: any) {
  const [profilesResult, modulesResult, assignmentsResult, attemptsResult] = await Promise.all([
    admin.from("training_profiles").select("id,email,full_name,external_id,learner_type,role,active,created_at").order("created_at", { ascending: false }).limit(500),
    admin.from("training_modules").select("id,code,slug,title,status,practical_required,current_version_id").neq("status", "retired").order("code"),
    admin.from("training_assignments").select("id,learner_id,module_version_id,status,assigned_at,expires_at,theory_passed_at,revoked_at,revoke_reason").order("assigned_at", { ascending: false }).limit(1000),
    admin.from("training_assessment_attempts").select("id,assignment_id,attempt_number,score,critical_passed,passed,submitted_at").order("submitted_at", { ascending: false }).limit(1000)
  ]);
  if (profilesResult.error || modulesResult.error || assignmentsResult.error || attemptsResult.error) {
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

  const profileMap = new Map((profilesResult.data || []).map((profile: any) => [profile.id, profile]));
  const versionMap = new Map((versionsResult.data || []).map((version: any) => [version.id, version]));
  const moduleMap = new Map((modulesResult.data || []).map((module: any) => [module.id, module]));
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
      activeLearners: (profilesResult.data || []).filter((profile: any) => profile.active && profile.role === "learner").length,
      openAssignments: assignments.filter((assignment: any) => ["assigned", "theory_passed"].includes(assignment.status) && new Date(assignment.expiresAt).getTime() > Date.now()).length,
      theoryPassed: assignments.filter((assignment: any) => assignment.status === "theory_passed").length
    }
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

  let profileResult = await admin.from("training_profiles").select("id,email,active").eq("email", email).maybeSingle();
  if (profileResult.error) throw httpError(500, "Learner lookup failed.");
  let userId = profileResult.data?.id;
  let invitationSent = false;

  if (!userId) {
    const redirectTo = Deno.env.get("TRAINING_APP_URL") || "https://jaysonsugpatanjs-hub.github.io/training/";
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

  const profileUpsert = await admin.from("training_profiles").upsert({
    id: userId,
    email,
    full_name: fullName,
    external_id: externalId,
    learner_type: learnerType,
    active: true
  }, { onConflict: "id" }).select("id,email,full_name,external_id,learner_type,active").single();
  if (profileUpsert.error) throw httpError(500, "The learner profile could not be prepared.");

  const existing = await admin.from("training_assignments")
    .select("id,status")
    .eq("learner_id", userId)
    .eq("module_version_id", versionResult.data.id)
    .in("status", ["assigned", "theory_passed"])
    .maybeSingle();
  if (existing.error) throw httpError(500, "Existing assignment lookup failed.");
  let assignment;
  if (existing.data) {
    const update = await admin.from("training_assignments").update({
      expires_at: expiresAt.toISOString(),
      assigned_by: administrator.id
    }).eq("id", existing.data.id).select("id,status,assigned_at,expires_at,theory_passed_at").single();
    if (update.error) throw httpError(500, "The existing assignment could not be updated.");
    assignment = update.data;
  } else {
    const insert = await admin.from("training_assignments").insert({
      learner_id: userId,
      module_version_id: versionResult.data.id,
      assigned_by: administrator.id,
      expires_at: expiresAt.toISOString()
    }).select("id,status,assigned_at,expires_at,theory_passed_at").single();
    if (insert.error) throw httpError(500, "The module assignment could not be created.");
    assignment = insert.data;
  }

  await audit(admin, {
    actor_user_id: administrator.id,
    subject_user_id: userId,
    assignment_id: assignment.id,
    event_type: invitationSent ? "learner_invited_and_assigned" : "learner_assigned",
    details: { moduleCode, expiresAt: expiresAt.toISOString(), learnerType }
  });
  return {
    invitationSent,
    learner: profileUpsert.data,
    assignment: { ...assignment, moduleCode, moduleRevision: versionResult.data.revision }
  };
}

async function revoke(admin: Client, administrator: any, body: any) {
  const assignmentId = String(body.assignmentId || "");
  const reason = cleanText(body.reason, "Revocation reason", 240, false) || "Access ended by training administrator";
  const existing = await admin.from("training_assignments").select("id,learner_id,status").eq("id", assignmentId).maybeSingle();
  if (existing.error || !existing.data) throw httpError(404, "Assignment not found.");
  if (existing.data.status === "revoked") return { revoked: true };
  const now = new Date().toISOString();
  const result = await admin.from("training_assignments").update({
    status: "revoked",
    revoked_at: now,
    revoke_reason: reason
  }).eq("id", assignmentId);
  if (result.error) throw httpError(500, "Assignment access could not be revoked.");
  await audit(admin, {
    actor_user_id: administrator.id,
    subject_user_id: existing.data.learner_id,
    assignment_id: assignmentId,
    event_type: "assignment_revoked",
    details: { reason }
  });
  return { revoked: true, revokedAt: now };
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request: Request, context: any) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
    if (!cors.allowed) return json(request, { message: "This website is not permitted to call training administration." }, 403);
    if (request.method !== "POST") return json(request, { message: "Method not allowed." }, 405);
    try {
      const userId = String(context.userClaims?.id || context.userClaims?.sub || "");
      if (!userId) throw httpError(401, "A verified administrator session is required.");
      const administrator = await requireAdmin(context.supabaseAdmin, userId);
      const body = await request.json().catch(() => ({}));
      let result: unknown;
      switch (body.action) {
        case "dashboard": result = await dashboard(context.supabaseAdmin, administrator); break;
        case "invite": result = await invite(context.supabaseAdmin, administrator, body); break;
        case "revoke": result = await revoke(context.supabaseAdmin, administrator, body); break;
        case "module_catalog": result = await moduleCatalog(context.supabaseAdmin); break;
        case "module_save_draft": result = await saveModuleDraft(context.supabaseAdmin, administrator, body); break;
        case "module_prepare_uploads": result = await prepareModuleUploads(context.supabaseAdmin, body.versionId, body.assets); break;
        case "module_validate": result = await validateModuleAssets(context.supabaseAdmin, body.versionId); break;
        case "module_publish": result = await publishModule(context.supabaseAdmin, administrator, body.versionId); break;
        default: throw httpError(400, "Unknown administration action.");
      }
      return json(request, result);
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
