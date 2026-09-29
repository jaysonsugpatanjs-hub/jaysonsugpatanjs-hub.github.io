#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const argumentsList = process.argv.slice(2);
const dryRun = argumentsList.includes("--dry-run");
const sourceDirectory = path.resolve(argumentsList.find(value => !value.startsWith("--")) || "training/ppt/pp-trn-wld-001");
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const secretKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const releaseStatus = process.env.MODULE_RELEASE_STATUS === "active" ? "active" : "draft";

if (!dryRun && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) throw new Error("Set SUPABASE_URL to the project URL.");
if (!dryRun && !/^(sb_secret_|eyJ)/.test(secretKey)) throw new Error("Set SUPABASE_SECRET_KEY to a secret/service key. Never commit it.");

const manifest = JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"));
if (!manifest.code || !manifest.title || !manifest.revision || !manifest.contentVersion) throw new Error("Manifest module metadata is incomplete.");
if (!Array.isArray(manifest.slides) || manifest.slides.length < 2) throw new Error("Manifest must contain at least two slides.");
if (!Array.isArray(manifest.exam) || !manifest.exam.length) throw new Error("Manifest final assessment is missing.");

const finalIndex = manifest.slides.length - 1;
for (const [index, slide] of manifest.slides.entries()) {
  if (slide.id !== index + 1) throw new Error(`Slide ${index + 1} is missing or out of order.`);
  if (index < finalIndex && (!slide.check || !Array.isArray(slide.check.options) || !Number.isInteger(slide.check.answer))) {
    throw new Error(`Slide ${slide.id} requires a complete knowledge check.`);
  }
  if (index === finalIndex && slide.check !== "final") throw new Error("The final slide must use the final assessment.");
  const slidePath = path.join(sourceDirectory, `slide-${String(slide.id).padStart(2, "0")}.webp`);
  if (!(await stat(slidePath)).isFile()) throw new Error(`Rendered slide is missing: ${slidePath}`);
}
for (const [index, question] of manifest.exam.entries()) {
  if (!Array.isArray(question.options) || !Number.isInteger(question.answer)) throw new Error(`Final question ${index + 1} is incomplete.`);
}

const learnerManifest = {
  slides: manifest.slides.map(slide => ({
    id: slide.id,
    title: slide.title,
    bullets: slide.bullets || [],
    check: slide.check === "final" ? "final" : {
      question: slide.check.question,
      options: slide.check.options,
      critical: Boolean(slide.check.critical)
    }
  })),
  exam: manifest.exam.map(question => ({
    question: question.question,
    options: question.options,
    critical: Boolean(question.critical)
  }))
};

const answerKey = {
  checkpoints: Object.fromEntries(manifest.slides.slice(0, -1).map(slide => [String(slide.id), {
    answer: slide.check.answer,
    feedback: slide.check.feedback || "Your answer has been recorded.",
    critical: Boolean(slide.check.critical)
  }])),
  exam: manifest.exam.map(question => ({ answer: question.answer, critical: Boolean(question.critical) }))
};

if (JSON.stringify(learnerManifest).match(/"answer"\s*:/g)) throw new Error("Learner manifest unexpectedly contains an answer key.");
if (dryRun) {
  console.log(JSON.stringify({
    module: manifest.code,
    revision: manifest.revision,
    contentVersion: manifest.contentVersion,
    slidesValidated: manifest.slides.length,
    checkpointsSeparated: Object.keys(answerKey.checkpoints).length,
    assessmentQuestionsSeparated: answerKey.exam.length,
    learnerManifestContainsAnswers: false,
    dryRun: true
  }, null, 2));
  process.exit(0);
}

const headers = {
  apikey: secretKey,
  Authorization: `Bearer ${secretKey}`,
  "Content-Type": "application/json"
};

async function request(relativeUrl, options = {}) {
  const response = await fetch(`${supabaseUrl}${relativeUrl}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const slug = manifest.code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const modules = await request("/rest/v1/training_modules?on_conflict=code", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({
    code: manifest.code,
    slug,
    title: manifest.title,
    description: manifest.description || "MIG welding, grinding, permits, fire prevention, cylinders and quality controls.",
    status: releaseStatus,
    practical_required: true
  })
});
const moduleRecord = modules?.[0];
if (!moduleRecord?.id) throw new Error("Module record was not returned.");

const storagePrefix = `${slug}/${manifest.contentVersion}`;
const versions = await request("/rest/v1/training_module_versions?on_conflict=module_id,content_version", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({
    module_id: moduleRecord.id,
    revision: manifest.revision,
    content_version: manifest.contentVersion,
    slide_count: manifest.slides.length,
    pass_mark: Number(manifest.passMark || 80),
    storage_prefix: storagePrefix,
    learner_manifest: learnerManifest,
    answer_key: answerKey,
    published: false
  })
});
const versionRecord = versions?.[0];
if (!versionRecord?.id) throw new Error("Module version record was not returned.");

async function uploadFile(localPath, remotePath, contentType) {
  const bytes = await readFile(localPath);
  const response = await fetch(`${supabaseUrl}/storage/v1/object/training-content/${remotePath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
      "Cache-Control": "max-age=31536000, immutable"
    },
    body: bytes
  });
  if (!response.ok) throw new Error(`Storage upload failed for ${remotePath}: ${response.status} ${await response.text()}`);
}

const uploadJobs = manifest.slides.map(slide => ({
  local: path.join(sourceDirectory, `slide-${String(slide.id).padStart(2, "0")}.webp`),
  remote: `${storagePrefix}/slide-${String(slide.id).padStart(2, "0")}.webp`,
  type: "image/webp"
}));
uploadJobs.push({ local: path.join(sourceDirectory, "source.pptx"), remote: `${storagePrefix}/source.pptx`, type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
uploadJobs.push({ local: path.resolve("training/assets/panalo-logo-certificate.jpg"), remote: "_brand/panalo-logo-certificate.jpg", type: "image/jpeg" });

for (let index = 0; index < uploadJobs.length; index += 4) {
  await Promise.all(uploadJobs.slice(index, index + 4).map(job => uploadFile(job.local, job.remote, job.type)));
}

await request(`/rest/v1/training_module_versions?id=eq.${encodeURIComponent(versionRecord.id)}`, {
  method: "PATCH",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ published: true })
});
await request(`/rest/v1/training_modules?id=eq.${encodeURIComponent(moduleRecord.id)}`, {
  method: "PATCH",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ current_version_id: versionRecord.id, status: releaseStatus })
});

console.log(JSON.stringify({
  module: manifest.code,
  revision: manifest.revision,
  contentVersion: manifest.contentVersion,
  slidesUploaded: manifest.slides.length,
  assessmentQuestions: manifest.exam.length,
  status: releaseStatus,
  publishedToPrivateStorage: true
}, null, 2));
