# Panalo Pipes controlled training portal

This directory contains the public learner/admin interface for the Panalo Pipes personal-email invitation system. Protected course content and records are supplied by Supabase after the server verifies the learner's identity and active assignment.

## Current module

`PP-TRN-WLD-001 - Hot Work: MIG Welding and Grinding Safety` contains 20 PowerPoint slides. Slides 1-19 have one corresponding knowledge check; slide 20 carries the final 15-question theory assessment. The pass rule is 80% overall plus 100% of critical questions.

The module front page displays the PowerPoint cover after access is authorised. A slide image is requested only when that slide is selected. The learner browser never receives the correct answer indices.

The module remains **Draft Rev 1** pending technical, WHS and IMS approval. Theory completion does not provide practical task authorisation.

## Integrated management system

The portal now covers three connected areas, all behind the same server-only boundary:

- **People** – employee register (positions, sites, supervisors, start and end dates), licences and tickets with expiry, and document access groups.
- **Competency matrix** – required modules per position with refresher intervals. A person is *competent* only when the theory is passed **and** the onsite practical is recorded, within the refresher period. Practical verifications are recorded from the matrix.
- **IMS documents** – the Panalo Asset File folder tree with access set per folder (Viewer, Editor, Approver, Owner). Access flows down to subfolders unless a folder stops inheriting. Documents have revisions; a revision becomes current only when every required approval gate (technical, WHS, IMS) is recorded by an Approver who is not its author.

A training module version can only be **published** once it is linked to an **approved** IMS revision of its document.

Every change in these areas runs as one database transaction that also writes its audit record, so an action cannot happen without its record.

## Onboarding: signing the employment contract online

Applicants no longer print, sign and re-upload their contract. HR attaches it and the applicant signs on the portal.

1. **HR sends the onboarding request** (*Administration → Onboarding*) with **Employment contract** ticked. It is a "Sign online" item and is ticked by default for employees and applicants.
2. **HR opens the request and uploads the contract as a PDF** (up to 20 MB, up to five files, for example the contract plus a position description). Word files must be saved as PDF first. The server checks each file really is a PDF and records its SHA-256 fingerprint.
3. **The applicant sees the contract on their portal.** *Read* opens it in a new tab. They tick the agreement, then sign by **typing their full name** (it must match their name on the register, ignoring case and spacing) or by **writing their name on screen** with a finger or mouse.
4. **HR finalizes the signature**, or sends it back with a reason. Under *Finalize*, HR opens the contract's pages, clicks the signature line (and the date line) where the signature belongs, and can *Preview* the stamped contract. Nothing is accepted or filed until HR presses **Finalize & file**. If the contract needs changing, sending it back unlocks the files; HR swaps them and the applicant signs again.
5. **On finalizing, the system files one signed PDF** in the person's HR folder (*06 Contract & employment terms*): the exact contract pages with the signature (handwriting, or the typed name) and the signing date placed where HR clicked, then a signature record page.

The page viewer uses pdf.js 3.11.174 (Apache-2.0), shipped unmodified in `vendor/pdfjs/` because the admin page only allows scripts from this site.

What is recorded with each signature, in the same database transaction as its audit event: who signed, when, how (typed or written), the exact agreement wording shown to them, and the SHA-256 fingerprint of every contract file. Each time the applicant opens the contract is audited too.

Rules the system enforces:

- A contract cannot be signed until HR has attached it, and cannot be changed after it has been signed. Sending it back is the only way to change it, and every earlier signature stays in the audit log.
- Before finalizing, each stored contract file is re-checked against its fingerprint, and the stamped document is built first. If a file no longer matches, or the chosen page doesn't exist, the signature stays waiting for HR and nothing is accepted or filed.
- Files are never deleted from the private HR bucket. Removing a file before signing only unlinks it.
- The older **Signed employment contract** upload item is retired for new requests. Requests already using it continue to work.

This is a simple electronic signature with a full record. Ask your employment adviser to confirm it suits your contracts and any award or agreement requirements.

## Main components

- `auth.js` - passwordless email session and authenticated Function requests.
- `admin/` - administrator invitation, assignment, revocation, secure module publishing, people, positions and requirements, the competency matrix, and onboarding (including attaching contracts for online signing).
- `ims/` - IMS document browser, used inside administration and as a standalone page for staff.
- `theme.css` / `components.css` - Panalo black-and-gold brand theme and layout for the newer screens.
- `modules/` - generic protected learner flow used by every published module.
- `modules/pp-trn-wld-001/` - shared learner-view assets and backward-compatible module URL.
- `scripts/provision-supabase-module.mjs` - private content/answer upload.
- `scripts/check-public-training.mjs` - release guard against public PowerPoints or answer manifests.
- `../supabase/` - database migrations and server functions: `training-api` (learners), `admin-api` (administrators) and `ims-api` (document control).
- `../supabase/tests/db/` - database tests that apply every migration to Postgres and check the access, approval and audit rules (`npm run test:db`).

## Secure module management

Administrators can open **Module management** to create a draft from module metadata and an authoring JSON file, then upload one PPTX and the rendered slide images. PNG and JPEG slides are converted to WebP in the administrator browser and uploaded with short-lived signed upload URLs directly to the private `training-content` bucket.

The server validates slide order, key points, knowledge checks, correct-answer indices, final assessment, file count and private asset presence. Correct answers are separated into the server-only answer key. A version cannot be assigned until an administrator explicitly publishes it; after publication, that version and its asset path are treated as immutable.

Deployment instructions are in [SETUP.md](SETUP.md). The security boundary and acceptance checks are in [ACCESS-CONTROL.md](ACCESS-CONTROL.md).
