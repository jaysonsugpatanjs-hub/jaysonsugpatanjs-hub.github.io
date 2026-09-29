import { withSupabase } from "npm:@supabase/server@^1";
import { corsHeaders, errorJson, httpError, json } from "../_shared/http.ts";

type Client = any;

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
        default: throw httpError(400, "Unknown administration action.");
      }
      return json(request, result);
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
