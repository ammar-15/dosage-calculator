import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type PrefetchReq = { drug_code?: string | null };

type CacheStatus = "PENDING" | "FETCHING" | "OK" | "NO_PDF" | "FAIL";

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
You are extracting dosing-relevant information from a Canadian drug Product Monograph (PDF).
Return STRICT JSON ONLY that matches this schema:

{
  "meta": {"drug_name": string|null, "pm_date": string|null, "source_pages": number|null},
  "recommended_dosing": [{"population": string|null, "indication": string|null, "route": string|null, "dose_text": string, "interval_text": string|null, "max_text": string|null, "page_refs": number[]}],
  "dose_adjustments": [{"type": string, "rule_text": string, "page_refs": number[]}],
  "contraindications": [{"text": string, "page_refs": number[]}],
  "interactions_affecting_dose": [{"text": string, "page_refs": number[]}],
  "missed_dose": {"text": string|null, "page_refs": number[]},
  "formulations": [{"text": string, "page_refs": number[]}],
  "supporting_excerpts": [{"quote": string, "page": number}]
}

Rules:
- Use ONLY information present in the PDF.
- dose_text and rule_text must preserve original wording as much as possible.
- If a section is absent, return empty arrays/nulls.
- Output JSON only.
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

export async function pmPrefetchHandler(req: { json: () => Promise<PrefetchReq> }) {
  let drugCode = "";
  try {
    const body = (await req.json().catch(() => ({}))) as PrefetchReq;
    drugCode = (body.drug_code ?? "").toString().trim();
    if (!drugCode) return json(400, { status: "ERROR", message: "drug_code is required" });

    const { data: srcRow, error: srcErr } = await sb
      .from("dpd_drug_product_all")
      .select("drug_code, brand_name, din, pm_pdf_url, pm_date")
      .eq("drug_code", drugCode)
      .maybeSingle();

    if (srcErr) return json(500, { status: "ERROR", message: srcErr.message });
    if (!srcRow) return json(404, { status: "ERROR", message: "drug_code not found" });

    const pmUrl = (srcRow.pm_pdf_url ?? "").toString().trim();

    await sb.from("dpd_pm_cache").upsert(
      {
        drug_code: drugCode,
        brand_name: srcRow.brand_name ?? null,
        din: srcRow.din ?? null,
        pm_pdf_url: srcRow.pm_pdf_url ?? null,
        pm_date: srcRow.pm_date ?? null,
        cache_status: "PENDING" as CacheStatus,
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

      return json(200, {
        status: "NO_PDF",
        message: "No Product Monograph exists in DPD for this product.",
      });
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

    const pdfRes = await fetchWithRetry(pmUrl, 4);
    const buf = new Uint8Array(await pdfRes.arrayBuffer());
    const hash = await sha256Hex(buf);

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

      return json(200, { status: "OK", message: "Cache already up-to-date." });
    }

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

    return json(200, { status: "OK", message: "Monograph cached.", drug_code: drugCode });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    if (drugCode) {
      await sb
        .from("dpd_pm_cache")
        .update({
          cache_status: "FAIL" as CacheStatus,
          cache_error: msg,
          updated_at: new Date().toISOString(),
        })
        .eq("drug_code", drugCode);
    }
    return json(500, { status: "ERROR", message: msg });
  }
}

export default pmPrefetchHandler;

serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  return pmPrefetchHandler({ json: () => req.json() });
});
