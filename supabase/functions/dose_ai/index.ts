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
  patient_specific_notes: string | null;
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

const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");

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

  if (age < 0 || age > 120) return { status: "WARN", message: "Age out of supported range." };
  if (wt < 1 || wt > 400) return { status: "WARN", message: "Weight out of supported range." };

  if (age < 2 && wt > 25) {
    return { status: "WARN", message: "Age/weight combination looks implausible." };
  }
  if (age >= 2 && age <= 10 && wt > 80) {
    return { status: "WARN", message: "Age/weight combination looks implausible." };
  }
  if (age > 18 && wt < 15) {
    return { status: "WARN", message: "Weight too low for adult; verify input." };
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
  const hasRules = Array.isArray(v.rules) && v.rules.length > 0;
  const hasTables = Array.isArray(v.tables) && v.tables.length > 0;
  const hasSections = Array.isArray(v.sections) && v.sections.length > 0;
  return hasRules || hasTables || hasSections;
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
  const rules = (extractedJson as any)?.rules;
  if (!Array.isArray(rules)) return null;

  const candidates: number[] = [];
  for (const rule of rules) {
    const txt = String(rule?.then?.notes ?? "").toLowerCase();
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

async function computeFromMonograph(
  body: DoseReq,
  extractedJson: unknown,
): Promise<DoseResp> {
  const prompt = `
You are given extracted_json from a Product Monograph.
It includes sections (headings + paragraphs) and may include tables and/or rules.

PRIMARY GOAL:
Return next dose (mg), interval (hours), and next eligible time based ONLY on info found in extracted_json.
Do NOT invent numbers.

DATA USE ORDER:
1) If extracted_json.rules contains a matching DOSING rule with numeric dose + interval_hours -> use it. calculate it
2) Else, calculate dosing from extracted_json.tables (rows + footer_notes).
3) Else, calculate dosing from extracted_json.sections where heading_norm is DOSING / ADMINISTRATION / SPECIAL_POPULATIONS.

STRICT:
- Only output values that are explicitly stated in extracted_json.
- If you see a range (e.g., 125–500 mg), choose the LOWER bound unless the text indicates otherwise.
- If interval is a range (6–8h), choose the SHORTER interval unless text indicates otherwise.
- If route-specific dosing exists, match route if provided in text; otherwise leave route unspecified.
- If dosing is TOTAL DAILY DOSE and divided doses are stated, compute per-dose = total_daily / divided_doses.
- If divided doses exist but interval is not given, derive interval_hours = 24 / divided_doses.

OUTPUT JSON ONLY:

{
  "status": "OK"|"WARN",
  "message": string,
  "suggested_next_dose_mg": number|null,
  "interval_hours": number|null,
  "next_eligible_time": string|null,
  "patient_specific_notes": string|null,
  "ai_summary": string
}

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

    if (!isUsableExtractedJson(body.extracted_json)) {
      return json(200, {
        status: "WARN",
        message: "Monograph incomplete. Using fallback logic.",
        suggested_next_dose_mg: null,
        interval_hours: null,
        next_eligible_time: null,
        patient_specific_notes: null,
        ai_summary: "Monograph incomplete.",
      });
    }

    const calc = await computeFromMonograph(body, body.extracted_json);

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

    const maxDailyMg = extractMaxDailyMg(body.extracted_json);
    if (
      maxDailyMg !== null &&
      calc.suggested_next_dose_mg !== null &&
      calc.interval_hours !== null &&
      calc.interval_hours > 0
    ) {
      const estimatedDaily = calc.suggested_next_dose_mg * (24 / calc.interval_hours);
      if (estimatedDaily > maxDailyMg) {
        return json(200, {
          status: "WARN",
          message: "Computed regimen exceeds monograph max daily limit.",
          suggested_next_dose_mg: null,
          interval_hours: null,
          next_eligible_time: null,
          patient_specific_notes: null,
          ai_summary: "Computed regimen exceeds monograph max daily limit.",
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
      patient_specific_notes: finalPatientNotes,
      ai_summary: "Dose computed from monograph cache.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI dose calculation failed";
    return json(500, {
      status: "WARN",
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
