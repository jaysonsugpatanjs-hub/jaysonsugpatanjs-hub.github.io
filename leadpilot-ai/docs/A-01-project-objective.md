# A-01 — LeadPilot AI Project Objective

**Project:** LeadPilot AI — AI Lead Generation & CRM Automation System  
**Milestone:** A — Agency Objective  
**Status:** Complete  
**Portfolio type:** Learning project + working technical case study

## 1. Project objective

LeadPilot AI is a portfolio project designed to demonstrate how a B2B service company can combine website lead capture, HubSpot CRM, n8n workflow automation and OpenAI-powered lead qualification to create a structured and measurable sales pipeline.

The objective is to build a real, testable AI-enabled lead-generation operating system rather than only a landing page, spreadsheet, or collection of prompts.

## 2. Demonstration client

**Northstar Industrial Services** is a fictional Victorian industrial-services company used to test the system without exposing confidential client information.

- Region: Victoria, Australia
- Sector: Industrial services
- Example services: fabrication, coded welding, shutdown and maintenance support
- Primary users: business owner, business development, sales and administration staff

## 3. Business problem

Small B2B service companies can lose sales opportunities because enquiries and prospect information are scattered across website forms, inboxes, spreadsheets and manual follow-up processes.

For the demonstration client, the problem is defined as:

> Northstar Industrial Services needs a structured way to capture, qualify, prioritize and follow up sales enquiries so valuable opportunities are not lost.

## 4. Proposed solution

LeadPilot AI will create a connected workflow that:

1. Captures a new enquiry.
2. Stores the person and company in HubSpot CRM.
3. Sends the relevant lead data through n8n.
4. Uses OpenAI to assess fit, urgency and available evidence.
5. Produces an explainable lead score and priority.
6. Updates the CRM with the AI result.
7. Creates or recommends the appropriate follow-up action.
8. Supports traceable opportunity and pipeline reporting.

## 5. Minimum Viable Product (MVP)

The first working version is intentionally small.

**MVP flow:**

`Website Inquiry → HubSpot CRM → n8n → OpenAI Qualification → AI Score → Priority → CRM Update → Follow-up Task`

The MVP is successful when one demonstration inquiry can complete that flow reliably and the result can be evidenced with screenshots, test records and workflow execution history.

## 6. Version 1 scope

### Included

- Website inquiry capture
- HubSpot contact and company records
- Lead source capture
- Basic sales opportunity tracking
- n8n workflow automation
- OpenAI lead qualification
- Explainable AI fit score
- HOT / WARM / DEVELOP / LOW priority classification
- Recommended next action
- Follow-up task or equivalent action
- Basic pipeline reporting
- Demo/test data
- QA evidence
- GitHub documentation and case study

### Excluded from Version 1

- Mass cold-email automation
- AI voice calling
- Paid advertising management
- Large-scale web scraping
- Fully autonomous sales decisions
- Complex multi-client SaaS architecture
- Advanced billing/subscription management
- Production deployment using confidential client data

These exclusions keep the first build safe, testable and understandable for a beginner.

## 7. Technology roles

| Technology | Role in LeadPilot AI |
|---|---|
| GitHub Pages | Public portfolio and demonstration front end |
| HubSpot | CRM / system of record |
| n8n | Workflow automation and orchestration |
| OpenAI | Lead analysis, qualification and next-action recommendation |
| GitHub | Source control, documentation and portfolio evidence |

## 8. Core design principle

LeadPilot AI will be built in this order:

`Business Problem → Process → Data → CRM → Automation → AI → Business Result`

The project will not introduce automation or AI unless the business process and required data are first defined.

## 9. Milestone A acceptance criteria

Milestone A is complete when the project has documented:

- Project name and purpose
- Demonstration client
- Business problem
- Proposed solution
- Primary users
- MVP flow
- Version 1 scope
- Explicit exclusions
- Technology roles
- Measurable MVP success condition

## 10. Portfolio evidence

This document is the formal Milestone A evidence artifact. The public LeadPilot AI portfolio page should also show Milestone A as completed and summarize the objective, problem, solution, MVP and scope.

**Next milestone:** B — Brand & Business Foundation
