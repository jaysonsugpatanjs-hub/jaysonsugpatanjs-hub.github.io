# E-01 — LeadPilot AI Environment Setup

**Project:** LeadPilot AI — AI Lead Generation & CRM Automation System  
**Milestone:** E — Environment Setup  
**Status:** Complete as a documented build standard; private account-side controls remain intentionally unpublished  
**Basis:** LeadPilot AI A–Z Implementation Guide 2026

## 1. Purpose

Milestone E establishes the minimum toolset and security rules required before the first live automation is built. The goal is a safe beginner workspace where test data, credentials and production data are clearly separated.

## 2. Minimum stack

| Tool | Role | Beginner setup rule |
|---|---|---|
| GitHub Pages | Portfolio website / public demo | Static HTML/CSS/JS is sufficient for the portfolio front end. |
| HubSpot | CRM, forms, contact/company/deal records | Use a test/demo pipeline and synthetic records before live data. |
| n8n | Automation layer | n8n Cloud is the simplest starting point; self-hosting is optional later. |
| OpenAI API / n8n OpenAI node | AI scoring and structured analysis | Keep API keys only in secure credential storage. Never place them in workflow text or GitHub. |
| Spreadsheet / CSV | Sample prospect data and test cases | Use synthetic data where possible. |

## 3. Environment separation

LeadPilot AI uses three conceptual environments:

### Local / Draft
Used for documentation, synthetic data, HTML/CSS changes and offline review.

### Test / Demo
Used for HubSpot test records, n8n test webhooks, OpenAI prompt testing and synthetic lead processing.

### Production / Live
Used only after workflows have been tested, published and reviewed. Production credentials and live customer data must not be exposed in the public portfolio repository.

## 4. Security rules

1. Enable MFA wherever the platform supports it.
2. Use separate test records and a test/demo CRM pipeline.
3. Never paste API keys, private tokens, passwords or secrets into screenshots, Git commits, README files, prompt files or exported JSON.
4. Store OpenAI, HubSpot and other secrets only in the relevant platform's secure credentials or secret manager.
5. Before publishing an n8n workflow export, inspect the JSON and confirm that no credentials or tokens are embedded.
6. Use n8n test webhook URLs while debugging.
7. Move to the n8n production webhook URL only after the workflow is published/active.
8. Use synthetic demo data for screenshots and public portfolio evidence.
9. Do not publish confidential client or prospect data.
10. Rotate/revoke a credential immediately if it is ever accidentally exposed.

## 5. Public repository credential policy

The repository may contain:

- `.env.example` placeholder variable names
- fake/demo domains
- synthetic contacts and companies
- redacted workflow exports
- screenshots containing demo data only

The repository must not contain:

- API keys
- OAuth access tokens
- private app tokens
- passwords
- real client personal information
- unredacted production workflow exports

## 6. Test data standard

Synthetic records should be clearly fictional and suitable for the demonstration ICP. Example records may use domains such as `example.com`, `example.org` or other reserved/fake values.

A starter file is included at:

`leadpilot-ai/data/synthetic-demo-leads.csv`

## 7. Credential placeholder template

A safe placeholder file is included at:

`leadpilot-ai/.env.example`

This file contains variable names only. Real values must be stored outside GitHub.

## 8. Beginner operating rule

**Test first → verify output → inspect for secrets → publish workflow → switch to production URL.**

## 9. Milestone E acceptance criteria

Milestone E is considered implemented when:

- the minimum stack is defined;
- test and production usage are separated conceptually;
- credential handling rules are documented;
- a safe placeholder credential template exists;
- synthetic test data exists;
- the project explicitly prohibits secrets and real personal data in GitHub;
- the workflow promotion rule from test to production is documented.

Private controls such as actual MFA status, account passwords, API keys and private credentials are intentionally not stored or displayed in the public repository.

**Next milestone:** F — Funnel Design
