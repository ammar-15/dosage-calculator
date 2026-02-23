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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    const drugName = String(body?.drug_name ?? "").trim();
    const drugIds: string[] = Array.isArray(body?.drug_ids)
      ? body.drug_ids.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : [];

    if (!drugName && drugIds.length === 0) {
      return json(400, { status: "ERROR", message: "drug_name or drug_ids required" });
    }

    const cacheQuery = sb
      .from("dpd_pm_cache")
      .select("drug_code, extracted_json, updated_at")
      .limit(50);

    const { data: rows, error: rowsErr } =
      drugIds.length > 0
        ? await cacheQuery.in("drug_code", drugIds)
        : await cacheQuery.ilike("brand_name", drugName);

    if (rowsErr) {
      return json(500, { status: "ERROR", message: rowsErr.message });
    }

    if (!rows || rows.length === 0) {
      if (drugIds.length > 0) {
        return json(200, { status: "NEEDS_PREFETCH", drug_code: drugIds[0] ?? null });
      }

      const { data: srcRows, error: srcErr } = await sb
        .from("dpd_drug_product_all")
        .select("drug_code")
        .ilike("brand_name", drugName)
        .limit(20);

      if (srcErr) {
        return json(500, { status: "ERROR", message: srcErr.message });
      }

      if (!srcRows || srcRows.length === 0) {
        return json(200, { status: "MISSING", message: "No cache rows found" });
      }

      const fallbackCode = String(srcRows[0]?.drug_code ?? "").trim();
      return json(200, {
        status: "NEEDS_PREFETCH",
        drug_code: fallbackCode || null,
      });
    }

    const readyRow = rows
      .filter((r: any) => isJsonObject(r.extracted_json))
      .sort((a: any, b: any) => {
        const at = Date.parse(String(a?.updated_at ?? ""));
        const bt = Date.parse(String(b?.updated_at ?? ""));
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
      })[0];

    if (readyRow) {
      return json(200, {
        status: "READY",
        extracted_json: readyRow.extracted_json,
        drug_codes: rows.map((r: any) => r.drug_code),
      });
    }

    const missing = rows.find((r: any) => !isJsonObject(r.extracted_json));
    return json(200, {
      status: "NEEDS_PREFETCH",
      drug_code: missing?.drug_code ?? rows[0]?.drug_code ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return json(500, { status: "ERROR", message: msg });
  }
});
