import { useWords, usePreferences } from "../providers";

/* The game tooltip of use, etc, set-up and cash items, from the Classic World
   client (`tip` on the item API: description, Item.wz info/spec). Used by the
   shop view and the quick preview. */

/** Item.wz fields in the order the game lists them. `pct` values are
 *  percentages; `time` is milliseconds. */
const TIP_STATS: [string, string, string, ("pct" | "time" | "sec")?][] = [
  ["hp", "恢复HP", "HP Recovery"],
  ["hpR", "恢复HP", "HP Recovery", "pct"],
  ["mp", "恢复MP", "MP Recovery"],
  ["mpR", "恢复MP", "MP Recovery", "pct"],
  ["STR", "力量", "STR"],
  ["DEX", "敏捷", "DEX"],
  ["INT", "智力", "INT"],
  ["LUK", "运气", "LUK"],
  ["MHP", "最大HP", "Max HP"],
  ["MMP", "最大MP", "Max MP"],
  ["WAT", "攻击力", "Attack Power"],
  ["pad", "攻击力", "Attack Power"],
  ["PAD", "攻击力", "Attack Power"],
  ["mad", "魔法攻击力", "Magic Attack"],
  ["MAD", "魔法攻击力", "Magic Attack"],
  ["pdd", "物理防御力", "Weapon Defense"],
  ["PDD", "物理防御力", "Weapon Defense"],
  ["mdd", "魔法防御力", "Magic Defense"],
  ["MDD", "魔法防御力", "Magic Defense"],
  ["acc", "命中率", "Accuracy"],
  ["ACC", "命中率", "Accuracy"],
  ["eva", "回避率", "Avoidability"],
  ["EVA", "回避率", "Avoidability"],
  ["speed", "移动速度", "Speed"],
  ["Speed", "移动速度", "Speed"],
  ["jump", "跳跃力", "Jump"],
  ["Jump", "跳跃力", "Jump"],
  ["crt", "暴击率", "Critical Rate", "pct"],
  ["CRT", "暴击率", "Critical Rate", "pct"],
  ["crd", "暴击伤害", "Critical Damage", "pct"],
  ["CRD", "暴击伤害", "Critical Damage", "pct"],
  ["time", "持续时间", "Duration", "time"],
];
const TIP_FLAGS: [string, string, string][] = [
  ["only", "唯一道具", "One-of-a-kind"],
  ["quest", "任务道具", "Quest item"],
  ["tradeBlock", "不可交换", "Untradeable"],
  ["accountSharable", "账号内共享", "Account-shareable"],
  ["timeLimited", "限时道具", "Time-limited"],
  ["notSale", "不能卖给商店", "Cannot be sold to shops"],
];
const duration = (ms: number, words: (zh: string, en: string) => string) => {
  const s = Math.round(ms / 1000);
  if (s >= 3600 && s % 3600 === 0) return words(`${s / 3600}小时`, `${s / 3600} hr`);
  if (s >= 60 && s % 60 === 0) return words(`${s / 60}分钟`, `${s / 60} min`);
  return words(`${s}秒`, `${s} sec`);
};
/** The game's description markup: `#c…#` is highlighted (orange in game). */
export function Desc({ text }: { text: string }) {
  const parts = text.replace(/\\n/g, "\n").split(/#c([\s\S]*?)#/);
  return (
    <p className="tip-desc">
      {parts.map((part, i) => (i % 2 ? <em key={i}>{part}</em> : part.replace(/#/g, "")))}
    </p>
  );
}


/** The tooltip's tags, description and data lines for an item's `tip`. */
export function useTip(tip: any) {
  const words = useWords();
  const { language } = usePreferences();
  const info = tip?.info || {};
  const spec = tip?.spec || {};
  const desc: string | undefined = language === "en" ? tip?.desc_en || tip?.desc_zh : tip?.desc_zh || tip?.desc_en;
  const lines: [string, string, string?][] = [];
  if (info.reqLevel) lines.push([words("要求等级", "Req. Level"), String(info.reqLevel)]);
  if (info.success != null) lines.push([words("成功率", "Success Rate"), info.success + "%"]);
  for (const [key, zh, en, unit] of TIP_STATS) {
    const value = Number(spec[key] ?? info["inc" + key]);
    if (!value) continue;
    const shown =
      unit === "time" ? duration(value, words) : unit === "pct" ? `+${value}%` : value > 0 ? `+${value}` : String(value);
    lines.push([words(zh, en), shown, "up"]);
  }
  if (info.cursed) lines.push([words("失败时装备损坏", "Destroys item on failure"), info.cursed + "%", "bad"]);
  if (info.useCooldown) lines.push([words("冷却时间", "Cooldown"), duration(info.useCooldown * 1000, words)]);
  if (info.slotMax) lines.push([words("每格上限", "Max per slot"), String(info.slotMax)]);
  if (info.price > 1 && !info.notSale)
    lines.push([words("卖给商店", "Sells to shops for"), Number(info.price).toLocaleString() + words(" 金币", " mesos")]);
  const flags = TIP_FLAGS.filter(([key]) => info[key]);
  return { desc, flags, lines };
}

export function TipFlags({ flags }: { flags: [string, string, string][] }) {
  const words = useWords();
  if (!flags.length) return null;
  return (
    <p className="tip-flags">
      {flags.map(([key, zh, en]) => (
        <span key={key}>{words(zh, en)}</span>
      ))}
    </p>
  );
}

/** The quick preview's section for a non-equipment item: tags, description, data. */
export function TipPeek({ tip }: { tip: any }) {
  const words = useWords();
  const { desc, flags, lines } = useTip(tip);
  if (!desc && !lines.length && !flags.length) return null;
  return (
    <section className="peek-section peek-tip" data-preview-tip>
      <h3>{words("道具资料", "Item details")}</h3>
      <TipFlags flags={flags} />
      {desc && <Desc text={desc} />}
      {lines.length > 0 && (
        <dl className="eq-lines">
          {lines.map(([label, value, tone], i) => (
            <div key={i} className={tone || ""}>
              <dt>{label}{words("：", ": ")}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
