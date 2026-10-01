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

## Main components

- `auth.js` - passwordless email session and authenticated Function requests.
- `admin/` - administrator invitation, assignment, revocation, secure module publishing, people, positions and requirements, and the competency matrix.
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
