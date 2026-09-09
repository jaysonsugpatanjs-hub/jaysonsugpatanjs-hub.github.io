# C-01 — LeadPilot AI Client Profile / ICP

**Project:** LeadPilot AI — AI Lead Generation & CRM Automation System  
**Milestone:** C — Client Profile / ICP  
**Status:** Complete  
**Basis:** LeadPilot AI A–Z Implementation Guide 2026

## 1. Purpose

The Ideal Customer Profile (ICP) defines the type of business and buyer LeadPilot AI is designed to prioritize. The portfolio CRM remains generic, but the demonstration ICP is deliberately specific so later HubSpot fields, AI qualification rules, scoring and workflows have realistic criteria.

## 2. Starter demonstration ICP

| Attribute | Starter rule |
|---|---|
| Region | Victoria, Australia |
| Business type | Industrial service, fabrication, maintenance, engineering subcontractor |
| Company size | 5–100 employees |
| Buyer roles | Owner, General Manager, Operations Manager, Maintenance Manager, Procurement / Projects |
| Typical pain | Inconsistent enquiries, slow follow-up, weak CRM discipline, tender opportunities not tracked |
| High-value signals | Active projects, shutdown capability, recurring maintenance demand, multiple service lines |
| Disqualifiers | Consumer-only businesses, no capacity to take work, mismatched geography, clearly irrelevant service need |

## 3. Plain-English ICP statement

LeadPilot AI's demonstration ICP is a Victorian B2B industrial-services SME with roughly 5–100 employees that sells fabrication, maintenance, engineering or related subcontract services and has a need to improve how enquiries, opportunities and follow-up are managed.

## 4. Buyer roles

The workflow should treat the following roles as commercially relevant buyer or influencer roles for the demonstration scenario:

- Owner
- General Manager
- Operations Manager
- Maintenance Manager
- Procurement
- Project / Projects Manager

These roles are not automatically qualified simply because of job title; later qualification must still consider service need, timing, company fit and evidence.

## 5. Customer pains to capture

The CRM and later AI workflow should be able to recognize or record these common pains:

- Inconsistent enquiries
- Slow follow-up
- Weak CRM discipline
- Tender opportunities not tracked

These fields help LeadPilot distinguish a business that merely exists from one that has a problem the service is intended to solve.

## 6. High-value signals

The following signals increase commercial relevance in the demonstration ICP:

- Active projects
- Shutdown capability
- Recurring maintenance demand
- Multiple service lines

These are evidence inputs for later qualification and scoring; they are not standalone proof that a prospect is qualified.

## 7. Disqualifiers

A prospect should be treated as a poor ICP fit when there is clear evidence of one or more of the following:

- Consumer-only business
- No capacity to take work
- Geography outside the intended demonstration market
- Clearly irrelevant service need

The system should retain the reason rather than silently discarding the record so later testing is explainable.

## 8. ICP worksheet fields

The workbook defines the following fields for the ICP worksheet:

| Field | What it records |
|---|---|
| `industry` | Broad industry |
| `sub_industry` | More specific business category |
| `region` | Geographic market |
| `company_size_band` | Company-size grouping |
| `buyer_role` | Role of the contact / decision-maker |
| `service_need` | Relevant service or business need |
| `budget_or_value_band` | Expected commercial value band |
| `urgency` | Timing / urgency |
| `capacity_fit` | Whether the opportunity matches delivery capacity |
| `source` | Where the prospect or lead came from |
| `notes` | Supporting context / evidence |

## 9. Demonstration prospect examples

### Strong-fit example

**Company:** Northstar Maintenance Projects Pty Ltd  
**Region:** Victoria  
**Size:** 35 employees  
**Buyer:** Operations Manager  
**Need:** Improve enquiry follow-up and track recurring shutdown opportunities  
**Signals:** Active projects + recurring maintenance demand  
**ICP assessment:** Strong fit

### Weak-fit example

**Company:** Local Home Repair Services  
**Region:** Victoria  
**Business type:** Consumer-only home repair  
**Need:** Residential customer bookings  
**ICP assessment:** Poor fit because the demonstration ICP is B2B industrial services

## 10. How C will be used later

Milestone C supplies the business rules used by later milestones:

- D — Data Model: converts ICP concepts into structured fields.
- H — HubSpot CRM: creates the fields and views that store ICP data.
- O — OpenAI Scoring: uses approved ICP evidence as scoring input.
- Q — Qualification: separates fit, intent and disqualifying evidence.
- X — QA: tests strong-fit and weak-fit examples.

## 11. Milestone C acceptance criteria

Milestone C is complete when the project documents and publicly displays:

- Region
- Business type
- Company size
- Buyer roles
- Typical pains
- High-value signals
- Disqualifiers
- ICP worksheet fields
- At least one strong-fit and one weak-fit example

## 12. Portfolio evidence

This document is the formal Milestone C ICP artifact. The public LeadPilot AI page should show C as completed and summarize the ICP rules so future CRM and AI scoring decisions are traceable.

**Next milestone:** D — Data Model
