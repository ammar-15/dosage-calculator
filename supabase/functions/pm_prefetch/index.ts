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

const PROJECT_URL = getEnv("PROJECT_URL");
const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");

const sb = createClient(PROJECT_URL, SERVICE_KEY);

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

async function mustWrite<T>(q: Promise<DbResult<T>>, label: string): Promise<T> {
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
  return !!v && Array.isArray(v?.rules) && v.rules.length > 0;
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

async function openaiExtractPdfToJson(pmUrl: string) {
  const prompt = `
You are given structured monograph JSON extracted from the PDF.
You MUST use ONLY extracted_json.rules (and their normalized fields).
If there is no matching DOSING rule with numeric dose + interval, get necessary info about the product as below.

ABSOLUTE:
- Do NOT invent any dose numbers.
- Do NOT infer missing intervals.
- If route is blocked by any ROUTE rule (then.block=true), you must WARN.
- If contraindication matches (rule_type=CONTRAINDICATION with block=true), you must WARN.

MATCHING:
- Prefer HIGH confidence rules over MED over LOW.
- Get infor on indication using rule.if.indication_text or pathogen_text against patient_notes (simple substring match is OK).
- Get info population using rule.if.population / age ranges if present.
- Match route if rule.if.route is not null; otherwise treat as general.
- Get dosing info for special age groups and special cases, all of them.

TOTAL DAILY DOSE HANDLING (STRICT):
If a matched DOSING rule has then.dose.per_day=true OR then.dose.divided_doses is set,
treat then.dose.amount as TOTAL DAILY DOSE.
- If divided_doses is provided, per-dose = total_daily / divided_doses.
- If divided_doses is missing, return WARN (do not guess number of doses).

Schema:
{
  "meta": { "drug_name": "", "pm_date": "", "source_pages": 0 },
  "sections": [
    {
      "heading_raw": "",
      "heading_norm": "DOSING|WARNINGS|CONTRAINDICATIONS|SPECIAL_POPULATIONS|ADMINISTRATION|INDICATIONS|OTHER",
      "page_refs": [],
      "paragraphs": ["...", "..."],
      "highlights": ["short key bullets only"]
    }
  ],
  "tables": [
    {
      "table_index": 0,
      "title": "optional",
      "page_refs": [],
      "rows": [
        { "label": "Adults", "value": "125–500 mg", "frequency": "q6–8h", "duration": "7–10 days", "notes": "" }
      ],
      "footer_notes": ["..."],
      "raw_grid": [["..."]]
    }
  ],
  "rules": []
}
Limit sections to at most 10 entries.
Truncate section.text to max 1200 characters.
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
        max_output_tokens: 1600,
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
              if (typeof c?.text === "string" && c.text.trim()) parts.push(c.text);
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

export async function pmPrefetchHandler(req: { json: () => Promise<PrefetchReq> }) {
  try {
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
          sb
            .from("dpd_pm_cache")
            .upsert(
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
          sb
            .from("dpd_pm_cache")
            .upsert(
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
        sb
          .from("dpd_pm_cache")
          .upsert(
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
      sb
        .from("dpd_pm_cache")
        .upsert(
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
      const extracted = await openaiExtractPdfToJson(pmUrl);

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
