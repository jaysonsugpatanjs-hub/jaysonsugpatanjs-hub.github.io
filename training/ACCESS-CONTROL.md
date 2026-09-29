# Panalo Pipes controlled training portal

The training application uses a public, non-sensitive GitHub Pages shell and a private Supabase backend. A login screen is not treated as security: the PowerPoint, rendered slides, answer key, learner records, assessment marking and certificates remain outside the public Pages deployment.

## Learner access model

1. A training administrator records the learner's full legal name, personal or company email, employee/applicant ID, learner type, assigned module and access expiry.
2. Supabase sends a single-user invitation. Later sign-ins use a time-limited email link and do not create unapproved accounts.
3. The server checks the verified user ID, active profile, exact assignment, revocation status and expiry on every protected request.
4. Only the selected, currently unlocked slide receives a short-lived signed URL. PowerPoint sources and answer keys are never returned to the browser.
5. Slide answers and the final assessment are marked on the server. Attempts use server timestamps and remain in the audit register.
6. A passing result requires at least 80% overall and every critical question correct. The server creates a Panalo-branded PDF with the verified name, record ID, score, critical result, attempt, Sydney date and unique certificate number.
7. The certificate states **Theory Passed - Practical Verification and Site Authorisation Pending**. Practical competency and task authorisation remain separate IMS records.
8. Administrators can revoke an assignment without deleting the audit history.
9. Administrators create new module versions as private drafts. The server strips correct answers from learner content, issues time-limited upload URLs and refuses publication until the PPTX and every numbered slide image are present.
10. Published versions are immutable. Revisions use a new content-version identifier so existing learner records and certificates continue to point to the version actually completed.

## Security boundary

- `training/config.js` contains only the project URL and browser-safe publishable key.
- Supabase secret/service keys belong only in local environment variables, Supabase Functions or protected CI secrets.
- All training tables have row-level security enabled and direct `anon` / `authenticated` grants revoked. Edge Functions perform the authorised operations.
- Both Storage buckets are private. Slide links expire after two minutes; certificate links expire after five minutes.
- The public site uses a restrictive Content Security Policy and contains no third-party runtime scripts.
- Open self-registration must be disabled. `signInWithOtp` is also called with user creation disabled.
- Allowed browser origins are restricted to the GitHub Pages site and the planned `training.panalopipesandstructurals.com.au` address.
- The existing public slide and answer files must be removed from the deployed repository. Because historic public commits cannot be made private by deletion, production questions should be rotated before formal assessment use.
- The module manager accepts source and rendered files only after administrator verification. It never writes a PowerPoint or answer-bearing manifest into the GitHub Pages tree.

## Required deployment checks

- A direct slide, PowerPoint, certificate or API URL without a session is denied.
- A signed-in but unassigned account is denied.
- A learner cannot open a later slide before passing the previous check.
- A revoked or expired assignment is denied immediately.
- Changing a browser-side score, timestamp or pass flag cannot alter the server record.
- The public repository passes `node training/scripts/check-public-training.mjs`.
- Administrator invitation, magic-link login, slide flow, failed and passing assessments, retake history, certificate PDF and revocation are verified end to end.
- Draft creation, private signed upload, missing-asset rejection, publication and generic module viewing are verified before enabling administrator self-service.

See [SETUP.md](SETUP.md) for deployment and first-administrator steps.
