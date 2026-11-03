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
  if (value === "/" || value === "/prices") return en ? "Market" : "市场行情";
  if (value.startsWith("/")) return (value.startsWith("/map/") ? (en ? "Map " : "地图 ") : value.startsWith("/mob/") ? (en ? "Monster " : "怪物 ") : (en ? "Item " : "物品 ")) + value.split("/").at(-1);
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host === "github.com") return en ? "Client data" : "客户端资料";
    const official = host === "nexon.com" || host.endsWith(".nexon.com") || host === "maplestory.nexon.net" || host === "steamcommunity.com";
    return (official ? (en ? "Official · " : "官方 · ") : (en ? "Community · " : "社区 · ")) + host;
  } catch { return en ? "Source" : "资料来源"; }
}
