import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

async function rateLimitOrThrow(
  sb: any,
  key: string,
  limit = 5,
  windowSec = 1,
) {
  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / (windowSec * 1000)) * windowSec * 1000,
  ).toISOString();

  // Try insert (first request in window)
  const ins = await sb
    .from("rate_limits")
    .insert({
      key,
      window_start: windowStart,
      count: 1,
      updated_at: now.toISOString(),
    })
    .select("count, window_start")
    .maybeSingle();

  // Insert worked → ok
  if (!ins.error) return;

  // Row exists → update if same window, else reset
  const { data: existing, error: selErr } = await sb
    .from("rate_limits")
    .select("count, window_start")
    .eq("key", key)
    .maybeSingle();

  if (selErr || !existing) throw new Error("RATE_LIMIT_DB_ERROR");

  const sameWindow = new Date(existing.window_start).toISOString() === windowStart;

  if (!sameWindow) {
    // reset window
    const { error: updErr } = await sb
      .from("rate_limits")
      .update({
        window_start: windowStart,
        count: 1,
        updated_at: now.toISOString(),
      })
      .eq("key", key);

    if (updErr) throw new Error("RATE_LIMIT_DB_ERROR");
    return;
  }

  if (existing.count >= limit) {
    const err: any = new Error("RATE_LIMITED");
    err.status = 429;
    err.retry_after = windowSec;
    throw err;
  }

  // increment count
  const { error: incErr } = await sb
    .from("rate_limits")
    .update({ count: existing.count + 1, updated_at: now.toISOString() })
    .eq("key", key);

  if (incErr) throw new Error("RATE_LIMIT_DB_ERROR");
}

function getIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function decodeJwtPayload(token: string): any | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob(padded);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getUserKeyFromAuth(req: Request): string | null {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = decodeJwtPayload(m[1]);
  const sub = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  return sub ? `user:${sub}` : null;
}

function isJsonObject(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const PROJECT_URL = getEnv("PROJECT_URL");
    const SERVICE_KEY = getEnv("SERVICE_ROLE_KEY");
    const sb = createClient(PROJECT_URL, SERVICE_KEY);
    const key = getUserKeyFromAuth(req) ?? `ip:${getIp(req)}`;

    // 5 requests per second max per key
    await rateLimitOrThrow(sb, `pm_resolver:${key}`, 5, 1);

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
    if ((e as any)?.status === 429) {
      return json(429, {
        status: "ERROR",
        message: "Too many requests. Please slow down.",
        retry_after_seconds: (e as any)?.retry_after ?? 1,
      });
    }
    const msg = e instanceof Error ? e.message : "unknown error";
    return json(500, { status: "ERROR", message: msg });
  }
});
