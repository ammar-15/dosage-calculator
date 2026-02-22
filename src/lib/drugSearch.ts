import { supabase } from "./supabase";

export type BrandSuggestion = {
  brand_name: string;
  drug_code: string | null;
  din: string | null;
};

export async function searchBrandSuggestions(query: string, limit = 10) {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabase
    .from("dpd_drug_product_all")
    .select("brand_name, drug_code, din")
    .ilike("brand_name", `%${q}%`)
    .order("brand_name", { ascending: true })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    brand_name: r.brand_name ?? "",
    drug_code: r.drug_code ?? null,
    din: r.din ?? null,
  })) as BrandSuggestion[];
}
