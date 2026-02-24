import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

type EvidenceBlock = {
  page: number;
  heading: string;
  type: string;
  text: string;
  structured: any | null;
};

type Extracted = {
  meta?: { drug_name?: string; pm_date?: string; source_pages?: number };
  evidence_blocks?: EvidenceBlock[];
};

function normStr(v: any): string {
  return typeof v === "string" ? v.trim() : "";
}

function stripCodeFences(s: string) {
  return s.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function sliceFirstJSONObject(s: string) {
  // grabs the first top-level {...} block even if extra text exists
  const start = s.indexOf("{");
  if (start < 0) return s;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return s.slice(start); // fallback
}

function removeTrailingCommas(s: string) {
  // removes trailing commas before } or ]
  return s.replace(/,\s*([}\]])/g, "$1");
}

function normalizeQuotesAndControls(s: string) {
  // normalize smart quotes + remove null/control chars that break parsing
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\u0000-\u001F\u007F]/g, " "); // control chars
}

function safeJsonParseObject(raw: string) {
  const cleaned = normalizeQuotesAndControls(
    removeTrailingCommas(sliceFirstJSONObject(stripCodeFences(raw))),
  ).trim();

  return JSON.parse(cleaned);
}

function normType(t: any): string {
  const s = normStr(t).toLowerCase();
  const allowed = new Set([
    "dosing",
    "renal_adjustment",
    "hepatic_adjustment",
    "nomogram",
    "monitoring",
    "contraindication",
    "interaction",
    "administration",
    "special_population",
    "warning",
    "other",
    "adverse_reaction",
  ]);

  if (allowed.has(s)) return s;

  // map common variants
  if (s.includes("contra")) return "contraindication";
  if (s.includes("interact")) return "interaction";
  if (s.includes("monitor")) return "monitoring";
  if (s.includes("renal")) return "renal_adjustment";
  if (s.includes("hepatic") || s.includes("liver")) return "hepatic_adjustment";
  if (s.includes("admin")) return "administration";
  if (s.includes("warn") || s.includes("precaution")) return "warning";
  if (s.includes("adverse")) return "adverse_reaction";
  if (s.includes("special") || s.includes("geriat"))
    return "special_population";
  if (s.includes("dose") || s.includes("posolog")) return "dosing";

  return "other";
}

function sanitizeExtracted(parsed: any): Extracted {
  const out: Extracted = {
    meta: {
      drug_name: normStr(parsed?.meta?.drug_name),
      pm_date: normStr(parsed?.meta?.pm_date),
      source_pages:
        typeof parsed?.meta?.source_pages === "number"
          ? parsed.meta.source_pages
          : undefined,
    },
    evidence_blocks: Array.isArray(parsed?.evidence_blocks)
      ? parsed.evidence_blocks
          .map((b: any) => ({
            page: Number.isFinite(Number(b?.page)) ? Number(b.page) : 0,
            heading: normStr(b?.heading),
            type: normType(b?.type),
            text: normStr(b?.text),
            structured: b?.structured ?? null,
          }))
          .filter(
            (b: EvidenceBlock) => b.text.length > 0 && b.heading.length > 0,
          )
      : [],
  };

  // de-dupe blocks by (type|page|heading|first 80 chars)
  const seen = new Set<string>();
  out.evidence_blocks = (out.evidence_blocks ?? []).filter((b) => {
    const key =
      `${b.type}|${b.page}|${b.heading.toLowerCase()}|` +
      b.text.slice(0, 80).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return out;
}

function missingCoverage(extracted: Extracted) {
  const blocks = extracted.evidence_blocks ?? [];
  const byType = new Map<string, EvidenceBlock[]>();
  for (const b of blocks) {
    const arr = byType.get(b.type) ?? [];
    arr.push(b);
    byType.set(b.type, arr);
  }

  const has = (t: string) => (byType.get(t)?.length ?? 0) > 0;
  const count = (t: string) => byType.get(t)?.length ?? 0;

  // Required minimums from your prompt
  const missing: string[] = [];
  if (!has("contraindication")) missing.push("contraindication (>=1)");
  if (count("warning") + count("warning") < 2 && count("warning") < 2)
    missing.push("warning (>=2)");
  if (!has("interaction")) missing.push("interaction (>=1)");
  if (!has("adverse_reaction") && !has("other"))
    missing.push("adverse_reaction (>=1)");
  // monitoring is conditional, so we don't hard-fail it

  // Robust dosing coverage checks
  if (count("dosing") < 2) missing.push("dosing (>=2)");

  // **KEY**: pediatric/child dosing presence (this is what you’re missing)
  const dosingText = blocks
    .filter((b) => b.type === "dosing")
    .map((b) => `${b.heading}\n${b.text}`.toLowerCase())
    .join("\n");

  const hasPeds =
    /pediat|paediat|child|children|infant|neonate|newborn|mg\/kg|mg\/kg\/day/.test(
      dosingText,
    );

  if (!hasPeds)
    missing.push("pediatric dosing evidence (child/infant/neonate/mg/kg)");

  return missing;
}

function buildRepairPrompt(missing: string[], existing: Extracted) {
  return `
You previously extracted JSON from this Canadian Product Monograph PDF, but it is missing critical coverage.

MISSING COVERAGE:
${missing.map((m) => `- ${m}`).join("\n")}

TASK:
- Re-scan the PDF and produce an UPDATED JSON object in the SAME schema.
- Keep existing evidence_blocks that are already correct.
- ADD ONLY the missing evidence_blocks you can find in the PDF (especially pediatric/child dosing).
- Do NOT invent anything. Use exact wording + exact numeric values + units.
- Each new block must include: heading, page, type, text.

Schema:
{
  "meta": { "drug_name": "", "pm_date": "", "source_pages": 0 },
  "evidence_blocks": [{ "heading":"", "page":0, "type":"...", "text":"", "structured": null }]
}

Here is the prior extraction JSON (for reference; do not delete valid blocks):
${JSON.stringify(existing)}
Return JSON ONLY.
`.trim();
}

async function openaiExtractPdfToJson(pmUrl: string, OPENAI_API_KEY: string) {
  const basePrompt = `
You are extracting dosing-critical information from a Canadian Product Monograph PDF.

Goal: Return a SIMPLE, FAST, RELIABLE JSON that does NOT miss critical dosing details.

ABSOLUTE RULE:
If pediatric/children dosing exists anywhere, you MUST include it as evidence_blocks (mg/kg, child/infant/neonate).

COVERAGE QUOTA (MANDATORY):
You MUST output evidence_blocks for ALL of the following categories IF they exist anywhere in the PDF.
Do not stop early after finding dosing.

Required block minimums:
- 1 block: CONTRAINDICATIONS
- 2 blocks: WARNINGS AND PRECAUTIONS (at least one must mention renal/nephrotoxicity/serum levels if present)
- 1 block: DRUG INTERACTIONS
- 1 block: ADVERSE REACTIONS (or "ADVERSE REACTIONS/Events")
- 1 block: MONITORING (serum levels/troughs/renal labs) if present
- 2 blocks: DOSAGE AND ADMINISTRATION (adult IV + pediatric/child or oral if present)
- 1 block: Renal dosing nomogram OR creatinine clearance formula if present
- 1 block: SPECIAL POPULATIONS (geriatrics/renal impairment/dialysis) if present

STRICT RULES:
- Do NOT invent information.
- Extract only what is explicitly stated in the PDF.
- Preserve numeric values and units exactly as written.
- Prefer multiple smaller blocks over one huge block if it improves coverage.

OUTPUT JSON ONLY. No markdown. No commentary.

Schema:
{
  "meta": { "drug_name": "", "pm_date": "", "source_pages": 0 },
  "evidence_blocks": [
    { "heading": "", "page": 0, "type": "dosing|renal_adjustment|hepatic_adjustment|nomogram|monitoring|contraindication|interaction|administration|special_population|warning|adverse_reaction|other", "text": "", "structured": null }
  ]
}
`.trim();

  async function callOpenAI(promptText: string, allowRepair = true) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 90_000); // more breathing room
    try {
      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          text: { format: { type: "json_object" } },
          max_output_tokens: 4500,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: promptText }],
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
      try {
        return safeJsonParseObject(jsonText);
      } catch (e) {
        console.log("pm_prefetch: JSON parse failed, raw output_text:", jsonText);
        if (!allowRepair) throw e;
        console.log("pm_prefetch: JSON parse failed, attempting repair...");
        const repairedRaw = await repairJsonWithOpenAI(jsonText);
        return repairedRaw;
      }
    } catch (e) {
      if ((e as any)?.name === "AbortError")
        throw new Error("OpenAI extraction timed out");
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function repairJsonWithOpenAI(badJsonText: string) {
    const repairPrompt = `
Fix this into VALID JSON (single JSON object) following the SAME schema.
Do not add new info. Do not remove fields. Only fix syntax/escaping/trailing commas.
Return JSON ONLY.

BAD JSON:
${badJsonText}
`.trim();

    return await callOpenAI(repairPrompt, false); // reuse same callOpenAI
  }

  // Pass 1: base extraction
  const firstRaw = await callOpenAI(basePrompt);
  let extracted = sanitizeExtracted(firstRaw);

  // Validate + repair up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    const missing = missingCoverage(extracted);
    if (missing.length === 0) break;

    console.log(`pm_prefetch: missing coverage (attempt ${attempt}):`, missing);

    const repairPrompt = buildRepairPrompt(missing, extracted);
    const repairedRaw = await callOpenAI(repairPrompt);
    extracted = sanitizeExtracted(repairedRaw);
  }

  // Final sanity
  if (!extracted.evidence_blocks || extracted.evidence_blocks.length === 0) {
    throw new Error("Extraction produced no evidence_blocks");
  }

  return extracted;
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
