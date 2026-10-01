// Competency status for one person against one required module.
// Pure function so the rules are unit-tested and shared by every caller.

export type CompetencyStatus =
  | "competent"
  | "expiring"
  | "expired"
  | "practical_pending"
  | "assigned"
  | "gap"
  | "awaiting_release"
  | "not_required";

export interface PracticalRecord {
  outcome: "competent" | "not_yet_competent";
  assessedOn: string; // YYYY-MM-DD
}

export interface AssignmentRecord {
  status: "assigned" | "theory_passed" | "revoked";
  theoryPassedAt: string | null; // ISO timestamp
  expiresAt: string; // ISO timestamp (access expiry)
  practicals: PracticalRecord[];
}

export interface Requirement {
  required: boolean;
  released: boolean; // module has a published current version
  practicalRequired: boolean;
  refresherMonths: number | null;
}

export interface CompetencyResult {
  status: CompetencyStatus;
  competentFrom: string | null;
  competentUntil: string | null;
  dueBy: string | null;
}

export const EXPIRING_WINDOW_DAYS = 30;

export function sydneyDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const NONE = { competentFrom: null, competentUntil: null, dueBy: null };

export function competencyStatus(requirement: Requirement, assignments: AssignmentRecord[], today: string): CompetencyResult {
  if (!requirement.required) return { status: "not_required", ...NONE };

  // Most recent date the person became competent, from any assignment.
  let competentFrom: string | null = null;
  let practicalPending = false;
  for (const assignment of assignments) {
    if (assignment.status !== "theory_passed" || !assignment.theoryPassedAt) continue;
    const theoryDate = sydneyDate(assignment.theoryPassedAt);
    let achieved: string | null = theoryDate;
    if (requirement.practicalRequired) {
      const passes = assignment.practicals
        .filter(practical => practical.outcome === "competent" && practical.assessedOn >= theoryDate)
        .map(practical => practical.assessedOn)
        .sort();
      achieved = passes.at(-1) ?? null;
      if (!achieved) practicalPending = true;
    }
    if (achieved && (!competentFrom || achieved > competentFrom)) competentFrom = achieved;
  }

  if (competentFrom) {
    const competentUntil = requirement.refresherMonths ? addMonths(competentFrom, requirement.refresherMonths) : null;
    if (!competentUntil || competentUntil >= today) {
      const status = competentUntil && daysBetween(today, competentUntil) <= EXPIRING_WINDOW_DAYS ? "expiring" : "competent";
      return { status, competentFrom, competentUntil, dueBy: null };
    }
    // Lapsed: an open refresher assignment takes priority over "expired".
    const open = openAssignment(assignments, today);
    if (open) return { status: "assigned", competentFrom, competentUntil, dueBy: sydneyDate(open.expiresAt) };
    return { status: "expired", competentFrom, competentUntil, dueBy: null };
  }

  if (practicalPending) return { status: "practical_pending", ...NONE };
  const open = openAssignment(assignments, today);
  if (open) return { status: "assigned", competentFrom: null, competentUntil: null, dueBy: sydneyDate(open.expiresAt) };
  if (!requirement.released) return { status: "awaiting_release", ...NONE };
  return { status: "gap", ...NONE };
}

function openAssignment(assignments: AssignmentRecord[], today: string) {
  return assignments
    .filter(assignment => assignment.status === "assigned" && sydneyDate(assignment.expiresAt) >= today)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
}

export function licenceStatus(expiresOn: string | null, today: string): "current" | "expiring" | "expired" | "no_expiry" {
  if (!expiresOn) return "no_expiry";
  if (expiresOn < today) return "expired";
  return daysBetween(today, expiresOn) <= EXPIRING_WINDOW_DAYS ? "expiring" : "current";
}
