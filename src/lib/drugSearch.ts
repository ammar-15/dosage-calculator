import { supabase } from "./supabase";

export type BrandSuggestion = {
  brand_name: string;
  drug_code: string | null;
};

export async function searchBrandSuggestions(query: string, limit = 10) {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabase
    .from("dpd_drug_product_all")
    .select("brand_name, drug_code")
    .ilike("brand_name", `%${q}%`)
    .order("brand_name", { ascending: true })
    .limit(limit * 8);

  if (error) throw error;

  // Deduplicate by normalized display name and keep the smallest numeric
  // drug_code as canonical for stable selection.
  const deduped = new Map<string, { brand_name: string; drug_code: string | null }>();
  for (const row of data ?? []) {
    const name = String(row.brand_name ?? "").trim();
    if (!name) continue;
    const key = name.toUpperCase();
    const candidateCode = row.drug_code ? String(row.drug_code) : null;
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, { brand_name: key, drug_code: candidateCode });
      continue;
    }

    if (!existing.drug_code || !candidateCode) continue;

    const a = Number(existing.drug_code);
    const b = Number(candidateCode);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) {
      deduped.set(key, { brand_name: key, drug_code: candidateCode });
    }
  }

  return Array.from(deduped.values()).slice(0, limit) as BrandSuggestion[];
}
