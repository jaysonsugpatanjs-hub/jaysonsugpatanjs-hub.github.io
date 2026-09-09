# LeadPilot AI

**AI Lead Generation & CRM Automation Portfolio Project**

LeadPilot AI demonstrates how a B2B service company can connect website lead capture, HubSpot CRM, n8n automation and OpenAI-powered qualification into a measurable sales workflow.

**Live case study:** https://jaysonsugpatanjs-hub.github.io/leadpilot-ai/

## 1. Problem and project objective

Small B2B service companies can lose opportunities when enquiries are scattered across website forms, inboxes, spreadsheets and manual follow-up. LeadPilot AI is being built to capture, organize, qualify, prioritize and follow up those enquiries through a connected CRM and automation system.

Demo client: **Northstar Industrial Services**, a fictional Victorian industrial-services company used for safe portfolio testing.

## 2. Architecture diagram

Current MVP direction:

```text
Website / Prospect List
        ↓
HubSpot Contact + Company
        ↓
n8n Validation + Deduplication
        ↓
OpenAI Structured Qualification
        ↓
Score + Priority + Next Action
        ↓
HubSpot Update + Task
        ↓
Human Review / Outreach / Meeting
        ↓
Deal Pipeline + Reporting
```

A detailed architecture artifact will be expanded as later technical milestones are implemented.

## 3. Technology stack

- **GitHub Pages** — public portfolio and demo front end
- **HubSpot** — CRM / system of record
- **n8n** — workflow automation and orchestration
- **OpenAI** — structured lead analysis, scoring and next-action recommendations
- **CSV / spreadsheet data** — synthetic prospect and test records

## 4. Key workflows

Planned portfolio workflow evidence will be stored in [`workflows/`](./workflows/). Exports will be redacted before publication.

Primary MVP workflow:

`Inquiry → CRM → validation/dedupe → AI qualification → score/priority → CRM update → follow-up task`

## 5. AI scoring logic

The data model already reserves fields such as:

- `ai_fit_score`
- `ai_priority`
- `ai_score_reason`
- `ai_next_action`
- `ai_processed`
- `last_ai_scored_at`

Prompt specifications will be versioned in [`prompts/`](./prompts/) when the OpenAI milestone is implemented.

## 6. Screenshots / demo

- Live demo: https://jaysonsugpatanjs-hub.github.io/leadpilot-ai/
- Visual implementation evidence will be stored in [`screenshots/`](./screenshots/).
- Demo/reference information is stored in [`website/`](./website/).

## 7. Testing and results

Testing will use synthetic/demo records first. The test plan and results will be added as the workflows become operational.

Current synthetic dataset: [`data/synthetic-demo-leads.csv`](./data/synthetic-demo-leads.csv)

## 8. Security/privacy choices

- Real API keys, passwords and tokens are never committed to GitHub.
- `.env.example` contains placeholders only.
- Synthetic records are preferred for portfolio testing.
- n8n workflow exports must be inspected and redacted before publication.
- Screenshots must not expose credentials or confidential customer information.

## 9. What I learned

This section will grow with the project. The current foundation demonstrates the sequence:

`Business problem → process → data → technology → automation → AI → business result`

## 10. Next version roadmap

A–Z milestone progress is published on the live case-study page. Current foundation milestones cover agency objective, positioning, ICP, data model, environment setup, funnel design and portfolio structure. The next technical milestone is **H — HubSpot CRM**.

## Repository evidence structure

```text
leadpilot-ai/
├─ README.md
├─ docs/
├─ workflows/
├─ prompts/
├─ data/
├─ screenshots/
├─ website/
├─ .env.example
└─ index.html
```

See [`docs/G-01-github-portfolio-structure.md`](./docs/G-01-github-portfolio-structure.md) for the folder rules and publication standards.
