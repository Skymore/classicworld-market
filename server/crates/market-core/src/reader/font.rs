//! Exact reading with the shop's 1-bit pixel font (reader.js exactLine,
//! splitRun, fixIl). Used for shop rows, the seller's tag and the
//! minimap's one-line bar: text on game pixels, read glyph run by glyph run.

use super::templates::Font;

/// One text line read on a baseline.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    /// Glyph runs the font cannot spell (each written as "?").
    pub unknown: usize,
    /// Glyph runs.
    pub n: usize,
    /// First column after the last run.
    pub end: i64,
    /// First column of the first run.
    pub start: i64,
    /// Blank columns of each space, in order.
    pub gaps: Vec<i64>,
}

/// The text of one glyph run: a glyph, or 2-4 touching glyphs, or `None`.
pub fn split_run(font: &Font, rows: &[String], depth: usize) -> Option<String> {
    if let Some(hit) = font.lookup(&rows.join("/")) {
        return Some(hit.to_string());
    }
    if depth >= 3 {
        return None;
    }
    let w = rows[0].len();
    for (ch, g) in &font.glyphs {
        let gw = g[0].len();
        if gw >= w || !rows.iter().zip(g).all(|(r, gy)| &r[..gw] == gy) {
            continue;
        }
        let rest: Vec<String> = rows.iter().map(|r| r[gw..].to_string()).collect();
        if let Some(rest) = split_run(font, &rest, depth + 1) {
            return Some(format!("{ch}{rest}"));
        }
    }
    None
}

/// One line on baseline `base`: glyph runs split at blank columns. A gap of
/// 3+ columns is a space, 6+ after a "1" (its glyph leaves room on its right).
pub fn exact_line(
    font: &Font,
    ink: &dyn Fn(i64, i64) -> bool,
    x0: i64,
    x1: i64,
    base: i64,
) -> Option<Line> {
    let top = base - font.above as i64;
    let band = font.band() as i64;
    let col = |x: i64| (top..top + band).any(|y| ink(x, y));
    let mut text = String::new();
    let (mut x, mut n, mut unknown) = (x0, 0usize, 0usize);
    let mut last: Option<(i64, String)> = None;
    let mut start = None;
    let mut gaps = Vec::new();
    while x < x1 {
        if !col(x) {
            x += 1;
            continue;
        }
        let a = x;
        while x < x1 && col(x) {
            x += 1;
        }
        start.get_or_insert(a);
        let rows: Vec<String> = (top..top + band)
            .map(|y| (a..x).map(|c| if ink(c, y) { '#' } else { '.' }).collect())
            .collect();
        let ch = split_run(font, &rows, 0).unwrap_or_else(|| "?".to_string());
        if ch == "?" {
            unknown += 1;
        }
        if let Some((end, prev)) = &last {
            if a - end >= if prev.ends_with('1') { 6 } else { 3 } {
                text.push(' ');
                gaps.push(a - end);
            }
        }
        text.push_str(&ch);
        last = Some((x, ch));
        n += 1;
    }
    let (end, _) = last?;
    Some(Line {
        text,
        unknown,
        n,
        end,
        start: start.unwrap_or(x0),
        gaps,
    })
}

/// Capital I and lowercase l share a glyph. I at a word's start, between two
/// capitals, and in a word of only that glyph; else l.
pub fn fix_il(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.is_empty() {
            return;
        }
        let w: Vec<char> = word.chars().collect();
        if w.iter().all(|&c| c == 'l') {
            out.extend(std::iter::repeat_n('I', w.len()));
        } else {
            for (i, &c) in w.iter().enumerate() {
                let upper = |j: Option<usize>| {
                    j.and_then(|j| w.get(j))
                        .is_some_and(|c| c.is_ascii_uppercase())
                };
                let cap = i == 0 || (upper(i.checked_sub(1)) && upper(Some(i + 1)));
                out.push(if c == 'l' && cap { 'I' } else { c });
            }
        }
        word.clear();
    };
    for c in text.chars() {
        if c.is_whitespace() {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// Draws `text` in the font onto a bitmap callback, left edge at `x`,
/// baseline at `base`: 1 blank column between glyphs, 4 for a space,
/// digits in 5-column cells (as the game draws prices). Returns the end x.
/// Used by tests and the benchmark to render synthetic rows.
pub fn draw_text(font: &Font, text: &str, x: i64, base: i64, put: &mut dyn FnMut(i64, i64)) -> i64 {
    let top = base - font.above as i64;
    let mut cx = x;
    for ch in text.chars() {
        if ch == ' ' {
            cx += 3;
            continue;
        }
        let key = if ch == 'I' {
            "l".to_string()
        } else {
            ch.to_string()
        };
        let Some(rows) = font.glyph(&key) else {
            cx += 4;
            continue;
        };
        let w = rows[0].len() as i64;
        for (dy, r) in rows.iter().enumerate() {
            for (dx, c) in r.chars().enumerate() {
                if c == '#' {
                    put(cx + dx as i64, top + dy as i64);
                }
            }
        }
        let cell = if ch.is_ascii_digit() { 5 } else { w };
        cx += cell + 1;
    }
    cx
}

#[cfg(test)]
mod tests {
    use super::super::templates;
    use super::*;
    use std::collections::HashSet;

    fn read(text: &str) -> Option<Line> {
        let font = &templates::get().font;
        let mut ink = HashSet::new();
        draw_text(font, text, 5, 12, &mut |x, y| {
            ink.insert((x, y));
        });
        exact_line(font, &|x, y| ink.contains(&(x, y)), 0, 400, 12)
    }

    #[test]
    fn drawn_text_reads_back() {
        let l = read("10 for 45,000 mesos").unwrap();
        assert_eq!(l.text, "10 for 45,000 mesos");
        assert_eq!(l.unknown, 0);
        assert_eq!(l.start, 5);
        assert_eq!(l.gaps, vec![4, 4, 4]);
        assert_eq!(read("1 for 5 mesos").unwrap().gaps, vec![6, 4, 4]);
        assert_eq!(read("11 for 5").unwrap().text, "11 for 5");
        assert_eq!(
            read("Iron Ore").map(|l| fix_il(&l.text)).as_deref(),
            Some("Iron Ore")
        );
    }

    #[test]
    fn i_and_l() {
        assert_eq!(fix_il("lron Ore"), "Iron Ore");
        assert_eq!(fix_il("Gold lll STlR"), "Gold III STIR");
        assert_eq!(fix_il("El Nath"), "El Nath");
    }

    #[test]
    fn touching_glyphs_split() {
        let font = &templates::get().font;
        let a = font.glyph("t").unwrap();
        let rows: Vec<String> = a.iter().map(|r| format!("{r}{r}")).collect();
        assert_eq!(split_run(font, &rows, 0).as_deref(), Some("tt"));
    }
}
