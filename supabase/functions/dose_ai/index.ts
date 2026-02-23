import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type DoseReq = {
  drug_code?: string | null;
  drug_codes?: string[] | null;
  weight_kg?: number | string | null;
  age_years?: number | string | null;
  gender?: string | null;
  last_dose_mg?: number | string | null;
  last_dose_time?: string | null;
  patient_notes?: string | null;
};

type DoseResp = {
  status: "OK" | "WARN" | "BLOCK";
  message: string;
  suggested_next_dose_mg: number | null;
  interval_hours: number | null;
  next_eligible_time: string | null;
  patient_specific_notes: string | null;
};

type CacheRow = {
  drug_code: string | null;
  pm_date: string | null;
  updated_at: string | null;
  cache_status: string | null;
  extracted_json: unknown;
};

type PlausibilityGate = {
  status: "OK" | "WARN" | "BLOCK";
  message?: string;
};

function getEnv(name: string): string {
  const denoVal = (globalThis as any)?.Deno?.env?.get?.(name);
  if (typeof denoVal === "string" && denoVal) return denoVal;
  const procVal = (globalThis as any)?.process?.env?.[name];
  if (typeof procVal === "string" && procVal) return procVal;
  throw new Error(`Missing env: ${name}`);
}

const PROJECT_URL = getEnv("PROJECT_URL");
const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");

const sb = createClient(PROJECT_URL, SERVICE_KEY);

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

function safeTime(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
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

  if (age < 0 || age > 120) return { status: "BLOCK", message: "Age out of supported range." };
  if (wt < 1 || wt > 400) return { status: "BLOCK", message: "Weight out of supported range." };

  if (age < 2 && wt > 25) {
    return { status: "BLOCK", message: "Age/weight combination looks implausible." };
  }
  if (age >= 2 && age <= 10 && wt > 80) {
    return { status: "BLOCK", message: "Age/weight combination looks implausible." };
  }
  if (age > 18 && wt < 15) {
    return { status: "BLOCK", message: "Weight too low for adult; verify input." };
  }
  if (age > 18 && wt < 25) {
    return { status: "WARN", message: "Low weight for adult; verify input." };
  }
  if (age >= 10 && age <= 18 && wt > 200) {
    return { status: "WARN", message: "High weight for teen; verify input." };
  }

  return { status: "OK" };
}

function extractMaxDailyMg(extractedJson: unknown): number | null {
  const dosing = (extractedJson as any)?.recommended_dosing;
  if (!Array.isArray(dosing)) return null;

  const candidates: number[] = [];
  for (const row of dosing) {
    const txt = String(row?.max_text ?? "").toLowerCase();
    if (!txt) continue;
    if (!txt.includes("day") && !txt.includes("daily")) continue;

    const gMatches = txt.matchAll(/(\d+(?:\.\d+)?)\s*g(?:\s*\/\s*day|\s*per\s*day|\s*daily)?/g);
    for (const m of gMatches) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) candidates.push(n * 1000);
    }

    const mgMatches = txt.matchAll(
      /(\d+(?:\.\d+)?)\s*mg(?:\s*\/\s*day|\s*per\s*day|\s*daily)?/g,
    );
    for (const m of mgMatches) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) candidates.push(n);
    }
  }

  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function getTotalDailyMgIfDailyKgRule(
  extractedJson: unknown,
  weightKgRaw: number | string | null | undefined,
): number | null {
  const weightKg = asNumber(weightKgRaw);
  if (!weightKg || weightKg <= 0) return null;

  const haystack = JSON.stringify((extractedJson as any)?.recommended_dosing ?? extractedJson);
  const lower = haystack.toLowerCase();
  const impliesDaily =
    lower.includes("mg/kg/day") ||
    lower.includes("mg/kg per day") ||
    lower.includes("divided doses") ||
    lower.includes("divided dose");
  if (!impliesDaily) return null;

  const mgPerKgMatch = lower.match(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg(?:\s*\/\s*day|\s*per\s*day)?/);
  if (!mgPerKgMatch) return null;
  const mgPerKg = Number(mgPerKgMatch[1]);
  if (!Number.isFinite(mgPerKg) || mgPerKg <= 0) return null;

  return mgPerKg * weightKg;
}

async function computeFromMonograph(
  body: DoseReq,
  primaryExtractedJson: unknown,
  otherVariantMonographs: { drug_code: string; extracted_json: unknown }[],
): Promise<DoseResp> {
  const prompt = `
Hackathon demo. Not medical advice.

You are given structured dosing-relevant monograph data in JSON plus patient inputs.
You MUST use ONLY the provided extracted monograph JSON.
If the monograph does not contain enough info to compute, return BLOCK.

CRITICAL RULES:
- If monograph says "mg/kg in divided doses" or "mg/kg daily", treat it as TOTAL DAILY DOSE.
- You MUST divide total daily dose by the number of doses to get per-dose mg.
- If the indication in patient_notes is not present in recommended_dosing indications, return:
  status="BLOCK" and explain "indication not supported by this monograph JSON".
- If last_dose_time is null, next_eligible_time must be null (do not invent).
- Output must be a single per-dose mg value (not total daily).
- If dose_text contains "mg/kg" AND contains "daily" OR "per day" OR "divided doses" OR "in X doses",
  interpret as TOTAL DAILY DOSE and divide by number of doses.

PATIENT NOTES RULES (STRICT):
- You may ONLY change dose/interval based on patient notes if the monograph JSON includes an explicit matching adjustment rule in:
  - dose_adjustments
  - contraindications
  - interactions_affecting_dose
- If notes mention renal/hepatic/heart/etc but the monograph JSON has no matching dosing adjustment guidance, do NOT adjust dose.
- In that case, return status="WARN" and patient_specific_notes explaining:
  "Monograph cache does not contain dosing adjustment guidance for the noted condition."

INDICATION MATCH (STRICT):
- Only compute if at least one recommended_dosing.indication meaningfully matches patient_notes indication text OR the monograph has a general dosing section that is not indication-specific.
- If no match, return BLOCK with: "No monograph dosing found for this indication/route in cached data."

Return STRICT JSON only:

{
  "status": "OK"|"WARN"|"BLOCK",
  "message": string,
  "suggested_next_dose_mg": number|null,
  "interval_hours": number|null,
  "next_eligible_time": string|null,
  "patient_specific_notes": string|null
}

Patient:
weight_kg=${asNumber(body.weight_kg)}
age_years=${asNumber(body.age_years)}
gender=${body.gender ?? null}
last_dose_mg=${asNumber(body.last_dose_mg)}
last_dose_time=${body.last_dose_time ?? null}
notes=${body.patient_notes ?? null}

Primary monograph extracted JSON:
${JSON.stringify(primaryExtractedJson)}

Other variant monographs:
${JSON.stringify(otherVariantMonographs)}
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

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  const sliced =
    firstBrace >= 0 && lastBrace >= 0
      ? content.slice(firstBrace, lastBrace + 1)
      : content;

  const parsed = JSON.parse(sliced);

  const status =
    parsed?.status === "OK" ||
    parsed?.status === "WARN" ||
    parsed?.status === "BLOCK"
      ? parsed.status
      : "BLOCK";

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
    patient_specific_notes:
      typeof parsed?.patient_specific_notes === "string"
        ? parsed.patient_specific_notes
        : null,
  };
}

export async function doseAiHandler(req: { json: () => Promise<DoseReq> }) {
  try {
    const body = await req.json();
    const gate = plausibilityGate(body);
    if (gate.status === "BLOCK") {
      return json(200, {
        status: "BLOCK",
        message: gate.message ?? "Input blocked by plausibility gate.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    const codes =
      Array.isArray(body.drug_codes) && body.drug_codes.length
        ? body.drug_codes.map(String)
        : [(body.drug_code ?? "").toString()].filter(Boolean);

    if (!codes.length) {
      return json(200, {
        status: "BLOCK",
        message: "drug_code is required",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    const { data: rows, error: cacheErr } = await sb
      .from("dpd_pm_cache")
      .select("drug_code, pm_date, updated_at, cache_status, extracted_json")
      .in("drug_code", codes);

    if (cacheErr) {
      return json(500, {
        status: "BLOCK",
        message: cacheErr.message,
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    const okRows = ((rows ?? []) as CacheRow[]).filter(
      (r) => r.cache_status === "OK" && r.extracted_json,
    );

    if (!okRows.length) {
      return json(200, {
        status: "BLOCK",
        message:
          "No Product Monograph dosing data available in DPD for this product.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    okRows.sort((a, b) => {
      const ad = safeTime(a.pm_date) || safeTime(a.updated_at);
      const bd = safeTime(b.pm_date) || safeTime(b.updated_at);
      return bd - ad;
    });

    const primary = okRows[0];
    const others = okRows.slice(1).map((r) => ({
      drug_code: String(r.drug_code),
      extracted_json: r.extracted_json,
    }));

    const calc = await computeFromMonograph(
      body,
      primary.extracted_json,
      others,
    );

    const totalDailyMg = getTotalDailyMgIfDailyKgRule(
      primary.extracted_json,
      body.weight_kg,
    );
    if (
      totalDailyMg !== null &&
      calc.suggested_next_dose_mg !== null &&
      calc.suggested_next_dose_mg > totalDailyMg
    ) {
      return json(200, {
        status: "BLOCK",
        message: "Model returned daily dose as per-dose.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    if (
      calc.interval_hours !== null &&
      (calc.interval_hours < 1 || calc.interval_hours > 72)
    ) {
      return json(200, {
        status: "BLOCK",
        message: "Interval out of plausible range.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "No monograph data available.",
      });
    }

    const maxDailyMg = extractMaxDailyMg(primary.extracted_json);
    if (
      maxDailyMg !== null &&
      calc.suggested_next_dose_mg !== null &&
      calc.interval_hours !== null &&
      calc.interval_hours > 0
    ) {
      const estimatedDaily = calc.suggested_next_dose_mg * (24 / calc.interval_hours);
      if (estimatedDaily > maxDailyMg) {
        return json(200, {
          status: "BLOCK",
          message: "Computed regimen exceeds monograph max daily limit.",
          suggested_next_dose_mg: null,
          interval_hours: null,
          next_eligible_time: null,
          patient_specific_notes: null,
          ai_summary: "No monograph data available.",
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
      next_eligible_time: calc.next_eligible_time,
      patient_specific_notes: finalPatientNotes,
      ai_summary:
        finalStatus === "BLOCK"
          ? "No monograph data available."
          : "Dose computed from monograph cache.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI dose calculation failed";
    return json(500, {
      status: "BLOCK",
      message: msg,
      suggested_next_dose_mg: null,
      interval_hours: null,
      next_eligible_time: null,
      patient_specific_notes: null,
      ai_summary: "AI explanation unavailable.",
    });
  }
}

export default doseAiHandler;

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  return doseAiHandler({ json: () => req.json() });
});
