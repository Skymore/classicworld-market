//! Bounded read-only access to a pinned Global Classic World client export.
//! No runtime URL fetching or arbitrary database queries in the client tools.
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::bestiary::mapledex::{opens_later, quest_area_opens_later};

fn snapshot() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("adventure-data.json"))
            .expect("validated gameplay snapshot")
    })
}

/// The snapshot as players can see it today: like the bestiary, areas that
/// open later (`OPENS_LATER`, Forgotten Hollow until 18 November) are left out.
fn data() -> &'static Value {
    data_on(chrono::Utc::now().date_naive())
}

fn data_on(today: NaiveDate) -> &'static Value {
    // One area is pending, so one filtered copy covers every day before it.
    static BEFORE: OnceLock<Value> = OnceLock::new();
    let raw = snapshot();
    if !hides_anything(raw, today) {
        return raw;
    }
    BEFORE.get_or_init(|| without_unopened(raw, today))
}

fn row_id(row: &Value) -> Option<i32> {
    row["id"]
        .as_i64()
        .or_else(|| row["id"].as_str()?.parse().ok())
        .and_then(|id| i32::try_from(id).ok())
}

fn closed_map(id: Option<i32>, today: NaiveDate) -> bool {
    id.is_some_and(|id| opens_later(id, today))
}

fn closed_quest(quest: &Value, today: NaiveDate) -> bool {
    quest["area"]
        .as_i64()
        .and_then(|a| i32::try_from(a).ok())
        .is_some_and(|area| quest_area_opens_later(area, today))
}

fn hides_anything(raw: &Value, today: NaiveDate) -> bool {
    raw["map"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| closed_map(row_id(m), today))
        || raw["quest"]
            .as_array()
            .unwrap()
            .iter()
            .any(|q| closed_quest(q, today))
}

/// Drops closed maps and quests, and closed maps from every list of maps;
/// monsters and NPCs left with only closed maps go too.
fn without_unopened(raw: &Value, today: NaiveDate) -> Value {
    let mut out = raw.clone();
    let closed = |v: &Value| {
        closed_map(
            row_id(v).or_else(|| v.as_i64().and_then(|i| i32::try_from(i).ok())),
            today,
        )
    };
    out["map"].as_array_mut().unwrap().retain(|m| !closed(m));
    for map in out["map"].as_array_mut().unwrap() {
        for key in ["exits", "exit_names"] {
            if let Some(list) = map[key].as_array_mut() {
                list.retain(|v| !closed(v));
            }
        }
    }
    out["quest"]
        .as_array_mut()
        .unwrap()
        .retain(|q| !closed_quest(q, today));
    for kind in ["monster", "npc"] {
        out[kind].as_array_mut().unwrap().retain_mut(|row| {
            let Some(maps) = row["maps"].as_array_mut() else {
                return true;
            };
            let had = !maps.is_empty();
            maps.retain(|m| !closed(m));
            !(had && maps.is_empty())
        });
    }
    out
}

pub fn definitions() -> Vec<Value> {
    let def = |name, description, properties, required| {
        json!({"type":"function","function":{
        "name":name,"description":description,"strict":false,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})
    };
    let query = json!({"type":"string","maxLength":100,"default":"","description":"Entity or skill name keywords in English or Chinese. Use English if no Chinese match. Do not put a whole question here."});
    let level = json!({"type":["integer","null"],"minimum":0,"maximum":250,"default":null});
    let kind = json!({"type":"string","enum":["monster","map","npc","quest"]});
    vec![
        def("get_game_rules", "Identify our game edition, available classes, dataset date and limitations. Use for version, job advancement and general gameplay context; not market prices.", json!({}), json!([])),
        def("get_skills", "Look up Global Classic World skill mechanics, prerequisites and ranks. REQUIRED before skill/AP/SP/build advice. Returns all skills for an exact class, or matching names. class_name: Beginner, Warrior, Fighter, Page, Spearman, Magician, F/P Wizard, I/L Wizard, Cleric, Archer, Hunter, Crossbowman, Rogue, Assassin, Bandit. Hunter is bow; Crossbowman is crossbow. Rank is optional; omitted returns first/max effects, not every intermediate rank. The data is not a recommended build.",
            json!({"query":query,"class_name":{"type":["string","null"],"maxLength":40,"default":null},"rank":{"type":["integer","null"],"minimum":1,"maximum":30,"default":null}}), json!([])),
        def("search_game_data", "Search Classic World monsters, maps, NPCs or quests. For training, kind=monster with a suitable level range and empty query: returns HP, EXP and spawn maps, sorted by EXP/HP (a theoretical comparison, not measured EXP/hour). For quests use name keywords, not a whole question. Returns at most 12; read details with get_game_entity. Not player inventory or live server status.",
            json!({"kind":kind,"query":query,"min_level":level,"max_level":level}), json!(["kind"])),
        def("get_game_entity", "Read a resolved Classic World monster/map/NPC/quest ID from search_game_data: stats and spawn maps, map monsters/exits/NPCs, NPC locations, or quest requirements and rewards. Use IDs from tools, never from modern GMS memory. Sources have explicit snapshot dates.",
            json!({"kind":kind,"id":{"type":"integer","minimum":0,"maximum":999999999}}), json!(["kind","id"])),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skills {
    #[serde(default)]
    query: String,
    class_name: Option<String>,
    rank: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    kind: String,
    #[serde(default)]
    query: String,
    min_level: Option<i64>,
    max_level: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entity {
    kind: String,
    id: i64,
}
pub enum Request {
    Rules,
    Skills(Skills),
    Search(Search),
    Entity(Entity),
}
fn valid_kind(s: &str) -> bool {
    matches!(s, "monster" | "map" | "npc" | "quest")
}
fn classes() -> Vec<String> {
    let mut result = data()["skill"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["class_name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}
fn class_alias(s: &str) -> &str {
    match s.trim() {
        "初心者" | "新手" => "Beginner",
        "战士" => "Warrior",
        "剑客" => "Fighter",
        "准骑士" => "Page",
        "枪战士" => "Spearman",
        "魔法师" | "法师" => "Magician",
        "火毒" | "火毒法师" => "F/P Wizard",
        "冰雷" | "冰雷法师" => "I/L Wizard",
        "牧师" => "Cleric",
        "弓箭手" | "弓手" => "Archer",
        "猎人" => "Hunter",
        "弩弓手" | "弩手" => "Crossbowman",
        "飞侠" => "Rogue",
        "刺客" => "Assassin",
        "侠客" => "Bandit",
        _ => s.trim(),
    }
}
pub fn parse(name: &str, args: Value) -> Result<Request, &'static str> {
    let bad = "invalid_tool_arguments";
    Ok(match name {
        "get_game_rules" if args.as_object().is_some_and(|o| o.is_empty()) => Request::Rules,
        "get_skills" => {
            let mut s: Skills = serde_json::from_value(args).map_err(|_| bad)?;
            if let Some(c) = &s.class_name {
                s.class_name = Some(class_alias(c).to_owned());
            }
            if s.query.chars().count() > 100
                || s.rank.is_some_and(|r| !(1..=30).contains(&r))
                || s.class_name
                    .as_ref()
                    .is_some_and(|c| !classes().iter().any(|v| v.eq_ignore_ascii_case(c)))
                || (s.query.trim().is_empty() && s.class_name.is_none())
            {
                return Err(bad);
            }
            Request::Skills(s)
        }
        "search_game_data" => {
            let s: Search = serde_json::from_value(args).map_err(|_| bad)?;
            if !valid_kind(&s.kind)
                || s.query.chars().count() > 100
                || s.min_level.is_some_and(|n| !(0..=250).contains(&n))
                || s.max_level.is_some_and(|n| !(0..=250).contains(&n))
                || s.min_level.zip(s.max_level).is_some_and(|(a, b)| a > b)
                || (s.query.trim().is_empty() && s.min_level.is_none() && s.max_level.is_none())
                || (!matches!(s.kind.as_str(), "monster" | "quest")
                    && (s.min_level.is_some() || s.max_level.is_some()))
            {
                return Err(bad);
            }
            Request::Search(s)
        }
        "get_game_entity" => {
            let s: Entity = serde_json::from_value(args).map_err(|_| bad)?;
            if !valid_kind(&s.kind) || !(0..=999_999_999).contains(&s.id) {
                return Err(bad);
            }
            Request::Entity(s)
        }
        _ => return Err("unknown_tool"),
    })
}

fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn matches(row: &Value, query: &str) -> bool {
    let searchable = [
        "id",
        "name",
        "aliases",
        "npc_name",
        "region",
        "parent",
        "street_name",
    ]
    .iter()
    .map(|k| row[*k].to_string())
    .collect::<String>();
    let searchable = normalized(&searchable);
    query
        .split_whitespace()
        .all(|term| searchable.contains(&normalized(term)))
}
fn envelope(kind: &str, value: Value) -> Value {
    let mut value = value;
    value["game"] = data()["provenance"].clone();
    value["source_urls"] = json!([data()["provenance"]["sources"][kind]]);
    value
}
fn id(row: &Value) -> Option<i64> {
    row["id"]
        .as_i64()
        .or_else(|| row["id"].as_str()?.parse().ok())
}
pub fn run(request: Request) -> Value {
    match request {
        Request::Rules => envelope(
            "skill",
            json!({"classes":classes(),"scope":"冒险助手 / Adventure assistant: jobs, skills, AP/SP planning, leveling, maps, quests, drops, equipment, crafting/citizenship questions and the market. Default game is Global MapleStory Classic World. Other editions require explicit comparison and separate sources.","limits":["This export contains beginner, first and second jobs only. Do not treat archived CoT2 third-job content or modern GMS, Artale, MapleLand, CMS/TMS or private-server rules as this live edition.","Skill prerequisites/effects are facts; recommended build order is advice. Check rank caps and prerequisites before recommending SP. Do not claim an exact optimal build or measured EXP/hour from this data.","Map spawn counts are client spawn points, not simultaneous live monsters. Client quests may include unavailable server content. Quest chain prerequisites, job/level restrictions and reward choice must be preserved.","Client data alone does not provide current server rules. Consult search_guides and search_web for official notices, events and crafting/citizenship rules. Inventory and the player's existing character build remain unavailable unless supplied."]}),
        ),
        Request::Skills(s) => {
            let mut rows: Vec<Value> = data()["skill"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| {
                    s.class_name.as_ref().is_none_or(|c| {
                        r["class_name"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(c))
                    })
                })
                .filter(|r| matches(r, &s.query))
                .cloned()
                .collect();
            let total = rows.len();
            rows.truncate(12);
            for row in &mut rows {
                let levels = row
                    .as_object_mut()
                    .unwrap()
                    .remove("all_level_stats")
                    .unwrap_or(json!([]));
                row["rank_1_effect"] = levels[0].clone();
                row["max_rank_effect"] = levels
                    .as_array()
                    .and_then(|v| v.last())
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Some(rank) = s.rank {
                    row["requested_rank"] = json!(rank);
                    row["requested_rank_effect"] =
                        levels.get(rank - 1).cloned().unwrap_or(Value::Null);
                    if row["requested_rank_effect"].is_null() {
                        row["rank_note"] =
                            json!("No recorded row at this rank. Do not extrapolate.");
                    }
                }
            }
            envelope(
                "skill",
                json!({"skills":rows,"total_matches":total,"truncated":total>12,"build_note":"No authoritative SP allocation or character's existing skill levels provided. Offer a reasoned, explicitly suggested path from these prerequisites, not a universal official build. Complete required prerequisite ranks BEFORE adding a dependent skill. Skill English names are authoritative in this source; do not invent Chinese translations.","class_names":classes(),
                "hunter_unlock_example":if s.class_name.as_deref().is_some_and(|c| c.eq_ignore_ascii_case("Hunter")) {json!({"type":"editorial suggestion, not official build or measured optimum","assumes":"New second-job skills are all zero; complete incrementally only when enough SP is available. An existing build needs its actual allocated ranks.","steps":[{"skill":"Arrow Bomb","target_rank":1},{"skill":"Bow Mastery","target_rank":5},{"skill":"Bow Booster","target_rank":5},{"skill":"Soul Arrow: Bow","target_rank":1}],"total_sp_from_zero":12,"later_priorities":"Compare maxing Bow Mastery for stability and Arrow Bomb for training; Final Attack: Bow is the current trigger-then-manual-use attack, not the old automatic follow-up. Amazon's Judgement is the slow-on-critical passive, not The Eye of Amazon. Do not max every buff or invent a full 30-70 SP plan."})} else {Value::Null}}),
            )
        }
        Request::Search(s) => {
            let mut rows = data()[&s.kind]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| matches(r, &s.query))
                .filter(|r| {
                    let n = r[if s.kind == "quest" {
                        "level_min"
                    } else {
                        "level"
                    }]
                    .as_i64();
                    s.min_level.is_none_or(|lo| n.is_some_and(|n| n >= lo))
                        && s.max_level.is_none_or(|hi| n.is_some_and(|n| n <= hi))
                })
                .filter(|r| {
                    s.kind != "monster"
                        || !s.query.trim().is_empty()
                        || (!r["boss"].as_bool().unwrap_or(false)
                            && !r["is_boss"].as_bool().unwrap_or(false)
                            && !r["name"].as_str().unwrap_or("").starts_with("Tutorial"))
                })
                .cloned()
                .collect::<Vec<_>>();
            if s.kind == "monster" {
                rows.sort_by(|a, b| {
                    let score = |r: &Value| {
                        r["exp"].as_f64().unwrap_or(0.) / r["hp"].as_f64().unwrap_or(1.).max(1.)
                    };
                    score(b).total_cmp(&score(a))
                });
            }
            let total = rows.len();
            rows.truncate(12);
            for row in &mut rows {
                for field in ["requirements_list", "rewards", "npc_positions"] {
                    row.as_object_mut().unwrap().remove(field);
                }
            }
            envelope(
                &s.kind,
                json!({"kind":s.kind,"results":rows,"total_matches":total,"truncated":total>12,"note":"Search results are snapshot candidates. Read details for requirements, quest chains and locations. Empty Chinese results: try the English name. EXP/HP does not account for travel, misses, attack speed, crowding, respawn or potion costs."}),
            )
        }
        Request::Entity(s) => {
            let row = data()[&s.kind]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| id(r) == Some(s.id));
            envelope(
                &s.kind,
                json!({"kind":s.kind,"entity":row,"found":row.is_some()}),
            )
        }
    }
}

pub fn trusted_source(url: &str) -> bool {
    data()["provenance"]["sources"]
        .as_object()
        .unwrap()
        .values()
        .any(|v| v.as_str() == Some(url))
}

/// Drop chances are server data, absent from the client. The drops come from
/// NiaDB's community reports; keep them separate from the client stats.
pub async fn supplement(db: &sqlx::PgPool, value: &mut Value) -> sqlx::Result<()> {
    if value["kind"] != "monster" {
        return Ok(());
    }
    let Some(id) = value["entity"]["id"].as_i64() else {
        return Ok(());
    };
    let drops: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT d.item_id,COALESCE(i.name_en,d.name_en) AS name_en,
         COALESCE(i.name_zh,d.name_zh) AS name_zh,d.meso_min,d.meso_max,d.upvotes,d.downvotes,d.source
         FROM drops d LEFT JOIN items i ON i.id=d.item_id
         WHERE d.mob_id=$1 ORDER BY d.ord LIMIT 20) x",
    )
    .bind(id as i32)
    .fetch_all(db)
    .await?;
    value["drop_reference"] = json!({"drops":drops,"limit":20,
        "provenance":"NiaDB community reports of what players saw this monster drop in Classic World, kept only with more up than down votes (weighted), most confirmed first. A row with meso_min/meso_max is NiaDB's median meso amount per pile over its trusted reports. Classic World publishes no drop rates.",
        "note":"Client stats above and player-reported drops below have different provenance. Do not state or estimate drop rates."});
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forgotten_hollow_stays_out_until_it_opens() {
        let before = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let after = NaiveDate::from_ymd_opt(2026, 11, 18).unwrap();
        let shut = data_on(before);
        let ids = |v: &Value, kind: &str| -> Vec<i32> {
            v[kind]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(row_id)
                .collect()
        };
        assert!(!ids(shut, "map").contains(&10006121));
        assert!(!ids(shut, "monster").contains(&700003));
        assert!(!shut["quest"]
            .as_array()
            .unwrap()
            .iter()
            .any(|q| q["area"] == 17));
        // Zombie Mushroom spawns elsewhere too: kept, without the closed map.
        let zombie = shut["monster"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == 21)
            .unwrap();
        assert!(!zombie["maps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == 10006121));
        let open = data_on(after);
        assert!(ids(open, "map").contains(&10006121));
        assert!(open["quest"]
            .as_array()
            .unwrap()
            .iter()
            .any(|q| q["area"] == 17));
    }
    #[test]
    fn launch_skills_do_not_mix_prerequisites_or_old_final_attack() {
        let r = run(parse("get_skills", json!({"class_name":"猎人"})).unwrap());
        let rows = r["skills"].as_array().unwrap();
        let find = |name| rows.iter().find(|r| r["name"] == name).unwrap();
        assert_eq!(find("Bow Booster")["required_skill"], "Bow Mastery Lv.5");
        assert_eq!(
            find("Soul Arrow: Bow")["required_skill"],
            "Bow Booster Lv.5"
        );
        assert_eq!(
            find("Final Attack: Bow")["required_skill"],
            "Bow Mastery Lv.3"
        );
        assert!(find("Final Attack: Bow")["description"]
            .as_str()
            .unwrap()
            .contains("60 sec"));
        assert!(rows.iter().any(|r| r["name"] == "Amazon's Judgement"));
        assert!(!rows.iter().any(|r| r["name"] == "Power Knockback"));
        let mut allocated = std::collections::BTreeMap::new();
        let mut cost = 0;
        for step in r["hunter_unlock_example"]["steps"].as_array().unwrap() {
            let name = step["skill"].as_str().unwrap();
            let skill = find(name);
            if let Some(required) = skill["required_skill"].as_str() {
                let (prerequisite, rank) = required.split_once(" Lv.").unwrap();
                assert!(
                    allocated.get(prerequisite).copied().unwrap_or(0)
                        >= rank.parse::<i64>().unwrap()
                );
            }
            let rank = step["target_rank"].as_i64().unwrap();
            assert!(rank <= skill["max_level"].as_i64().unwrap());
            cost += rank;
            allocated.insert(name, rank);
        }
        assert_eq!(cost, 12);
        assert!(parse("get_skills", json!({"class_name":"Ranger"})).is_err());
        assert!(parse(
            "get_game_entity",
            json!({"kind":"quest","id":1,"url":"https://example.com"})
        )
        .is_err());
        assert!(!trusted_source("https://github.com.evil.test/"));
        let r = run(parse(
            "get_skills",
            json!({"class_name":"Hunter","query":"Bow Booster","rank":30}),
        )
        .unwrap());
        assert!(r["skills"][0]["requested_rank_effect"].is_null());
        assert!(!r["skills"][0]["rank_note"].is_null());
    }
}
