import guardrails from "./guardrails.json";

export type GuardrailsResult = {
  status: "OK" | "WARN" | "BLOCK";
  message: string;
  suggestedNextDoseMg: number | null;
  timeIntervalHours: number | null;
  nextEligibleAt: string | null;
};

/**
 * This engine MUST NOT invent anything.
 * It must only use values defined in guardrails.json.
 */
export function computeFromGuardrails(input: {
  patientName: string;
  weightKg?: number | null;
  ageYears?: number | null;
  gender?: "male" | "female" | "other" | null;
  drugName: string;
  lastDoseMg?: number | null;
  lastDoseTakenAt?: Date | null;
  notes?: string | null;
}): GuardrailsResult {
  // 1) basic required checks
  if (!input.patientName?.trim()) {
    return block("Patient name is required.");
  }
  if (!input.drugName?.trim()) {
    return block("Drug name is required.");
  }

  // 2) find matching rule
  // NOTE: I don't know your schema yet, so this is a safe placeholder.
  // After you re-upload guardrails.json, I will replace this selector
  // to match your exact JSON structure.
  const rule = findRuleByDrugName(input.drugName);

  if (!rule) {
    return warn("Drug not supported by guardrails.", null, null, null);
  }

  // 3) enforce rule-required inputs
  // Example: if pediatric rule requires weight
  if (rule.requiresWeight && (!input.weightKg || input.weightKg <= 0)) {
    return warn("Weight is required for this drug.", null, null, null);
  }

  // 4) compute dose using ONLY guardrails-provided values
  // Example patterns your guardrails might encode:
  // - mg_per_kg with caps
  // - fixed_mg adult dosing
  // - interval hours
  // - min interval checks vs lastDoseTakenAt
  const dose = computeDoseFromRule(rule, input);
  const intervalHours = rule.intervalHours ?? null;

  const nextEligibleAt =
    input.lastDoseTakenAt && intervalHours
      ? new Date(input.lastDoseTakenAt.getTime() + intervalHours * 3600 * 1000).toISOString()
      : null;

  // 5) optional: check last dose too high vs max single dose
  if (input.lastDoseMg && rule.maxSingleDoseMg && input.lastDoseMg > rule.maxSingleDoseMg) {
    return warn("Last dose exceeds guardrails max single dose. Double-check units.", dose, intervalHours, nextEligibleAt);
  }

  // 6) success
  return {
    status: "OK",
    message: "Computed using guardrails (demo only).",
    suggestedNextDoseMg: dose,
    timeIntervalHours: intervalHours,
    nextEligibleAt,
  };
}

/* ---------- helpers ---------- */

function block(message: string): GuardrailsResult {
  return { status: "BLOCK", message, suggestedNextDoseMg: null, timeIntervalHours: null, nextEligibleAt: null };
}
function warn(message: string, dose: number | null, interval: number | null, nextEligibleAt: string | null): GuardrailsResult {
  return { status: "WARN", message, suggestedNextDoseMg: dose, timeIntervalHours: interval, nextEligibleAt };
}

// PLACEHOLDERS until you re-upload guardrails.json
function findRuleByDrugName(drugName: string): any | null {
  const name = drugName.trim().toLowerCase();

  // Example of a common shape:
  // guardrails.drugs = [{ names: ["tylenol","acetaminophen"], ...rule }]
  const drugs: any[] = (guardrails as any)?.drugs ?? [];
  return (
    drugs.find((d) =>
      (d.names ?? []).some((n: string) => name.includes(String(n).toLowerCase()))
    ) ?? null
  );
}

function computeDoseFromRule(rule: any, input: any): number | null {
  // Example logic:
  // pediatric mg/kg with cap
  if (rule.mgPerKg && input.weightKg) {
    const raw = input.weightKg * rule.mgPerKg;
    const capped = rule.maxSingleDoseMg ? Math.min(raw, rule.maxSingleDoseMg) : raw;
    const rounded = rule.roundToMg ? Math.round(capped / rule.roundToMg) * rule.roundToMg : capped;
    return Math.max(rule.minSingleDoseMg ?? 0, rounded);
  }

  // adult fixed mg
  if (rule.fixedDoseMg) return rule.fixedDoseMg;

  return null;
}