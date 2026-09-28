# Controlled access migration for Panalo Pipes training

The current `username.github.io` Pages site is a public pilot. GitHub Pages serves these files directly, including the PowerPoint, slide images, manifest with answers, and browser code. The local browser result and PDF certificate are provisional. A login screen added to this page alone cannot restrict access or verify a result.

## Target deployment

Use an identity provider and a private content/record service. A Supabase project is one workable choice; use a company-approved equivalent if Panalo Pipes already has one. The public site may keep a landing and sign-in shell, but it must contain no protected slides, answer key, employee records, or privileged API keys.

The intended company entry point is [panalopipesandstructurals.com.au](https://panalopipesandstructurals.com.au/), a public RealBoss-powered marketing website. Subject to control of the company's DNS, use a separate address such as `training.panalopipesandstructurals.com.au` for the learner portal, and add a Training link on the marketing site only after the protected portal is working. Confirm with the RealBoss administrator whether its existing workspace login can authenticate external learners through a documented integration; do not assume that a staff console login or a website page protects training files. If that integration is unavailable, use a separate approved identity service for the training address.

1. Provision the Panalo Pipes project and designate administrators. Configure email/password sign-in, verified email, password recovery, and administrator-created accounts or invitations. Disable open self-registration. Supply the web application only the project URL and publishable key. Keep service-role credentials solely on the server.
2. Create an `allowed_learners` table keyed to the authenticated user ID, with an active/revoked flag and assigned module IDs. Enforce row-level security on all learner records and private storage; a signed-in account alone must not grant access until an administrator assigns it.
3. Move the source PowerPoint and rendered slide images to a private bucket. Serve a learner only the assigned slide and a versioned, answer-free lesson payload after checking the account and assignment. Keep the answer key in server-only storage. Check slide answers and grade final assessments in a server function. Do not accept a client-supplied pass flag, score, or assessment date.
4. Record each attempt on the server with user ID, module revision, answers, computed score, critical-question outcome, and server timestamp. Give learners read access to their own result and administrators controlled reporting access. Record practical verification and final task authorisation separately under the approved IMS process.
5. Generate the certificate from the stored, passing attempt on the server or verify a server-signed result before creating it. Print the verified learner identity, score, attempt and date taken with the Panalo Pipes logo. Mark theory completion and practical-pending status explicitly. Include a record ID or verification endpoint if certificates will be used as official evidence.
6. Remove `training/ppt/` and the answer-bearing manifest from the public Pages deployment. A public git commit deleting them does not erase earlier public commits; move the controlled source to a new private repository or private store and retire the old public repository/history as appropriate. Disable the public module route until the restricted version is verified. Rotate any credentials if any were ever placed in the public repository.
7. Test direct file URLs without a session, with an unassigned account, after revocation, and with a forged score or timestamp. Check that all are denied. Test an assigned learner's slide flow, exam retake, certificate, and administrator audit record before inviting learners.

## Inputs needed to activate

- The company-approved identity/content service and its project URL plus **publishable** browser key; never put a service-role key or a user's password in this repository.
- Administrative access to the Panalo Pipes DNS and the RealBoss website (or the contact who manages those), to point the training address and add its link after verification.
- The administrator who will invite or create learner accounts and assign modules.
- The approved certificate wording, signatory or record-verification policy, and where authoritative results must be retained.

The provisional PDF feature can be used for pilot review, but it must not be treated as a controlled certificate until the server-side identity, grading, and record steps above are live.

## Alternative using the existing Google account

The existing **Panalo Pipes & Structurals Pty Ltd – Company Drive** folder is under **My Drive**; it is not an organisation-owned Google Workspace Shared Drive. It can support a small restricted pilot if the account owner manages each person's access. For controlled company records, an organisation-owned Shared Drive offers better continuity and role administration when the Workspace edition supports it.

One low-development route is a **restricted Google Site** for the lessons and a **Google Forms quiz** shared only with named responders or an approved group. Store the PowerPoint and rendered images in restricted Drive folders, collect the signed-in learner's email, and record results in an administrator-controlled response Sheet. An Apps Script form-submit process can check both the 80% threshold and every critical question, then generate and store a Panalo-branded PDF with the score and submission date. The public Panalo website can link to the restricted Site. Keep practical sign-off as a separate controlled record.

This route changes the current web experience: Google Sites and Forms do not by themselves preserve automatic progression from one PowerPoint slide to the matching knowledge check. To keep that exact interface, build a custom Google-backed application with restricted content access and server-side checking, or use the identity/private-service design above. Either route requires removing the current public slide files and answer-bearing manifest from GitHub Pages before announcing that access is controlled. Verify Google account ownership, responder restrictions, email collection, Apps Script execution identity, and record retention before rollout.
