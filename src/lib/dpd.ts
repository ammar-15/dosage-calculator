import { supabase } from "./supabase";

const DPD_BASE_URL = "https://health-products.canada.ca/api/drug";

export type CachedDrug = {
  id: string;
  brand_name: string;
  din?: string;
  drug_code?: string;
  raw: unknown;
};

type DpdObject = Record<string, unknown>;

function getValue(obj: DpdObject, keys: string[]): string | null {
  const entries = Object.entries(obj);
  for (const key of keys) {
    const match = entries.find(
      ([k]) => k.toLowerCase() === key.toLowerCase().trim()
    );
    if (!match) continue;
    const value = match[1];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function extractDpdFields(item: unknown): {
  brand_name: string | null;
  din: string | null;
  drug_code: string | null;
} {
  if (!item || typeof item !== "object") {
    return { brand_name: null, din: null, drug_code: null };
  }

  const obj = item as DpdObject;
  const brand_name = getValue(obj, ["brand_name", "brandname", "brand_name_f"]);
  const din = getValue(obj, ["din"]);
  const drug_code = getValue(obj, ["drug_code", "drugcode"]);

  return { brand_name, din, drug_code };
}

export function buildUniqueKey(item: unknown): string {
  const { brand_name, din, drug_code } = extractDpdFields(item);
  const rawText = JSON.stringify(item);
  const base = [drug_code, din, brand_name]
    .filter(Boolean)
    .join("|")
    .toLowerCase();
  const fallback = `raw_len:${rawText?.length ?? 0}`;
  return base || fallback;
}

export function mapDpdToCachedDrug(item: unknown): CachedDrug {
  const { brand_name, din, drug_code } = extractDpdFields(item);
  return {
    id: `remote:${buildUniqueKey(item)}`,
    brand_name: brand_name ?? "Unknown",
    din: din ?? undefined,
    drug_code: drug_code ?? undefined,
    raw: item,
  };
}

export async function searchDpdByBrandName(query: string): Promise<unknown[]> {
  try {
    const q = query.trim();
    if (q.length < 2) return [];

    const url =
      `${DPD_BASE_URL}/drugproduct/` +
      `?brandname=${encodeURIComponent(q)}&lang=en&type=json`;

    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

export async function cacheDpdResults(
  query: string,
  items: unknown[]
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;

  const rows = items.map((item) => {
    const { brand_name, din, drug_code } = extractDpdFields(item);
    return {
      query: query.trim() || null,
      brand_name,
      din,
      drug_code,
      unique_key: buildUniqueKey(item),
      raw: item,
    };
  });

  const { error: upsertError } = await supabase
    .from("dpd_drug_products")
    .upsert(rows, { onConflict: "unique_key" });

  if (!upsertError) return;

  const { error: insertError } = await supabase
    .from("dpd_drug_products")
    .insert(rows);

  if (insertError) {
    throw insertError;
  }
}

export async function searchCache(query: string): Promise<CachedDrug[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabase
    .from("dpd_drug_products")
    .select("id,brand_name,din,drug_code,raw")
    .ilike("brand_name", `%${q}%`)
    .limit(10);

  if (error || !data) return [];

  return data
    .map((row) => ({
      id: String(row.id),
      brand_name: row.brand_name ? String(row.brand_name) : "Unknown",
      din: row.din ? String(row.din) : undefined,
      drug_code: row.drug_code ? String(row.drug_code) : undefined,
      raw: row.raw,
    }))
    .filter((row) => Boolean(row.brand_name));
}
