//! Formatting shared by the pages: the page language and the mockup's number
//! and time rules (`web/js/lib/format.js` renders the same strings).

/// Page language. Chinese is the default; `?lang=en` renders English.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    Zh,
    En,
}

impl Lang {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("en") => Self::En,
            _ => Self::Zh,
        }
    }

    /// The text for this language; strings live next to the markup.
    pub fn t<'a>(self, zh: &'a str, en: &'a str) -> &'a str {
        match self {
            Self::Zh => zh,
            Self::En => en,
        }
    }

    pub fn code(self) -> &'static str {
        self.t("zh", "en")
    }

    pub fn html_lang(self) -> &'static str {
        self.t("zh-CN", "en")
    }

    pub fn other(self) -> Self {
        match self {
            Self::Zh => Self::En,
            Self::En => Self::Zh,
        }
    }
}

/// Mesos as `meso()` in web/js/lib/format.js renders them. English uses K / M
/// (450, 1.2K, 1.5M); Chinese uses 万 / 亿 (9999, 1.2万, 150万, 1.2亿). The
/// browser switches Chinese pages to K / M when the visitor chose that.
pub fn meso(value: i64, lang: Lang) -> String {
    large(value as f64, lang).unwrap_or_else(|| value.to_string())
}

/// Unit prices can be fractional (a bundle price over its size).
pub fn meso_f(value: f64, lang: Lang) -> String {
    match large(value, lang) {
        Some(text) => text,
        None if value.fract() == 0.0 => (value as i64).to_string(),
        None => one_decimal(value),
    }
}

/// The unit a large number takes, or None when it is shown in full.
fn large(value: f64, lang: Lang) -> Option<String> {
    // Up to 1,000 of a unit keeps one decimal (44.4万); more drops it (1235万).
    let scaled = |x: f64| {
        if x.abs() >= 1_000.0 {
            format!("{}", x.round())
        } else {
            one_decimal(x)
        }
    };
    let abs = value.abs();
    match lang {
        // Thresholds sit where rounding would show 1000K or 10000万.
        Lang::En if abs >= 999_950.0 => Some(scaled(value / 1e6) + "M"),
        Lang::En if abs >= 1_000.0 => Some(one_decimal(value / 1e3) + "K"),
        Lang::Zh if abs >= 99_995_000.0 => Some(scaled(value / 1e8) + "亿"),
        Lang::Zh if abs >= 10_000.0 => Some(scaled(value / 1e4) + "万"),
        _ => None,
    }
}

fn one_decimal(x: f64) -> String {
    let text = format!("{:.1}", (x * 10.0).round() / 10.0);
    text.strip_suffix(".0").map(str::to_string).unwrap_or(text)
}

/// 2100000000 -> "2,100,000,000".
pub fn grouped(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        out.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 24h change: (css class, text).
pub fn change(pct: f32, lang: Lang) -> (&'static str, String) {
    if pct.abs() < 0.5 {
        ("flat", lang.t("持平", "flat").to_string())
    } else if pct > 0.0 {
        ("up", format!("▲ {:.1}%", pct.abs()))
    } else {
        ("down", format!("▼ {:.1}%", pct.abs()))
    }
}

/// Relative time of an event `seconds` before the reference point. Pages
/// measure against the data's `as_of`, not the clock: collection is
/// intermittent and the site can lag by days (plan v1 §4.2).
pub fn ago(seconds: i64, lang: Lang) -> String {
    let s = seconds.max(0);
    match (s, lang) {
        (..60, _) => lang.t("刚刚", "just now").to_string(),
        (..3600, Lang::Zh) => format!("{}分钟前", s / 60),
        (..3600, Lang::En) => format!("{}m ago", s / 60),
        (..86400, Lang::Zh) => format!("{}小时前", s / 3600),
        (..86400, Lang::En) => format!("{}h ago", s / 3600),
        (_, Lang::Zh) => format!("{}天前", s / 86400),
        (_, Lang::En) => format!("{}d ago", s / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meso_units() {
        let en = Lang::En;
        assert_eq!(meso(450, en), "450");
        assert_eq!(meso(1_000, en), "1K");
        assert_eq!(meso(1_234, en), "1.2K");
        assert_eq!(meso(1_500_000, en), "1.5M");
        assert_eq!(meso(999_960, en), "1M");
        assert_eq!(meso(-2_000, en), "-2K");
        assert_eq!(meso_f(449.0, en), "449");
        assert_eq!(meso_f(12.5, en), "12.5");
        assert_eq!(meso_f(1_250.4, en), "1.3K");
        let zh = Lang::Zh;
        assert_eq!(meso(9_999, zh), "9999");
        assert_eq!(meso(12_345, zh), "1.2万");
        assert_eq!(meso(444_444, zh), "44.4万");
        assert_eq!(meso(12_345_678, zh), "1235万");
        assert_eq!(meso(99_994_999, zh), "9999万");
        assert_eq!(meso(99_995_000, zh), "1亿");
        assert_eq!(meso(123_456_789, zh), "1.2亿");
        assert_eq!(meso(-25_000, zh), "-2.5万");
        assert_eq!(meso_f(0.3, zh), "0.3");
        assert_eq!(meso_f(1_250.4, zh), "1250.4");
    }

    #[test]
    fn grouping_and_change() {
        assert_eq!(grouped(2_100_000_000), "2,100,000,000");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(-1_000), "-1,000");
        assert_eq!(change(0.2, Lang::Zh), ("flat", "持平".to_string()));
        assert_eq!(change(0.2, Lang::En), ("flat", "flat".to_string()));
        assert_eq!(change(-6.1, Lang::Zh), ("down", "▼ 6.1%".to_string()));
        assert_eq!(change(3.0, Lang::En), ("up", "▲ 3.0%".to_string()));
    }

    #[test]
    fn relative_time_matches_format_js() {
        assert_eq!(ago(30, Lang::Zh), "刚刚");
        assert_eq!(ago(-5, Lang::En), "just now");
        assert_eq!(ago(9 * 60, Lang::Zh), "9分钟前");
        assert_eq!(ago(3 * 3600, Lang::En), "3h ago");
        assert_eq!(ago(2 * 86400 + 5, Lang::Zh), "2天前");
    }

    #[test]
    fn languages() {
        assert_eq!(Lang::parse(Some("en")), Lang::En);
        assert_eq!(Lang::parse(Some("fr")), Lang::Zh);
        assert_eq!(Lang::parse(None).html_lang(), "zh-CN");
        assert_eq!(Lang::En.other(), Lang::Zh);
    }
}
