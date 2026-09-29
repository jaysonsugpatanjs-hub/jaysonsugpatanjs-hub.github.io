# Secure training setup

This runbook activates the personal-email invitation system for the Panalo Pipes training portal.

## 1. Create the dedicated backend

Create a dedicated Supabase project in the Sydney region. Do not reuse a client or unrelated production project.

From a trusted workstation with the Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set \
  ALLOWED_ORIGINS="https://jaysonsugpatanjs-hub.github.io,https://training.panalopipesandstructurals.com.au" \
  TRAINING_APP_URL="https://jaysonsugpatanjs-hub.github.io/training/"
supabase functions deploy training-api
supabase functions deploy admin-api
```

The database migration creates private training tables, audit records and two private Storage buckets. The Edge Functions contain the assignment checks, marking and certificate issue logic.

## 2. Configure email authentication

In Supabase Authentication:

- Set the Site URL to `https://jaysonsugpatanjs-hub.github.io/training/` until the company training subdomain is active.
- Add both that URL and `https://training.panalopipesandstructurals.com.au/` to the redirect allow-list.
- Keep email magic links enabled.
- Disable open user registration. Learners must be invited by an administrator.
- For production use, configure company-approved SMTP so invitations are branded and delivery is auditable. The default mail service is suitable only for a small pilot.
- Review link expiry and email rate limits before a larger intake.

## 3. Create the first administrator

Use Authentication > Users in the Supabase dashboard to invite the first Panalo Pipes administrator. After the user exists, run this once in the SQL editor, replacing the placeholder with the exact administrator email:

```sql
update public.training_profiles
set role = 'admin', active = true
where email = lower('ADMIN_EMAIL_HERE');
```

The administrator can then sign in through the training page and open `/training/admin/` to invite learners, set expiries, assign modules, revoke access and manage private module releases.

## 4. Upload the private module

### Administrator workflow

For normal module additions, open **Training Administration > Module management**:

1. Download the authoring JSON template.
2. Enter the module code, title, revision, content version and pass mark.
3. Complete the authoring JSON with slide key points, one knowledge check for every learning slide and the final assessment. Correct answers use zero-based indices (`0` is the first option).
4. Export every PowerPoint slide as PNG, JPEG or WebP and keep the filenames in slide order.
5. Select the authoring JSON, the source PPTX and all rendered slide images.
6. Create the draft. Files upload directly to private Supabase Storage; none are committed to GitHub.
7. Review the module register. Publish only when the asset count is complete and technical/IMS approval has been obtained.

The first PowerPoint slide becomes the module front page. A published version becomes available in the learner-assignment form without adding a new GitHub folder.

### Trusted workstation fallback

Apply the database migration before running this step. Keep the secret key only in the command environment and terminal history controls appropriate to the workstation.

```bash
export SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
export SUPABASE_SECRET_KEY="YOUR_SECRET_KEY"
node training/scripts/provision-supabase-module.mjs training/ppt/pp-trn-wld-001
unset SUPABASE_SECRET_KEY
```

The script validates the 20-slide package, removes all answer indices from the learner manifest, stores the answer key in the server-only database and uploads the PowerPoint, one-slide WebP files and logo to private Storage. It publishes the module as `draft` by default. Set `MODULE_RELEASE_STATUS=active` only after technical, WHS and IMS approval.

## 5. Connect the public shell

Copy only the Project URL and publishable browser key into `training/config.js`:

```js
window.PANALO_TRAINING_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  publishableKey: "sb_publishable_...",
  appUrl: "https://jaysonsugpatanjs-hub.github.io/training/",
  trainingFunction: "training-api",
  adminFunction: "admin-api"
});
```

Never use a secret/service key in this file.

## 6. Remove public content before release

After the private upload is confirmed:

1. Remove `training/ppt/`, the legacy answer-bearing manifest, old public training visuals and the client-side certificate generator from the Pages deployment.
2. Disable the old slide-render workflow that commits images to the public repository.
3. Run `node training/scripts/check-public-training.mjs` and require it to pass before pushing.
4. Rotate the production question bank because the pilot answers were previously public.
5. Push the protected shell and verify the live direct URLs return 404 or access denied.

## 7. Acceptance test

Use one administrator test address and one learner test address:

1. Invite and assign the learner for 14 days.
2. Open the email link and confirm only the assigned module appears.
3. Confirm the module front page displays PowerPoint slide 1 from a signed URL.
4. Confirm each slide unlocks only after its corresponding check is passed.
5. Submit one failing and one passing final attempt.
6. Confirm the server record shows score, critical result, attempt number and Sydney timestamp.
7. Open the PDF certificate and check the Panalo logo, learner name, score, date, unique number and practical-pending wording.
8. Revoke the assignment and confirm the learner immediately loses access while the audit history remains.

The module remains **Draft Rev 1** until its technical and IMS approval is recorded. Controlled access alone does not approve training content for employee issue.
