# G-01 — GitHub Portfolio Structure

## LeadPilot AI

**Milestone:** G — GitHub Portfolio Structure  
**Status:** Complete  
**Purpose:** Organize the LeadPilot AI build so business requirements, architecture, workflows, prompts, synthetic data, screenshots, testing evidence and the public demo remain easy to find as the project grows.

## Portfolio structure

The workbook recommends a portfolio repository with documentation, workflow exports, prompts, sample data, screenshots and a website/demo reference. Because LeadPilot AI is implemented as a subfolder inside the existing GitHub Pages portfolio repository, the same structure is adapted under `leadpilot-ai/`.

```text
leadpilot-ai/
├─ README.md
├─ index.html
├─ .env.example
├─ docs/
│  ├─ A-01-project-objective.md
│  ├─ B-01-brand-business-foundation.md
│  ├─ C-01-client-profile-icp.md
│  ├─ D-01-data-model.md
│  ├─ E-01-environment-setup.md
│  ├─ F-01-funnel-design.md
│  └─ G-01-github-portfolio-structure.md
├─ workflows/
│  └─ README.md
├─ prompts/
│  └─ README.md
├─ data/
│  └─ synthetic-demo-leads.csv
├─ screenshots/
│  └─ README.md
└─ website/
   └─ demo-or-link.txt
```

## Folder responsibilities

| Path | Purpose | What belongs here |
|---|---|---|
| `README.md` | Portfolio overview | Problem, architecture, stack, workflows, scoring, testing, security, lessons and roadmap |
| `docs/` | Project documentation | Requirements, architecture, CRM data model, workflow design, test plan and case study evidence |
| `workflows/` | Automation evidence | Redacted n8n workflow exports only; never credentials or tokens |
| `prompts/` | AI design evidence | Versioned prompt specifications and expected structured outputs |
| `data/` | Test data | Synthetic/demo CSV records only |
| `screenshots/` | Visual proof | HubSpot, n8n, AI scoring and test-result screenshots with sensitive data removed |
| `website/` | Demo reference | Public demo URL or website notes |
| `index.html` | Live case study | Public GitHub Pages page for the LeadPilot project |

## README structure

The workbook recommends the following story for the portfolio README:

1. Problem and project objective
2. Architecture diagram
3. Technology stack
4. Key workflows
5. AI scoring logic
6. Screenshots / demo
7. Testing and results
8. Security/privacy choices
9. What I learned
10. Next version roadmap

The current README uses this sequence and will be filled progressively as later milestones are implemented.

## Naming convention

Milestone documentation uses the pattern:

`<LETTER>-<NUMBER>-<descriptive-name>.md`

Examples:

- `A-01-project-objective.md`
- `D-01-data-model.md`
- `G-01-github-portfolio-structure.md`

Future technical evidence should use descriptive names and version suffixes where useful, for example:

- `inbound-lead-qualification.REDACTED.json`
- `lead-qualification-v1.md`
- `hubspot-pipeline.png`

## Redaction and publication rule

Before anything is published to GitHub:

1. Remove API keys, tokens and passwords.
2. Remove real personal or confidential client information.
3. Inspect exported workflow JSON for credentials.
4. Use synthetic records where possible.
5. Label workflow exports `REDACTED` when they were produced from connected systems.
6. Capture screenshots only after sensitive data is hidden or replaced with demo data.

## Milestone acceptance criteria

Milestone G is complete when:

- a LeadPilot-specific README exists;
- `docs`, `workflows`, `prompts`, `data`, `screenshots` and `website` locations exist;
- each location has a documented purpose;
- synthetic data has a defined home;
- future n8n exports and prompt files have defined homes;
- the live case study links back to the repository evidence;
- no real secrets are stored in the portfolio structure.

## Result

LeadPilot AI now has a scalable evidence structure. Future milestones can add technical implementation proof without scattering files across the main portfolio repository.
