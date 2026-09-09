# D-01 — LeadPilot AI Data Model

**Project:** LeadPilot AI — AI Lead Generation & CRM Automation System  
**Milestone:** D — Data Model  
**Status:** Complete  
**Basis:** LeadPilot AI A–Z Implementation Guide 2026

## 1. Why the data model comes before automation

The workbook defines a CRM as a structured database and warns that automating before the fields are decided produces disconnected workflow nodes.

For LeadPilot AI, Milestone D therefore defines the records and fields that later HubSpot, n8n and OpenAI workflows will use.

## 2. Core CRM objects

| Object | Plain-English meaning | Workbook example | LeadPilot use |
|---|---|---|---|
| Contact | A person | Jane Smith, Maintenance Manager | Stores the individual buyer or enquiry contact. |
| Company | The organisation | ABC Engineering Pty Ltd | Stores the business the contact belongs to. |
| Deal / Opportunity | A potential commercial job | 2026 shutdown labour support | Stores a qualified commercial requirement or potential sale. |
| Activity | What happened | Email, call, form submission, meeting | Records interactions and engagement history. |
| Task | What someone must do next | Call within 1 business day | Stores the next human follow-up action. |

## 3. LeadPilot custom fields

These fields are taken directly from the workbook's LeadPilot custom-field model.

| Property | Type | Example | Purpose |
|---|---|---|---|
| `lead_source_detail` | Text | Portfolio website form | Attribution |
| `ai_fit_score` | Number 0–100 | 82 | Prioritisation |
| `ai_priority` | Dropdown | HOT / WARM / DEVELOP / LOW | Simple queueing |
| `ai_score_reason` | Multi-line text | Industrial fit + active project + location match | Explainability |
| `ai_next_action` | Text | Call within 4 business hours | Actionability |
| `ai_processed` | Boolean | true | Avoid repeat processing |
| `consent_or_basis` | Dropdown | Form opt-in / existing relationship / review required | Compliance control |
| `last_ai_scored_at` | Datetime | 2026-09-09 14:30 | Auditability |

## 4. Relationship between records

The implementation will use the five workbook-defined objects together:

`Company → Contact → Deal / Opportunity`

Activities and Tasks attach to the relevant records so the system can answer both:

- **What has happened?** → Activity
- **What must happen next?** → Task

## 5. Deduplication rule

The workbook defines deduplication as deciding when two records are really the same lead.

### Contact deduplication

**Primary key:** email address

Before creating a new Contact, the workflow should search for the email address first.

### Company deduplication

**Primary key:** company domain

Before creating a new Company, the workflow should search for the company domain first.

### Workflow rule

`Search first → update existing record if matched → create only if no match exists`

This reduces duplicate CRM records and prevents the same lead from being processed as multiple unrelated prospects.

## 6. Data flow for the MVP

The workbook-defined data model supports the following future workflow:

`Lead data enters system`

`→ identify Contact`

`→ identify Company`

`→ search for duplicates`

`→ create/update CRM records`

`→ AI qualification writes score, priority, reason and next action`

`→ Activity records what occurred`

`→ Task records the required follow-up`

`→ Deal / Opportunity is created or updated when there is a commercial requirement`

## 7. Example demonstration record

The workbook supplies the object and field definitions but does not prescribe one complete demonstration record. The following values are **LeadPilot implementation choices for synthetic testing**, not workbook source data.

### Company

- Name: Northstar Industrial Services
- Domain: northstar-industrial.example
- Region: Victoria, Australia

### Contact

- Name: Jordan Smith
- Role: Operations Manager
- Email: jordan.smith@northstar-industrial.example

### Example AI fields after qualification

- `lead_source_detail`: Portfolio website form
- `ai_fit_score`: 82
- `ai_priority`: HOT
- `ai_score_reason`: Industrial fit + active project + location match
- `ai_next_action`: Call within 4 business hours
- `ai_processed`: true
- `consent_or_basis`: Form opt-in
- `last_ai_scored_at`: demonstration timestamp

## 8. Important design boundary

Milestone D defines the data structure only.

It does **not** yet create these custom properties inside HubSpot. That implementation happens later under **H — HubSpot CRM**. It also does not yet build the n8n workflow or OpenAI scoring logic.

## 9. Milestone D acceptance criteria

Milestone D is complete when the project has documented:

- Five core CRM objects
- Plain-English meaning of each object
- LeadPilot custom fields
- Field types and purposes
- Contact deduplication key
- Company deduplication key
- Search-before-create rule
- How the records relate to the MVP flow
- Clear separation between workbook-defined data and synthetic demo choices

## 10. Portfolio evidence

This document is the formal Milestone D data dictionary/schema artifact. The public LeadPilot AI page should also display the core objects, custom fields and deduplication logic.

**Next milestone:** E — Environment Setup
