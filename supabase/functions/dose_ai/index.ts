import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type DoseReq = {
  extracted_json?: unknown;
  weight_kg?: number | string | null;
  age_years?: number | string | null;
  gender?: string | null;
  last_dose_mg?: number | string | null;
  last_dose_time?: string | null;
  patient_notes?: string | null;
};

type DoseResp = {
  status: "OK" | "WARN";
  message: string;
  suggested_next_dose_mg: number | null;
  interval_hours: number | null;
  next_eligible_time: string | null;
  max_daily_mg: number | null;
  max_daily_cap_quote: string | null;
  max_daily_cap_page: number | null;
  assumptions: string[] | null;
  patient_specific_notes: string | null;
  ai_summary: string | null;
};

type PlausibilityGate = {
  status: "OK" | "WARN";
  message?: string;
};

function getEnv(name: string): string {
  const denoVal = (globalThis as any)?.Deno?.env?.get?.(name);
  if (typeof denoVal === "string" && denoVal) return denoVal;
  const procVal = (globalThis as any)?.process?.env?.[name];
  if (typeof procVal === "string" && procVal) return procVal;
  throw new Error(`Missing env: ${name}`);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function plausibilityGate(body: DoseReq): PlausibilityGate {
  const age = asNumber(body.age_years);
  const wt = asNumber(body.weight_kg);

  if (age == null || wt == null) {
    return {
      status: "WARN",
      message: "Missing age/weight; calculation may be limited.",
    };
  }

  if (age < 0 || age > 120)
    return { status: "WARN", message: "Age out of supported range." };
  if (wt < 1 || wt > 400)
    return { status: "WARN", message: "Weight out of supported range." };

  if (age < 2 && wt > 25) {
    return {
      status: "WARN",
      message: "Age/weight combination looks implausible.",
    };
  }
  if (age >= 2 && age <= 10 && wt > 80) {
    return {
      status: "WARN",
      message: "Age/weight combination looks implausible.",
    };
  }
  if (age > 18 && wt < 15) {
    return {
      status: "WARN",
      message: "Weight too low for adult; verify input.",
    };
  }
  if (age > 18 && wt < 25) {
    return { status: "WARN", message: "Low weight for adult; verify input." };
  }
  if (age >= 10 && age <= 18 && wt > 200) {
    return { status: "WARN", message: "High weight for teen; verify input." };
  }

  return { status: "OK" };
}

function isUsableExtractedJson(v: any): boolean {
  if (!v || typeof v !== "object") return false;

  const hasEvidence =
    Array.isArray((v as any)?.evidence_blocks) &&
    (v as any).evidence_blocks.length > 0;

  const hasRules = Array.isArray(v.rules) && v.rules.length > 0;
  const hasTables = Array.isArray(v.tables) && v.tables.length > 0;
  const hasSections = Array.isArray(v.sections) && v.sections.length > 0;

  const hasDosing =
    v.dosing &&
    (Array.isArray(v.dosing.oral) ||
      Array.isArray(v.dosing.intravenous) ||
      Array.isArray(v.dosing.other_routes));

  const hasAnyDosingRows =
    (Array.isArray(v?.dosing?.oral) && v.dosing.oral.length > 0) ||
    (Array.isArray(v?.dosing?.intravenous) &&
      v.dosing.intravenous.length > 0) ||
    (Array.isArray(v?.dosing?.other_routes) &&
      v.dosing.other_routes.length > 0);

  const hasCaps =
    Array.isArray(v.max_dose_limits) && v.max_dose_limits.length > 0;
  const hasMonitoring =
    Array.isArray(v.monitoring_requirements) &&
    v.monitoring_requirements.length > 0;

  return (
    hasEvidence ||
    hasRules ||
    hasTables ||
    hasSections ||
    hasDosing ||
    hasAnyDosingRows ||
    hasCaps ||
    hasMonitoring
  );
}

function parseJsonFromContent(content: string): any {
  const stripped = content
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  const sliced =
    firstBrace >= 0 && lastBrace >= 0
      ? stripped.slice(firstBrace, lastBrace + 1)
      : stripped;
  return JSON.parse(sliced);
}

function extractMaxDailyMg(extractedJson: unknown): number | null {
  const j: any = extractedJson;
  const candidates: number[] = [];

  // A) New schema: scan evidence_blocks text
  if (Array.isArray(j?.evidence_blocks)) {
    for (const b of j.evidence_blocks) {
      const txt = String(b?.text ?? "").toLowerCase();
      if (!txt) continue;

      // look for "should not exceed" / "max" + daily/day
      if (!txt.includes("day") && !txt.includes("daily")) continue;

      for (const m of txt.matchAll(/(\d+(?:\.\d+)?)\s*g(?:\s*\/\s*day|\s*per\s*day|\s*daily)?/g)) {
        candidates.push(Number(m[1]) * 1000);
      }
      for (const m of txt.matchAll(/(\d+(?:\.\d+)?)\s*mg(?:\s*\/\s*day|\s*per\s*day|\s*daily)?/g)) {
        candidates.push(Number(m[1]));
      }
    }
  }

  // B) Backward compatible: max_dose_limits
  if (Array.isArray(j?.max_dose_limits)) {
    for (const lim of j.max_dose_limits) {
      const unit = String(lim?.unit ?? "").toLowerCase();
      const n = Number(lim?.numeric_value);
      if (!Number.isFinite(n)) continue;
      if (unit === "g") candidates.push(n * 1000);
      if (unit === "mg") candidates.push(n);
    }
  }

  // C) Backward compatible: dosing max_daily_dose fields
  const dosingLists = [
    ...(j?.dosing?.oral ?? []),
    ...(j?.dosing?.intravenous ?? []),
    ...(j?.dosing?.other_routes ?? []),
  ];
  for (const row of dosingLists) {
    const txt = String(row?.max_daily_dose ?? "").toLowerCase();
    if (!txt) continue;
    const g = txt.match(/(\d+(?:\.\d+)?)\s*g/);
    const mg = txt.match(/(\d+(?:\.\d+)?)\s*mg/);
    if (g) candidates.push(Number(g[1]) * 1000);
    if (mg) candidates.push(Number(mg[1]));
  }

  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function trustAiDailyCap(calc: any): number | null {
  const n = typeof calc?.max_daily_mg === "number" ? calc.max_daily_mg : null;
  const q =
    typeof calc?.max_daily_cap_quote === "string"
      ? calc.max_daily_cap_quote.toLowerCase()
      : "";
  const p = typeof calc?.max_daily_cap_page === "number" ? calc.max_daily_cap_page : null;

  if (n === null) return null;
  if (!q) return null;

  const hasUnits = /\b\d+(\.\d+)?\s*(mg|g)\b/i.test(q);
  const hasDaily = /(per day|daily|24[-\s]?hour|in 24 hours|a day)/i.test(q);

  if (!hasUnits || !hasDaily) return null;
  if (p === null) return null;

  return n;
}

async function computeFromMonograph(
  body: DoseReq,
  extractedJson: unknown,
  OPENAI_API_KEY: string,
): Promise<DoseResp> {
  const prompt = `
You are given extracted_json from a Canadian Product Monograph (already structured).

Goal: compute next dose (mg), interval (hours), and next eligible time using ONLY extracted_json.
Do NOT invent numbers.

------------------------------------------------
STEP 0 — CLINICAL FLAGS FROM patient_notes (IMPORTANT)
------------------------------------------------
Before selecting a dose, infer these flags from patient_notes using keyword matching.
Treat these as TRUE if ANY keyword appears (case-insensitive):

RENAL_FLAG keywords:
"renal", "kidney", "ckd", "chronic kidney", "nephro", "eGFR", "creatinine clearance", "CrCl", "dialysis", "uremia"

HEPATIC_FLAG keywords:
"hepatic", "liver", "cirrhosis", "hepatitis", "ALT", "AST", "bilirubin"

RESP_FLAG keywords (smoking / lung disease):
"smoker", "smoking", "COPD", "asthma", "bronchitis", "emphysema", "lung disease", "shortness of breath", "wheeze"

PREG_FLAG keywords:
"pregnant", "pregnancy", "breastfeeding", "lactation"

If patient_notes are empty, all flags are FALSE.

------------------------------------------------
STEP 1 — FIND RELEVANT MONOGRAPH SAFETY CONTENT (SYNONYM-AWARE)
------------------------------------------------
Even if extracted_json does NOT have renal_adjustment/hepatic_adjustment fields,
you MUST search ALL of extracted_json (any text fields, sections_summary, max_dose_limits,
monitoring_requirements, special_populations_notes, contraindications, administration_constraints)
for safety/adjustment language using synonym matching.

Renal adjustment synonym phrases (examples):
"impaired renal function", "renal insufficiency", "decreased renal clearance",
"dosage adjustment required", "reduce dose", "extend interval", "monitor serum levels",
"avoid toxic levels", "accumulation", "nephrotoxicity"

Respiratory risk / monitoring synonym phrases:
"respiratory", "pulmonary", "wheezing", "dyspnea", "bronchospasm", "COPD", "asthma",
and any explicit "monitor" guidance that mentions respiratory status or related parameters.

If RENAL_FLAG is TRUE:
- Search extracted_json (especially evidence_blocks) for any explicit numeric renal dose/interval adjustment.
- If numeric renal adjustment is found, apply it.
- If NO numeric renal adjustment is found:
  - Return the best explicit STANDARD regimen from the monograph (do not invent an adjustment)
  - status="WARN"
  - In patient_specific_notes, explicitly say:
    "Renal impairment mentioned in patient_notes; no explicit numeric renal adjustment found in monograph extraction; standard regimen shown."
If RENAL_FLAG is FALSE:
- Assume general dosing scenario unless monograph itself restricts it.
- In patient_specific_notes, explicitly say:
  "No renal impairment mentioned in patient_notes; used general adult dosing."

If RESP_FLAG is TRUE:
- Include any monograph monitoring requirements or adverse reaction risks that relate to respiratory symptoms
  IF they exist in extracted_json (do not invent). If none exist, do not add respiratory claims.

------------------------------------------------
STEP 2 — DOSE SELECTION (EVIDENCE_BLOCKS FIRST)
------------------------------------------------
You MUST treat extracted_json.evidence_blocks as the PRIMARY source of truth.

Find candidate dosing regimens by scanning evidence_blocks where:
- type is "dosing" OR heading contains synonyms of dosing/admin (dosage, administration, posology)
- include IV/oral keywords in the text itself

If evidence_blocks are present:
1) pick dosing regimen from evidence_blocks (primary)
2) only if evidence_blocks are missing/empty, fall back to older schema fields:
   population_specific_dosing, dosing.*, rules, max_dose_limits

Population:
neonate (<1 month), infant (<1 year), child (1–11), adolescent (12–17), adult (>=18)

Route selection:
- Choose route using BOTH patient_notes and the dosing text.
- If route unclear, choose the most explicit adult regimen and set status="WARN".

Dose math rules:
- If mg/kg exists, calculate using weight_kg (if missing -> WARN + null).
- Only compute mg/kg if the dosing text explicitly contains "mg/kg".
- If dosing text only contains fixed mg regimens, do not convert to mg/kg.
- If "in 3 or 4 divided doses" and no interval is stated, use 4 divided doses (interval_hours = 24/4 = 6),
  unless extracted_json explicitly forces 3 only.
- If fixed-dose options exist, choose the lower total daily exposure unless indication/route text clearly matches the other.
- If dosing requires lab values (CrCl/SCr/levels) and they are not provided AND no explicit numeric fallback exists, return WARN and standard regimen only.

------------------------------------------------
MAX DAILY CAP HANDLING (MUST SELF-CORRECT)
------------------------------------------------
If you find an explicit maximum daily dose cap in extracted_json, you MUST:

1) Provide it as:
   - max_daily_mg (number)
   - max_daily_cap_quote (exact short quote)
   - max_daily_cap_page (page number if available)
   Only set these if the quote explicitly states daily/day/24-hour maximum.

2) Build a list of candidate explicit regimens from evidence_blocks (dose + interval).
   Example candidates:
   - 500 mg every 6 hours
   - 1 g every 12 hours
   - 10 mg/kg every 6 hours (requires weight)

3) Select a candidate regimen that DOES NOT exceed the max daily cap.
   - Prefer an explicitly stated alternative regimen over inventing a new interval.
   - You may choose the lower total daily exposure regimen if both are explicit.
   - Do NOT "reduce dose" unless that reduced dose is explicitly stated in the monograph.

4) If NO explicit candidate regimen can satisfy the cap:
   - If patient already took >= max_daily_mg within the last 24h (based on last_dose_mg only if you can safely interpret it), return:
     suggested_next_dose_mg = 0
     interval_hours = null
     next_eligible_time = null
     message must say: "Max daily dose already reached; no additional dose recommended within 24 hours per monograph cap."
   - Otherwise return WARN with the safest explicit regimen and explain the conflict.

Next eligible time:
- If last_dose_time and interval_hours exist, next_eligible_time = last_dose_time + interval_hours.

------------------------------------------------
OUTPUT REQUIREMENTS (STRICT)
------------------------------------------------
Return JSON ONLY:
{
  "status": "OK"|"WARN",
  "message": string,
  "suggested_next_dose_mg": number|null,
  "interval_hours": number|null,
  "next_eligible_time": string|null,
  "max_daily_mg": number|null,
  "max_daily_cap_quote": string|null,
  "max_daily_cap_page": number|null,
  "assumptions": string[],
  "patient_specific_notes": string|null,
  "ai_summary": string
}

patient_specific_notes MUST include:
- matched route + population
- exact dosing row used (short quote)
- any max daily cap referenced (short quote)
- if RENAL_FLAG: include monograph renal caution/monitoring text if present; otherwise say "no renal guidance found in monograph"
- if RESP_FLAG: include monograph respiratory-related monitoring/risk text only if present
- If no renal impairment keywords and no labs provided → add assumption: "Assumed normal renal function (no renal impairment provided)."
- If dialysis not mentioned → assumption: "Assumed not on dialysis (not mentioned)."

Patient:
weight_kg=${asNumber(body.weight_kg)}
age_years=${asNumber(body.age_years)}
gender=${body.gender ?? null}
last_dose_mg=${asNumber(body.last_dose_mg)}
last_dose_time=${body.last_dose_time ?? null}
patient_notes=${body.patient_notes ?? null}

extracted_json:
${JSON.stringify(extractedJson)}
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI dose calculation failed: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Empty OpenAI response");
  }

  const parsed = parseJsonFromContent(content);
  const status =
    parsed?.status === "OK"
      ? "OK"
      : parsed?.status === "WARN"
        ? "WARN"
        : "WARN";

  return {
    status,
    message:
      typeof parsed?.message === "string"
        ? parsed.message
        : "Unable to compute from monograph.",
    suggested_next_dose_mg:
      typeof parsed?.suggested_next_dose_mg === "number"
        ? parsed.suggested_next_dose_mg
        : null,
    interval_hours:
      typeof parsed?.interval_hours === "number" ? parsed.interval_hours : null,
    next_eligible_time:
      typeof parsed?.next_eligible_time === "string"
        ? parsed.next_eligible_time
        : null,
    max_daily_mg:
      typeof parsed?.max_daily_mg === "number" ? parsed.max_daily_mg : null,
    max_daily_cap_quote:
      typeof parsed?.max_daily_cap_quote === "string"
        ? parsed.max_daily_cap_quote
        : null,
    max_daily_cap_page:
      typeof parsed?.max_daily_cap_page === "number"
        ? parsed.max_daily_cap_page
        : null,
    assumptions: Array.isArray(parsed?.assumptions)
      ? parsed.assumptions.map(String)
      : null,
    patient_specific_notes:
      typeof parsed?.patient_specific_notes === "string"
        ? parsed.patient_specific_notes
        : null,
    ai_summary:
      typeof parsed?.ai_summary === "string" ? parsed.ai_summary : null,
  };
}

export async function doseAiHandler(
  req: { json: () => Promise<DoseReq> },
  OPENAI_API_KEY: string,
) {
  try {
    const body = await req.json();
    const gate = plausibilityGate(body);

    if (!isUsableExtractedJson(body.extracted_json)) {
      return json(200, {
        status: "WARN",
        message: "Monograph incomplete.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "Monograph incomplete.",
      });
    }

    const calc = await computeFromMonograph(
      body,
      body.extracted_json,
      OPENAI_API_KEY,
    );

    let nextEligible = calc.next_eligible_time;
    if (!nextEligible && calc.interval_hours && body.last_dose_time) {
      const t0 = new Date(body.last_dose_time);
      if (!Number.isNaN(t0.getTime())) {
        nextEligible = new Date(
          t0.getTime() + calc.interval_hours * 60 * 60 * 1000,
        ).toISOString();
      }
    }

    if (
      calc.interval_hours !== null &&
      (calc.interval_hours < 1 || calc.interval_hours > 72)
    ) {
      return json(200, {
        status: "WARN",
        message: "Interval out of plausible range.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "Interval out of plausible range.",
      });
    }

    const trustedAiCap = trustAiDailyCap(calc);
    const maxDailyMg = trustedAiCap ?? extractMaxDailyMg(body.extracted_json);
    if (
      maxDailyMg !== null &&
      calc.suggested_next_dose_mg !== null &&
      calc.interval_hours !== null &&
      calc.interval_hours > 0
    ) {
      const estimatedDaily =
        calc.suggested_next_dose_mg * (24 / calc.interval_hours);
      if (estimatedDaily > maxDailyMg) {
        const lastDose = asNumber(body.last_dose_mg);
        if (lastDose !== null && lastDose >= maxDailyMg) {
          return json(200, {
            status: "WARN",
            message:
              "Max daily dose already reached/exceeded; no additional dose eligible within 24 hours per monograph cap.",
            suggested_next_dose_mg: 0,
            interval_hours: null,
            next_eligible_time: null,
            max_daily_mg: maxDailyMg,
            max_daily_cap_quote: calc.max_daily_cap_quote,
            max_daily_cap_page: calc.max_daily_cap_page,
            assumptions: (calc as any)?.assumptions ?? [],
            patient_specific_notes:
              (calc.patient_specific_notes ?? "") +
              ` Cap used: ${maxDailyMg} mg/day.`,
            ai_summary: calc.ai_summary ?? "Cap reached; next dose set to 0.",
          });
        }

        return json(200, {
          status: "WARN",
          message:
            "Computed regimen appears to exceed monograph max daily limit; verify. Returning best explicit regimen.",
          suggested_next_dose_mg: calc.suggested_next_dose_mg,
          interval_hours: calc.interval_hours,
          next_eligible_time: nextEligible,
          max_daily_mg: maxDailyMg,
          max_daily_cap_quote: calc.max_daily_cap_quote,
          max_daily_cap_page: calc.max_daily_cap_page,
          assumptions: (calc as any)?.assumptions ?? [],
          patient_specific_notes: calc.patient_specific_notes,
          ai_summary: calc.ai_summary,
        });
      }
    }

    const finalStatus =
      gate.status === "WARN" && calc.status === "OK" ? "WARN" : calc.status;
    const finalMessage =
      gate.status === "WARN" && gate.message
        ? `${calc.message} ${gate.message}`
        : calc.message;
    const finalPatientNotes =
      gate.status === "WARN" && gate.message
        ? `${gate.message}${calc.patient_specific_notes ? ` ${calc.patient_specific_notes}` : ""}`
        : calc.patient_specific_notes;

    return json(200, {
      status: finalStatus,
      message: finalMessage,
      suggested_next_dose_mg: calc.suggested_next_dose_mg,
      interval_hours: calc.interval_hours,
      next_eligible_time: nextEligible,
      max_daily_mg: maxDailyMg,
      max_daily_cap_quote: calc.max_daily_cap_quote,
      max_daily_cap_page: calc.max_daily_cap_page,
      assumptions: calc.assumptions,
      patient_specific_notes: finalPatientNotes,
      ai_summary: calc.ai_summary ?? "Dose computed from monograph data.",
    });
  } catch (e) {
    console.error("dose_ai crash:", e);
    return json(500, {
      status: "ERROR",
      message: e instanceof Error ? e.message : String(e),
      where: "dose_ai",
    });
  }
}

export default doseAiHandler;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
    return await doseAiHandler(
      { json: () => req.json() },
      OPENAI_API_KEY,
    );
  } catch (e) {
    console.error("dose_ai error:", e);
    return json(500, {
      status: "WARN",
      code: "DOSE_AI_CRASH",
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : null,
    });
  }
});
