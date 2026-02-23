import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PrefetchReq = {
  drug_code?: string | null;
  drug_codes?: string[] | null;
};

type CacheStatus =
  | "NEW"
  | "FETCHING"
  | "PARSING"
  | "OK"
  | "NO_PDF"
  | "FETCH_FAIL"
  | "PARSE_FAIL";

type PrefetchDetail = {
  drug_code: string;
  status: "OK" | "NO_PDF" | "FAIL";
  error?: string;
};

function getEnv(name: string): string {
  const denoVal = (globalThis as any)?.Deno?.env?.get?.(name);
  if (typeof denoVal === "string" && denoVal) return denoVal;
  const procVal = (globalThis as any)?.process?.env?.[name];
  if (typeof procVal === "string" && procVal) return procVal;
  throw new Error(`Missing env: ${name}`);
}

const SUPABASE_URL = getEnv("PROJECT_URL");
const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function isUsableExtractedJson(v: any): boolean {
  return !!v && Array.isArray(v?.rules) && v.rules.length >= 1;
}

async function pickCandidateOrder(drugCodes: string[]): Promise<string[]> {
  const cleaned = Array.from(
    new Set(drugCodes.map((c) => String(c).trim()).filter(Boolean)),
  );
  if (!cleaned.length) throw new Error("no drug_codes");

  const [{ data: cacheRows }, { data: srcRows }] = await Promise.all([
    sb
      .from("dpd_pm_cache")
      .select("drug_code, cache_status, extracted_json")
      .in("drug_code", cleaned),
    sb
      .from("dpd_drug_product_all")
      .select("drug_code, pm_pdf_url")
      .in("drug_code", cleaned),
  ]);

  const cacheByCode = new Map<string, any>();
  for (const row of cacheRows ?? []) {
    cacheByCode.set(String(row.drug_code), row);
  }

  const hasPdfUrl = new Set<string>();
  for (const row of srcRows ?? []) {
    const code = String(row.drug_code ?? "").trim();
    const url = String(row.pm_pdf_url ?? "").trim();
    if (code && url) hasPdfUrl.add(code);
  }

  const okFirst: string[] = [];
  const pdfNext: string[] = [];
  const rest: string[] = [];

  for (const code of cleaned) {
    const cached = cacheByCode.get(code);
    if (
      cached?.cache_status === "OK" &&
      isUsableExtractedJson(cached?.extracted_json)
    ) {
      okFirst.push(code);
    } else if (hasPdfUrl.has(code)) {
      pdfNext.push(code);
    } else {
      rest.push(code);
    }
  }

  return [...okFirst, ...pdfNext, ...rest];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, max = 4): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 1; i <= max; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "DoseValidatorHackathon/1.0",
          Accept: "application/pdf,*/*",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const backoff = 300 * Math.pow(2, i - 1) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

function parseJsonFromResponsesPayload(data: any): unknown {
  function stripCodeFences(s: string): string {
    return s.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  }

  const textParts: string[] = [];
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    textParts.push(data.output_text);
  }

  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        textParts.push(content.text);
      }
    }
  }

  let combined = stripCodeFences(textParts.join("\n").trim());
  if (!combined) throw new Error("Empty OpenAI response");

  const firstBrace = combined.indexOf("{");
  const lastBrace = combined.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < 0) throw new Error("No JSON object found");

  combined = combined.slice(firstBrace, lastBrace + 1);
  return JSON.parse(combined);
}

async function openaiExtractPdfToJson(pmUrl: string) {
  const prompt = `
You are extracting dosing-relevant information from a Canadian Product Monograph (PDF).

GOAL:
1) Do section-first extraction from rule-heavy zones.
2) Convert to normalized IF -> THEN rules with confidence.
3) Preserve short source excerpts with page refs (auditability).

SECTION-FIRST RULE:
Only trust content under these headings (or close variants):
- INDICATIONS / CLINICAL USE
- CONTRAINDICATIONS
- WARNINGS / PRECAUTIONS
- DOSAGE AND ADMINISTRATION
- PEDIATRICS / GERIATRICS / RENAL IMPAIRMENT (special populations)
- ADMINISTRATION / RECONSTITUTION / INFUSION
- ADVERSE REACTIONS / DRUG INTERACTIONS

HEADING DETECTION:
Treat headings as lines that look like section headers, using variants.
Assign each paragraph to the most recent heading.

RULE CONVERSION:
Convert sentences into IF -> THEN rules using trigger phrases.

Indications triggers:
"indicated for", "used in", "for the treatment of", "therapy of", "suggested for"
Contra triggers:
"contraindicated", "should not be used", "must not be used", "avoid"
Dosing triggers:
dose patterns (mg/kg, mg), frequency (q6h, every 6 hours), duration, route, infusion time/rate
Route triggers:
"must be given orally", "not effective by the oral route", "should never be given intramuscularly"
Monitoring triggers:
"monitor", "serum levels", "renal function", "ototoxicity", "nephrotoxicity", "adjust dose"

NORMALIZATION:
- Normalize headings (e.g., DOSAGE & ADMINISTRATION -> DOSING; WARNINGS AND PRECAUTIONS -> WARNINGS).
- Normalize routes (intravenous|IV|i.v. -> IV; oral|PO|by mouth -> PO).
- Normalize common pathogens/conditions where explicitly stated (e.g., MRSA, C. difficile).

CONFIDENCE:
HIGH: "contraindicated", "should never", "must be given", "not effective"
MED: "recommended", "should be used", "usual dose"
LOW: "may", "suggested", "advisable"

OUTPUT:
Return STRICT JSON ONLY matching this schema.
Do not invent clinical guidance. If unsure, omit the rule.

SCHEMA:

{
  "meta": {
    "drug_name": string|null,
    "pm_date": string|null,
    "extraction_version": "v2_rule_first",
    "source": "dpd_pm_pdf",
    "source_pages": number|null
  },

  "sections": [
    {
      "heading_raw": string,
      "heading_norm": "INDICATIONS"|"CONTRAINDICATIONS"|"WARNINGS"|"DOSING"|"SPECIAL_POPULATIONS"|"ADMINISTRATION"|"INTERACTIONS"|"ADVERSE_REACTIONS"|"OTHER",
      "text": string,
      "page_refs": number[]
    }
  ],

  "normalization": {
    "heading_map": [{"from": string, "to": string}],
    "route_map": [{"from": string, "to": "IV"|"PO"|"IM"|"SC"|"INHALATION"|"TOPICAL"|"OTHER"}],
    "condition_map": [{"from": string, "to": string}]
  },

  "rules": [
    {
      "rule_type": "INDICATION"|"CONTRAINDICATION"|"DOSING"|"ROUTE"|"MONITORING"|"INTERACTION"|"ADVERSE_REACTION",
      "confidence": "HIGH"|"MED"|"LOW",

      "if": {
        "population": string|null,
        "age_min_years": number|null,
        "age_max_years": number|null,
        "weight_min_kg": number|null,
        "weight_max_kg": number|null,

        "indication_text": string|null,
        "pathogen_text": string|null,
        "condition_text": string|null,

        "route": "IV"|"PO"|"IM"|"SC"|"INTRATHECAL"|"OTHER"|null,
        "renal_impairment": "none"|"mild"|"moderate"|"severe"|null,
        "hepatic_impairment": "none"|"mild"|"moderate"|"severe"|null,

        "contra_flag": string|null,
        "interaction_text": string|null
      },

      "then": {
        "allow": boolean|null,
        "block": boolean|null,

        "dose": {
          "amount": number|null,
          "unit": "mg"|"g"|null,
          "per_kg": boolean|null,
          "per_day": boolean|null,
          "divided_doses": number|null
        },

        "frequency": {
          "interval_hours": number|null,
          "frequency_text": string|null
        },

        "duration": {
          "amount": number|null,
          "unit": "days"|"weeks"|null,
          "text": string|null
        },

        "administration": {
          "infusion_minutes": number|null,
          "max_rate_mg_per_min": number|null,
          "dilution_text": string|null
        },

        "monitoring": {
          "required": boolean|null,
          "items": string[]
        },

        "notes": string|null
      },

      "source": {
        "page_refs": number[],
        "excerpts": string[]
      }
    }
  ]
}

Also include a compact audit trail in sections and rule.source.excerpts (short snippets).
Output JSON only.
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      max_output_tokens: 4000,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [
            { type: "input_file", file_url: pmUrl },
            { type: "input_text", text: "Extract dosing-relevant JSON from this PDF." },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI extraction failed: ${resp.status} ${t}`);
  }

  try {
    const data = await resp.json();
    return parseJsonFromResponsesPayload(data);
  } catch {
    throw new Error("Failed to parse extracted JSON");
  }
}

async function prefetchOne(drugCode: string): Promise<PrefetchDetail> {
  try {
    const { data: existing } = await sb
      .from("dpd_pm_cache")
      .select("cache_status, source_hash, extracted_json, pm_pdf_url, pm_date, updated_at")
      .eq("drug_code", drugCode)
      .maybeSingle();

    // If already cached and usable, skip immediately.
    if (
      existing?.cache_status === "OK" &&
      existing?.extracted_json &&
      Array.isArray((existing.extracted_json as any)?.rules)
    ) {
      return { drug_code: drugCode, status: "OK" };
    }

    const { data: srcRow, error: srcErr } = await sb
      .from("dpd_drug_product_all")
      .select("drug_code, brand_name, din, pm_pdf_url, pm_date")
      .eq("drug_code", drugCode)
      .maybeSingle();

    if (srcErr) {
      return { drug_code: drugCode, status: "FAIL", error: srcErr.message };
    }
    if (!srcRow) {
      return { drug_code: drugCode, status: "FAIL", error: "drug_code not found" };
    }

    const pmUrl = (srcRow.pm_pdf_url ?? "").toString().trim();
    await sb.from("dpd_pm_cache").upsert(
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
    );

    if (!pmUrl) {
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "NO_PDF" as CacheStatus,
          cache_error: "No Product Monograph PDF URL for this drug_code",
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
      return { drug_code: drugCode, status: "NO_PDF" };
    }

    const { data: cacheRow } = await sb
      .from("dpd_pm_cache")
      .select("cache_status, source_hash")
      .eq("drug_code", drugCode)
      .maybeSingle();

    await sb
      .from("dpd_pm_cache")
      .update({
        cache_status: "FETCHING" as CacheStatus,
        fetched_at: new Date().toISOString(),
        cache_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("drug_code", drugCode);

    let hash = "";
    try {
      console.log(`[pm_prefetch] code=${drugCode} fetching pdf ${pmUrl}`);
      const pdfRes = await fetchWithRetry(pmUrl, 4);
      const buf = new Uint8Array(await pdfRes.arrayBuffer());
      hash = await sha256Hex(buf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "FETCH_FAIL" as CacheStatus,
          cache_error: msg,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
      return { drug_code: drugCode, status: "FAIL", error: msg };
    }

    if (
      cacheRow?.cache_status === "OK" &&
      cacheRow?.source_hash &&
      cacheRow.source_hash === hash
    ) {
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "OK" as CacheStatus,
          fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
      return { drug_code: drugCode, status: "OK" };
    }

    await sb
      .from("dpd_pm_cache")
      .update({
        cache_status: "PARSING" as CacheStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("drug_code", drugCode);

    try {
      console.log(`[pm_prefetch] code=${drugCode} calling openai`);
      const extracted = await openaiExtractPdfToJson(pmUrl);
      if (!isUsableExtractedJson(extracted)) {
        throw new Error("Schema mismatch: extracted_json.rules missing");
      }
      console.log(`[pm_prefetch] code=${drugCode} openai done, updating cache`);
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "OK" as CacheStatus,
          parsed_at: new Date().toISOString(),
          source_hash: hash,
          extracted_json: extracted,
          extracted_text: null,
          cache_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
      return { drug_code: drugCode, status: "OK" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "parse failed";
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "PARSE_FAIL" as CacheStatus,
          cache_error: msg,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
      return { drug_code: drugCode, status: "FAIL", error: msg };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return { drug_code: drugCode, status: "FAIL", error: msg };
  }
}

export async function pmPrefetchHandler(req: { json: () => Promise<PrefetchReq> }) {
  try {
    const body = (await req.json().catch(() => ({}))) as PrefetchReq;
    const codes =
      Array.isArray(body.drug_codes) && body.drug_codes.length
        ? body.drug_codes
        : [(body.drug_code ?? "").toString()].filter(Boolean);
    if (!codes.length) {
      return json(400, { status: "ERROR", message: "drug_code(s) required" });
    }

    const ordered = await pickCandidateOrder(codes);
    const maxTries = Math.min(ordered.length, 6);
    const attempts: PrefetchDetail[] = [];

    for (let i = 0; i < maxTries; i++) {
      const code = ordered[i];
      const detail = await prefetchOne(code);
      attempts.push(detail);
      if (detail.status === "OK") {
        return json(200, {
          status: "OK",
          message: "Monograph ready",
          total_tried: attempts.length,
          ok: 1,
          no_pdf: 0,
          fail: 0,
          details: [detail],
          attempts,
        });
      }
    }

    const noPdf = attempts.filter((a) => a.status === "NO_PDF").length;
    const fail = attempts.filter((a) => a.status === "FAIL").length;
    return json(200, {
      status: "OK",
      message: "No usable Product Monograph found for provided drug_codes.",
      total_tried: attempts.length,
      ok: 0,
      no_pdf: noPdf,
      fail,
      details: [attempts[0] ?? { drug_code: ordered[0], status: "FAIL", error: "No attempts" }],
      attempts,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return json(500, { status: "ERROR", message: msg });
  }
}

export default pmPrefetchHandler;

serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  return pmPrefetchHandler({ json: () => req.json() });
});
