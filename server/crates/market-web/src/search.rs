//! Keyword matching shared by catalogue search and watchlist search. Queries
//! are bound as literal regex patterns, never interpolated into SQL.
//! Aliases and regression cases are shared in meaning with web/js/lib/search.js.
const ALIASES: &[&[&str]] = &[
    &["移动速度", "移動速度", "移速", "移动", "移動"],
    &["跳跃力", "跳躍力", "跳跃", "跳躍", "跳力"],
    &["宠物", "寵物"],
    &["装备", "裝備"],
    &["卷轴", "卷軸"],
    &["命中率", "命中"],
    &["回避率", "回避", "闪避", "閃避"],
];

pub(crate) fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap(),
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn literal(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn add_pattern(patterns: &mut Vec<String>, pattern: String) {
    if !pattern.is_empty() && !patterns.contains(&pattern) {
        patterns.push(pattern);
    }
}

pub fn patterns(query: &str) -> Vec<String> {
    let normalized = normalize(query);
    let mut patterns = Vec::new();
    for term in normalized.split_whitespace() {
        let mut rest = term;
        let mut fragment = String::new();
        while !rest.is_empty() {
            let alias = ALIASES
                .iter()
                .flat_map(|group| group.iter().map(move |word| (*word, *group)))
                .filter(|(word, _)| rest.starts_with(word))
                .max_by_key(|(word, _)| word.len());
            if let Some((word, group)) = alias {
                // Split at known terms, so both 移速宠物 and 宠物移速
                // retain every keyword without imposing their input order.
                add_pattern(&mut patterns, literal(&fragment));
                fragment.clear();
                add_pattern(
                    &mut patterns,
                    format!(
                        "({})",
                        group
                            .iter()
                            .map(|s| literal(s))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
                rest = &rest[word.len()..];
            } else {
                let len = rest.chars().next().unwrap().len_utf8();
                fragment.push_str(&rest[..len]);
                rest = &rest[len..];
            }
        }
        add_pattern(&mut patterns, literal(&fragment));
    }
    patterns
}

/// The names a table normalizes into its `search_text` column, in order
/// (migration 0043): items, then mobs and maps.
const STORED: [&[&str]; 2] = [&["name_zh", "name_en"], &["name_zh", "name_tw", "name_en"]];

/// The names joined (NULLs skipped), full-width ASCII folded, whitespace
/// removed, lower case: what `search_text` stores for these columns. Kept
/// as the reference the stored column is tested against.
pub fn normalized_sql(id: &str, columns: &[&str]) -> String {
    let columns = columns.join(", ");
    let wide: String = ('\u{ff01}'..='\u{ff5e}').collect();
    let ascii: String = ('!'..='~').collect::<String>().replace('\'', "''");
    format!(
        "lower(regexp_replace(translate(concat_ws(chr(31), {columns}, {id}::text), '{wide}', '{ascii}'), '[[:space:]　]+', '', 'g'))"
    )
}

/// `parameter` names a bound text[] of patterns; all keywords must match.
/// Reads the stored `normalized_sql` of `columns`, so `id` must be the
/// table's id column (`i.id` or `id`) and `columns` its stored names.
/// The column names and parameter are compile-time SQL fragments.
pub(crate) fn filter_sql(id: &str, columns: &[&str], parameter: &str) -> String {
    let table = id.strip_suffix("id").expect("the table's id column");
    let names: Vec<&str> = columns
        .iter()
        .map(|column| {
            column
                .strip_prefix(table)
                .expect("columns of the id's table")
        })
        .collect();
    assert!(
        STORED.contains(&names.as_slice()),
        "no search_text for {columns:?}"
    );
    format!("{table}search_text ~ ALL({parameter}::text[])")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_regex_metacharacters_and_full_width_input() {
        assert_eq!(patterns(r"50%_a\b [x].*"), [r"50%_a\\b", r"\[x\]\.\*"]);
        assert_eq!(patterns("ＰＥＴ　ＳＰＥＥＤ"), ["pet", "speed"]);
        assert_eq!(patterns(" 宠物 宠物 移速 "), patterns("宠物 移动速度"));
    }

    #[test]
    fn compact_keywords_split_only_at_known_game_terms() {
        assert_eq!(patterns("移速宠物"), patterns("移速 宠物"));
        assert_eq!(patterns("宠物移速"), patterns("宠物 移速"));
        assert_eq!(patterns("宠物速度"), patterns("宠物 速度"));
        assert_eq!(patterns("鞋子移速60%"), patterns("鞋子 移速 60%"));
        assert_eq!(patterns("移速移动宠物宠物"), patterns("移速 宠物"));
        assert_eq!(patterns("褐色皮帽"), ["褐色皮帽"]);
    }

    #[test]
    fn filters_read_the_stored_column_of_their_table() {
        assert_eq!(
            filter_sql("i.id", &["i.name_zh", "i.name_en"], "$4"),
            "i.search_text ~ ALL($4::text[])"
        );
        assert_eq!(
            filter_sql("id", &["name_zh", "name_en"], "$3"),
            "search_text ~ ALL($3::text[])"
        );
        assert_eq!(
            filter_sql("m.id", &["m.name_zh", "m.name_tw", "m.name_en"], "$4"),
            "m.search_text ~ ALL($4::text[])"
        );
    }

    #[test]
    fn migration_stores_the_reference_expression() {
        let migration = include_str!("../../../migrations/0043_catalog_search_text.sql");
        let reference = normalized_sql("id", &["name_zh"]);
        // Same fold table and whitespace pattern as the reference.
        for part in reference.split('\'').skip(1).step_by(2) {
            if !part.is_empty() {
                assert!(migration.contains(part), "{part}");
            }
        }
        assert!(migration.contains("catalog_search_text(name_zh, name_en, id::text)"));
        assert_eq!(
            migration
                .matches("catalog_search_text(name_zh, name_tw, name_en, id::text)")
                .count(),
            2
        );
    }
}
