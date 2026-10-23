//! Item names to catalog ids (snap.js). An exactly read name is matched
//! exactly (`snap_exact`); a name read by template scores is matched by
//! 3-gram candidates and edit-distance similarity (`snap`), accepted only
//! with score >= 0.82 and a margin >= 0.1 over the next different name.

pub mod letters;
pub mod seller;

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

use super::round_to;
use super::templates;

const MIN_SCORE: f64 = 0.82;
const MIN_MARGIN: f64 = 0.1;
const N: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapped {
    pub item_id: u32,
    pub name: String,
    pub score: f64,
    pub margin: f64,
}

struct Entry {
    item_id: u32,
    name: String,
    key: String,
}

struct Index {
    entries: Vec<Entry>,
    grams: HashMap<String, Vec<usize>>,
    by_key: HashMap<String, usize>,
}

fn index() -> &'static Index {
    static I: OnceLock<Index> = OnceLock::new();
    I.get_or_init(|| {
        let mut idx = Index {
            entries: Vec::new(),
            grams: HashMap::new(),
            by_key: HashMap::new(),
        };
        for it in &templates::get().catalog {
            let key = fold(&it.name);
            if key.is_empty() {
                continue;
            }
            let i = idx.entries.len();
            *idx.by_key.entry(key.clone()).or_default() += 1;
            for g in grams_of(&key) {
                idx.grams.entry(g).or_default().push(i);
            }
            idx.entries.push(Entry {
                item_id: it.item_id,
                name: it.name.clone(),
                key,
            });
        }
        idx
    })
}

/// Folds typical pixel-font confusions: l/I/|/1 -> l, O/0 -> o, rn -> m,
/// vv -> w; drops spaces, punctuation and ellipses.
pub fn fold(s: &str) -> String {
    let mut t = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '.' && chars.get(i + 1) == Some(&'.') {
            while i < chars.len() && chars[i] == '.' {
                i += 1;
            }
            continue;
        }
        if chars[i] != '…' {
            t.extend(chars[i].to_lowercase());
        }
        i += 1;
    }
    let t = t.replace("rn", "m").replace("vv", "w");
    t.chars()
        .map(|c| match c {
            '|' | '1' | '!' | 'i' => 'l',
            '0' => 'o',
            '5' => 's',
            '8' => 'b',
            c => c,
        })
        .filter(|c| c.is_ascii_lowercase())
        .collect()
}

fn is_truncated(s: &str) -> bool {
    let t = s.trim_end();
    t.ends_with("..") || t.ends_with('…')
}

/// The 3-grams of "^key$", in order, each once.
fn grams_of(k: &str) -> Vec<String> {
    let p: Vec<char> = format!("^{k}$").chars().collect();
    if p.len() < N {
        return vec![p.iter().collect()];
    }
    let mut out: Vec<String> = Vec::new();
    for w in p.windows(N) {
        let g: String = w.iter().collect();
        if !out.contains(&g) {
            out.push(g);
        }
    }
    out
}

/// Levenshtein distance, giving up past `cap`.
fn lev(a: &[u8], b: &[u8], cap: usize) -> usize {
    if a == b {
        return 0;
    }
    if a.len().abs_diff(b.len()) > cap {
        return cap + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut row_min = i;
        for j in 1..=b.len() {
            let c = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + c);
            row_min = row_min.min(cur[j]);
        }
        if row_min > cap {
            return cap + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn sim(a: &str, b: &str) -> f64 {
    let m = a.len().max(b.len());
    if m == 0 {
        return 0.0;
    }
    let cap = (m as f64 * 0.4).ceil() as usize;
    1.0 - lev(a.as_bytes(), b.as_bytes(), cap).min(cap + 1) as f64 / m as f64
}

fn result(e: &Entry, score: f64, margin: f64) -> Snapped {
    Snapped {
        item_id: e.item_id,
        name: e.name.clone(),
        score: round_to(score, 3),
        margin: round_to(margin, 3),
    }
}

/// A possibly misread name snapped to the catalog; `None` when unsure.
pub fn snap(name: &str) -> Option<Snapped> {
    let idx = index();
    let trunc = is_truncated(name);
    let q = fold(name);
    if q.len() < 3 {
        return None;
    }
    // Candidates: entries sharing 3-grams, most shared first (ties: first hit first).
    let mut count: HashMap<usize, (usize, usize)> = HashMap::new();
    for g in grams_of(&q) {
        if let Some(list) = idx.grams.get(&g) {
            for &i in list {
                let order = count.len();
                count.entry(i).or_insert((0, order)).0 += 1;
            }
        }
    }
    let mut cand: Vec<(usize, usize, usize)> =
        count.into_iter().map(|(i, (n, o))| (i, n, o)).collect();
    cand.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    cand.truncate(60);
    let mut scored: Vec<(f64, usize)> = cand
        .iter()
        .map(|&(i, _, _)| {
            let k = &idx.entries[i].key;
            let mut s = sim(&q, k);
            if trunc && q.len() >= 4 && k.len() > q.len() {
                // The window cut the name: compare with the same-length start.
                let sp = sim(&q, &k[..q.len()]);
                let frac = q.len() as f64 / k.len() as f64;
                if sp > s {
                    s = sp * (0.9 + 0.1 * frac.min(1.0));
                }
            }
            (s, i)
        })
        .collect();
    if scored.is_empty() {
        return None;
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best, bi) = scored[0];
    let e = &idx.entries[bi];
    let second = scored[1..]
        .iter()
        .find(|(_, i)| idx.entries[*i].key != e.key)
        .map_or(0.0, |s| s.0);
    // The same folded name for two ids: cannot tell which.
    if idx.by_key.get(&e.key).copied().unwrap_or(0) > 1 {
        return None;
    }
    let margin = best - second;
    (best >= MIN_SCORE && margin >= MIN_MARGIN).then(|| result(e, best, margin))
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Lit(char),
    /// I and l share a glyph.
    Il,
    /// A glyph the font lacks: 1-3 letters.
    Any,
}

fn matches(pat: &[Tok], name: &[char], anchored_end: bool) -> bool {
    match pat.split_first() {
        None => !anchored_end || name.is_empty(),
        Some((Tok::Lit(c), rest)) => {
            name.first() == Some(c) && matches(rest, &name[1..], anchored_end)
        }
        Some((Tok::Il, rest)) => {
            matches!(name.first(), Some('l' | 'I')) && matches(rest, &name[1..], anchored_end)
        }
        Some((Tok::Any, rest)) => {
            (1..=3).any(|n| n <= name.len() && matches(rest, &name[n..], anchored_end))
        }
    }
}

/// An exactly read name: the catalog name itself; a name cut with "..." is
/// the start of exactly one name; a "?" (1-3 letters the font lacks) is
/// filled only when one name fits. `grade` (a scroll's, from its icon)
/// picks among names that differ only in it.
pub fn snap_exact(name: &str, grade: Option<&str>) -> Option<Snapped> {
    let idx = index();
    let t = name.trim();
    let cut = t.ends_with("...");
    let body = if cut { &t[..t.len() - 3] } else { t };
    if body.chars().filter(|&c| c != '?').count() < 3 {
        return None;
    }
    let pat: Vec<Tok> = body
        .chars()
        .map(|c| match c {
            '?' => Tok::Any,
            'l' | 'I' => Tok::Il,
            c => Tok::Lit(c),
        })
        .collect();
    let mut fits: Vec<&Entry> = idx
        .entries
        .iter()
        .filter(|e| matches(&pat, &e.name.chars().collect::<Vec<_>>(), !cut))
        .collect();
    if fits.len() > 1 {
        if let Some(g) = grade {
            let tail = format!(": {g}");
            fits.retain(|e| e.name.ends_with(&tail));
        }
    }
    match fits.as_slice() {
        [one] => Some(result(one, 1.0, 1.0)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_names_snap_exactly() {
        assert_eq!(
            snap_exact("Iron Ore", None).map(|s| s.item_id),
            Some(4_010_001)
        );
        assert_eq!(
            snap_exact("lron Ore", None).map(|s| s.item_id),
            Some(4_010_001)
        );
        // Near twins are not mixed up, and an unknown name is rejected.
        assert!(snap_exact("Iron Oer", None).is_none());
        assert!(snap_exact("Ir", None).is_none());
        // A cut name fits when exactly one name starts so.
        assert_eq!(
            snap_exact("Iron O...", None).map(|s| s.name),
            Some("Iron Ore".to_string())
        );
        assert!(snap_exact("Iron ...", None).is_none());
        assert_eq!(
            snap_exact("Ir?n Ore", None).map(|s| s.item_id),
            Some(4_010_001)
        );
    }

    #[test]
    fn fuzzy_names_need_score_and_margin() {
        let s = snap("lron 0re").unwrap();
        assert_eq!(s.item_id, 4_010_001);
        assert!(s.score >= MIN_SCORE);
        assert!(snap("xq").is_none());
        assert!(snap("Zzzzqqqq Wwwwkkkk").is_none());
    }

    #[test]
    fn folding() {
        assert_eq!(fold("Iron Ore..."), "lronore");
        assert_eq!(fold("Bu rn 0x"), "bumox");
        assert_eq!(lev(b"kitten", b"sitting", 5), 3);
    }
}
