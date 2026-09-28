# Controlled access migration for Panalo Pipes training

The current `username.github.io` Pages site is a public pilot. GitHub Pages serves these files directly, including the PowerPoint, slide images, manifest with answers, and browser code. The local browser result and PDF certificate are provisional. A login screen added to this page alone cannot restrict access or verify a result.

## Target deployment

Use an identity provider and a private content/record service. A Supabase project is one workable choice; use a company-approved equivalent if Panalo Pipes already has one. The public site may keep a landing and sign-in shell, but it must contain no protected slides, answer key, employee records, or privileged API keys.

1. Provision the Panalo Pipes project and designate administrators. Configure email/password sign-in, verified email, password recovery, and administrator-created accounts or invitations. Disable open self-registration. Supply the web application only the project URL and publishable key. Keep service-role credentials solely on the server.
2. Create an `allowed_learners` table keyed to the authenticated user ID, with an active/revoked flag and assigned module IDs. Enforce row-level security on all learner records and private storage; a signed-in account alone must not grant access until an administrator assigns it.
3. Move the source PowerPoint and rendered slide images to a private bucket. Serve a learner only the assigned slide and a versioned, answer-free lesson payload after checking the account and assignment. Keep the answer key in server-only storage. Check slide answers and grade final assessments in a server function. Do not accept a client-supplied pass flag, score, or assessment date.
4. Record each attempt on the server with user ID, module revision, answers, computed score, critical-question outcome, and server timestamp. Give learners read access to their own result and administrators controlled reporting access. Record practical verification and final task authorisation separately under the approved IMS process.
5. Generate the certificate from the stored, passing attempt on the server or verify a server-signed result before creating it. Print the verified learner identity, score, attempt and date taken with the Panalo Pipes logo. Mark theory completion and practical-pending status explicitly. Include a record ID or verification endpoint if certificates will be used as official evidence.
6. Remove `training/ppt/` and the answer-bearing manifest from the public Pages deployment. A public git commit deleting them does not erase earlier public commits; move the controlled source to a new private repository or private store and retire the old public repository/history as appropriate. Disable the public module route until the restricted version is verified. Rotate any credentials if any were ever placed in the public repository.
7. Test direct file URLs without a session, with an unassigned account, after revocation, and with a forged score or timestamp. Check that all are denied. Test an assigned learner's slide flow, exam retake, certificate, and administrator audit record before inviting learners.

## Inputs needed to activate

- The company-approved identity/content service and its project URL plus **publishable** browser key; never put a service-role key or a user's password in this repository.
- The administrator who will invite or create learner accounts and assign modules.
- The approved certificate wording, signatory or record-verification policy, and where authoritative results must be retained.

The provisional PDF feature can be used for pilot review, but it must not be treated as a controlled certificate until the server-side identity, grading, and record steps above are live.
