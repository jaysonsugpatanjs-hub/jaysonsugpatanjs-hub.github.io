# F-01 — Funnel Design

## LeadPilot AI

**Milestone:** F — Funnel Design  
**Status:** Complete  
**Purpose:** Translate the business journey into trackable CRM stages and define the event that moves a prospect from one stage to the next.

## Funnel principle

The system should not treat every record the same. A visitor, a submitted lead, a qualified lead, a booked meeting, and a commercial opportunity represent different levels of intent and should be measured separately.

## Funnel stages

| Stage | System event / definition | Example KPI |
|---|---|---|
| Visitor / Prospect | Someone visits or is identified as a target account | Visitors, target companies |
| Lead | Contact submits a form or enters an approved prospect list | New leads |
| Qualified | Rules + AI indicate a plausible fit | MQL / SQL count |
| Meeting | Discovery call is booked | Booking rate |
| Opportunity | Commercial need and next step are confirmed | Pipeline value |
| Customer | Work / engagement is won | Revenue |
| Nurture | Not ready now, but still a valid future fit | Reactivation rate |

## Stage-entry rules

### Visitor / Prospect
A record may enter this stage through website activity, an approved prospect list, or another legitimate target-account source. This stage does not automatically mean the individual is known.

### Lead
Move to Lead when a person submits an inquiry/form or is intentionally added to an approved prospect list with enough data for CRM processing.

### Qualified
Move to Qualified when the required fields are present and LeadPilot rules plus AI indicate plausible commercial fit. Qualification should consider the ICP defined in Milestone C and the structured fields defined in Milestone D.

### Meeting
Move to Meeting only when a discovery or commercial conversation has actually been booked.

### Opportunity
Move to Opportunity only when a real commercial need and a defined next step have been confirmed. A high AI score by itself does not create an Opportunity.

### Customer
Move to Customer when work or an engagement is won.

### Nurture
Move to Nurture when the organisation is a valid fit but the timing, readiness, requirement, or commercial condition is not currently suitable.

## MVP system flow

```text
Website / Prospect List
        ↓
HubSpot Contact + Company
        ↓
n8n validation + dedupe
        ↓
OpenAI structured qualification
        ↓
Score + Priority + Next Action
        ↓
HubSpot update + task
        ↓
Human review / outreach / meeting
        ↓
Deal pipeline + reporting
```

## Automation boundary

LeadPilot may automate capture, validation, deduplication, qualification, scoring, CRM updates and follow-up task creation. Human review remains important before high-impact commercial actions and before treating a lead as a genuine opportunity.

## Funnel conversion measurements

Recommended conversion calculations for later KPI implementation:

- Visitor / Prospect → Lead
- Lead → Qualified
- Qualified → Meeting
- Meeting → Opportunity
- Opportunity → Customer
- Nurture → Reactivated Lead / Opportunity

## Example journey

**Demo case:** A Maintenance Manager from a Victorian engineering company submits an inquiry about coded-welding support.

1. Form submission creates or updates the Contact and Company — **Lead**.
2. Required data is validated and deduplicated.
3. AI assesses industry, geography, service need, urgency and buyer role.
4. If plausible fit is confirmed — **Qualified**.
5. A discovery call is booked — **Meeting**.
6. The buyer confirms a shutdown requirement and agrees on a quoting next step — **Opportunity**.
7. The engagement is awarded — **Customer**.

If the same buyer says the shutdown is likely next year but the fit remains strong, the record can move to **Nurture** rather than being treated as lost.

## Acceptance criteria

Milestone F is complete when:

- [x] Funnel stages are defined.
- [x] Each stage has a clear entry event.
- [x] Example KPIs are identified.
- [x] The MVP workflow is mapped end to end.
- [x] Nurture is separated from lost/unqualified records.
- [x] AI qualification does not automatically equal a commercial opportunity.
- [x] The funnel is ready to be implemented in later HubSpot and automation milestones.

## Next milestone

**G — GitHub Portfolio Structure**
