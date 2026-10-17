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

## Document control

- Folder access is resolved in the database (`ims_folder_level`) on every request, from grants on the folder and its ancestors while each folder inherits. Browsers never read folder, document or grant tables directly.
- Viewers see approved revisions only; drafts and revisions in approval need Editor or above. Downloads use five-minute signed links from the private `ims-documents` bucket and are audited.
- Approvals need Approver access on the folder, cannot be recorded by the revision author, and require the controlled file to be attached first. The file cannot change after the first approval.
- A folder cannot be left without an owner. Stopping inheritance copies the current access first so nobody is locked out by surprise.
- "All employees" means active employees on the register, not every login.

## Contract signing

- Contract files and handwriting images live in the private `hr-documents` bucket. Browsers receive only short-lived signed links: two minutes for HR, five minutes for the applicant, who can open only a contract on their own request. Every opening is audited.
- `onboarding_sign_documents` has row-level security on, no browser policies, and is readable by the server role only. Attaching, removing and signing run only through `onboarding_sign_doc_add`, `onboarding_sign_doc_remove` and `onboarding_record_signature`, which are executable by the server role only.
- Attaching or removing a contract needs the HR onboarding permission. It is refused once the item is signed, accepted or the request is closed, so a signature can never sit on a file that has since been swapped.
- The signer is always the signed-in applicant. A typed name must match the register name; a handwritten signature records the register name. The agreement wording is fixed on the server, never taken from the browser.
- A signature image must be a real PNG of sensible size; anything else is refused. Contracts must really be PDFs, checked on the stored bytes, not the file name.
- The upload routes for ordinary documents refuse sign items, so no upload link into the HR bucket is issued for a contract item.
- Accepting a signed contract needs HR to say where the signature goes (page and position); a plain accept is refused. Finalizing re-hashes each stored contract file and builds the stamped document before anything is accepted, so a changed file or a bad placement leaves the signature waiting.
- Previews are built on demand, returned to HR and never stored; each preview and each view of a contract file is audited.

## Required deployment checks

- A direct slide, PowerPoint, certificate or API URL without a session is denied.
- A signed-in but unassigned account is denied.
- A learner cannot open a later slide before passing the previous check.
- A revoked or expired assignment is denied immediately.
- Changing a browser-side score, timestamp or pass flag cannot alter the server record.
- The public repository passes `node training/scripts/check-public-training.mjs`.
- Administrator invitation, magic-link login, slide flow, failed and passing assessments, retake history, certificate PDF and revocation are verified end to end.
- Draft creation, private signed upload, missing-asset rejection, publication and generic module viewing are verified before enabling administrator self-service.
- `npm run test:db` passes: inheritance, locked folders, last-owner protection, approval gates, publish blocked until approved, and no audit row for a failed action.
- A signed-in applicant cannot open any IMS folder; a supervisor sees approved revisions but not drafts.
- `npm run test:db` and `npm run test:api` cover contract signing: attach, read, type and written signatures, send-back and re-sign, locking after signing, placement and preview, finalizing, a changed file refused before anything is accepted, and the browser roles having no direct access.

See [SETUP.md](SETUP.md) for deployment and first-administrator steps.
