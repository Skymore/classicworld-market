// Equipment details in the game's tooltip order: requirements, jobs, type,
// attack speed, stats and upgrade slots. `equipment` is the catalogue
// reference the server sends with an item (`page.equipment`); `base` is
// `page.market.base_stats`; `piece` is one listed instance's captured stats.
// The Rust first paint renders the same strip (`pages/item.rs`).
import { useWords } from "../providers";
import { RelativeTime, Slot } from "./shared";

type Words = (zh: string, en: string) => string;
type Base = [string, number][];

// MSCW has no pirates. Bits as in `items.req_job_mask`.
export const JOBS: [number, string, string][] = [
  [0, "新手", "Beginner"],
  [1, "战士", "Warrior"],
  [2, "魔法师", "Magician"],
  [4, "弓箭手", "Bowman"],
  [8, "飞侠", "Thief"],
];
// 0 is every job (beginners included); -1 beginners only.
export const jobAllowed = (mask: number, bit: number) =>
  mask === 0 ? true : mask === -1 ? bit === 0 : bit !== 0 && (mask & bit) !== 0;

export function attackSpeed(speed: number): [string, string] {
  if (speed <= 3) return ["很快", "Faster"];
  if (speed <= 5) return ["快", "Fast"];
  if (speed === 6) return ["普通", "Normal"];
  if (speed <= 8) return ["慢", "Slow"];
  return ["很慢", "Slower"];
}

// Variant stat keys in the tooltip's order.
export const GAME_STATS: [string, string, string][] = [
  ["str", "力量", "STR"],
  ["dex", "敏捷", "DEX"],
  ["int", "智力", "INT"],
  ["luk", "运气", "LUK"],
  ["hp", "最大HP", "MaxHP"],
  ["mp", "最大MP", "MaxMP"],
  ["weapon_attack", "物理攻击", "Weapon Attack"],
  ["magic_attack", "魔法攻击", "Magic Attack"],
  ["critical_rate", "暴击率", "Critical Rate"],
  ["critical_damage", "暴击伤害", "Critical Damage"],
  ["weapon_defense", "物理防御", "Weapon Defense"],
  ["magic_defense", "魔法防御", "Magic Defense"],
  ["accuracy", "命中值", "Accuracy"],
  ["avoid", "回避值", "Avoidability"],
  ["speed", "移动速度", "Speed"],
  ["jump", "跳跃力", "Jump"],
];
const ALIASES: Record<string, string> = {
  pad: "weapon_attack",
  mad: "magic_attack",
  pdd: "weapon_defense",
  mdd: "magic_defense",
  acc: "accuracy",
  eva: "avoid",
};
const statKey = (key: string) => ALIASES[key] || key;

export type CardStat = {
  key: string;
  label: [string, string];
  value: number;
  max?: number;
  bonus: number;
};

// The piece's own stats when given (never catalogue defaults), else the
// item's base stats. `bonus` is how far a piece is above (or below) the base value.
export function cardStats(base: Base, piece?: any): CardStat[] {
  const reference = new Map(base.map(([key, value]) => [statKey(key), value]));
  const source: { key: string; label?: string; value: number; max?: number }[] = piece
    ? (piece.stats || []).map((stat: any) => ({
        key: statKey(String(stat.key)),
        label: stat.label,
        value: Number(stat.value),
        max: Number(stat.maxValue) > Number(stat.value) ? Number(stat.maxValue) : undefined,
      }))
    : base.map(([key, value]) => ({ key: statKey(key), value }));
  const order = (key: string) => {
    const index = GAME_STATS.findIndex(([k]) => k === key);
    return index < 0 ? GAME_STATS.length : index;
  };
  return source
    .filter((stat) => Number.isFinite(stat.value) && stat.value > 0)
    .sort((a, b) => order(a.key) - order(b.key))
    .map((stat) => {
      const known = GAME_STATS.find(([k]) => k === stat.key);
      const base = reference.get(stat.key);
      return {
        key: stat.key,
        label: known ? [known[1], known[2]] : [stat.label || stat.key, stat.key],
        value: stat.value,
        max: stat.max,
        bonus: piece && stat.max == null && base != null ? stat.value - base : 0,
      };
    });
}

function kindLabel(equipment: any, words: Words) {
  const kind = words(equipment.kind || "", equipment.kind_en || equipment.kind || "");
  return kind ? [equipment.weapon ? words("武器分类", "Category") : words("装备分类", "Category"), kind] : null;
}

function Requirements({ req, words, prefix }: { req: any; words: Words; prefix: boolean }) {
  const rows: [string, string, number][] = [
    ["等级", "Level", req.level],
    ["力量", "STR", req.str],
    ["敏捷", "DEX", req.dex],
    ["智力", "INT", req.int],
    ["运气", "LUK", req.luk],
  ];
  return (
    <>
      {rows.map(([zh, en, value]) => (
        <div key={en} className={value ? "" : "zero"} data-req={en.toLowerCase()}>
          <dt>{prefix ? words("要求" + zh, "Req " + en) : words(zh, en)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </>
  );
}

function Jobs({ mask, words }: { mask: number; words: Words }) {
  return (
    <div className="eq-jobs" data-jobs={mask}>
      {JOBS.map(([bit, zh, en]) => (
        <span key={en} className={jobAllowed(mask, bit) ? "on" : ""}>
          {words(zh, en)}
        </span>
      ))}
    </div>
  );
}

// "武器分类：拳套", "物理攻击：+30 (+7)", "可升级次数：7".
function Lines({ equipment, base, piece, words }: { equipment: any; base: Base; piece?: any; words: Words }) {
  const kind = equipment && kindLabel(equipment, words);
  const speed = equipment?.weapon && equipment.attack_speed != null ? attackSpeed(equipment.attack_speed) : null;
  const upgrades = piece ? piece.remaining_upgrades : equipment?.upgrades;
  const colon = words("：", ": ");
  return (
    <dl className="eq-lines">
      {kind && (
        <div>
          <dt>{kind[0]}{colon}</dt>
          <dd>{kind[1]}</dd>
        </div>
      )}
      {speed && (
        <div>
          <dt>{words("攻击速度", "Attack Speed")}{colon}</dt>
          <dd>{words(...speed)}</dd>
        </div>
      )}
      {cardStats(base, piece).map((stat) => (
        <div key={stat.key} data-stat={stat.key} className={stat.bonus > 0 ? "up" : stat.bonus < 0 ? "down" : ""}>
          <dt>{words(...stat.label)}{colon}</dt>
          <dd>
            +{stat.value}
            {stat.max != null && `–${stat.max}`}
            {stat.bonus !== 0 && <i>({stat.bonus > 0 ? "+" : ""}{stat.bonus})</i>}
          </dd>
        </div>
      ))}
      {piece && !(piece.stats || []).length && (
        <div>
          <dt>{words("没有解析到属性", "No stats decoded")}</dt>
        </div>
      )}
      {upgrades != null && (
        <div data-stat="upgrades">
          <dt>{words("可升级次数", "Number of Upgrades Available")}{colon}</dt>
          <dd>{upgrades}</dd>
        </div>
      )}
    </dl>
  );
}

// Compact requirements: only those that are not zero, on one line.
function ShortRequirements({ req, words }: { req: any; words: Words }) {
  const parts = (
    [
      ["等级", "Lv", req.level],
      ["力量", "STR", req.str],
      ["敏捷", "DEX", req.dex],
      ["智力", "INT", req.int],
      ["运气", "LUK", req.luk],
    ] as [string, string, number][]
  ).filter(([, , v]) => Number(v) > 0);
  if (!parts.length) return null;
  return (
    <div className="eq-req-short">
      {words("要求", "Req")}{" "}
      {parts.map(([zh, en, v]) => (
        <span key={en}>
          {words(zh, en)} <b>{v}</b>
        </span>
      ))}
    </div>
  );
}

// Compact jobs: one tag ("全职业" or the jobs that may wear it).
function JobTag({ mask, words }: { mask: number; words: Words }) {
  const allowed = JOBS.filter(([bit]) => jobAllowed(mask, bit));
  const text =
    allowed.length === JOBS.length
      ? words("全职业", "All jobs")
      : allowed.map(([, zh, en]) => words(zh, en)).join(" / ");
  return <span className="eq-job-tag">{text}</span>;
}

// The game tooltip of one item, or of one listed piece of it. `compact`
// (the cloud market, where a whole shop fits one phone screen) keeps every
// stat but puts requirements on one line and the jobs in a tag.
export function EquipmentCard({
  item,
  equipment,
  base,
  piece,
  headingId,
  compact = false,
}: {
  item: any;
  equipment?: any;
  base: Base;
  piece?: any;
  headingId?: string;
  compact?: boolean;
}) {
  const words = useWords();
  const enhanced = Number(piece?.enhancements) > 0 ? Number(piece.enhancements) : 0;
  if (compact)
    return (
      <div className="eq-card compact" data-equipment-card={item.id}>
        <h2 className="eq-title" id={headingId}>
          {words(item.name_zh || item.name_en, item.name_en)}
          {enhanced > 0 && <em>(+{enhanced})</em>}
        </h2>
        <div className="eq-top">
          <Slot empty url={item.icon_url} size={40} />
          <div className="eq-short">
            {equipment?.req && <ShortRequirements req={equipment.req} words={words} />}
            {equipment?.jobs != null && <JobTag mask={equipment.jobs} words={words} />}
          </div>
        </div>
        <Lines equipment={equipment} base={base} piece={piece} words={words} />
        {piece?.offer && <Offer offer={piece.offer} words={words} />}
      </div>
    );
  return (
    <div className="eq-card" data-equipment-card={item.id}>
      <h2 className="eq-title" id={headingId}>
        {words(item.name_zh || item.name_en, item.name_en)}
        {enhanced > 0 && <em>(+{enhanced})</em>}
      </h2>
      <div className="eq-top">
        <Slot empty url={item.icon_url} size={40} />
        {equipment?.req && (
          <dl className="eq-req">
            <Requirements req={equipment.req} words={words} prefix />
          </dl>
        )}
      </div>
      {equipment?.jobs != null && <Jobs mask={equipment.jobs} words={words} />}
      <Lines equipment={equipment} base={base} piece={piece} words={words} />
      {piece?.offer && <Offer offer={piece.offer} words={words} />}
    </div>
  );
}

// The quick preview's section: requirements in two columns, then the card's lines.
export function EquipmentPeek({ equipment, base }: { equipment: any; base: Base }) {
  const words = useWords();
  return (
    <section className="peek-section peek-equipment" data-preview-equipment>
      {equipment.req && (
        <dl className="peek-stats eq-req-grid">
          <Requirements req={equipment.req} words={words} prefix />
        </dl>
      )}
      {equipment.jobs != null && <Jobs mask={equipment.jobs} words={words} />}
      <Lines equipment={equipment} base={base} words={words} />
    </section>
  );
}

// The item page's strip under the head: 要求 / 职业 / 类型 / 基础.
export function EquipmentStrip({ equipment, base }: { equipment: any; base: Base }) {
  const words = useWords();
  const kind = words(equipment.kind || "", equipment.kind_en || equipment.kind || "");
  const speed = equipment.weapon && equipment.attack_speed != null ? attackSpeed(equipment.attack_speed) : null;
  const stats = cardStats(base);
  const req = equipment.req;
  return (
    <dl className="eq-strip" data-equipment-strip>
      {req && (
        <>
          <dt>{words("要求", "Requires")}</dt>
          <dd>
            {(
              [
                ["等级", "Level", req.level],
                ["力量", "STR", req.str],
                ["敏捷", "DEX", req.dex],
                ["智力", "INT", req.int],
                ["运气", "LUK", req.luk],
              ] as [string, string, number][]
            ).map(([zh, en, value]) => (
              <span key={en} className={value ? "" : "zero"}>
                {words(zh, en)} <b>{value}</b>
              </span>
            ))}
          </dd>
        </>
      )}
      {equipment.jobs != null && (
        <>
          <dt>{words("职业", "Jobs")}</dt>
          <dd className="eq-jobs">
            {JOBS.map(([bit, zh, en]) => (
              <span key={en} className={jobAllowed(equipment.jobs, bit) ? "on" : ""}>
                {words(zh, en)}
              </span>
            ))}
          </dd>
        </>
      )}
      {(kind || speed || equipment.upgrades != null) && (
        <>
          <dt>{words("类型", "Type")}</dt>
          <dd>
            {kind && <span>{kind}</span>}
            {speed && (
              <span>
                {words("攻击速度 ", "Attack speed ")}
                <b>{words(...speed)}</b>
              </span>
            )}
            {equipment.upgrades != null && (
              <span>
                {words("可升级次数 ", "Upgrades ")}
                <b>{equipment.upgrades}</b>
              </span>
            )}
          </dd>
        </>
      )}
      {stats.length > 0 && (
        <>
          <dt>{words("基础", "Base")}</dt>
          <dd>
            {stats.map((stat) => (
              <span key={stat.key}>
                {words(...stat.label)} <b>+{stat.value}</b>
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

// Where and for how much this piece was listed (or sold).
export type PieceOffer = {
  channel?: number | null;
  room?: number | null;
  place?: string | null;
  shop?: string | null;
  owner?: string | null;
  price?: number | null;
  set?: boolean;
  stock?: number | null;
  at?: number | null;
  expired?: boolean;
  sale?: boolean;
  /** Shown inside the shop view, whose header already names the place, shop and owner. */
  inShop?: boolean;
};

// Under the stats: the row's location, price, stock and time, so the phone
// sheet still says where the piece is after it covers the row.
function Offer({ offer, words }: { offer: PieceOffer; words: Words }) {
  const where =
    offer.channel != null
      ? [words(`${offer.channel}频道`, `CH ${offer.channel}`), offer.room != null ? words(`${offer.room}洞`, `FM${offer.room}`) : offer.place]
      : [offer.place || words("位置未知", "Unknown location")];
  return (
    <div className={"eq-offer" + (offer.expired ? " expired" : "")} data-piece-offer>
      {!offer.inShop && <div className="eq-offer-loc">
        {where.filter(Boolean).map((part, i) => (i ? <span key={i}>{part}</span> : <b key={i}>{part}</b>))}
        {offer.expired && <span className="eq-offer-tag">{words("已失效", "Expired")}</span>}
      </div>}
      {!offer.inShop && (offer.shop || offer.owner) && (
        <div className="eq-offer-shop">
          {offer.shop && <span>{offer.shop}</span>}
          {offer.owner && <span>{words("摊主 ", "Owner ")}{offer.owner}</span>}
        </div>
      )}
      <div className="eq-offer-meta">
        {offer.price != null && (
          <span>
            <b>{Math.round(offer.price).toLocaleString()}</b>
            {words(" 金币", " mesos")}
            {offer.set && words("/组", "/set")}
          </span>
        )}
        {offer.stock != null && (
          <span>
            {offer.expired ? words("当时库存 ", "Previous stock ") : words("库存 ", "Stock ")}
            {offer.stock}
          </span>
        )}
        {offer.at != null && (
          <span>
            {offer.sale && words("卖出 ", "Sold ")}
            <RelativeTime at={offer.at} />
          </span>
        )}
      </div>
    </div>
  );
}

// What a listing row hands the quick preview so it can show this piece.
export function pieceData(equipment: any, offer?: PieceOffer) {
  if (!equipment || equipment.status !== "candidate") return undefined;
  return JSON.stringify({
    stats: (equipment.stats || []).map((stat: any) => ({
      key: stat.key,
      label: stat.label,
      value: stat.value,
      ...(stat.maxValue != null ? { maxValue: stat.maxValue } : {}),
    })),
    enhancements: equipment.enhancements ?? null,
    remaining_upgrades: equipment.remaining_upgrades ?? null,
    ...(offer ? { offer } : {}),
  });
}
