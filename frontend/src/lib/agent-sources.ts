import { pick } from "/web/js/lib/i18n.js";
export function evidenceUrl(value: string): boolean {
  // "/" is the price table; older answers still name /prices, which redirects there.
  if (value === "/" || /^\/(?:item\/\d+|mob\/\d+|map\/\d+|prices)$/.test(value)) return true;
  if (/^https:\/\/github\.com\/ohmi69\/osms_datamine_dashboard\/blob\/63db09449642c4bf3414276223e4cb7d72af02d9\/data\/current\/(?:skills|quests|maps|monsters)\.json$/.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname;
    const domains = ["nexon.com", "maplestory.nexon.net", "steamcommunity.com", "maplestory.quest", "mapleclassic.guide", "mapleclassic.wiki", "maplestory-classic.com", "meowdb.com", "osmsdataexplorer.com", "reddit.com"];
    if (!domains.some((d) => host === d || host.endsWith("." + d))) return false;
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return url.pathname.toLowerCase().startsWith("/r/msclassicworld/");
    if (host === "steamcommunity.com" || host.endsWith(".steamcommunity.com")) return /^\/(?:app|games|ogg)\/216150\//.test(url.pathname);
    return true;
  } catch { return false; }
}

export function sourceLabel(value: string, en: boolean): string {
  if (value === "/" || value === "/prices") return pick("市场行情", "Market");
  if (value.startsWith("/")) return (value.startsWith("/map/") ? (pick("地图 ", "Map ")) : value.startsWith("/mob/") ? (pick("怪物 ", "Monster ")) : (pick("物品 ", "Item "))) + value.split("/").at(-1);
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host === "github.com") return pick("客户端资料", "Client data");
    const official = host === "nexon.com" || host.endsWith(".nexon.com") || host === "maplestory.nexon.net" || host === "steamcommunity.com";
    return (official ? (pick("官方 · ", "Official · ")) : (pick("社区 · ", "Community · "))) + host;
  } catch { return pick("资料来源", "Source"); }
}
