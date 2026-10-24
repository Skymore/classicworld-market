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

pub(crate) fn patterns(query: &str) -> Vec<String> {
    let normalized = normalize(query);
    let mut patterns = Vec::new();
    for term in normalized.split_whitespace() {
        let mut rest = term;
        let mut pattern = String::new();
        while !rest.is_empty() {
            let alias = ALIASES
                .iter()
                .flat_map(|group| group.iter().map(move |word| (*word, *group)))
                .filter(|(word, _)| rest.starts_with(word))
                .max_by_key(|(word, _)| word.len());
            if let Some((word, group)) = alias {
                pattern.push('(');
                pattern.push_str(
                    &group
                        .iter()
                        .map(|s| literal(s))
                        .collect::<Vec<_>>()
                        .join("|"),
                );
                pattern.push(')');
                rest = &rest[word.len()..];
            } else {
                let len = rest.chars().next().unwrap().len_utf8();
                pattern.push_str(&literal(&rest[..len]));
                rest = &rest[len..];
            }
        }
        if !patterns.contains(&pattern) {
            patterns.push(pattern);
        }
    }
    patterns
}

/// `parameter` names a bound text[] of patterns; all keywords must match.
/// The column names and parameter are compile-time SQL fragments.
pub(crate) fn filter_sql(id: &str, columns: &[&str], parameter: &str) -> String {
    let columns = columns.join(", ");
    let wide: String = ('\u{ff01}'..='\u{ff5e}').collect();
    let ascii: String = ('!'..='~').collect::<String>().replace('\'', "''");
    format!(
        "lower(regexp_replace(translate(concat_ws(chr(31), {columns}, {id}::text), '{wide}', '{ascii}'), '[[:space:]　]+', '', 'g')) ~ ALL({parameter}::text[])"
    )
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
}
