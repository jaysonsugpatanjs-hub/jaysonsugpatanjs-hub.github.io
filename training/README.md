# Panalo Pipes controlled training portal

This directory contains the public learner/admin interface for the Panalo Pipes personal-email invitation system. Protected course content and records are supplied by Supabase after the server verifies the learner's identity and active assignment.

## Current module

`PP-TRN-WLD-001 - Hot Work: MIG Welding and Grinding Safety` contains 20 PowerPoint slides. Slides 1-19 have one corresponding knowledge check; slide 20 carries the final 15-question theory assessment. The pass rule is 80% overall plus 100% of critical questions.

The module front page displays the PowerPoint cover after access is authorised. A slide image is requested only when that slide is selected. The learner browser never receives the correct answer indices.

The module remains **Draft Rev 1** pending technical, WHS and IMS approval. Theory completion does not provide practical task authorisation.

## Main components

- `auth.js` - passwordless email session and authenticated Function requests.
- `admin/` - administrator invitation, assignment, revocation and secure module publishing.
- `modules/` - generic protected learner flow used by every published module.
- `modules/pp-trn-wld-001/` - shared learner-view assets and backward-compatible module URL.
- `scripts/provision-supabase-module.mjs` - private content/answer upload.
- `scripts/check-public-training.mjs` - release guard against public PowerPoints or answer manifests.
- `../supabase/` - database migration and server functions for access checks, marking, records and PDF certificates.

## Secure module management

Administrators can open **Module management** to create a draft from module metadata and an authoring JSON file, then upload one PPTX and the rendered slide images. PNG and JPEG slides are converted to WebP in the administrator browser and uploaded with short-lived signed upload URLs directly to the private `training-content` bucket.

The server validates slide order, key points, knowledge checks, correct-answer indices, final assessment, file count and private asset presence. Correct answers are separated into the server-only answer key. A version cannot be assigned until an administrator explicitly publishes it; after publication, that version and its asset path are treated as immutable.

Deployment instructions are in [SETUP.md](SETUP.md). The security boundary and acceptance checks are in [ACCESS-CONTROL.md](ACCESS-CONTROL.md).
