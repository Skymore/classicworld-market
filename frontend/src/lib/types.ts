export interface Product {
  item_id: number;
  name_zh?: string;
  name_en?: string;
  icon_url?: string;
  category?: string;
  subcategory?: string;
  level?: number;
  jobs?: string[];
  typical?: number | null;
  typical_low?: number | null;
  typical_high?: number | null;
  typical_window?: number | null;
  typical_window_low?: number | null;
  typical_window_high?: number | null;
  low?: number | null;
  low_data?: boolean;
  change_window?: number | null;
  sales_window?: number;
  sales_10d?: number;
  listings?: number;
  last_seen?: number | null;
  last_sale_at?: number | null;
  last_sale_price?: number | null;
  trend?: unknown[];
  [key: string]: unknown;
}
export interface Market {
  as_of: number;
  products: Product[];
}
export interface Sale extends Product {
  sale_id?: number;
  id?: number;
  time: number;
  quantity?: number;
  price?: number;
  [key: string]: unknown;
}
export interface Account {
  public_id?: string;
  username?: string;
  has_password?: boolean;
  google_linked?: boolean;
  signed_in: boolean;
  mode?: string;
  linked?: boolean;
  temporary?: boolean;
  nickname?: string;
  listed?: boolean;
  collectors?: number;
  google_enabled?: boolean;
  csrf?: string;
  stats?: { shops: number; quotes: number };
}
export type Language = "zh" | "en";
export type Theme = "dark" | "light";

export interface CraftRecipe {
  id: string;
  item_id: number;
  discipline: string;
  level: number;
  output_quantity: number;
  fee: number;
  exp: number;
  ingredients: { item_id: number; quantity: number }[];
  catalyst: { item_id: number; quantity: number } | null;
}
export interface CraftCatalog {
  source: string;
  checked_on: string;
  recipes: CraftRecipe[];
  items: Record<string, { name_en: string; niadb_id: number | null }>;
}
export interface CraftPrice {
  item_id: number;
  market_price: number | null;
  ask_price: number | null;
  npc_price: number | null;
}
