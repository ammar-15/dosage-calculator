import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

type WorkerReq = { seed_drug_code?: string | null };

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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  const combined = textParts.join("\n").trim();
  if (!combined) throw new Error("Empty OpenAI response");

  const firstBrace = combined.indexOf("{");
  const lastBrace = combined.lastIndexOf("}");
  const sliced =
    firstBrace >= 0 && lastBrace >= 0
      ? combined.slice(firstBrace, lastBrace + 1)
      : combined;
  return JSON.parse(sliced);
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

OUTPUT:
Return STRICT JSON ONLY matching this schema.
Do not invent clinical guidance. If unsure, omit the rule.

SCHEMA:
{
  "meta": {"drug_name": string|null, "pm_date": string|null, "extraction_version": "v2_rule_first", "source": "dpd_pm_pdf", "source_pages": number|null},
  "sections": [{"heading_raw": string, "heading_norm": "INDICATIONS"|"CONTRAINDICATIONS"|"WARNINGS"|"DOSING"|"SPECIAL_POPULATIONS"|"ADMINISTRATION"|"INTERACTIONS"|"ADVERSE_REACTIONS"|"OTHER", "text": string, "page_refs": number[]}],
  "normalization": {"heading_map": [{"from": string, "to": string}], "route_map": [{"from": string, "to": "IV"|"PO"|"IM"|"SC"|"INHALATION"|"TOPICAL"|"OTHER"}], "condition_map": [{"from": string, "to": string}]},
  "rules": [{
    "rule_type": "INDICATION"|"CONTRAINDICATION"|"DOSING"|"ROUTE"|"MONITORING"|"INTERACTION"|"ADVERSE_REACTION",
    "confidence": "HIGH"|"MED"|"LOW",
    "if": {"population": string|null, "age_min_years": number|null, "age_max_years": number|null, "weight_min_kg": number|null, "weight_max_kg": number|null, "indication_text": string|null, "pathogen_text": string|null, "condition_text": string|null, "route": "IV"|"PO"|"IM"|"SC"|"INTRATHECAL"|"OTHER"|null, "renal_impairment": "none"|"mild"|"moderate"|"severe"|null, "hepatic_impairment": "none"|"mild"|"moderate"|"severe"|null, "contra_flag": string|null, "interaction_text": string|null},
    "then": {"allow": boolean|null, "block": boolean|null, "dose": {"amount": number|null, "unit": "mg"|"g"|null, "per_kg": boolean|null, "per_day": boolean|null, "divided_doses": number|null}, "frequency": {"interval_hours": number|null, "frequency_text": string|null}, "duration": {"amount": number|null, "unit": "days"|"weeks"|null, "text": string|null}, "administration": {"infusion_minutes": number|null, "max_rate_mg_per_min": number|null, "dilution_text": string|null}, "monitoring": {"required": boolean|null, "items": string[]}, "notes": string|null},
    "source": {"page_refs": number[], "excerpts": string[]}
  }]
}
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
        { role: "system", content: [{ type: "input_text", text: prompt }] },
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

  const data = await resp.json();
  return parseJsonFromResponsesPayload(data);
}

async function prefetchOne(drugCode: string): Promise<PrefetchDetail> {
  try {
    const { data: existing } = await sb
      .from("dpd_pm_cache")
      .select("cache_status, extracted_json")
      .eq("drug_code", drugCode)
      .maybeSingle();

    if (existing?.cache_status === "OK" && existing?.extracted_json) {
      return { drug_code: drugCode, status: "OK" };
    }

    const { data: srcRow, error: srcErr } = await sb
      .from("dpd_drug_product_all")
      .select("drug_code, brand_name, din, pm_pdf_url, pm_date")
      .eq("drug_code", drugCode)
      .maybeSingle();

    if (srcErr) return { drug_code: drugCode, status: "FAIL", error: srcErr.message };
    if (!srcRow) return { drug_code: drugCode, status: "FAIL", error: "drug_code not found" };

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

    await sb
      .from("dpd_pm_cache")
      .update({
        cache_status: "FETCHING" as CacheStatus,
        fetched_at: new Date().toISOString(),
        cache_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("drug_code", drugCode);

    const pdfRes = await fetchWithRetry(pmUrl, 4);
    const buf = new Uint8Array(await pdfRes.arrayBuffer());
    const hash = await sha256Hex(buf);

    await sb
      .from("dpd_pm_cache")
      .update({
        cache_status: "PARSING" as CacheStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("drug_code", drugCode);

    const extracted = await openaiExtractPdfToJson(pmUrl);
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
    const msg = e instanceof Error ? e.message : "unknown error";
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
}

async function getVariantCodes(seedDrugCode: string): Promise<string[]> {
  const { data: seedRow } = await sb
    .from("dpd_drug_product_all")
    .select("drug_code, brand_name, pm_pdf_url")
    .eq("drug_code", seedDrugCode)
    .maybeSingle();

  if (!seedRow) return [seedDrugCode];

  const variantSet = new Set<string>([seedDrugCode]);

  if (seedRow.pm_pdf_url) {
    const { data: rows } = await sb
      .from("dpd_drug_product_all")
      .select("drug_code")
      .eq("pm_pdf_url", seedRow.pm_pdf_url);

    (rows ?? [])
      .map((r: any) => String(r.drug_code ?? "").trim())
      .filter(Boolean)
      .forEach((c) => variantSet.add(c));
  }

  if (seedRow.brand_name) {
    const { data: rows } = await sb
      .from("dpd_drug_product_all")
      .select("drug_code")
      .eq("brand_name", seedRow.brand_name);

    (rows ?? [])
      .map((r: any) => String(r.drug_code ?? "").trim())
      .filter(Boolean)
      .forEach((c) => variantSet.add(c));
  }

  return Array.from(variantSet);
}

async function worker(body: WorkerReq) {
  const seed = String(body.seed_drug_code ?? "").trim();
  if (!seed) return json(400, { status: "ERROR", message: "seed_drug_code required" });

  const codes = await getVariantCodes(seed);
  console.log(`[pm_prefetch_worker] seed=${seed} variants=${codes.length}`);

  let ok = 0;
  let fail = 0;
  let noPdf = 0;
  let skipped = 0;

  for (const code of codes) {
    const { data: existing } = await sb
      .from("dpd_pm_cache")
      .select("cache_status, extracted_json")
      .eq("drug_code", code)
      .maybeSingle();

    if (existing?.cache_status === "OK" && existing?.extracted_json) {
      skipped += 1;
      continue;
    }

    try {
      const detail = await prefetchOne(code);
      if (detail.status === "OK") ok += 1;
      else if (detail.status === "NO_PDF") noPdf += 1;
      else fail += 1;
      await sleep(1500);
    } catch (e) {
      fail += 1;
      console.log(`[pm_prefetch_worker] code=${code} FAIL ${(e as any)?.message ?? e}`);
      await sleep(1500);
    }
  }

  return json(200, {
    status: "OK",
    seed,
    total: codes.length,
    ok,
    no_pdf: noPdf,
    fail,
    skipped,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  const body = (await req.json().catch(() => ({}))) as WorkerReq;
  return worker(body);
});
