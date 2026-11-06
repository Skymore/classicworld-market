import { useWords, usePreferences } from "../providers";

/* The game tooltip of use, etc, set-up and cash items, from the Classic World
   client (`tip` on the item API): as in the game, tags and the description
   only — the description already states what the item does. Used by the shop
   view and the quick preview. */

const TIP_FLAGS: [string, string, string][] = [
  ["only", "唯一道具", "One-of-a-kind"],
  ["quest", "任务道具", "Quest item"],
  ["tradeBlock", "不可交换", "Untradeable"],
  ["accountSharable", "账号内共享", "Account-shareable"],
  ["timeLimited", "限时道具", "Time-limited"],
];

/** The game's description markup: `#c…#` is highlighted (orange in game). */
export function Desc({ text }: { text: string }) {
  const parts = text.replace(/\\n/g, "\n").split(/#c([\s\S]*?)#/);
  return (
    <p className="tip-desc">
      {parts.map((part, i) => (i % 2 ? <em key={i}>{part}</em> : part.replace(/#/g, "")))}
    </p>
  );
}

/** The tooltip's tags and description for an item's `tip`. */
export function useTip(tip: any) {
  const { language } = usePreferences();
  const info = tip?.info || {};
  const desc: string | undefined = language === "en" ? tip?.desc_en || tip?.desc_zh : tip?.desc_zh || tip?.desc_en;
  const flags = TIP_FLAGS.filter(([key]) => info[key]);
  return { desc, flags };
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

/** The quick preview's part for a non-equipment item: tags and description. */
export function TipPeek({ tip }: { tip: any }) {
  const { desc, flags } = useTip(tip);
  if (!desc && !flags.length) return null;
  return (
    <section className="peek-section peek-tip" data-preview-tip>
      <TipFlags flags={flags} />
      {desc && <Desc text={desc} />}
    </section>
  );
}
