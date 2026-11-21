import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usePreferences, useWords } from "../providers";
import { Icon, Slot, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import "./hollow.css";

// 遗忘空洞专题（2026-11-18 开放）。任务、刷怪、NPC 位置来自 NiaDB（data/reference/niadb/）。
// 英文名取 NiaDB（GMS 名），按编号查。
const EN: Record<"map" | "mob" | "npc" | "quest", Record<number, string>> = {
  map: {
    10002000: "Ellinia",
    10002003: "Magic Library",
    10002021: "Monkey Forest I",
    10002071: "The Tree Tunnel At the Forest Up North",
    10002081: "Tree Dungeon, Forest Up North VII",
    10003000: "Kerning City",
    10003003: "Thieves' Hideout",
    10005054: "Sleepy Dungeon V",
    10006000: "Forgotten Hollow",
    10006001: "Cave Fairy Sanctuary",
    10006002: "Cave Fairy Store",
    10006003: "The Faded Threshold",
    10006010: "Primeval Forest I",
    10006020: "Primeval Forest II",
    10006022: "Hanging Gardens of Rot",
    10006030: "Primeval Forest III",
    10006031: "The Valley of Death",
    10006040: "Forgotten Entrance I",
    10006050: "Forgotten Entrance II",
    10006060: "Forgotten Entrance III",
    10006070: "The End of Fleeting Light",
    10006071: "Forgotten Dungeon Tunnel",
    10006072: "The Faded Canopy",
    10006080: "Forbidden Entrance",
    10006090: "Perilous Descent I",
    10006100: "Perilous Descent II",
    10006110: "Perilous Descent III",
    10006120: "Decayed Tunnel I",
    10006121: "Someone Else's Grave",
    10006122: "Rotten House",
    10006130: "Decayed Tunnel II",
    10006140: "Decayed Tunnel III",
    10006150: "Lingering Regret",
    10006160: "Precipice of Darkness",
    10006161: "Dilapidated Tomb",
    10006162: "Another Sanctuary",
  },
  mob: {
    35: "Lupin",
    37: "Cold Eye",
    38: "Zombie Lupin",
    54: "Glowshroom",
    55: "Raffle",
    56: "Golden Stirge",
    57: "Aqumander",
    58: "Echopus",
    59: "Rafflesia",
    60: "Duskmander",
    61: "Myewood",
    62: "Rotten Mushroom",
    63: "Sporewood",
    700003: "Rotten Mushmom",
  },
  npc: {
    304: "Arwen the Fairy",
    305: "Rowen the Fairy",
    313: "Grendel the Really Old",
    411: "Dark Lord",
    437: "Alston",
    438: "Whitney",
    701: "Zelya",
    702: "Myen",
    703: "Myra",
    707: "Nyroth",
    711: "Jaime the Explorer",
    712: "Daniel the Scholar",
    715: "Tamya",
    717: "Glimmer",
  },
  quest: {
    10600: "Zelya's Map",
    10601: "Natural Adhesive",
    10602: "A Step Toward Home",
    10603: "Old Friends",
    10604: "Myra's Old Friend",
    10607: "The Roots of Regret",
    10608: "A Fairy's Insight",
    10609: "Tracing the Resonance",
    10610: "The Yawning Abyss",
    10611: "Welcome to the Hollow",
    10612: "Stores Before the Frost",
    10613: "Something to Trade",
    10614: "Supplies for the Hollow",
    10615: "A Night of Lights",
    10616: "The Sage's Burden",
    10617: "Matters of the Heart",
    10618: "A Memory of Iron",
    10619: "A Heart of Stillness and Wood",
    10620: "The Sage's Burden",
    10621: "Embers in the Garden",
    10622: "Words Nobody Taught",
    10623: "Boughs for the Lanterns",
    10624: "Charms Gone Gray",
    10625: "The Dilapidated Tomb",
    10626: "The Last Lantern",
    10627: "Missing Pieces",
    10628: "No Questions Asked",
    10629: "The Girl on the Rooftop",
    10630: "Medicine Money",
    10631: "Buying Time",
    10632: "Word from the Hideout",
    10633: "A Rival's Gambit",
    10634: "Two Thieves, One Plan",
    10635: "An Uneasy Truce",
    10636: "Rot at the Door",
    10637: "A Light Against the Rot",
    10638: "A Ward for the Door",
    10639: "Glowspore Ward",
    10640: "What Rots Below",
  },
};

const english = (language: string) => language !== "zh";

/** A name in the page's language, with the other language small after it. */
function Name({ zh, en }: { zh: string; en?: string }) {
  const { language } = usePreferences();
  const [main, other] = english(language) ? [en || zh, zh] : [zh, en];
  return (
    <>
      {main}
      {other && other !== main && <small className="hollow-sub">{other}</small>}
    </>
  );
}

/** Text written in both languages. */
function T({ zh, en }: { zh: ReactNode; en: ReactNode }) {
  const { language } = usePreferences();
  return <>{english(language) ? en : zh}</>;
}

const npc = (id: number, name: string) => (
  <SiteLink href={`/npc/${id}`}>
    <Name zh={name} en={EN.npc[id]} />
  </SiteLink>
);
const map = (id: number, name: string) => (
  <SiteLink href={`/map/${id}`}>
    <Name zh={name} en={EN.map[id]} />
  </SiteLink>
);
const mob = (id: number, name: string) => (
  <SiteLink href={`/mob/${id}`}>
    <Name zh={name} en={EN.mob[id]} />
  </SiteLink>
);

// 场景图和缩略图换过后改这个值，绕开浏览器和 CDN 的旧缓存。
const IMAGES = "20261120m";

type Step = [quest: number, name: string, level: number | null, what: ReactNode, whatEn: ReactNode];

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

const REWARDS_EN: Record<number, string> = {
  10600: "EXP 7,990 · Mesos 1,228 · Blue Potion ×20",
  10601: "EXP 7,990 · Mesos 1,228 · Return Scroll to Forgotten Hollow ×2",
  10602: "EXP 9,060 · Mesos 1,330 · one random Earring scroll (STR/DEX/INT/LUK, Greater)",
  10603: "EXP 12,300 · Mesos 1,535 · Topwear HP Scroll: Intermediate",
  10604: "EXP 12,300 · Mesos 1,535 · Mana Elixir ×15",
  10607: "EXP 7,990 · Mesos 1,228 · Orange Potion ×20",
  10608: "EXP 5,593 · Mesos 859 · Blue Potion ×20",
  10609: "EXP 7,990 · Mesos 1,228 · one random Helmet Accuracy scroll (Intermediate/Greater)",
  10610: "EXP 5,593 · Mesos 859 · Blue Potion ×10",
  10611: "EXP 5,593 · Mesos 859 · one random attack scroll for your class's weapon (Greater)",
  10612: "EXP 8,280 · Mesos 1,272 · White Potion ×15 · Blue Potion ×15",
  10613: "EXP 8,280 · Mesos 1,272 · one random Topwear/Bottomwear DEF scroll (Chaos)",
  10614: "EXP 10,400 · Mesos 1,418 · Return Scroll to Forgotten Hollow ×3",
  10615: "EXP 10,400 · Mesos 1,418 · Pansy Earrings · Standing Glowspore Lamp",
  10616: "EXP 9,875 · Mesos 2,500 · Mana Elixir ×2 · Lemon ×10 · Elixir ×15",
  10617: "EXP 10,400 · Mesos 1,418 · one random Cape Accuracy scroll (Intermediate/Greater)",
  10618: "EXP 10,400 · Mesos 1,418 · Watermelon ×15 · Lemon ×10",
  10619: "EXP 12,900 · Mesos 1,579 · Red Potion ×15 · Bottomwear HP Scroll: Greater",
  10620: "EXP 12,900 · Mesos 1,579 · Mana Elixir ×2 · Lemon ×10 · Elixir ×15",
  10621: "EXP 12,900 · Mesos 1,579 · White Potion ×15 · Return Scroll to Forgotten Hollow ×2",
  10622: "EXP 12,900 · Mesos 1,579 · Blue Potion ×30",
  10623: "EXP 12,900 · Mesos 1,579 · Sap of Ancient Tree ×3",
  10624: "EXP 15,600 · Mesos 1,667 · Elixir ×15",
  10625: "EXP 15,600 · Mesos 1,667 · Mana Elixir ×15",
  10626: "EXP 15,600 · Mesos 1,667 · Hearthkeeper's Lantern",
  10627: "EXP 11,340 · Mesos 1,207 · Elixir ×10 · Meat ×15",
  10628: "EXP 16,200 · Mesos 1,725 · Mana Elixir ×15",
  10629: "EXP 11,340 · Mesos 1,207 · one random Shoes Jump/Speed scroll (Greater)",
  10630: "EXP 11,340 · Mesos 1,207 · Meat ×15",
  10631: "EXP 16,200 · Mesos 1,725 · Lemon ×15",
  10632: "EXP 11,340 · Mesos 1,207 · Blue Potion ×15",
  10633: "EXP 11,340 · Mesos 1,207 · Salad ×15",
  10634: "EXP 16,200 · Mesos 1,725 · Dexterity Potion ×3",
  10635: "EXP 16,200 · Mesos 1,725 · one random One-Handed Sword/Axe/BW/Dagger attack scroll (Chaos)",
  10636: "EXP 16,200 · Mesos 1,725 · Pure Water ×10",
  10637: "EXP 16,200 · Mesos 1,725 · Speed Potion ×5",
  10638: "EXP 16,200 · Mesos 1,725 · Dexterity Potion ×5",
  10639: "EXP 11,340 · Mesos 1,207 · Pure Water ×10",
  10640: "EXP 16,200 · Mesos 1,725 · one random Cape STR/DEX/INT/LUK scroll (Chaos)",
};

const LINES: { who: ReactNode; steps: Step[] }[] = [
  {
    who: <>{npc(313, "汉斯")} · {map(10002003, "魔法图书馆")}</>,
    steps: [
      [10607, "遗憾之根", 39, <>到{map(10002021, "猴子森林Ⅰ")}打{mob(35, "猴子")}，收集 25 个发光魔力共鸣</>, <>Hunt {mob(35, "猴子")} in {map(10002021, "猴子森林Ⅰ")} for 25 Glowing Mana Resonances</>],
      [10608, "妖精的洞察", 39, <>去{map(10002000, "魔法密林")}找{npc(304, "妖精 艾温")}对话</>, <>Talk to {npc(304, "妖精 艾温")} in {map(10002000, "魔法密林")}</>],
      [10609, "追寻共鸣", 39, <>到{map(10002081, "北部森林训练场Ⅶ")}打{mob(37, "冰独眼兽")}，收集 25 个腐根碎片</>, <>Hunt {mob(37, "冰独眼兽")} in {map(10002081, "北部森林训练场Ⅶ")} for 25 Rotroot Shards</>],
      [10610, "无底深渊", 39, <>把消息带回给汉斯</>, <>Take the news back to Grendel</>],
      [10611, "欢迎来到遗忘空洞", 39, <>进遗忘空洞找{npc(702, "米恩")}；空洞里大部分任务要先做完这一步</>, <>Enter the Hollow and find {npc(702, "米恩")}; most quests in the Hollow need this one first</>],
    ],
  },
  {
    who: <>{npc(702, "米恩")} · <T zh="过冬" en={<>Winter stores</>} /></>,
    steps: [
      [10612, "入冬前的储备", 40, <>打 50 只{mob(54, "发光蘑菇")}，交 30 个发光蘑菇孢子</>, <>Defeat 50 {mob(54, "发光蘑菇")} and hand in 30 Glowshroom Spores</>],
      [10613, "用来交换的东西", 40, <>带上荧光孢子灯和 30 个莱芙花瓣（{mob(55, "莱芙")}），交给魔法密林的妖精 艾温</>, <>Bring the Glowspore Lamp and 30 Raffle Petals ({mob(55, "莱芙")}) to Arwen the Fairy in Ellinia</>],
      [10614, "送往空洞的物资", 45, <>从{npc(305, "妖精 罗雯")}拿过冬物资送给米恩，路上打 50 只{mob(57, "水螈")}</>, <>Take winter supplies from {npc(305, "妖精 罗雯")} to Myen; defeat 50 {mob(57, "水螈")} on the way</>],
      [10615, "灯火之夜", 45, <>{npc(701, "泽莉娅")}接：打 50 只{mob(58, "回音章鱼")}、50 只{mob(56, "黄金蝙蝠")}，交 30 个章鱼腿、20 个蝙蝠翅膀给米恩</>, <>From {npc(701, "泽莉娅")}: defeat 50 {mob(58, "回音章鱼")} and 50 {mob(56, "黄金蝙蝠")}, give Myen 30 Echopus Legs and 20 Stirge Wings</>],
    ],
  },
  {
    who: <>{npc(712, "学者丹尼尔")} · {map(10006160, "黑暗峭壁")}</>,
    steps: [
      [10616, "贤者的重担", 50, <>接在过冬线之后：和丹尼尔对话，回魔法图书馆交给汉斯</>, <>After the winter line: talk to Daniel, then report to Grendel in the Magic Library</>],
      [10617, "心事", 45, <>{npc(707, "尼洛斯")}把烧焦的卷轴交给你，送去{map(10006140, "腐烂隧道Ⅲ")}给{npc(711, "探险家杰米")}</>, <>{npc(707, "尼洛斯")} hands you a burnt scroll; take it to {npc(711, "探险家杰米")} in {map(10006140, "腐烂隧道Ⅲ")}</>],
      [10618, "铁之记忆", 45, <>打 50 只回音章鱼</>, <>Defeat 50 Echopus</>],
      [10619, "静与木之心", 50, <>交给丹尼尔 30 个诅咒娃娃（{mob(38, "僵尸猴")}）和 20 个暮色螈尾（{mob(60, "暮色螈")}）</>, <>Give Daniel 30 Cursed Dolls ({mob(38, "僵尸猴")}) and 20 Duskmander Tails ({mob(60, "暮色螈")})</>],
      [10620, "贤者的重担", 50, <>再回魔法图书馆交给汉斯</>, <>Report to Grendel in the Magic Library again</>],
    ],
  },
  {
    who: <>{npc(701, "泽莉娅")} · {map(10006001, "洞穴精灵圣域")}</>,
    steps: [
      [10600, "泽莉娅的地图", 39, <>25 个地图片段，打发光蘑菇</>, <>25 Map Fragments from Glowshrooms</>],
      [10601, "天然黏合剂", 39, <>打 40 只莱芙，交 25 个莱芙花瓣</>, <>Defeat 40 Raffles and hand in 25 Raffle Petals</>],
      [10602, "回家的一步", 42, <>打 75 只水螈、25 只回音章鱼</>, <>Defeat 75 Aqumanders and 25 Echopus</>],
    ],
  },
  {
    who: <>{npc(703, "米拉")} · {map(10006150, "挥之不去的遗憾")}</>,
    steps: [
      [10603, "老朋友", 49, <>打 50 只{mob(61, "木喵")}、50 只{mob(63, "孢子木")}</>, <>Defeat 50 {mob(61, "木喵")} and 50 {mob(63, "孢子木")}</>],
      [10604, "米拉的老朋友", 49, <>把不祥的腐枝交给汉斯</>, <>Give the Ominous Rotten Branch to Grendel</>],
    ],
  },
  {
    who: <>{npc(715, "塔米娅")} · {map(10006022, "腐烂的空中花园")}</>,
    steps: [
      [10621, "庭中余烬", 50, <>打 60 只暮色螈</>, <>Defeat 60 Duskmanders</>],
      [10622, "无人教诲之言", 50, <>把日志送给丹尼尔</>, <>Take the journal to Daniel</>],
      [10623, "灯笼用的树枝", 50, <>打 60 只木喵，交 30 个巨树枝给杰米</>, <>Defeat 60 Myewoods and give Jaime 30 Giant Branches</>],
      [10624, "褪色的护符", 53, <>打 60 只{mob(62, "腐烂蘑菇")}，交 30 个腐朽护符</>, <>Defeat 60 {mob(62, "腐烂蘑菇")} and hand in 30 Decayed Charms</>],
      [10625, "破败的坟墓", 53, <>在{map(10006161, "破败的坟墓")}打 60 只孢子木，把艾尔达的护符交给丹尼尔</>, <>Defeat 60 Sporewoods in {map(10006161, "破败的坟墓")} and give Elda&apos;s charm to Daniel</>],
      [10626, "最后的灯笼", 53, <>交回塔米娅</>, <>Report back to Tamya</>],
    ],
  },
  {
    who: <>{npc(702, "米恩")} · <T zh="失窃（接在塔米娅线之后）" en={<>The theft (after Tamya&apos;s line)</>} /></>,
    steps: [
      [10627, "失窃的东西", 55, <>去{map(10003000, "废弃都市")}网吧楼顶找{npc(437, "阿尔斯顿")}</>, <>Find {npc(437, "阿尔斯顿")} on the internet café rooftop in {map(10003000, "废弃都市")}</>],
      [10628, "不问来路", 55, <>交 20 张账本残页，在原始森林Ⅱ、遗忘入口Ⅰ打黄金蝙蝠</>, <>Hand in 20 Ledger Scraps from Golden Stirges in Primeval Forest II and Forgotten Entrance I</>],
      [10629, "屋顶上的女孩", 55, <>去美发店楼顶找{npc(438, "惠特妮")}</>, <>Find {npc(438, "惠特妮")} on the hair salon rooftop</>],
      [10630, "药钱", 55, <>找丹尼尔问病情</>, <>Ask Daniel about the illness</>],
      [10631, "争取时间", 55, <>在黑暗峭壁收集 25 个未被污染的蘑菇盖，交给惠特妮</>, <>Collect 25 Untainted Mushroom Caps at the Precipice of Darkness and give them to Whitney</>],
      [10632, "来自藏身处的消息", 55, <>去{map(10003003, "盗贼藏身处")}找{npc(411, "达克鲁")}</>, <>Find {npc(411, "达克鲁")} in the {map(10003003, "盗贼藏身处")}</>],
      [10633, "对手的算盘", 55, <>把达克鲁的提议带给阿尔斯顿</>, <>Take the Dark Lord&apos;s offer to Alston</>],
      [10634, "两个盗贼，一个计划", 55, <>在遗忘入口Ⅱ、Ⅲ打 60 只莱芙，找惠特妮</>, <>Defeat 60 Raffles in Forgotten Entrance II and III, then see Whitney</>],
      [10635, "不安的休战", 55, <>把米恩的结界卷轴还给米恩</>, <>Return Myen&apos;s ward scroll to Myen</>],
    ],
  },
  {
    who: <>{npc(717, "微光")} · {map(10006122, "腐烂之屋")}</>,
    steps: [
      [10636, "门口的腐烂", 55, <>打 60 只腐烂蘑菇</>, <>Defeat 60 Rotten Mushrooms</>],
      [10637, "对抗腐烂的光", 55, <>在{map(10006121, "别人的坟墓")}打僵尸蘑菇，交 50 个不死者护符</>, <>Defeat Zombie Mushrooms in {map(10006121, "别人的坟墓")} and hand in 50 Undead Charms</>],
      [10638, "门上的结界", 55, <>交 30 个巨树枝（木喵）给米恩</>, <>Give Myen 30 Giant Branches (Myewood)</>],
      [10639, "荧光孢子结界", 55, <>把米恩做好的结界带回给微光</>, <>Take the ward Myen made back to Glimmer</>],
      [10640, "地底的腐烂之源", 55, <>打倒别人的坟墓深处的{mob(700003, "腐烂蘑菇王")}，带回它的蘑菇盖</>, <>Defeat {mob(700003, "腐烂蘑菇王")} deep in Someone Else&apos;s Grave and bring back its cap</>],
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
      {steps.map(([quest, name, level, what, whatEn]) => (
        <li key={quest}>
          <b>
            <Name zh={name} en={EN.quest[quest]} />
          </b>
          {level !== null && <span className="hollow-lv">Lv{level}</span>}
          <span className="hollow-what">
            <T zh={what} en={whatEn} />
          </span>
          {REWARDS[quest] && (
            <span className="hollow-reward">
              <b>
                <T zh="奖励" en="Rewards" />
              </b>{" "}
              <T zh={REWARDS[quest]} en={REWARDS_EN[quest]} />
            </span>
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
        <b>
          <Name zh={name} en={EN.map[id]} />
        </b>
      </SiteLink>
      {info && (
        <div className="hollow-map-info">
          {info.mobs.length ? (
            <ul className="hollow-map-mobs">
              {info.mobs.map((mob) => (
                <li key={mob.id}>
                  <SiteLink href={`/mob/${mob.id}`}>
                    <img src={`/web/images/mobs/head/${mob.id}.png`} alt="" width={24} height={24} loading="lazy" />
                    <Name zh={mob.names.zh} en={mob.names.en} />
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
              <b>
                <Name zh={name} en={EN.mob[id]} />
              </b>
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
