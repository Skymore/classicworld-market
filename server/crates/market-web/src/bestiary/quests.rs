//! Quests from NiaDB `quests.json`: rewards (an item source), the items and
//! monsters they ask for, NPC, level and event dates. DVG's quest list
//! (`data/reference/dvg/quest-list.json`, `tools/dvg_lists.py`) adds the
//! simplified names Chinese players see and the giver's NPC id.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::mapledex::{clean, nia_id, quest_area_opens_later, same_mob_name, Dataset};
use super::rows::{QuestNeedRow, QuestRewardRow, QuestRow};

#[derive(Deserialize)]
struct NiaQuest {
    id: String,
    name: Option<String>,
    npc: Option<String>,
    #[serde(rename = "levelMin")]
    level_min: Option<i16>,
    area: Option<i32>,
    #[serde(default)]
    need: Vec<NiaNeed>,
    #[serde(default)]
    get: Vec<NiaItem>,
    #[serde(rename = "rewardChoices", default)]
    reward_choices: Vec<NiaGroup>,
    #[serde(rename = "rewardRandom", default)]
    reward_random: Vec<NiaGroup>,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    #[serde(rename = "isDaily", default)]
    is_daily: Option<bool>,
    #[serde(rename = "isWeekly", default)]
    is_weekly: Option<bool>,
}

#[derive(Deserialize)]
struct NiaNeed {
    #[serde(rename = "itemId")]
    item_id: Option<i32>,
    #[serde(rename = "mobId")]
    mob_id: Option<i32>,
    count: Option<i64>,
}

#[derive(Deserialize)]
struct NiaItem {
    #[serde(rename = "itemId")]
    item_id: Option<i32>,
    count: Option<i64>,
    /// The job or gender a fixed reward is for.
    only: Option<String>,
    chance: Option<f64>,
}

#[derive(Deserialize)]
struct NiaGroup {
    #[serde(rename = "jobName")]
    job_name: Option<String>,
    #[serde(default)]
    items: Vec<NiaItem>,
}

/// `data/reference/dvg/quest-list.json` (written by `tools/dvg_lists.py`).
#[derive(Deserialize)]
pub struct DvgQuests {
    pub fetched: String,
    items: Vec<DvgQuest>,
}

#[derive(Deserialize)]
struct DvgQuest {
    questid: i32,
    questname: Option<String>,
    name_en: Option<String>,
    npcid: Option<i32>,
}

impl DvgQuests {
    pub fn from_file(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }
}

/// What `add_quests` wrote.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct QuestCounts {
    pub quests: usize,
    /// With DVG's simplified name.
    pub named_zh: usize,
    pub with_npc: usize,
    pub unreleased: usize,
    pub rewards: usize,
    pub needs: usize,
}

fn fold(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The items of reward groups, with each group's job ("Any Class" is none).
fn grouped<'a>(
    kind: &'static str,
    groups: &'a [NiaGroup],
) -> impl Iterator<Item = (&'static str, Option<String>, &'a NiaItem)> + 'a {
    groups.iter().flat_map(move |g| {
        let job = clean(g.job_name.as_deref()).filter(|j| j != "Any Class");
        g.items.iter().map(move |i| (kind, job.clone(), i))
    })
}

fn count(n: Option<i64>) -> Option<i32> {
    n.and_then(|n| i32::try_from(n).ok()).filter(|&n| n > 0)
}

impl Dataset {
    /// Reads NiaDB `quests.json` and DVG `quest-list.json`.
    pub fn add_quests_from(
        &mut self,
        niadb_dir: &Path,
        dvg: &DvgQuests,
        today: NaiveDate,
    ) -> Result<QuestCounts> {
        let path = niadb_dir.join("quests.json");
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        self.add_quests(&text, dvg, today)
    }

    /// One `quests` row per NiaDB quest with its rewards and needs. The NPC is
    /// DVG's id, else the NPC NiaDB names (an open one when several share the
    /// name). A quest is unreleased when its area opens later or its NPC only
    /// stands on unreleased maps. Call after the NPCs, mobs and their
    /// `unreleased` flags are final.
    pub fn add_quests(
        &mut self,
        quests: &str,
        dvg: &DvgQuests,
        today: NaiveDate,
    ) -> Result<QuestCounts> {
        let quests: Vec<NiaQuest> =
            serde_json::from_str(quests).context("parsing NiaDB quests.json")?;
        let dvg: HashMap<i32, &DvgQuest> = dvg.items.iter().map(|q| (q.questid, q)).collect();
        let npcs: HashMap<i32, bool> = self.npcs.iter().map(|n| (n.id, n.unreleased)).collect();
        let mut by_name: HashMap<String, Vec<i32>> = HashMap::new();
        for npc in &self.npcs {
            if let Some(name) = npc.name_en.as_deref() {
                by_name.entry(fold(name)).or_default().push(npc.id);
            }
        }
        let mobs: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        let mut counts = QuestCounts::default();
        let mut seen = HashSet::new();
        for quest in &quests {
            let Some(id) = nia_id(&quest.id).filter(|id| seen.insert(*id)) else {
                self.warnings
                    .push(format!("NiaDB quest {:?}: bad or repeated id", quest.id));
                continue;
            };
            let name_en = clean(quest.name.as_deref());
            let dvg_row = dvg.get(&id).filter(|d| {
                same_mob_name(
                    name_en.as_deref().unwrap_or(""),
                    d.name_en.as_deref().unwrap_or(""),
                )
            });
            let name_zh = dvg_row.and_then(|d| clean(d.questname.as_deref()));
            let npc_id = dvg_row
                .and_then(|d| d.npcid)
                .filter(|id| npcs.contains_key(id))
                .or_else(|| {
                    let mut ids = by_name
                        .get(&fold(quest.npc.as_deref().unwrap_or("")))?
                        .clone();
                    ids.sort_by_key(|id| (npcs[id], *id));
                    ids.first().copied()
                });
            let unreleased = quest
                .area
                .is_some_and(|area| quest_area_opens_later(area, today))
                || npc_id.is_some_and(|id| npcs[&id]);
            let date = |raw: &Option<String>, what: &str, warnings: &mut Vec<String>| {
                let raw = clean(raw.as_deref())?;
                match chrono::DateTime::parse_from_rfc3339(&raw) {
                    Ok(_) => Some(raw),
                    Err(_) => {
                        warnings.push(format!("NiaDB quest {id}: {what} {raw:?} is not a date"));
                        None
                    }
                }
            };
            let starts_at = date(&quest.start_date, "start", &mut self.warnings);
            let ends_at = date(&quest.end_date, "end", &mut self.warnings);
            counts.named_zh += usize::from(name_zh.is_some());
            counts.with_npc += usize::from(npc_id.is_some());
            counts.unreleased += usize::from(unreleased);
            self.quests.push(QuestRow {
                id,
                name_en,
                name_zh,
                name_tw: None,
                npc_id,
                level_min: quest.level_min.filter(|&l| l > 0),
                repeats: if quest.is_daily == Some(true) {
                    Some("daily")
                } else if quest.is_weekly == Some(true) {
                    Some("weekly")
                } else {
                    None
                },
                starts_at,
                ends_at,
                unreleased,
            });
            // Rewards: one row per item, the first kind that lists it.
            let mut rewards: BTreeMap<i32, QuestRewardRow> = BTreeMap::new();
            let fixed = quest.get.iter().map(|i| ("fixed", i.only.clone(), i));
            for (kind, job, item) in fixed
                .chain(grouped("choice", &quest.reward_choices))
                .chain(grouped("random", &quest.reward_random))
            {
                let (Some(item_id), Some(quantity)) =
                    (item.item_id.filter(|&i| i > 0), count(item.count))
                else {
                    continue;
                };
                rewards.entry(item_id).or_insert(QuestRewardRow {
                    quest_id: id,
                    item_id,
                    quantity,
                    kind,
                    job: clean(job.as_deref()),
                    chance_pct: item.chance.filter(|c| *c > 0.0 && *c <= 100.0),
                });
            }
            counts.rewards += rewards.len();
            self.quest_rewards.extend(rewards.into_values());
            let mut ord: i16 = 0;
            for need in &quest.need {
                let quantity = count(need.count).unwrap_or(0);
                let (item_id, mob_id) = match (need.item_id, need.mob_id) {
                    (Some(item), None) if item > 0 => (Some(item), None),
                    (None, Some(mob)) if mobs.contains(&mob) => (None, Some(mob)),
                    _ => continue,
                };
                self.quest_needs.push(QuestNeedRow {
                    quest_id: id,
                    ord,
                    item_id,
                    mob_id,
                    quantity,
                });
                ord = ord.saturating_add(1);
                counts.needs += 1;
            }
            counts.quests += 1;
        }
        Ok(counts)
    }
}
