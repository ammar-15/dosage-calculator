import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PrefetchReq = {
  drug_code?: string | null;
};

type CacheStatus =
  | "NEW"
  | "FETCHING"
  | "PARSING"
  | "OK"
  | "NO_PDF"
  | "FETCH_FAIL"
  | "PARSE_FAIL";

type DbResult<T> = { data: T; error: any };

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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function sbErr(label: string, error: any): never {
  throw new Error(`${label}: ${error?.message ?? JSON.stringify(error)}`);
}

async function mustWrite<T>(
  q: Promise<DbResult<T>>,
  label: string,
): Promise<T> {
  const { data, error } = await q;
  if (error) sbErr(label, error);
  if (data == null) throw new Error(`${label}: no row affected`);
  return data;
}

async function mustOk<T>(q: Promise<DbResult<T>>, label: string): Promise<T> {
  const { data, error } = await q;
  if (error) sbErr(label, error);
  return data;
}

function isUsableExtractedJson(v: any): boolean {
  if (!v || typeof v !== "object") return false;

  // New schema: evidence blocks
  const hasEvidence =
    Array.isArray((v as any)?.evidence_blocks) &&
    (v as any).evidence_blocks.length > 0;

  // Backward compatibility (in case old rows exist)
  const hasDosing =
    !!(v as any)?.dosing &&
    (Array.isArray((v as any)?.dosing?.oral) ||
      Array.isArray((v as any)?.dosing?.intravenous) ||
      Array.isArray((v as any)?.dosing?.other_routes));

  const hasRules =
    Array.isArray((v as any)?.rules) && (v as any).rules.length > 0;

  return hasEvidence || hasDosing || hasRules;
}

function isJsonObject(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function quickPdfHeaderCheck(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "DoseValidatorHackathon/1.0",
      Range: "bytes=0-1023",
      Accept: "application/pdf,*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const isPdf =
    buf.length >= 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46;

  if (!isPdf) throw new Error("Not a valid PDF");
}

async function openaiExtractPdfToJson(pmUrl: string, OPENAI_API_KEY: string) {
  const prompt = `
You are extracting dosing-critical information from a Canadian Product Monograph PDF.

Goal: Return a SIMPLE, FAST, RELIABLE JSON that does NOT miss critical dosing details.

COVERAGE QUOTA (MANDATORY):
You MUST output evidence_blocks for ALL of the following categories IF they exist anywhere in the PDF.
Do not stop early after finding dosing.

Required block minimums:
- 1 block: CONTRAINDICATIONS
- 2 blocks: WARNINGS AND PRECAUTIONS (at least one must mention renal/nephrotoxicity/serum levels if present)
- 1 block: DRUG INTERACTIONS
- 1 block: ADVERSE REACTIONS (or "ADVERSE REACTIONS/Events")
- 1 block: MONITORING (serum levels/troughs/renal labs) if present
- 2 blocks: DOSAGE AND ADMINISTRATION (adult IV + pediatric or oral if present)
- 1 block: Renal dosing nomogram OR creatinine clearance formula if present
- 1 block: SPECIAL POPULATIONS (geriatrics/renal impairment/dialysis) if present

If a required section truly does not exist, omit it (do NOT invent).

CRITICAL SECTIONS (must be captured if present):
- DOSAGE AND ADMINISTRATION (including renal dosing, formulas, nomograms, tables)
- WARNINGS AND PRECAUTIONS (renal/ototoxicity, monitoring, serum levels)
- CONTRAINDICATIONS
- DRUG INTERACTIONS
- ADMINISTRATION constraints (infusion rate, minimum infusion time, dilution, etc.)
- SPECIAL POPULATIONS (geriatrics, renal impairment, dialysis)

STRICT RULES:
- Do NOT invent information.
- Extract only what is explicitly stated in the PDF.
- Preserve numeric values and units exactly as written.

IMPORTANT (NOMOGRAM/CHART RULE):
- If the PDF contains a dosing nomogram/graph/chart (image), you MUST extract:
  1) chart title (if any)
  2) x-axis label + units
  3) y-axis label + units
  4) at least 6 anchor points read from the printed ticks/grid (x,y pairs)
- Do NOT derive formulas. Do NOT “estimate” beyond the printed chart.

OUTPUT JSON ONLY. No markdown. No commentary.

Schema (keep it small):

{
  "meta": {
    "drug_name": "",
    "pm_date": "",
    "source_pages": 0
  },
  "evidence_blocks": [
    {
      "heading": "",
      "page": 0,
      "type": "dosing|renal_adjustment|hepatic_adjustment|nomogram|monitoring|contraindication|interaction|administration|special_population|warning|other",
      "text": "",
      "structured": null
    }
  ]
}

INSTRUCTIONS:
- Each evidence block must contain a clear heading and the exact relevant text.
- Keep text concise but include all dosing/monitoring numbers.
- If a renal formula exists (e.g., CrCl estimation), include it verbatim in text and also put a structured object:

Example structured for formulas:
{
  "kind": "formula",
  "name": "Creatinine clearance (CrCl) estimation",
  "inputs": ["age_years","weight_kg","sex","serum_creatinine"],
  "notes": "copy exact constraints if present"
}

- If a nomogram exists, put structured object like:

{
  "kind": "nomogram_points",
  "x_axis": { "label": "", "unit": "mL/min" },
  "y_axis": { "label": "", "unit": "mg/kg/24 h" },
  "points": [
    { "x": 10, "y": 5.0 },
    { "x": 20, "y": 7.5 }
  ]
}

Return JSON only.
`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 55_000);
  let resp: Response;

  try {
    resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        text: { format: { type: "json_object" } },
        max_output_tokens: 3000,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: prompt }],
          },
          {
            role: "user",
            content: [
              { type: "input_file", file_url: pmUrl },
              {
                type: "input_text",
                text: "Extract dosing-relevant JSON from this PDF.",
              },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    if ((e as any)?.name === "AbortError") {
      throw new Error("OpenAI extraction timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI extraction failed: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const jsonText =
    typeof data?.output_text === "string" && data.output_text.trim()
      ? data.output_text
      : (() => {
          const parts: string[] = [];
          for (const item of data?.output ?? []) {
            for (const c of item?.content ?? []) {
              if (typeof c?.text === "string" && c.text.trim())
                parts.push(c.text);
            }
          }
          return parts.join("\n").trim();
        })();

  if (!jsonText) throw new Error("OpenAI returned empty JSON text");

  const trimmed = jsonText.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("OpenAI did not return a JSON object");
  }

  const parsed = JSON.parse(trimmed);
  if (!isJsonObject(parsed)) {
    throw new Error("Invalid JSON object");
  }

  return parsed;
}

export async function pmPrefetchHandler(req: {
  json: () => Promise<PrefetchReq>;
}) {
  try {
    const PROJECT_URL = getEnv("PROJECT_URL");
    const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
    const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
    const sb = createClient(PROJECT_URL, SERVICE_KEY);

    const body = (await req.json().catch(() => ({}))) as PrefetchReq;
    const drugCode = String(body.drug_code ?? "").trim();
    if (!drugCode) {
      return json(400, { status: "ERROR", message: "drug_code required" });
    }

    const { data: cacheRow } = await sb
      .from("dpd_pm_cache")
      .select("drug_code, brand_name, din, pm_pdf_url, pm_date, extracted_json")
      .eq("drug_code", drugCode)
      .maybeSingle();

    if (isJsonObject(cacheRow?.extracted_json)) {
      return json(200, {
        status: "OK",
        extracted_json: cacheRow?.extracted_json,
      });
    }

    let pmUrl = String(cacheRow?.pm_pdf_url ?? "").trim();
    let pmPdfUrlSource: "cache" | "dpd_drug_product_all" = "cache";

    if (!pmUrl) {
      const { data: srcRow } = await sb
        .from("dpd_drug_product_all")
        .select("drug_code, brand_name, din, pm_pdf_url, pm_date")
        .eq("drug_code", drugCode)
        .maybeSingle();

      if (!srcRow) {
        await mustOk(
          sb.from("dpd_pm_cache").upsert(
            {
              drug_code: drugCode,
              cache_status: "NO_PDF" as CacheStatus,
              cache_error: "drug_code not found in dpd_drug_product_all",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "drug_code" },
          ),
          "SET NO_PDF source missing",
        );

        return json(200, { status: "ERROR", message: "No pm_pdf_url" });
      }

      pmUrl = String(srcRow.pm_pdf_url ?? "").trim();
      pmPdfUrlSource = "dpd_drug_product_all";

      if (cacheRow) {
        await mustWrite(
          sb
            .from("dpd_pm_cache")
            .update({
              brand_name: srcRow.brand_name ?? cacheRow.brand_name ?? null,
              din: srcRow.din ?? cacheRow.din ?? null,
              pm_pdf_url: srcRow.pm_pdf_url ?? cacheRow.pm_pdf_url ?? null,
              pm_date: srcRow.pm_date ?? cacheRow.pm_date ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq("drug_code", drugCode)
            .select("drug_code")
            .maybeSingle(),
          "UPDATE cache metadata",
        );
      } else {
        await mustOk(
          sb.from("dpd_pm_cache").upsert(
            {
              drug_code: drugCode,
              brand_name: srcRow.brand_name ?? null,
              din: srcRow.din ?? null,
              pm_pdf_url: srcRow.pm_pdf_url ?? null,
              pm_date: srcRow.pm_date ?? null,
              cache_status: "NEW" as CacheStatus,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "drug_code" },
          ),
          "UPSERT new cache row",
        );
      }
    }

    if (!pmUrl) {
      await mustOk(
        sb.from("dpd_pm_cache").upsert(
          {
            drug_code: drugCode,
            cache_status: "NO_PDF" as CacheStatus,
            cache_error: "No Product Monograph PDF URL for this drug_code",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "drug_code" },
        ),
        "SET NO_PDF",
      );

      return json(200, { status: "ERROR", message: "No pm_pdf_url" });
    }

    await mustOk(
      sb.from("dpd_pm_cache").upsert(
        {
          drug_code: drugCode,
          pm_pdf_url: pmUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "drug_code" },
      ),
      "ENSURE cache row exists",
    );

    await mustWrite(
      sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "FETCHING" as CacheStatus,
          fetched_at: new Date().toISOString(),
          cache_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode)
        .select("drug_code")
        .maybeSingle(),
      "SET FETCHING",
    );

    try {
      await quickPdfHeaderCheck(pmUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      await mustWrite(
        sb
          .from("dpd_pm_cache")
          .update({
            cache_status: "FETCH_FAIL" as CacheStatus,
            cache_error: msg,
            updated_at: new Date().toISOString(),
          })
          .eq("drug_code", drugCode)
          .select("drug_code")
          .maybeSingle(),
        "SET FETCH_FAIL",
      );

      return json(200, { status: "ERROR", message: msg });
    }

    await mustWrite(
      sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "PARSING" as CacheStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode)
        .select("drug_code")
        .maybeSingle(),
      "SET PARSING",
    );

    try {
      const extracted = await openaiExtractPdfToJson(pmUrl, OPENAI_API_KEY);

      await mustWrite(
        sb
          .from("dpd_pm_cache")
          .update({
            extracted_json: extracted,
            cache_status: "OK" as CacheStatus,
            parsed_at: new Date().toISOString(),
            cache_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("drug_code", drugCode)
          .select("drug_code")
          .maybeSingle(),
        "SAVE extracted_json",
      );

      return json(200, {
        status: "OK",
        extracted_json: extracted,
        pm_pdf_url_source: pmPdfUrlSource,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "parse failed";
      await mustWrite(
        sb
          .from("dpd_pm_cache")
          .update({
            cache_status: "PARSE_FAIL" as CacheStatus,
            cache_error: msg,
            updated_at: new Date().toISOString(),
          })
          .eq("drug_code", drugCode)
          .select("drug_code")
          .maybeSingle(),
        "SET PARSE_FAIL",
      );

      return json(200, { status: "ERROR", message: msg });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return json(500, { status: "ERROR", message: msg });
  }
}

export default pmPrefetchHandler;

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }
  return pmPrefetchHandler({ json: () => req.json() });
});
