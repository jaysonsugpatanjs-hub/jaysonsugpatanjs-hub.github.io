# Single Touch Payroll (Panalo Accounts, Phase 8)

Panalo Accounts prepares **STP Phase 2 information** for each pay run and for
update and finalisation events, checks it against the reporting rules, and
exports it. **It does not send anything to the ATO.** Sending is switched off
in the database (`stp_settings.transmission_enabled` has a check constraint
that only allows `false`, and `stp_event_submit` always refuses).

Keep reporting STP through the current STP-enabled payroll product. Use these
events to check that product's figures, and as the groundwork for sending
directly later.

This system is not ATO approved, not STP certified and not on the ATO's STP
product register.

## What is built

| Part | Notes |
| --- | --- |
| Employer settings | ABN from company settings, branch (usually 001), contact, and a generated software ID (BMS ID) |
| Pay item mapping | Each pay item has an STP Phase 2 category (gross, overtime, bonus, directors' fees, paid leave, allowance, deduction, not reported) and type code (leave O/C/U/P/W/A; allowances CD, AD, LD, MD, RD, TD, KN, QN, OD with G1/H1/ND/T1/U1/V1; deductions F/W/G/D). Seeded for the standard items (public holidays not worked are gross, as if worked); a deduction item can only be a deduction or not reported, and earnings can't be deductions. Check with the accountant |
| Employee STP details | Family and given names, home address, income type (SAW, CHP, IAA, WHM, SWP, FEI, JPD, VOL, LAB, OSP), country for working holiday makers and foreign residents, cessation type (V, I, D, R, F, C, T) |
| Tax treatment code | Six characters worked out from the pay settings: category and option (for example RT regular, RN no tax-free threshold, NA no TFN, plus the other categories), then study and training loan, Medicare levy surcharge, exemption and reduction. Example: `RTXXXX` |
| TFN codes | Quoted TFN, or 000000000 (not quoted), 111111111 (applied for), 333333333 (under 18), 444444444 (pensioner) |
| Year-to-date figures | By employee for the financial year: gross after salary sacrifice, overtime, bonuses, directors' fees, paid leave by type, allowances by type, deductions by type, salary sacrifice (S), PAYG withheld, super liability, ordinary time earnings and reportable employer super |
| Events | Pay event for each paid pay run; update events (only employees whose figures changed since the last ready event); finalisation for the year |
| Checks | Employer: ABN, branch, contact, software ID. Employee: names, address, date of birth, TFN code, income type, tax treatment, cessation when finished, figures not negative. Errors stop an event becoming ready; warnings don't |
| Ready | A second person with `payroll.approve` (not the preparer) marks an error-free event ready; the event is rebuilt first and refused if any figure or detail changed |
| Finalisation | Refused until every approved pay run in the year has a pay event marked ready |
| Who sees what | Payroll officers and approvers see the figures; dates of birth, addresses and TFN digits only with `payroll.sensitive` |
| Export | JSON and CSV by employee for a person with `payroll.sensitive`. Full TFNs appear only in the export, which is logged. Elsewhere TFNs are masked. Spreadsheets drop leading zeros from codes like 000000000; use the JSON to compare exactly |
| Send to the ATO | Shown and disabled. Always refused |

Screens: Payroll › STP (events, pay item mapping, settings) and an STP
section on each employee's pay form.

## Stages to sending directly

Sending is the last stage. Each stage needs its own review, and stage 5 needs
the ATO's processes first.

1. **Information and checks (done in Phase 8).** Data mapping, validation,
   events, exports. Compare with the current STP product each pay run.
2. **Parallel run.** For at least one full quarter, compare each pay event
   here with what the current product reported (gross, PAYG, super,
   allowances, leave) and fix any mapping differences.
3. **Message format.** Build the STP Phase 2 payroll event message to the
   ATO's message structure table and business implementation guide, with the
   ATO's test data. Still not sent.
4. **Sending service and registration.** Choose a sending service provider
   (SSP) on the ATO's list, or build to the ATO's cloud software requirements
   (software provider registration, cloud software authentication and
   authorisation, the ATO's security requirements). Complete product
   registration and conformance testing with the ATO, so the product appears
   on the STP product register. Set up machine credentials or the SSP
   arrangement, and the ATO notification for the payroll's software ID.
5. **Switch on.** Only after stage 4 is finished: a new migration lifts the
   `transmission_enabled` check, adds the send, response and
   correction flows (accepted, partly accepted, rejected), and moves reporting
   across from the current product at the start of a pay period with an
   update event to carry the year-to-date figures.

Until stage 5, the database itself refuses to send. Changing that needs a
reviewed migration, not a setting.

## Sources

- ATO, [Single Touch Payroll Phase 2 employer reporting guidelines](https://www.ato.gov.au/businesses-and-organisations/hiring-and-paying-your-workers/single-touch-payroll/in-detail/single-touch-payroll-phase-2-employer-reporting-guidelines)
  (income types, tax treatment codes, payment types, allowance and leave
  types, cessation types, TFN codes).
- ATO Software Developers, [STP product registration](https://softwaredevelopers.ato.gov.au/STP_ProductRegistration),
  [sending service providers](https://softwaredevelopers.ato.gov.au/sending-service-providers)
  and the [STP product register](https://softwaredevelopers.ato.gov.au/stpregisters).
- ATO, [STP checklists](https://www.ato.gov.au/businesses-and-organisations/hiring-and-paying-your-workers/single-touch-payroll/start-reporting/stp-checklists).

The codes are kept in the database check constraints and in
`accounts/views/stp.js`. When the ATO changes the guidelines, change both in a
new migration and update this page.

## Database changes (`20261014000000_stp.sql`)

- Current structure: pay items, payroll employees and pay runs from Phase 5;
  no STP records.
- Change: `stp_settings` (sending locked off), STP category and type on pay
  items, STP details on payroll employees, `stp_events` and
  `stp_employee_records`; functions for the tax treatment, TFN code,
  year-to-date figures, building and checking events, ready, export and the
  refused send.
- Reason: Phase 8 of the brief (STP Phase 2 data, validation, exports,
  integration architecture, sending off until the requirements are met).
- Affected modules: payroll (pay items, employees, pay runs read-only).
- Migration strategy: additive. Existing pay items get a mapping; existing
  employees get income type SAW; names come from the people register when
  the event is built.
