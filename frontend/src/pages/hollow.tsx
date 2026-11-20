import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useWords } from "../providers";
import { Icon, Slot, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import "./hollow.css";

// 遗忘空洞专题（2026-11-18 开放）。任务、刷怪、NPC 位置来自 NiaDB（data/reference/niadb/）。
const npc = (id: number, name: string) => (
  <SiteLink href={`/npc/${id}`}>{name}</SiteLink>
);
const map = (id: number, name: string) => (
  <SiteLink href={`/map/${id}`}>{name}</SiteLink>
);
const mob = (id: number, name: string) => (
  <SiteLink href={`/mob/${id}`}>{name}</SiteLink>
);

// 场景图和缩略图换过后改这个值，绕开浏览器和 CDN 的旧缓存。
const IMAGES = "20261120m";

type Step = [quest: number, name: string, level: number | null, what: ReactNode];

// 两个入口都不需要任务，站上去按上就进（客户端 Map.wz 的脚本传送口）。
const ENTRANCES: [from: ReactNode, to: ReactNode][] = [
  [map(10002071, "北部森林通道"), map(10006060, "遗忘入口Ⅲ")],
  [map(10005054, "森林迷宫Ⅴ"), map(10006071, "遗忘地牢隧道")],
];

// 2026-11-19 游戏更新后的任务线（NiaDB quests.json，area 17）。
// 任务奖励（NiaDB quests.json 的 exp、mesos、get、rewardRandom）。
const REWARDS: Record<number, string> = {
  10600: "经验 7,990 · 金币 1,228 · 蓝色药水 ×20",
  10601: "经验 7,990 · 金币 1,228 · 遗忘山谷回城卷 ×2",
  10602: "经验 9,060 · 金币 1,330 · 随机一张耳环卷轴（力量/敏捷/智力/幸运，高级）",
  10603: "经验 12,300 · 金币 1,535 · 上衣生命值卷轴：中级",
  10604: "经验 12,300 · 金币 1,535 · 活力神水 ×15",
  10607: "经验 7,990 · 金币 1,228 · 橙色药水 ×20",
  10608: "经验 5,593 · 金币 859 · 蓝色药水 ×20",
  10609: "经验 7,990 · 金币 1,228 · 随机一张头盔命中率卷轴（中级/高级）",
  10610: "经验 5,593 · 金币 859 · 蓝色药水 ×10",
  10611: "经验 5,593 · 金币 859 · 随机一张本职业武器攻击卷轴（高级）",
  10612: "经验 8,280 · 金币 1,272 · 白色药水 ×15 · 蓝色药水 ×15",
  10613: "经验 8,280 · 金币 1,272 · 随机一张上衣/下装防御力卷轴（混沌）",
  10614: "经验 10,400 · 金币 1,418 · 遗忘山谷回城卷 ×3",
  10615: "经验 10,400 · 金币 1,418 · 紫荆花耳环 · 落地荧光孢子灯",
  10616: "经验 9,875 · 金币 2,500 · 活力神水 ×2 · 柠檬 ×10 · 特殊药水 ×15",
  10617: "经验 10,400 · 金币 1,418 · 随机一张披风命中率卷轴（中级/高级）",
  10618: "经验 10,400 · 金币 1,418 · 西瓜 ×15 · 柠檬 ×10",
  10619: "经验 12,900 · 金币 1,579 · 红色药水 ×15 · 下装生命值卷轴：高级",
  10620: "经验 12,900 · 金币 1,579 · 活力神水 ×2 · 柠檬 ×10 · 特殊药水 ×15",
  10621: "经验 12,900 · 金币 1,579 · 白色药水 ×15 · 遗忘山谷回城卷 ×2",
  10622: "经验 12,900 · 金币 1,579 · 蓝色药水 ×30",
  10623: "经验 12,900 · 金币 1,579 · 古木树液 ×3",
  10624: "经验 15,600 · 金币 1,667 · 特殊药水 ×15",
  10625: "经验 15,600 · 金币 1,667 · 活力神水 ×15",
  10626: "经验 15,600 · 金币 1,667 · 守火人的灯笼",
  10627: "经验 11,340 · 金币 1,207 · 特殊药水 ×10 · 烤肉 ×15",
  10628: "经验 16,200 · 金币 1,725 · 活力神水 ×15",
  10629: "经验 11,340 · 金币 1,207 · 随机一张鞋子跳跃力/移动速度卷轴（高级）",
  10630: "经验 11,340 · 金币 1,207 · 烤肉 ×15",
  10631: "经验 16,200 · 金币 1,725 · 柠檬 ×15",
  10632: "经验 11,340 · 金币 1,207 · 蓝色药水 ×15",
  10633: "经验 11,340 · 金币 1,207 · 沙拉 ×15",
  10634: "经验 16,200 · 金币 1,725 · 敏捷药水 ×3",
  10635: "经验 16,200 · 金币 1,725 · 随机一张单手剑/单手斧/单手钝器/短剑攻击卷轴（混沌）",
  10636: "经验 16,200 · 金币 1,725 · 矿泉水 ×10",
  10637: "经验 16,200 · 金币 1,725 · 速度药水 ×5",
  10638: "经验 16,200 · 金币 1,725 · 敏捷药水 ×5",
  10639: "经验 11,340 · 金币 1,207 · 矿泉水 ×10",
  10640: "经验 16,200 · 金币 1,725 · 随机一张披风力量/敏捷/智力/幸运卷轴（混沌）",
};

const LINES: { who: ReactNode; steps: Step[] }[] = [
  {
    who: <>{npc(313, "汉斯")} · {map(10002003, "魔法图书馆")}</>,
    steps: [
      [10607, "遗憾之根", 39, <>到{map(10002021, "猴子森林Ⅰ")}打{mob(35, "猴子")}，收集 25 个发光魔力共鸣</>],
      [10608, "妖精的洞察", 39, <>去{map(10002000, "魔法密林")}找{npc(304, "妖精 艾温")}对话</>],
      [10609, "追寻共鸣", 39, <>到{map(10002081, "北部森林训练场Ⅶ")}打{mob(37, "冰独眼兽")}，收集 25 个腐根碎片</>],
      [10610, "无底深渊", 39, <>把消息带回给汉斯</>],
      [10611, "欢迎来到遗忘空洞", 39, <>进遗忘空洞找{npc(702, "米恩")}；空洞里大部分任务要先做完这一步</>],
    ],
  },
  {
    who: <>{npc(702, "米恩")} · 过冬</>,
    steps: [
      [10612, "入冬前的储备", 40, <>打 50 只{mob(54, "发光蘑菇")}，交 30 个发光蘑菇孢子</>],
      [10613, "用来交换的东西", 40, <>带上荧光孢子灯和 30 个莱芙花瓣（{mob(55, "莱芙")}），交给魔法密林的妖精 艾温</>],
      [10614, "送往空洞的物资", 45, <>从{npc(305, "妖精 罗雯")}拿过冬物资送给米恩，路上打 50 只{mob(57, "水螈")}</>],
      [10615, "灯火之夜", 45, <>{npc(701, "泽莉娅")}接：打 50 只{mob(58, "回音章鱼")}、50 只{mob(56, "黄金蝙蝠")}，交 30 个章鱼腿、20 个蝙蝠翅膀给米恩</>],
    ],
  },
  {
    who: <>{npc(712, "学者丹尼尔")} · {map(10006160, "黑暗峭壁")}</>,
    steps: [
      [10616, "贤者的重担", 50, <>接在过冬线之后：和丹尼尔对话，回魔法图书馆交给汉斯</>],
      [10617, "心事", 45, <>{npc(707, "尼洛斯")}把烧焦的卷轴交给你，送去{map(10006140, "腐烂隧道Ⅲ")}给{npc(711, "探险家杰米")}</>],
      [10618, "铁之记忆", 45, <>打 50 只回音章鱼</>],
      [10619, "静与木之心", 50, <>交给丹尼尔 30 个诅咒娃娃（{mob(38, "僵尸猴")}）和 20 个暮色螈尾（{mob(60, "暮色螈")}）</>],
      [10620, "贤者的重担", 50, <>再回魔法图书馆交给汉斯</>],
    ],
  },
  {
    who: <>{npc(701, "泽莉娅")} · {map(10006001, "洞穴精灵圣域")}</>,
    steps: [
      [10600, "泽莉娅的地图", 39, <>25 个地图片段，打发光蘑菇</>],
      [10601, "天然黏合剂", 39, <>打 40 只莱芙，交 25 个莱芙花瓣</>],
      [10602, "回家的一步", 42, <>打 75 只水螈、25 只回音章鱼</>],
    ],
  },
  {
    who: <>{npc(703, "米拉")} · {map(10006150, "挥之不去的遗憾")}</>,
    steps: [
      [10603, "老朋友", 49, <>打 50 只{mob(61, "木喵")}、50 只{mob(63, "孢子木")}</>],
      [10604, "米拉的老朋友", 49, <>把不祥的腐枝交给汉斯</>],
    ],
  },
  {
    who: <>{npc(715, "塔米娅")} · {map(10006022, "腐烂的空中花园")}</>,
    steps: [
      [10621, "庭中余烬", 50, <>打 60 只暮色螈</>],
      [10622, "无人教诲之言", 50, <>把日志送给丹尼尔</>],
      [10623, "灯笼用的树枝", 50, <>打 60 只木喵，交 30 个巨树枝给杰米</>],
      [10624, "褪色的护符", 53, <>打 60 只{mob(62, "腐烂蘑菇")}，交 30 个腐朽护符</>],
      [10625, "破败的坟墓", 53, <>在{map(10006161, "破败的坟墓")}打 60 只孢子木，把艾尔达的护符交给丹尼尔</>],
      [10626, "最后的灯笼", 53, <>交回塔米娅</>],
    ],
  },
  {
    who: <>{npc(702, "米恩")} · 失窃（接在塔米娅线之后）</>,
    steps: [
      [10627, "失窃的东西", 55, <>去{map(10003000, "废弃都市")}网吧楼顶找{npc(437, "阿尔斯顿")}</>],
      [10628, "不问来路", 55, <>交 20 张账本残页，在原始森林Ⅱ、遗忘入口Ⅰ打黄金蝙蝠</>],
      [10629, "屋顶上的女孩", 55, <>去美发店楼顶找{npc(438, "惠特妮")}</>],
      [10630, "药钱", 55, <>找丹尼尔问病情</>],
      [10631, "争取时间", 55, <>在黑暗峭壁收集 25 个未被污染的蘑菇盖，交给惠特妮</>],
      [10632, "来自藏身处的消息", 55, <>去{map(10003003, "盗贼藏身处")}找{npc(411, "达克鲁")}</>],
      [10633, "对手的算盘", 55, <>把达克鲁的提议带给阿尔斯顿</>],
      [10634, "两个盗贼，一个计划", 55, <>在遗忘入口Ⅱ、Ⅲ打 60 只莱芙，找惠特妮</>],
      [10635, "不安的休战", 55, <>把米恩的结界卷轴还给米恩</>],
    ],
  },
  {
    who: <>{npc(717, "微光")} · {map(10006122, "腐烂之屋")}</>,
    steps: [
      [10636, "门口的腐烂", 55, <>打 60 只腐烂蘑菇</>],
      [10637, "对抗腐烂的光", 55, <>在{map(10006121, "别人的坟墓")}打僵尸蘑菇，交 50 个不死者护符</>],
      [10638, "门上的结界", 55, <>交 30 个巨树枝（木喵）给米恩</>],
      [10639, "荧光孢子结界", 55, <>把米恩做好的结界带回给微光</>],
      [10640, "地底的腐烂之源", 55, <>打倒别人的坟墓深处的{mob(700003, "腐烂蘑菇王")}，带回它的蘑菇盖</>],
    ],
  },
];

const MOBS: [id: number, name: string, level: number][] = [
  [54, "发光蘑菇", 39],
  [55, "莱芙", 40],
  [56, "黄金蝙蝠", 42],
  [57, "水螈", 43],
  [58, "回音章鱼", 45],
  [59, "大花草", 47],
  [60, "暮色螈", 50],
  [61, "木喵", 54],
  [62, "腐烂蘑菇", 56],
  [63, "孢子木", 59],
  [700003, "腐烂蘑菇王", 60],
];

const MAPS: [id: number, name: string][] = [
  [10006000, "遗忘空洞"],
  [10006001, "洞穴精灵圣域"],
  [10006002, "洞穴精灵商店"],
  [10006003, "褪色的门槛"],
  [10006010, "原始森林Ⅰ"],
  [10006020, "原始森林Ⅱ"],
  [10006030, "原始森林Ⅲ"],
  [10006022, "腐烂的空中花园"],
  [10006031, "死亡峡谷"],
  [10006040, "遗忘入口Ⅰ"],
  [10006050, "遗忘入口Ⅱ"],
  [10006060, "遗忘入口Ⅲ"],
  [10006070, "流光尽头"],
  [10006071, "遗忘地牢隧道"],
  [10006072, "褪色的树冠"],
  [10006080, "禁忌入口"],
  [10006090, "险峻下坡Ⅰ"],
  [10006100, "险峻下坡Ⅱ"],
  [10006110, "险峻下坡Ⅲ"],
  [10006120, "腐朽隧道Ⅰ"],
  [10006121, "别人的坟墓"],
  [10006122, "腐烂之屋"],
  [10006130, "腐烂隧道Ⅱ"],
  [10006140, "腐烂隧道Ⅲ"],
  [10006150, "挥之不去的遗憾"],
  [10006160, "黑暗峭壁"],
  [10006161, "破败的坟墓"],
  [10006162, "另一处避难所"],
];

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="hollow-steps">
      {steps.map(([quest, name, level, what]) => (
        <li key={quest}>
          <b>{name}</b>
          {level !== null && <span className="hollow-lv">Lv{level}</span>}
          <span className="hollow-what">{what}</span>
          {REWARDS[quest] && (
            <span className="hollow-reward">{REWARDS[quest]}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

type Names = { zh: string; en: string };
type AreaMob = { id: number; names: Names; level: number | null; spawn_count: number };
type AreaDrop = { id: number; names: Names; icon_url: string | null; typical: number | null; quest: boolean };
type AreaMap = { id: number; mobs: AreaMob[]; drops: AreaDrop[] };

// 每张图刷什么怪、掉什么（/api/v1/dex/maps，跟着图鉴导入更新）。
function useAreaMaps(ids: number[]) {
  return useQuery({
    queryKey: ["dex-maps", ids],
    queryFn: async () => {
      const response = await fetch("/api/v1/dex/maps?ids=" + ids.join(","));
      if (!response.ok) throw new Error("dex maps " + response.status);
      const body: { maps: AreaMap[] } = await response.json();
      return new Map(body.maps.map((m) => [m.id, m]));
    },
    staleTime: 3_600_000,
  });
}

const DROP_PREVIEW = 12;

function MapCard({ id, name, info }: { id: number; name: string; info?: AreaMap }) {
  const words = useWords();
  const [all, setAll] = useState(false);
  const drops = info?.drops ?? [];
  const shown = all ? drops : drops.slice(0, DROP_PREVIEW);
  return (
    <div className="hollow-map well">
      <SiteLink className="hollow-map-pic" href={`/map/${id}`}>
        <img src={`/web/images/map-thumbs/${id}.webp?v=${IMAGES}`} alt="" loading="lazy" />
        <b>{name}</b>
      </SiteLink>
      {info && (
        <div className="hollow-map-info">
          {info.mobs.length ? (
            <ul className="hollow-map-mobs">
              {info.mobs.map((mob) => (
                <li key={mob.id}>
                  <SiteLink href={`/mob/${mob.id}`}>
                    <img src={`/web/images/mobs/head/${mob.id}.png`} alt="" width={24} height={24} loading="lazy" />
                    {words(mob.names.zh, mob.names.en)}
                  </SiteLink>
                  {mob.level != null && <small>Lv{mob.level}</small>}
                  <small>×{mob.spawn_count}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hollow-map-none">{words("没有怪物", "No monsters")}</p>
          )}
          {drops.length > 0 && (
            <div className="hollow-map-drops">
              {shown.map((drop) => (
                <SiteLink
                  key={drop.id}
                  href={`/item/${drop.id}`}
                  className={drop.quest ? "quest" : undefined}
                  title={words(drop.names.zh, drop.names.en) + (drop.quest ? words("（任务）", " (quest)") : "")}
                >
                  <Slot empty url={drop.icon_url ?? undefined} />
                </SiteLink>
              ))}
              {drops.length > DROP_PREVIEW && (
                <button type="button" className="hollow-more" onClick={() => setAll(!all)}>
                  {all ? words("收起", "Less") : words(`全部 ${drops.length}`, `All ${drops.length}`)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TABS = ["maps", "mobs", "quests"] as const;
type Tab = (typeof TABS)[number];

export default function Hollow() {
  usePageReady();
  const words = useWords();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "maps";
  const pick = (next: Tab) => {
    const copy = new URLSearchParams(params);
    if (next === "maps") copy.delete("tab");
    else copy.set("tab", next);
    setParams(copy, { replace: true, preventScrollReset: true });
  };
  const overview = useAreaMaps(MAPS.map(([id]) => id));
  const labels: Record<Tab, [string, string, number]> = {
    maps: ["地图", "Maps", MAPS.length],
    mobs: ["怪物", "Monsters", MOBS.length],
    quests: ["任务", "Quests", LINES.reduce((sum, line) => sum + line.steps.length, 0)],
  };
  return (
    <div className="lwrap hollow-page">
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("新地图 · 遗忘空洞", "New area · Forgotten Hollow")}</h1>
          <span className="bar-meta">11-18 {words("开放", "opened")} · Lv39–60</span>
        </div>
        <img
          className="hollow-scene"
          src={`/web/images/scenes/10006000.webp?v=${IMAGES}`}
          srcSet={`/web/images/scenes/small/10006000.webp?v=${IMAGES} 1100w, /web/images/scenes/10006000.webp?v=${IMAGES} 1760w`}
          sizes="(max-width: 900px) 100vw, 900px"
          alt=""
        />
        <div className="hollow-actions">
          <SiteLink className="btn primary" href="/route?from=10001000&to=10006000">
            <Icon name="map" />
            {words("射手村怎么去", "Route from Henesys")}
          </SiteLink>
          <SiteLink className="btn" href="/world?map=10006000">
            {words("世界地图", "World map")}
          </SiteLink>
          <SiteLink className="btn" href="/map/10006000">
            {words("地图页", "Map page")}
          </SiteLink>
        </div>

        <h2 className="hollow-h">{words("怎么进去", "Getting in")}</h2>
        <ul className="hollow-steps hollow-entrances">
          {ENTRANCES.map(([from, to], index) => (
            <li key={index}>
              {from} {words("最底下，站上去按上 →", "bottom, press up →")} {to}
            </li>
          ))}
        </ul>
        <p className="hollow-note">
          {words("不用做任务，直接能进。", "Open to everyone; no quest needed.")}
        </p>

        <div className="hollow-tabs" role="tablist" aria-label={words("专题分类", "Sections")}>
          {TABS.map((key) => (
            <button
              type="button"
              role="tab"
              key={key}
              aria-selected={tab === key}
              aria-controls="hollow-panel"
              data-hollow-tab={key}
              onClick={() => pick(key)}
            >
              {words(labels[key][0], labels[key][1])} <small>{labels[key][2]}</small>
            </button>
          ))}
        </div>
        <div id="hollow-panel" role="tabpanel">
          {tab === "maps" && (
            <>
        <div className="hollow-maps">
          {MAPS.map(([id, name]) => (
            <MapCard key={id} id={id} name={name} info={overview.data?.get(id)} />
          ))}
        </div>
            </>
          )}
          {tab === "mobs" && (
            <>
        <div className="hollow-mobs">
          {MOBS.map(([id, name, level]) => (
            <SiteLink className="hollow-mob well" href={`/mob/${id}`} key={id}>
              <img src={`/web/images/mobs/head/${id}.png`} alt="" width={48} height={48} loading="lazy" />
              <b>{name}</b>
              <small>Lv{level}</small>
            </SiteLink>
          ))}
        </div>

            </>
          )}
          {tab === "quests" && (
            <>
        <div className="hollow-lines">
          {LINES.map((line, index) => (
            <div className="hollow-line well" key={index}>
              <h3>{line.who}</h3>
              <Steps steps={line.steps} />
            </div>
          ))}
        </div>

            </>
          )}
        </div>
      </section>
    </div>
  );
}
