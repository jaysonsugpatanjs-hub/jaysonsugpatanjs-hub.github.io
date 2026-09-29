# Panalo Pipes controlled training portal

This directory contains the public learner/admin interface for the Panalo Pipes personal-email invitation system. Protected course content and records are supplied by Supabase after the server verifies the learner's identity and active assignment.

## Current module

`PP-TRN-WLD-001 - Hot Work: MIG Welding and Grinding Safety` contains 20 PowerPoint slides. Slides 1-19 have one corresponding knowledge check; slide 20 carries the final 15-question theory assessment. The pass rule is 80% overall plus 100% of critical questions.

The module front page displays the PowerPoint cover after access is authorised. A slide image is requested only when that slide is selected. The learner browser never receives the correct answer indices.

The module remains **Draft Rev 1** pending technical, WHS and IMS approval. Theory completion does not provide practical task authorisation.

## Main components

- `auth.js` - passwordless email session and authenticated Function requests.
- `admin/` - administrator invitation, expiry and revocation register.
- `modules/pp-trn-wld-001/` - protected learner flow.
- `scripts/provision-supabase-module.mjs` - private content/answer upload.
- `scripts/check-public-training.mjs` - release guard against public PowerPoints or answer manifests.
- `../supabase/` - database migration and server functions for access checks, marking, records and PDF certificates.

Deployment instructions are in [SETUP.md](SETUP.md). The security boundary and acceptance checks are in [ACCESS-CONTROL.md](ACCESS-CONTROL.md).
