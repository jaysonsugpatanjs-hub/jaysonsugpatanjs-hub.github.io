import { withSupabase } from "npm:@supabase/server@^1";
import { createCertificatePdf } from "../_shared/certificate.ts";
import { allLearningSlidesComplete, gradeAssessment, isSlideUnlocked } from "../_shared/grading.ts";
import { corsHeaders, errorJson, httpError, json } from "../_shared/http.ts";

type Client = any;

function assertData<T>(data: T | null, error: any, message = "Secure record lookup failed."): T {
  if (error) throw httpError(500, message);
  if (!data) throw httpError(404, "The requested training record was not found.");
  return data;
}

async function getProfile(admin: Client, userId: string) {
  const { data, error } = await admin
    .from("training_profiles")
    .select("id,email,full_name,external_id,learner_type,role,active")
    .eq("id", userId)
    .maybeSingle();
  const profile = assertData(data, error, "Learner profile lookup failed.");
  if (!profile.active) throw httpError(403, "This training account has been deactivated.", "account_inactive");
  return profile;
}

async function getAssignmentContext(admin: Client, userId: string, assignmentId: string) {
  if (!assignmentId) throw httpError(400, "An assignment ID is required.");
  const { data, error } = await admin
    .from("training_assignments")
    .select("id,learner_id,module_version_id,status,assigned_at,expires_at,theory_passed_at,revoked_at")
    .eq("id", assignmentId)
    .maybeSingle();
  const assignment = assertData(data, error, "Assignment lookup failed.");
  if (assignment.learner_id !== userId) throw httpError(403, "This module is not assigned to the signed-in email.");
  if (assignment.status === "revoked" || assignment.revoked_at) throw httpError(403, "This assignment has been revoked.", "assignment_revoked");
  if (new Date(assignment.expires_at).getTime() <= Date.now()) throw httpError(403, "This assignment has expired. Contact the training administrator.", "assignment_expired");

  const profile = await getProfile(admin, userId);
  const versionResult = await admin
    .from("training_module_versions")
    .select("id,module_id,revision,content_version,slide_count,pass_mark,storage_prefix,learner_manifest,answer_key,published")
    .eq("id", assignment.module_version_id)
    .maybeSingle();
  const version = assertData(versionResult.data, versionResult.error, "Module version lookup failed.");
  if (!version.published) throw httpError(403, "This module version is not available for learning.");

  const moduleResult = await admin
    .from("training_modules")
    .select("id,code,slug,title,description,status,practical_required")
    .eq("id", version.module_id)
    .maybeSingle();
  const module = assertData(moduleResult.data, moduleResult.error, "Module lookup failed.");
  if (module.status === "retired") throw httpError(403, "This module has been retired.");
  return { assignment, profile, version, module };
}

async function completedSlideSet(admin: Client, assignmentId: string) {
  const { data, error } = await admin
    .from("training_slide_attempts")
    .select("slide_number")
    .eq("assignment_id", assignmentId)
    .eq("correct", true);
  if (error) throw httpError(500, "Recorded progress could not be loaded.");
  return new Set<number>((data || []).map((row: any) => Number(row.slide_number)));
}

async function latestAttempt(admin: Client, assignmentId: string) {
  const { data, error } = await admin
    .from("training_assessment_attempts")
    .select("id,attempt_number,correct_count,total_questions,score,critical_passed,passed,missed_question_numbers,submitted_at")
    .eq("assignment_id", assignmentId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw httpError(500, "Assessment record could not be loaded.");
  if (!data) return null;
  const certificateResult = data.passed
    ? await admin.from("training_certificates").select("certificate_number,status").eq("attempt_id", data.id).maybeSingle()
    : { data: null, error: null };
  if (certificateResult.error) throw httpError(500, "Certificate record could not be loaded.");
  return normaliseAttempt(data, certificateResult.data?.status === "issued" ? certificateResult.data.certificate_number : null);
}

function normaliseAttempt(attempt: any, certificateNumber: string | null = null) {
  return {
    id: attempt.id,
    attemptNumber: attempt.attempt_number,
    correct: attempt.correct_count,
    total: attempt.total_questions,
    score: attempt.score,
    criticalPassed: attempt.critical_passed,
    pass: attempt.passed,
    missedQuestionNumbers: attempt.missed_question_numbers || [],
    submittedAt: attempt.submitted_at,
    certificateNumber
  };
}

async function audit(admin: Client, values: Record<string, unknown>) {
  const { error } = await admin.from("training_audit_events").insert(values);
  if (error) console.error("Audit insert failed", error.message);
}

async function downloadBytes(admin: Client, bucket: string, path: string) {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function issueCertificate(admin: Client, context: any, attempt: any) {
  const existing = await admin
    .from("training_certificates")
    .select("id,certificate_number,storage_path,status")
    .eq("attempt_id", attempt.id)
    .maybeSingle();
  if (existing.error) throw httpError(500, "Certificate record lookup failed.");
  if (existing.data?.status === "issued") return existing.data;

  const year = new Intl.DateTimeFormat("en-AU", { year: "numeric", timeZone: "Australia/Sydney" }).format(new Date(attempt.submitted_at));
  const uniquePart = String(attempt.id).replace(/-/g, "").slice(0, 16).toUpperCase();
  const certificateNumber = `PP-${year}-${context.module.code.replace(/[^A-Z0-9]/gi, "")}-${uniquePart}`;
  const storagePath = `${context.profile.id}/${context.module.code}/${certificateNumber}.pdf`;
  const logoJpeg = await downloadBytes(admin, "training-content", "_brand/panalo-logo-certificate.jpg");
  const examKey = Array.isArray(context.version.answer_key?.exam) ? context.version.answer_key.exam : [];
  const criticalTotal = examKey.filter((question: any) => question.critical).length;
  const pdf = await createCertificatePdf({
    learnerName: context.profile.full_name,
    externalId: context.profile.external_id,
    moduleCode: context.module.code,
    moduleTitle: context.module.title,
    revision: context.version.revision,
    score: attempt.score,
    correct: attempt.correct_count,
    total: attempt.total_questions,
    criticalCorrect: criticalTotal,
    criticalTotal,
    attemptNumber: attempt.attempt_number,
    submittedAt: attempt.submitted_at,
    certificateNumber,
    practicalRequired: Boolean(context.module.practical_required),
    logoJpeg
  });

  const upload = await admin.storage.from("training-certificates").upload(storagePath, pdf, {
    contentType: "application/pdf",
    cacheControl: "0",
    upsert: false
  });
  if (upload.error && !String(upload.error.message || "").toLowerCase().includes("already exists")) {
    throw httpError(500, "Certificate PDF could not be stored.");
  }

  const insert = await admin.from("training_certificates").insert({
    attempt_id: attempt.id,
    certificate_number: certificateNumber,
    storage_path: storagePath
  }).select("id,certificate_number,storage_path,status").single();
  if (insert.error) {
    const retry = await admin.from("training_certificates").select("id,certificate_number,storage_path,status").eq("attempt_id", attempt.id).maybeSingle();
    if (retry.error || !retry.data) throw httpError(500, "Certificate record could not be created.");
    return retry.data;
  }
  return insert.data;
}

async function handleBootstrap(admin: Client, userId: string) {
  const profile = await getProfile(admin, userId);
  const now = new Date().toISOString();
  const assignmentResult = await admin
    .from("training_assignments")
    .select("id,module_version_id,status,assigned_at,expires_at,theory_passed_at")
    .eq("learner_id", userId)
    .in("status", ["assigned", "theory_passed"])
    .gt("expires_at", now)
    .order("assigned_at", { ascending: false });
  if (assignmentResult.error) throw httpError(500, "Assignments could not be loaded.");

  const assignments = [];
  for (const assignment of assignmentResult.data || []) {
    const versionResult = await admin
      .from("training_module_versions")
      .select("id,module_id,revision,slide_count,published")
      .eq("id", assignment.module_version_id)
      .maybeSingle();
    if (versionResult.error || !versionResult.data?.published) continue;
    const moduleResult = await admin
      .from("training_modules")
      .select("code,slug,title,description,status,practical_required")
      .eq("id", versionResult.data.module_id)
      .maybeSingle();
    if (moduleResult.error || !moduleResult.data || moduleResult.data.status === "retired") continue;
    const completed = await completedSlideSet(admin, assignment.id);
    const result = await latestAttempt(admin, assignment.id);
    const completeUnits = completed.size + (result?.pass ? 1 : 0);
    assignments.push({
      id: assignment.id,
      status: assignment.status,
      assignedAt: assignment.assigned_at,
      expiresAt: assignment.expires_at,
      theoryPassedAt: assignment.theory_passed_at,
      progressPercent: Math.round(completeUnits / versionResult.data.slide_count * 100),
      module: {
        ...moduleResult.data,
        revision: versionResult.data.revision,
        practicalRequired: moduleResult.data.practical_required
      }
    });
  }

  return {
    learner: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      externalId: profile.external_id,
      learnerType: profile.learner_type,
      role: profile.role
    },
    assignments
  };
}

async function handleModule(admin: Client, userId: string, body: any) {
  const context = await getAssignmentContext(admin, userId, String(body.assignmentId || ""));
  const completed = await completedSlideSet(admin, context.assignment.id);
  return {
    learner: {
      email: context.profile.email,
      fullName: context.profile.full_name,
      externalId: context.profile.external_id
    },
    assignment: {
      id: context.assignment.id,
      assignedAt: context.assignment.assigned_at,
      expiresAt: context.assignment.expires_at,
      status: context.assignment.status
    },
    module: {
      code: context.module.code,
      slug: context.module.slug,
      title: context.module.title,
      description: context.module.description,
      status: context.module.status,
      practicalRequired: context.module.practical_required,
      revision: context.version.revision,
      contentVersion: context.version.content_version,
      passMark: context.version.pass_mark,
      ...context.version.learner_manifest
    },
    completedSlides: [...completed].sort((a, b) => a - b),
    latestResult: await latestAttempt(admin, context.assignment.id)
  };
}

async function handleSlide(admin: Client, userId: string, body: any) {
  const context = await getAssignmentContext(admin, userId, String(body.assignmentId || ""));
  const slideNumber = Number(body.slideNumber);
  if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > context.version.slide_count) {
    throw httpError(400, "That slide number is invalid.");
  }
  const completed = await completedSlideSet(admin, context.assignment.id);
  if (!isSlideUnlocked(slideNumber, context.version.slide_count, completed)) {
    throw httpError(403, "Complete the previous slide check before opening this slide.");
  }
  const filename = `slide-${String(slideNumber).padStart(2, "0")}.webp`;
  const path = `${context.version.storage_prefix}/${filename}`;
  const signed = await admin.storage.from("training-content").createSignedUrl(path, 120);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "The selected PowerPoint slide could not be loaded.");
  return { url: signed.data.signedUrl, expiresIn: 120, slideNumber };
}

async function handleCheck(admin: Client, userId: string, body: any) {
  const context = await getAssignmentContext(admin, userId, String(body.assignmentId || ""));
  const slideNumber = Number(body.slideNumber);
  const selectedAnswer = Number(body.selectedAnswer);
  if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber >= context.version.slide_count || !Number.isInteger(selectedAnswer) || selectedAnswer < 0) {
    throw httpError(400, "The checkpoint answer is invalid.");
  }
  const completed = await completedSlideSet(admin, context.assignment.id);
  if (!isSlideUnlocked(slideNumber, context.version.slide_count, completed)) {
    throw httpError(403, "Complete the previous slide check first.");
  }
  const key = context.version.answer_key?.checkpoints?.[String(slideNumber)];
  if (!key || !Number.isInteger(Number(key.answer))) throw httpError(500, "The checkpoint key is unavailable.");
  const correct = selectedAnswer === Number(key.answer);
  const insert = await admin.from("training_slide_attempts").insert({
    assignment_id: context.assignment.id,
    slide_number: slideNumber,
    selected_answer: selectedAnswer,
    correct
  });
  if (insert.error) throw httpError(500, "The checkpoint attempt could not be recorded.");
  await audit(admin, {
    actor_user_id: userId,
    subject_user_id: userId,
    assignment_id: context.assignment.id,
    event_type: correct ? "slide_check_passed" : "slide_check_failed",
    details: { slideNumber }
  });
  return { correct, feedback: correct ? String(key.feedback || "Your answer has been recorded.") : undefined };
}

async function handleSubmitExam(admin: Client, userId: string, body: any) {
  const context = await getAssignmentContext(admin, userId, String(body.assignmentId || ""));
  const completed = await completedSlideSet(admin, context.assignment.id);
  if (!allLearningSlidesComplete(context.version.slide_count, completed)) throw httpError(403, "Complete every slide check before submitting the final assessment.");
  const answers = body.answers;
  const key = Array.isArray(context.version.answer_key?.exam) ? context.version.answer_key.exam : [];
  if (!Array.isArray(answers) || answers.length !== key.length || !answers.every((value: unknown) => Number.isInteger(value) && Number(value) >= 0)) {
    throw httpError(400, "Answer every final assessment question before submitting.");
  }
  const grade = gradeAssessment(answers, key, context.version.pass_mark);
  const { correctCount, score, criticalPassed, passed, missedQuestionNumbers } = grade;
  const latest = await admin
    .from("training_assessment_attempts")
    .select("attempt_number")
    .eq("assignment_id", context.assignment.id)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw httpError(500, "The assessment attempt number could not be created.");
  const attemptNumber = Number(latest.data?.attempt_number || 0) + 1;
  const insert = await admin.from("training_assessment_attempts").insert({
    assignment_id: context.assignment.id,
    attempt_number: attemptNumber,
    answers,
    correct_count: correctCount,
    total_questions: key.length,
    score,
    critical_passed: criticalPassed,
    passed,
    missed_question_numbers: missedQuestionNumbers,
    module_revision: context.version.revision
  }).select("id,attempt_number,correct_count,total_questions,score,critical_passed,passed,missed_question_numbers,submitted_at").single();
  if (insert.error) throw httpError(409, "This attempt could not be recorded. Please wait and submit again.");
  const attempt = insert.data;

  if (passed) {
    const assignmentUpdate = await admin.from("training_assignments").update({
      status: "theory_passed",
      theory_passed_at: attempt.submitted_at
    }).eq("id", context.assignment.id).neq("status", "revoked");
    if (assignmentUpdate.error) throw httpError(500, "The passing result could not be linked to the assignment.");
  }

  let certificateNumber: string | null = null;
  if (passed) {
    try {
      certificateNumber = (await issueCertificate(admin, context, attempt)).certificate_number;
    } catch (error) {
      console.error("Certificate generation deferred", error);
    }
  }
  await audit(admin, {
    actor_user_id: userId,
    subject_user_id: userId,
    assignment_id: context.assignment.id,
    event_type: passed ? "theory_assessment_passed" : "theory_assessment_failed",
    details: { attemptNumber, score, criticalPassed }
  });
  return normaliseAttempt(attempt, certificateNumber);
}

async function handleCertificate(admin: Client, userId: string, body: any) {
  const context = await getAssignmentContext(admin, userId, String(body.assignmentId || ""));
  const { data, error } = await admin
    .from("training_assessment_attempts")
    .select("id,assignment_id,attempt_number,correct_count,total_questions,score,critical_passed,passed,submitted_at")
    .eq("id", String(body.attemptId || ""))
    .eq("assignment_id", context.assignment.id)
    .maybeSingle();
  const attempt = assertData(data, error, "Assessment result lookup failed.");
  if (!attempt.passed) throw httpError(403, "A certificate is available only for a passing theory attempt.");
  const certificate = await issueCertificate(admin, context, attempt);
  if (certificate.status !== "issued") throw httpError(403, "This certificate has been voided.");
  const signed = await admin.storage.from("training-certificates").createSignedUrl(certificate.storage_path, 300);
  if (signed.error || !signed.data?.signedUrl) throw httpError(500, "The certificate could not be opened.");
  await audit(admin, {
    actor_user_id: userId,
    subject_user_id: userId,
    assignment_id: context.assignment.id,
    event_type: "certificate_opened",
    details: { certificateNumber: certificate.certificate_number }
  });
  return { url: signed.data.signedUrl, expiresIn: 300, certificateNumber: certificate.certificate_number };
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request: Request, context: any) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
    if (!cors.allowed) return json(request, { message: "This website is not permitted to call the training service." }, 403);
    if (request.method !== "POST") return json(request, { message: "Method not allowed." }, 405);

    try {
      const userId = String(context.userClaims?.id || context.userClaims?.sub || "");
      if (!userId) throw httpError(401, "A verified email session is required.");
      const body = await request.json().catch(() => ({}));
      let result: unknown;
      switch (body.action) {
        case "bootstrap": result = await handleBootstrap(context.supabaseAdmin, userId); break;
        case "module": result = await handleModule(context.supabaseAdmin, userId, body); break;
        case "slide": result = await handleSlide(context.supabaseAdmin, userId, body); break;
        case "check": result = await handleCheck(context.supabaseAdmin, userId, body); break;
        case "submit_exam": result = await handleSubmitExam(context.supabaseAdmin, userId, body); break;
        case "certificate": result = await handleCertificate(context.supabaseAdmin, userId, body); break;
        default: throw httpError(400, "Unknown training action.");
      }
      return json(request, result);
    } catch (error) {
      return errorJson(request, error);
    }
  })
};
