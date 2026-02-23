import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function getEnv(name: string): string {
  const denoVal = (globalThis as any)?.Deno?.env?.get?.(name);
  if (typeof denoVal === "string" && denoVal) return denoVal;
  const procVal = (globalThis as any)?.process?.env?.[name];
  if (typeof procVal === "string" && procVal) return procVal;
  throw new Error(`Missing env: ${name}`);
}

const PROJECT_URL = getEnv("PROJECT_URL");
const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
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

function isJsonObject(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function pickMostRecentOk(rows: any[]) {
  const okRows = rows.filter((r) => isJsonObject(r.extracted_json));
  if (!okRows.length) return null;

  okRows.sort((a, b) => {
    const at = Date.parse(String(a?.updated_at ?? a?.parsed_at ?? ""));
    const bt = Date.parse(String(b?.updated_at ?? b?.parsed_at ?? ""));
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });

  return okRows[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // what your frontend should send:
    // { drug_name: string, drug_ids: string[] }  (or drug_codes)
    const drugName = String(body?.drug_name ?? "").trim();
    const drugIdsRaw = body?.drug_ids ?? body?.drug_codes ?? [];
    const drugCodes = Array.isArray(drugIdsRaw)
      ? drugIdsRaw.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : [];

    if (!drugName) {
      return json(400, { status: "ERROR", message: "drug_name required" });
    }
    if (!drugCodes.length) {
      return json(400, {
        status: "ERROR",
        message: "drug_ids (drug_codes) required for resolver",
      });
    }

    // 1) Fast path: check cache for ANY of these drug_codes
    const { data: cacheRows, error: cacheErr } = await sb
      .from("dpd_pm_cache")
      .select("drug_code, extracted_json, pm_pdf_url, cache_status, updated_at, parsed_at")
      .in("drug_code", drugCodes);

    if (cacheErr) {
      return json(500, { status: "ERROR", message: cacheErr.message });
    }

    const rows = cacheRows ?? [];
    const best = pickMostRecentOk(rows);

    // If ANY extracted_json exists for these codes, return it (NO PREFETCH)
    if (best?.extracted_json) {
      return json(200, {
        status: "READY",
        extracted_json: best.extracted_json,
        drug_codes: drugCodes,
        used_drug_code: best.drug_code,
        cache_status: best.cache_status ?? null,
      });
    }

    // 2) No extracted_json found -> choose a drug_code to prefetch
    // Prefer a code that already has pm_pdf_url in cache, otherwise pull from dpd_drug_product_all
    let candidateCode =
      rows.find((r) => String(r?.pm_pdf_url ?? "").trim())?.drug_code ?? null;

    if (!candidateCode) {
      const { data: srcRows, error: srcErr } = await sb
        .from("dpd_drug_product_all")
        .select("drug_code, pm_pdf_url")
        .in("drug_code", drugCodes);

      if (srcErr) {
        return json(500, { status: "ERROR", message: srcErr.message });
      }

      candidateCode =
        (srcRows ?? []).find((r) => String(r?.pm_pdf_url ?? "").trim())?.drug_code ??
        null;
    }

    if (!candidateCode) {
      return json(200, {
        status: "MISSING",
        message: "No pm_pdf_url available for any drug_code under this drug_name",
        drug_codes: drugCodes,
      });
    }

    return json(200, {
      status: "NEEDS_PREFETCH",
      drug_code: candidateCode,
      drug_codes: drugCodes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return json(500, { status: "ERROR", message: msg });
  }
});