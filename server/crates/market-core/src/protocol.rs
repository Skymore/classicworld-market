//! Upload schema v1, ported check for check from `shared_protocol.validate`.
//!
//! The order of checks and the accepted shapes follow Python, including its
//! loose corners (`version: true` equals 1, an empty string iterates as an
//! empty list), so a payload is accepted here exactly when Python accepts it.
//! `Upload::clean_json` rebuilds Python's cleaned dict, so fingerprints match
//! the hashes the Python store recorded.

use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::pyjson;

pub const WORLD: &str = "ClassicWorld";
pub const MAX_ITEMS: usize = 200;
/// Channel IDs use the unsigned-byte representation shared with the reader.
pub const MAX_CHANNEL: u16 = 255;
/// Free-market rooms are maps 80002000..=80002022.
pub const MARKET_MAP_BASE: u32 = 80_002_000;
pub const EQUIPMENT_PARSER: &str = "cw_equipment_v1";
pub const EQUIPMENT_NOTE: &str = "包内解析值，待同件截图核对";
const UPLOAD_WINDOW_SECONDS: f64 = 30.0 * 86400.0;
const CLOCK_AHEAD_SECONDS: f64 = 120.0;
const MAX_UNKNOWN_FIELDS: usize = 17;

/// `market_equipment.FIELDS` values: stat key and label.
pub const EQUIPMENT_FIELDS: [(&str, &str); 16] = [
    ("str", "力量"),
    ("dex", "敏捷"),
    ("int", "智力"),
    ("luk", "运气"),
    ("hp", "最大 HP"),
    ("mp", "最大 MP"),
    ("speed", "移动速度"),
    ("jump", "跳跃力"),
    ("magic_attack", "魔法攻击"),
    ("weapon_defense", "物理防御"),
    ("magic_defense", "魔法防御"),
    ("accuracy", "命中"),
    ("avoid", "回避"),
    ("critical_rate", "暴击率"),
    ("critical_damage", "暴击伤害"),
    ("weapon_attack", "物理攻击"),
];

/// Read-time interpretation of legacy captures. Never use this for upload
/// fingerprints or stored variant identities: old uploads must remain retryable.
/// Both fields were checked against same-offer game tooltips on 2026-10-29.
pub fn equipment_for_display(mut value: Value) -> Value {
    if value["status"] != "candidate" {
        return value;
    }
    let Some(mut stats) = value["stats"].as_array().cloned() else {
        return value;
    };
    let Some(unknown) = value["unknown_fields"].as_array() else {
        return value;
    };
    let mut remaining = Vec::new();
    for field in unknown {
        let known = match field["bit"].as_u64() {
            Some(14) => Some(("critical_rate", "暴击率")),
            Some(15) => Some(("critical_damage", "暴击伤害")),
            _ => None,
        };
        if let (Some((key, label)), Some(n)) = (known, field["value"].as_u64()) {
            if n <= u16::MAX.into() {
                if let Some(existing) = stats.iter().find(|s| s["key"] == key) {
                    if existing["value"].as_u64() == Some(n) {
                        continue;
                    }
                } else {
                    stats.push(json!({"key": key, "label": label, "value": n}));
                    continue;
                }
            }
        }
        remaining.push(field.clone());
    }
    stats.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    value["stats"] = json!(stats);
    value["unknown_fields"] = json!(remaining);
    value
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("Unsupported schema")]
    UnsupportedSchema,
    #[error("Observation outside 30-day upload window or clock is ahead")]
    ObservedOutsideWindow,
    #[error("Invalid integer: {0}")]
    InvalidInteger(&'static str),
    #[error("Invalid text: {0}")]
    InvalidText(&'static str),
    #[error("Complete ClassicWorld snapshots required")]
    IncompleteSnapshot,
    #[error("Too many items")]
    TooManyItems,
    #[error("Category mismatch")]
    CategoryMismatch,
    #[error("Invalid equipment field")]
    InvalidEquipmentField,
    #[error("Invalid unknown fields")]
    InvalidUnknownFields,
    /// Python raises KeyError.
    #[error("Missing field: {0}")]
    MissingField(&'static str),
    /// Python raises TypeError.
    #[error("Wrong type: {0}")]
    WrongType(&'static str),
    /// Not in Python: the `source` field is new in this service.
    #[error("source must be packet or screen")]
    InvalidSource,
}

impl ProtocolError {
    /// Python exception class, plus the message for ValueError. Lets tests
    /// compare outcomes with `shared_protocol.validate`.
    pub fn python_class(&self) -> String {
        match self {
            Self::MissingField(_) => "KeyError".into(),
            Self::WrongType(_) => "TypeError".into(),
            Self::InvalidInteger(_) => "ValueError: Invalid integer".into(),
            Self::InvalidText(_) => "ValueError: Invalid text".into(),
            other => format!("ValueError: {other}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Packet,
    Screen,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Packet => "packet",
            Self::Screen => "screen",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketLocation {
    pub channel: u16,
    pub room: u16,
}

impl MarketLocation {
    pub fn map_id(self) -> u32 {
        MARKET_MAP_BASE + u32::from(self.room)
    }

    /// `dict(channel=..., room=..., map_id=...)` as Python stores it.
    pub fn to_json(self) -> Value {
        json!({"channel": self.channel, "room": self.room, "map_id": self.map_id()})
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquipmentStat {
    pub key: &'static str,
    pub label: &'static str,
    pub value: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownField {
    pub bit: u8,
    pub value: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquipmentCandidate {
    pub stats: Vec<EquipmentStat>,
    pub remaining_upgrades: Option<u8>,
    pub unknown_fields: Vec<UnknownField>,
    pub enhancements: Option<u8>,
}

/// Equipment rows always carry this; other items never do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Equipment {
    Unsupported,
    Candidate(EquipmentCandidate),
}

impl Equipment {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Unsupported => {
                json!({"status": "unsupported", "stats": [], "remaining_upgrades": null, "unknown_fields": []})
            }
            Self::Candidate(eq) => {
                let mut map = Map::new();
                map.insert("status".into(), json!("candidate"));
                map.insert("parser".into(), json!(EQUIPMENT_PARSER));
                map.insert(
                    "stats".into(),
                    eq.stats
                        .iter()
                        .map(|s| json!({"key": s.key, "label": s.label, "value": s.value}))
                        .collect(),
                );
                map.insert("remaining_upgrades".into(), json!(eq.remaining_upgrades));
                map.insert(
                    "unknown_fields".into(),
                    eq.unknown_fields
                        .iter()
                        .map(|u| json!({"bit": u.bit, "value": u.value}))
                        .collect(),
                );
                map.insert("note".into(), json!(EQUIPMENT_NOTE));
                if let Some(e) = eq.enhancements {
                    map.insert("enhancements".into(), json!(e));
                }
                Value::Object(map)
            }
        }
    }

    pub fn variant(&self) -> Variant {
        match self {
            Self::Unsupported => Variant::Unknown,
            Self::Candidate(_) => {
                let canonical = pyjson::dumps(&self.to_json(), pyjson::Dumps::CANONICAL);
                Variant::Stats(Sha256::digest(canonical.as_bytes()).into())
            }
        }
    }
}

/// Listing variant. Python labels it "standard", "unknown" or the first 16
/// hex digits of the equipment digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Variant {
    Standard,
    Unknown,
    Stats([u8; 32]),
}

impl Variant {
    pub fn label(&self) -> String {
        match self {
            Self::Standard => "standard".into(),
            Self::Unknown => "unknown".into(),
            Self::Stats(hash) => hex::encode(&hash[..8]),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRow {
    pub slot: u8,
    pub category: u8,
    pub item_id: u32,
    pub price: u64,
    pub bundle: u32,
    pub stock: u32,
    pub equipment: Option<Equipment>,
}

impl UploadRow {
    pub fn variant(&self) -> Variant {
        self.equipment
            .as_ref()
            .map_or(Variant::Standard, Equipment::variant)
    }

    /// Slot key without the repeat counter: inventory tab × 1000 + slot.
    pub fn base_slot(&self) -> i32 {
        i32::from(self.category) * 1000 + i32::from(self.slot)
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("slot".into(), json!(self.slot));
        map.insert("category".into(), json!(self.category));
        map.insert("item_id".into(), json!(self.item_id));
        map.insert("price".into(), json!(self.price));
        map.insert("bundle".into(), json!(self.bundle));
        map.insert("stock".into(), json!(self.stock));
        if let Some(eq) = &self.equipment {
            map.insert("equipment".into(), eq.to_json());
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShopOwner {
    pub character_id: u32,
    pub name: String,
}

/// Where the shop stands in its room, in world pixels (the map's own
/// coordinates), and the store permit that sets how the stall looks.
/// Packet uploads read both from the owner's map-entry record; a screen
/// upload has no stall.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stall {
    pub x: i16,
    pub y: i16,
    pub permit: u32,
}

pub const STALL_PARSER: &str = "cw_stall_v1";

#[derive(Debug, Clone, PartialEq)]
pub struct Upload {
    pub observation_id: String,
    /// Kept as sent (integer or float) because the fingerprint hashes it.
    pub observed_at: Number,
    pub shop_id: u32,
    pub title: String,
    pub location: Option<MarketLocation>,
    /// Sorted by (category, slot), stable.
    pub items: Vec<UploadRow>,
    pub source: Source,
    pub reader_version: Option<String>,
    pub owner: Option<ShopOwner>,
    pub stall: Option<Stall>,
}

impl Upload {
    pub fn observed_seconds(&self) -> f64 {
        self.observed_at.as_f64().unwrap_or(f64::NAN)
    }

    /// Python's cleaned dict. `source` and `reader_version` appear only when
    /// they differ from what a legacy upload implies, so legacy fingerprints
    /// stay valid.
    pub fn clean_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("version".into(), json!(1));
        map.insert("observation_id".into(), json!(self.observation_id));
        map.insert(
            "observed_at".into(),
            Value::Number(self.observed_at.clone()),
        );
        map.insert("world".into(), json!(WORLD));
        map.insert("shop_id".into(), json!(self.shop_id));
        map.insert("title".into(), json!(self.title));
        map.insert(
            "location".into(),
            self.location.map_or(Value::Null, MarketLocation::to_json),
        );
        map.insert(
            "items".into(),
            self.items.iter().map(UploadRow::to_json).collect(),
        );
        map.insert("complete".into(), json!(true));
        if self.source != Source::Packet {
            map.insert("source".into(), json!(self.source.as_str()));
        }
        if let Some(version) = &self.reader_version {
            map.insert("reader_version".into(), json!(version));
        }
        if let Some(owner) = &self.owner {
            map.insert(
                "owner".into(),
                json!({"character_id":owner.character_id,
                "name":owner.name,"parser":"cw_shop_owner_v1"}),
            );
        }
        if let Some(stall) = &self.stall {
            map.insert(
                "stall".into(),
                json!({"x":stall.x,"y":stall.y,"permit":stall.permit,"parser":STALL_PARSER}),
            );
        }
        Value::Object(map)
    }

    /// `digest(clean)`: equal content gives equal fingerprints.
    pub fn fingerprint(&self) -> String {
        pyjson::digest(&self.clean_json())
    }

    /// Rows with the stored slot: repeated (category, slot) pairs get
    /// +1000000 per repeat, as `SharedStore.upload` does.
    pub fn encoded_rows(&self) -> Vec<(i32, &UploadRow)> {
        let mut seen = std::collections::HashMap::<i32, i32>::new();
        self.items
            .iter()
            .map(|row| {
                let base = row.base_slot();
                let repeat = seen.entry(base).or_insert(0);
                let slot = base + *repeat * 1_000_000;
                *repeat += 1;
                (slot, row)
            })
            .collect()
    }
}

/// `shared_protocol.validate(data, now)`.
pub fn validate(data: &Value, now: f64) -> Result<Upload, ProtocolError> {
    let data = data.as_object().ok_or(ProtocolError::UnsupportedSchema)?;
    if !equals_one(data.get("version")) {
        return Err(ProtocolError::UnsupportedSchema);
    }
    let observed_at = match data.get("observed_at") {
        Some(Value::Number(n))
            if n.as_f64().is_some_and(|t| {
                t.is_finite() && now - UPLOAD_WINDOW_SECONDS <= t && t <= now + CLOCK_AHEAD_SECONDS
            }) =>
        {
            n.clone()
        }
        _ => return Err(ProtocolError::ObservedOutsideWindow),
    };
    let location = match data.get("location") {
        None | Some(Value::Null) => None,
        Some(Value::Object(loc)) => {
            let channel = integer(
                require(loc, "channel", "location.channel")?,
                "channel",
                1,
                i64::from(MAX_CHANNEL),
            )?;
            let room = integer(require(loc, "room", "location.room")?, "room", 0, 22)?;
            Some(MarketLocation {
                channel: channel as u16,
                room: room as u16,
            })
        }
        Some(_) => return Err(ProtocolError::WrongType("location")),
    };
    let observation_id = text(
        require(data, "observation_id", "observation_id")?,
        "observation_id",
        64,
    )?;
    let shop_id = integer(
        require(data, "shop_id", "shop_id")?,
        "shop_id",
        1,
        u32::MAX as i64,
    )?;
    let title = text(require(data, "title", "title")?, "title", 120)?;
    if data.get("world").and_then(Value::as_str) != Some(WORLD)
        || data.get("complete") != Some(&Value::Bool(true))
    {
        return Err(ProtocolError::IncompleteSnapshot);
    }
    let rows = match require(data, "items", "items")? {
        Value::Array(rows) if rows.len() <= MAX_ITEMS => rows,
        _ => return Err(ProtocolError::TooManyItems),
    };
    let mut items = rows
        .iter()
        .map(validate_row)
        .collect::<Result<Vec<_>, _>>()?;
    items.sort_by_key(|row| (row.category, row.slot));
    let source = match data.get("source") {
        None | Some(Value::Null) => Source::Packet,
        Some(Value::String(s)) if s == "packet" => Source::Packet,
        Some(Value::String(s)) if s == "screen" => Source::Screen,
        Some(_) => return Err(ProtocolError::InvalidSource),
    };
    let reader_version = match data.get("reader_version") {
        None | Some(Value::Null) => None,
        Some(v) => Some(text(v, "reader_version", 64)?),
    };
    let owner = match data.get("owner") {
        None | Some(Value::Null) => None,
        Some(Value::Object(o))
            if source == Source::Packet
                && o.get("parser").and_then(Value::as_str) == Some("cw_shop_owner_v1") =>
        {
            Some(ShopOwner {
                character_id: integer(
                    require(o, "character_id", "owner.character_id")?,
                    "owner.character_id",
                    1,
                    u32::MAX as i64,
                )? as u32,
                name: text(require(o, "name", "owner.name")?, "owner.name", 24)?,
            })
        }
        Some(_) => return Err(ProtocolError::WrongType("owner")),
    };
    let stall = match data.get("stall") {
        None | Some(Value::Null) => None,
        Some(Value::Object(o))
            if source == Source::Packet
                && o.get("parser").and_then(Value::as_str) == Some(STALL_PARSER) =>
        {
            Some(Stall {
                x: integer(require(o, "x", "stall.x")?, "stall.x", -32768, 32767)? as i16,
                y: integer(require(o, "y", "stall.y")?, "stall.y", -32768, 32767)? as i16,
                permit: integer(
                    require(o, "permit", "stall.permit")?,
                    "stall.permit",
                    5_140_000,
                    5_149_999,
                )? as u32,
            })
        }
        Some(_) => return Err(ProtocolError::WrongType("stall")),
    };
    Ok(Upload {
        observation_id,
        observed_at,
        shop_id: shop_id as u32,
        title,
        location,
        items,
        source,
        reader_version,
        owner,
        stall,
    })
}

fn validate_row(row: &Value) -> Result<UploadRow, ProtocolError> {
    let row = row.as_object().ok_or(ProtocolError::WrongType("items[]"))?;
    let slot = integer(require(row, "slot", "slot")?, "slot", 1, 200)?;
    let item_id = integer(
        require(row, "item_id", "item_id")?,
        "item_id",
        1_000_000,
        5_999_999,
    )?;
    let kind = item_id / 1_000_000;
    let category = match row.get("category") {
        None => kind,
        Some(v) => integer(v, "category", 1, 6)?,
    };
    if category != 6 && category != kind {
        return Err(ProtocolError::CategoryMismatch);
    }
    let price = integer(
        require(row, "price", "price")?,
        "price",
        0,
        1_000_000_000_000,
    )?;
    let bundle = integer(require(row, "bundle", "bundle")?, "bundle", 1, 1_000_000)?;
    let stock = integer(require(row, "stock", "stock")?, "stock", 0, 1_000_000)?;
    let equipment = if kind == 1 {
        Some(validate_equipment(row.get("equipment"))?)
    } else {
        None
    };
    Ok(UploadRow {
        slot: slot as u8,
        category: category as u8,
        item_id: item_id as u32,
        price: price as u64,
        bundle: bundle as u32,
        stock: stock as u32,
        equipment,
    })
}

fn validate_equipment(eq: Option<&Value>) -> Result<Equipment, ProtocolError> {
    let eq = match eq {
        Some(Value::Object(eq))
            if eq.get("status").and_then(Value::as_str) == Some("candidate") =>
        {
            eq
        }
        _ => return Ok(Equipment::Unsupported),
    };
    let mut stats = Vec::new();
    for stat in py_iter(eq.get("stats"), "equipment.stats")? {
        let stat = stat
            .as_object()
            .ok_or(ProtocolError::WrongType("equipment.stats[]"))?;
        let field = match require(stat, "key", "equipment.stats[].key")? {
            Value::String(key) => EQUIPMENT_FIELDS.iter().find(|(k, _)| k == key),
            // Lists and dicts are unhashable in Python.
            Value::Array(_) | Value::Object(_) => {
                return Err(ProtocolError::WrongType("equipment.stats[].key"))
            }
            _ => None,
        };
        let Some(&(key, label)) = field else {
            return Err(ProtocolError::InvalidEquipmentField);
        };
        if stats.iter().any(|s: &EquipmentStat| s.key == key) {
            return Err(ProtocolError::InvalidEquipmentField);
        }
        let value = integer(
            require(stat, "value", "equipment.stats[].value")?,
            "stat value",
            0,
            65535,
        )?;
        stats.push(EquipmentStat {
            key,
            label,
            value: value as u16,
        });
    }
    let unknown = eq.get("unknown_fields");
    if py_len(unknown, "equipment.unknown_fields")? > MAX_UNKNOWN_FIELDS {
        return Err(ProtocolError::InvalidUnknownFields);
    }
    let mut unknown_fields = Vec::new();
    for field in py_iter(unknown, "equipment.unknown_fields")? {
        let field = field
            .as_object()
            .ok_or(ProtocolError::WrongType("equipment.unknown_fields[]"))?;
        let bit = integer(require(field, "bit", "unknown_fields[].bit")?, "bit", 0, 16)?;
        let value = integer(
            require(field, "value", "unknown_fields[].value")?,
            "bit value",
            0,
            65535,
        )?;
        unknown_fields.push(UnknownField {
            bit: bit as u8,
            value: value as u16,
        });
    }
    let remaining_upgrades = match eq.get("remaining_upgrades") {
        None | Some(Value::Null) => None,
        Some(v) => Some(integer(v, "remaining_upgrades", 0, 15)? as u8),
    };
    let enhancements = match eq.get("enhancements") {
        None | Some(Value::Null) => None,
        Some(v) => Some(integer(v, "enhancements", 0, 15)? as u8),
    };
    stats.sort_by_key(|s| s.key);
    unknown_fields.sort_by_key(|u| u.bit);
    Ok(Equipment::Candidate(EquipmentCandidate {
        stats,
        remaining_upgrades,
        unknown_fields,
        enhancements,
    }))
}

/// Python `value == 1`: true for 1, 1.0 and True.
fn equals_one(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        _ => false,
    }
}

fn require<'a>(
    map: &'a Map<String, Value>,
    key: &str,
    field: &'static str,
) -> Result<&'a Value, ProtocolError> {
    map.get(key).ok_or(ProtocolError::MissingField(field))
}

/// `integer(value, low, high)`: a JSON integer (not a float, not a bool).
fn integer(value: &Value, field: &'static str, low: i64, high: i64) -> Result<i64, ProtocolError> {
    match value {
        Value::Number(n) if !n.is_f64() => n
            .as_i64()
            .filter(|v| (low..=high).contains(v))
            .ok_or(ProtocolError::InvalidInteger(field)),
        _ => Err(ProtocolError::InvalidInteger(field)),
    }
}

/// `text(value, size)`: non-empty, at most `size` code points, no control chars.
fn text(value: &Value, field: &'static str, size: usize) -> Result<String, ProtocolError> {
    match value {
        Value::String(s)
            if !s.is_empty() && s.chars().count() <= size && s.chars().all(|c| c >= ' ') =>
        {
            Ok(s.clone())
        }
        _ => Err(ProtocolError::InvalidText(field)),
    }
}

/// Elements Python's `for x in value` yields, for a field whose elements are
/// then subscripted. An absent field defaults to `[]`; an empty string or
/// dict iterates nothing; a non-empty one yields elements that fail later.
fn py_iter<'a>(
    value: Option<&'a Value>,
    field: &'static str,
) -> Result<&'a [Value], ProtocolError> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(Value::String(s)) if s.is_empty() => Ok(&[]),
        Some(Value::Object(m)) if m.is_empty() => Ok(&[]),
        Some(_) => Err(ProtocolError::WrongType(field)),
    }
}

/// Python `len(value)`; absent defaults to `[]`.
fn py_len(value: Option<&Value>, field: &'static str) -> Result<usize, ProtocolError> {
    match value {
        None => Ok(0),
        Some(Value::Array(items)) => Ok(items.len()),
        Some(Value::String(s)) => Ok(s.chars().count()),
        Some(Value::Object(m)) => Ok(m.len()),
        Some(_) => Err(ProtocolError::WrongType(field)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_792_000_000.0;

    fn base() -> Value {
        json!({
            "version": 1, "world": "ClassicWorld", "observation_id": "first", "complete": true,
            "observed_at": NOW - 60.0, "title": "Shop", "shop_id": 77,
            "location": {"channel": 9, "room": 8},
            "items": [{"item_id": 4010001, "slot": 1, "price": 500, "bundle": 1, "stock": 8}]
        })
    }

    fn with(mut value: Value, f: impl FnOnce(&mut Value)) -> Value {
        f(&mut value);
        value
    }

    #[test]
    fn accepts_the_python_test_payload() {
        let upload = validate(&base(), NOW).unwrap();
        assert_eq!(
            upload.location,
            Some(MarketLocation {
                channel: 9,
                room: 8
            })
        );
        assert_eq!(upload.location.unwrap().map_id(), 80_002_008);
        assert_eq!(upload.items[0].equipment, None);
        assert_eq!(upload.source, Source::Packet);
        let clean = upload.clean_json();
        assert_eq!(clean["location"]["map_id"], 80_002_008);
        assert!(clean.get("source").is_none());
    }

    #[test]
    fn accepts_extended_channels() {
        for channel in [12, 18, 19, 20, 21, 33, 40, 60, 255] {
            let data = with(base(), |v| v["location"]["channel"] = json!(channel));
            let upload = validate(&data, NOW).unwrap();
            assert_eq!(upload.location.unwrap().channel, channel);
        }
    }

    #[test]
    fn rejects_like_python() {
        let cases: Vec<(Value, ProtocolError)> = vec![
            (json!([]), ProtocolError::UnsupportedSchema),
            (
                with(base(), |v| v["version"] = json!(2)),
                ProtocolError::UnsupportedSchema,
            ),
            (
                with(base(), |v| v["observed_at"] = json!(NOW + 600.0)),
                ProtocolError::ObservedOutsideWindow,
            ),
            (
                with(base(), |v| v["observed_at"] = json!(NOW - 31.0 * 86400.0)),
                ProtocolError::ObservedOutsideWindow,
            ),
            (
                with(base(), |v| v["observed_at"] = json!(true)),
                ProtocolError::ObservedOutsideWindow,
            ),
            (
                with(base(), |v| v["location"]["channel"] = json!(256)),
                ProtocolError::InvalidInteger("channel"),
            ),
            (
                with(base(), |v| v["location"]["room"] = json!(23)),
                ProtocolError::InvalidInteger("room"),
            ),
            (
                with(base(), |v| v["location"] = json!([1])),
                ProtocolError::WrongType("location"),
            ),
            (
                with(base(), |v| v["title"] = json!("")),
                ProtocolError::InvalidText("title"),
            ),
            (
                with(base(), |v| v["title"] = json!("a\nb")),
                ProtocolError::InvalidText("title"),
            ),
            (
                with(base(), |v| v["observation_id"] = json!("x".repeat(65))),
                ProtocolError::InvalidText("observation_id"),
            ),
            (
                with(base(), |v| v["shop_id"] = json!(0)),
                ProtocolError::InvalidInteger("shop_id"),
            ),
            (
                with(base(), |v| v["complete"] = json!(1)),
                ProtocolError::IncompleteSnapshot,
            ),
            (
                with(base(), |v| v["world"] = json!("Scania")),
                ProtocolError::IncompleteSnapshot,
            ),
            (
                with(base(), |v| v["items"] = json!(vec![json!({}); 201])),
                ProtocolError::TooManyItems,
            ),
            (
                with(base(), |v| v["items"][0]["price"] = json!(-1)),
                ProtocolError::InvalidInteger("price"),
            ),
            (
                with(base(), |v| v["items"][0]["price"] = json!(5.0)),
                ProtocolError::InvalidInteger("price"),
            ),
            (
                with(base(), |v| v["items"][0]["bundle"] = json!(0)),
                ProtocolError::InvalidInteger("bundle"),
            ),
            (
                with(base(), |v| v["items"][0]["category"] = json!(2)),
                ProtocolError::CategoryMismatch,
            ),
            (
                with(base(), |v| v["items"][0]["category"] = json!(null)),
                ProtocolError::InvalidInteger("category"),
            ),
            (
                with(base(), |v| {
                    v["items"][0].as_object_mut().unwrap().remove("stock");
                }),
                ProtocolError::MissingField("stock"),
            ),
            (
                with(base(), |v| v["source"] = json!("ocr")),
                ProtocolError::InvalidSource,
            ),
        ];
        for (payload, expected) in cases {
            assert_eq!(validate(&payload, NOW), Err(expected.clone()), "{payload}");
        }
    }

    #[test]
    fn python_equality_quirks_are_kept() {
        assert!(validate(&with(base(), |v| v["version"] = json!(true)), NOW).is_ok());
        assert!(validate(&with(base(), |v| v["version"] = json!(1.0)), NOW).is_ok());
        assert!(validate(&with(base(), |v| v["location"] = json!(null)), NOW).is_ok());
        // Category 6 is allowed for any item.
        assert!(validate(&with(base(), |v| v["items"][0]["category"] = json!(6)), NOW).is_ok());
    }

    fn equipment(eq: Value) -> Result<Upload, ProtocolError> {
        validate(
            &with(
                base(),
                |v| v["items"] = json!([{"item_id": 1040020, "slot": 1, "price": 2499, "bundle": 1, "stock": 1, "equipment": eq}]),
            ),
            NOW,
        )
    }

    #[test]
    fn equipment_candidates_are_normalised() {
        let upload = equipment(json!({
            "status": "candidate", "remaining_upgrades": 7, "enhancements": 0,
            "stats": [{"key": "weapon_defense", "value": 28}, {"key": "hp", "value": 5}],
            "unknown_fields": [{"bit": 14, "value": 1}, {"bit": 8, "value": 2}]
        }))
        .unwrap();
        let eq = upload.items[0].equipment.as_ref().unwrap().to_json();
        assert_eq!(eq["stats"][0]["key"], "hp");
        assert_eq!(eq["stats"][0]["label"], "最大 HP");
        assert_eq!(eq["unknown_fields"][0]["bit"], 8);
        assert_eq!(eq["parser"], EQUIPMENT_PARSER);
        assert_eq!(eq["enhancements"], 0);
        assert!(matches!(upload.items[0].variant(), Variant::Stats(_)));
    }

    #[test]
    fn equipment_without_candidate_status_is_unsupported() {
        let upload = equipment(json!({"status": "weird"})).unwrap();
        assert_eq!(upload.items[0].equipment, Some(Equipment::Unsupported));
        assert_eq!(upload.items[0].variant().label(), "unknown");
        let upload = equipment(json!(null)).unwrap();
        assert_eq!(upload.items[0].equipment, Some(Equipment::Unsupported));
    }

    #[test]
    fn critical_fields_accept_new_uploads_and_display_legacy_without_rewriting_evidence() {
        let legacy = json!({"status":"candidate", "stats":[
            {"key":"weapon_defense","label":"物理防御","value":5}],
            "remaining_upgrades":4,"unknown_fields":[{"bit":14,"value":2},{"bit":8,"value":1}]});
        let upload = equipment(legacy).unwrap();
        let original = upload.clean_json();
        let fingerprint = upload.fingerprint();
        let display = equipment_for_display(upload.items[0].equipment.as_ref().unwrap().to_json());
        assert_eq!(
            display["stats"][0],
            json!({"key":"critical_rate","label":"暴击率","value":2})
        );
        assert_eq!(display["unknown_fields"], json!([{"bit":8,"value":1}]));
        assert_eq!(upload.clean_json(), original);
        assert_eq!(upload.fingerprint(), fingerprint);
        assert_eq!(display, equipment_for_display(display.clone()));

        let new = equipment(json!({"status":"candidate", "stats":[
            {"key":"critical_rate","value":2},{"key":"critical_damage","value":3}]}))
        .unwrap();
        let new_json = new.items[0].equipment.as_ref().unwrap().to_json();
        let stats = &new_json["stats"];
        assert_eq!(stats[0]["key"], "critical_damage");
        assert_eq!(stats[0]["label"], "暴击伤害");
        assert_eq!(stats[1]["key"], "critical_rate");

        let earring = equipment_for_display(json!({"status":"candidate", "stats":[
            {"key":"int","label":"智力","value":6},
            {"key":"magic_defense","label":"魔法防御","value":27}],
            "unknown_fields":[{"bit":15,"value":2}],"remaining_upgrades":0}));
        assert_eq!(
            earring["stats"][0],
            json!({"key":"critical_damage","label":"暴击伤害","value":2})
        );
        assert_eq!(earring["unknown_fields"], json!([]));
    }

    #[test]
    fn critical_display_keeps_conflicting_or_invalid_fields_unknown() {
        let value = json!({"status":"candidate", "stats":[{"key":"critical_rate","value":3}],
            "unknown_fields":[{"bit":14,"value":2},{"bit":15,"value":65536},{"bit":15,"value":-1}]});
        assert_eq!(equipment_for_display(value.clone()), value);
        let unsupported =
            json!({"status":"unsupported", "stats":[],"unknown_fields":[{"bit":14,"value":2}]});
        assert_eq!(equipment_for_display(unsupported.clone()), unsupported);
    }

    #[test]
    fn equipment_errors() {
        let bad = [
            (
                json!({"status": "candidate", "stats": [{"key": "luck", "value": 1}]}),
                ProtocolError::InvalidEquipmentField,
            ),
            (
                json!({"status": "candidate", "stats": [{"key": "luk", "value": 1}, {"key": "luk", "value": 2}]}),
                ProtocolError::InvalidEquipmentField,
            ),
            (
                json!({"status": "candidate", "stats": [{"key": ["luk"], "value": 1}]}),
                ProtocolError::WrongType("equipment.stats[].key"),
            ),
            (
                json!({"status": "candidate", "stats": "x"}),
                ProtocolError::WrongType("equipment.stats"),
            ),
            (
                json!({"status": "candidate", "stats": null}),
                ProtocolError::WrongType("equipment.stats"),
            ),
            (
                json!({"status": "candidate", "unknown_fields": vec![json!({"bit": 1, "value": 1}); 18]}),
                ProtocolError::InvalidUnknownFields,
            ),
            (
                json!({"status": "candidate", "unknown_fields": [{"bit": 17, "value": 1}]}),
                ProtocolError::InvalidInteger("bit"),
            ),
            (
                json!({"status": "candidate", "remaining_upgrades": 16}),
                ProtocolError::InvalidInteger("remaining_upgrades"),
            ),
            (
                json!({"status": "candidate", "enhancements": -1}),
                ProtocolError::InvalidInteger("enhancements"),
            ),
        ];
        for (eq, expected) in bad {
            assert_eq!(equipment(eq.clone()), Err(expected), "{eq}");
        }
        // Python iterates "" and {} as empty.
        assert!(
            equipment(json!({"status": "candidate", "stats": "", "unknown_fields": {}})).is_ok()
        );
    }

    #[test]
    fn repeated_slots_are_encoded_like_the_python_store() {
        let upload = validate(
            &with(base(), |v| {
                v["items"] = json!([
                    {"item_id": 4010001, "slot": 1, "price": 500, "bundle": 1, "stock": 8},
                    {"item_id": 2040000, "slot": 1, "price": 100, "bundle": 1, "stock": 1},
                    {"item_id": 4010001, "slot": 1, "price": 600, "bundle": 1, "stock": 2}
                ])
            }),
            NOW,
        )
        .unwrap();
        let slots: Vec<i32> = upload
            .encoded_rows()
            .iter()
            .map(|(slot, _)| *slot)
            .collect();
        assert_eq!(slots, vec![2001, 4001, 1_004_001]);
    }
}
