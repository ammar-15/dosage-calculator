import { computeFromGuardrails } from "../../../src/lib/guardrailsEngine";

type Req = {
  patient_name?: string;
  weight_kg?: number | string | null;
  age_years?: number | string | null;
  gender?: string | null;
  drug_name?: string | null;
  last_dose_mg?: number | string | null;
  last_dose_time?: string | null;
  patient_notes?: string | null;
};

type Calc = {
  status: "OK" | "WARN" | "BLOCK" | "STOP";
  message: string;
  suggested_next_dose_mg: number | null;
  interval_hours: number | null;
  next_eligible_time: string | null;
};

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeDose(input: Req): Calc {
  const rule = computeFromGuardrails({
    patientName: input.patient_name ?? "",
    weightKg: toNum(input.weight_kg),
    ageYears: toNum(input.age_years),
    gender:
      input.gender === "male" || input.gender === "female" || input.gender === "other"
        ? input.gender
        : null,
    drugName: input.drug_name ?? "",
    lastDoseMg: toNum(input.last_dose_mg),
    lastDoseTakenAt: input.last_dose_time ? new Date(input.last_dose_time) : null,
    notes: input.patient_notes ?? null,
    flags: {},
    symptoms: [],
  });

  return {
    status: rule.status,
    message: rule.message,
    suggested_next_dose_mg: rule.suggestedNextDoseMg,
    interval_hours: rule.timeIntervalHours,
    next_eligible_time: rule.nextEligibleAt,
  };
}

async function aiExplain(input: Req, calc: Calc): Promise<string | null> {
  const apiKey = (globalThis as any)?.process?.env?.OPENAI_API_KEY ?? "";
  if (!apiKey) return null;

  const prompt = `
This is a hackathon demo application.
This is NOT medical advice.

You must NOT generate new dose numbers.
You must NOT modify the provided dose or interval.
You may only explain the provided calculated result.

Patient Profile:
Name: ${input.patient_name ?? ""}
Weight: ${input.weight_kg ?? ""} kg
Age: ${input.age_years ?? ""}
Gender: ${input.gender ?? ""}

Medication:
Drug: ${input.drug_name ?? ""}
Last Dose: ${input.last_dose_mg ?? ""} mg
Last Dose Time: ${input.last_dose_time ?? ""}
Indication: ${input.patient_notes ?? ""}

Calculated Result:
Next Dose: ${calc.suggested_next_dose_mg ?? ""} mg
Interval: ${calc.interval_hours ?? ""} hours
Next Eligible Time: ${calc.next_eligible_time ?? ""}

Explain:
1. Why this dose is appropriate.
2. Any standard monitoring considerations.
3. Any assumptions made.
End with: "Demo only - not medical advice."
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

export async function doseAiHandler(req: { json: () => Promise<Req> }) {
  try {
    const body = await req.json();
    const calc = computeDose(body);

    let aiSummary: string | null = null;
    if (calc.status !== "BLOCK" && calc.status !== "STOP") {
      aiSummary = await aiExplain(body, calc);
    }

    return new Response(
      JSON.stringify({
        status: calc.status,
        message: calc.message,
        suggested_next_dose_mg: calc.suggested_next_dose_mg,
        interval_hours: calc.interval_hours,
        next_eligible_time: calc.next_eligible_time,
        ai_summary: aiSummary,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "AI explanation failed" }),
      { status: 500 },
    );
  }
}

export default doseAiHandler;
