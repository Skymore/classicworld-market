//! Regions of the currently imported Classic World map catalogue.
//! Classic World uses its own map IDs (not the GMS numbering scheme).
/// Orbis and El Nath (`region_sql` still classifies them) are not open yet:
/// their maps are imported as unreleased and never listed, so they are not
/// offered as filters. Add them back here and in `catalogue-search.tsx`.
pub const REGIONS: &[(&str, &str, &str)] = &[
    ("maple", "彩虹岛", "Maple Island"),
    ("victoria", "金银岛", "Victoria Island"),
    ("market", "自由市场", "Free Market"),
    ("special", "活动／特殊地图", "Events / special maps"),
    ("other", "其他", "Other"),
];

/// The map list's region chips. `rest` (其他) is every map off the two
/// islands: the Free Market, events and the rest.
pub const MAP_REGIONS: &[(&str, &str, &str)] = &[
    ("maple", "彩虹岛", "Maple Island"),
    ("victoria", "金银岛", "Victoria Island"),
    ("rest", "其他", "Other"),
];

/// The map list's world map islands: region key and `world_regions.id`.
pub const ISLANDS: &[(&str, &str)] = &[("maple", "MapleIsland"), ("victoria", "VictoriaIsland")];

pub fn normalize(region: &str) -> String {
    if REGIONS.iter().any(|r| r.0 == region) || region == "rest" {
        region.into()
    } else {
        String::new()
    }
}

/// A region's name, the map list's `rest` included.
pub fn label(region: &str) -> Option<(&'static str, &'static str)> {
    REGIONS
        .iter()
        .chain(MAP_REGIONS)
        .find(|r| r.0 == region)
        .map(|r| (r.1, r.2))
}

/// SQL: `alias` is in the region bound as `param` (`''` is every region).
pub fn region_match_sql(alias: &str, param: &str) -> String {
    let region = region_sql(alias);
    format!(
        "({param}='' OR {region}={param} OR ({param}='rest' AND {region} NOT IN ('maple','victoria')))"
    )
}

/// Shared by map filtering, mob spawn filtering and the area option list.
pub fn region_sql(alias: &str) -> String {
    format!("CASE
        WHEN {alias}.id BETWEEN 0 AND 9999999 THEN 'maple'
        WHEN {alias}.id BETWEEN 10000000 AND 19999999 OR {alias}.street_zh='金银岛' OR {alias}.street_en='Victoria Road' THEN 'victoria'
        WHEN {alias}.id BETWEEN 20000000 AND 20000999 THEN 'orbis'
        WHEN {alias}.id BETWEEN 20001000 AND 20001999 THEN 'elnath'
        WHEN {alias}.id BETWEEN 80002000 AND 80002999 THEN 'market'
        WHEN {alias}.id BETWEEN 90000000 AND 99999999 OR {alias}.id=89000000 OR {alias}.id BETWEEN 900000000 AND 999999999 THEN 'special'
        ELSE 'other' END")
}

pub fn area_sql(alias: &str) -> String {
    // The same localized area can have multiple English spellings in the
    // source catalogue. Prefer its localized key so one area stays together.
    format!("COALESCE(NULLIF({alias}.street_zh,''),NULLIF({alias}.street_en,''),'')")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn region_values_are_allowlisted() {
        assert_eq!(normalize("victoria"), "victoria");
        assert_eq!(normalize("<script>"), "");
        assert_eq!(normalize("rest"), "rest");
        assert_eq!(label("rest"), Some(("其他", "Other")));
        assert!(region_match_sql("m", "$5").contains("($5='rest' AND CASE"));
        assert!(region_sql("mp").contains("mp.id BETWEEN 20001000 AND 20001999"));
    }
}
