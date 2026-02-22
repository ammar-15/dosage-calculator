declare const Deno: any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

type DoseAiRequest = {
  patient_name?: string;
  drug_display_name?: string;
  drug_canonical?: string;
  profile?: {
    weight_kg?: number | null;
    age_years?: number | null;
    gender?: string | null;
  };
  computed?: {
    suggested_next_dose_mg?: number | null;
    time_interval_hours?: number | null;
    next_eligible_at?: string | null;
  };
  additional_comments?: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textChunks: string[] = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        textChunks.push(part.text);
      }
    }
  }

  return textChunks.join("\n").trim();
}

function safeParseAiJson(raw: string): { ai_summary: string; ai_warnings: string } {
  try {
    const parsed = JSON.parse(raw);
    const ai_summary =
      typeof parsed?.ai_summary === "string"
        ? parsed.ai_summary
        : "Demo only - not medical advice.";
    const ai_warnings =
      typeof parsed?.ai_warnings === "string"
        ? parsed.ai_warnings
        : "General safety checks are still required.";
    return { ai_summary, ai_warnings };
  } catch {
    return {
      ai_summary: raw || "Demo only - not medical advice.",
      ai_warnings: "General safety checks are still required.",
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: DoseAiRequest;
  try {
    body = (await req.json()) as DoseAiRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const patientName = body.patient_name?.trim();
  const drugDisplayName = body.drug_display_name?.trim();

  if (!patientName || !drugDisplayName) {
    return jsonResponse(
      { error: "patient_name and drug_display_name are required" },
      400,
    );
  }

  const canonical = (body.drug_canonical ?? "unknown").trim().toLowerCase();

  if (!canonical || canonical === "unknown") {
    return jsonResponse({
      ai_summary: "Drug not supported in demo rule engine.",
      ai_warnings: "Unsupported drug in hackathon demo.",
      ai_model: null,
    });
  }

  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    return jsonResponse({ error: "OPENAI_API_KEY not configured" }, 500);
  }

  const systemMessage = [
    "This is a hackathon demo.",
    "Do NOT calculate doses.",
    "Only summarize the provided computed dose and interval.",
    "Add general safety warnings.",
    "Clearly state: Demo only — not medical advice.",
    "Return strict JSON: {\"ai_summary\": string, \"ai_warnings\": string}.",
  ].join(" ");

  const userPayload = {
    patient_profile: {
      patient_name: patientName,
      age_years: body.profile?.age_years ?? null,
      weight_kg: body.profile?.weight_kg ?? null,
      gender: body.profile?.gender ?? null,
      drug_display_name: drugDisplayName,
      drug_canonical: canonical,
    },
    computed_result: {
      suggested_next_dose_mg: body.computed?.suggested_next_dose_mg ?? null,
      time_interval_hours: body.computed?.time_interval_hours ?? null,
      next_eligible_at: body.computed?.next_eligible_at ?? null,
    },
    additional_comments: body.additional_comments ?? null,
  };

  const openaiResp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      input: [
        { role: "system", content: systemMessage },
        {
          role: "user",
          content: `Summarize the computed output below. Do not recalculate anything.\\n${JSON.stringify(
            userPayload,
            null,
            2,
          )}`,
        },
      ],
    }),
  });

  if (!openaiResp.ok) {
    const details = await openaiResp.text();
    return jsonResponse(
      {
        error: "OpenAI request failed",
        details,
      },
      502,
    );
  }

  const openaiJson = await openaiResp.json();
  const outputText = extractOutputText(openaiJson);
  const parsed = safeParseAiJson(outputText);

  return jsonResponse({
    ai_summary: parsed.ai_summary,
    ai_warnings: parsed.ai_warnings,
    ai_model: OPENAI_MODEL,
  });
});
