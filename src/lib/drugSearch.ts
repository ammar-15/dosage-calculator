import { supabase } from "./supabase";

export type BrandSuggestion = {
  brand_name: string;
  drug_code: string | null;
  status_set_list: string[];
};

export async function searchBrandSuggestions(query: string, limit = 10) {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabase
    .from("dpd_brand_agg")
    .select("brand_name, drug_code, status_set_list")
    .ilike("brand_name", `%${q}%`)
    .order("brand_name", { ascending: true })
    .limit(limit);

  if (error) throw error;

  // Ensure arrays always exist
  return (data ?? []).map((r: any) => ({
    brand_name: r.brand_name ?? "",
    drug_code: r.drug_code ?? null,
    status_set_list: Array.isArray(r.status_set_list) ? r.status_set_list : [],
  })) as BrandSuggestion[];
}