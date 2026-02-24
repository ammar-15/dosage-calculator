import framework from "./dosing_rules.json";

type Gender = "male" | "female" | "other";

type Flags = {
  drug_allergy?: boolean;
  class_allergy?: boolean;
  active_gi_bleed?: boolean;
  severe_liver_disease?: boolean;
  severe_renal_failure?: boolean;
  mild_renal_impairment?: boolean;
  mild_hepatic_impairment?: boolean;
  dehydration?: boolean;
  pregnant?: boolean;
  breastfeeding?: boolean;
};

export type EngineInput = {
  patientName: string;
  weightKg?: number | null;
  ageYears?: number | null;
  gender?: Gender | null;
  drugName: string;
  lastDoseMg?: number | null;
  lastDoseTakenAt?: Date | null;
  notes?: string | null;
  flags?: Flags;
  symptoms?: string[];
};

export type GuardrailsResult = {
  status: "OK" | "WARN" | "STOP";
  message: string;
  suggestedNextDoseMg: number | null;
  timeIntervalHours: number | null;
  nextEligibleAt: string | null;
  capsApplied: boolean;
  appliedFormulaType: string | null;
  blockReasons: string[];
  ruleVersion: string;
};

type Framework = {
  meta: { rules_version: string };
  age_weight_logic: {
    plausibility_limits: {
      weight_kg_min: number;
      weight_kg_max: number;
      age_years_min: number;
      age_years_max: number;
    };
  };
  contraindication_handling: {
    hard_stop_conditions: string[];
  };
  antimicrobial_stewardship_rules: {
    require_supported_indication: boolean;
  };
  emergency_escalation: {
    hard_stop_symptoms: string[];
  };
  fail_safe_policy: {
    on_engine_error_message: string;
  };
};

const cfg = framework as Framework;

const EMERGENCY_KEYWORDS = new Set(
  (cfg.emergency_escalation?.hard_stop_symptoms ?? []).map((s) =>
    String(s).toLowerCase(),
  ),
);

function addHoursISO(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 3600 * 1000).toISOString();
}

function failSafe(message: string, reason: string): GuardrailsResult {
  return {
    status: "STOP",
    message,
    suggestedNextDoseMg: null,
    timeIntervalHours: null,
    nextEligibleAt: null,
    capsApplied: false,
    appliedFormulaType: null,
    blockReasons: [reason],
    ruleVersion: cfg.meta?.rules_version ?? "unknown",
  };
}

export function computeUsingGuardrails(input: EngineInput): GuardrailsResult {
  try {
    const blockReasons: string[] = [];

    const symptoms = (input.symptoms ?? []).map((s) => String(s).toLowerCase());
    if (symptoms.some((s) => EMERGENCY_KEYWORDS.has(s))) {
      return failSafe("Emergency symptom trigger - demo will not calculate.", "emergency_trigger");
    }

    if (!input.patientName?.trim()) blockReasons.push("missing_patient_name");
    if (!input.drugName?.trim()) blockReasons.push("missing_drug_name");
    if (!Number.isFinite(input.ageYears ?? NaN)) blockReasons.push("missing_age_years");
    if (!Number.isFinite(input.weightKg ?? NaN)) blockReasons.push("missing_weight_kg");
    if (!input.lastDoseTakenAt) blockReasons.push("missing_last_dose_time");
    if (
      cfg.antimicrobial_stewardship_rules.require_supported_indication &&
      !(input.notes ?? "").trim()
    ) {
      blockReasons.push("missing_indication");
    }

    const weightKg = Number(input.weightKg);
    const ageYears = Number(input.ageYears);

    const lim = cfg.age_weight_logic.plausibility_limits;
    if (weightKg < lim.weight_kg_min || weightKg > lim.weight_kg_max) {
      return failSafe("Weight outside plausible limits - demo will not calculate.", "weight_out_of_range");
    }
    if (ageYears < lim.age_years_min || ageYears > lim.age_years_max) {
      return failSafe("Age outside plausible limits - demo will not calculate.", "age_out_of_range");
    }

    const flags = input.flags ?? {};
    for (const cond of cfg.contraindication_handling.hard_stop_conditions ?? []) {
      if ((flags as Record<string, boolean | undefined>)[cond] === true) {
        return failSafe(`Hard stop: ${cond}.`, `hard_stop_${cond}`);
      }
    }

    // Framework-only deterministic demo calculation (no whitelist file dependency).
    const intervalHours = 6;
    const rawDose = weightKg * 10;
    const perDoseCap = 1000;
    const cappedDose = Math.min(rawDose, perDoseCap);
    const roundedDose = Math.round(cappedDose / 5) * 5;

    const nextEligibleAt = input.lastDoseTakenAt
      ? addHoursISO(input.lastDoseTakenAt, intervalHours)
      : null;

    return {
      status: rawDose > perDoseCap ? "WARN" : "OK",
      message: rawDose > perDoseCap ? "Cap applied per demo framework." : "Ready.",
      suggestedNextDoseMg: roundedDose,
      timeIntervalHours: intervalHours,
      nextEligibleAt,
      capsApplied: rawDose > perDoseCap,
      appliedFormulaType: "mg_per_kg_per_dose",
      blockReasons: [],
      ruleVersion: cfg.meta?.rules_version ?? "unknown",
    };
  } catch {
    return failSafe(cfg.fail_safe_policy.on_engine_error_message, "engine_error");
  }
}

// Keep existing screen import style stable.
export const computeFromGuardrails = computeUsingGuardrails;
