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

/// 450 -> "450", 1234 -> "1.2K", 1_500_000 -> "1.5M".
pub fn meso(value: i64) -> String {
    let abs = value.unsigned_abs();
    if abs >= 1_000_000 {
        one_decimal(value as f64 / 1e6) + "M"
    } else if abs >= 1_000 {
        one_decimal(value as f64 / 1e3) + "K"
    } else {
        value.to_string()
    }
}

/// Unit prices can be fractional (a bundle price over its size).
pub fn meso_f(value: f64) -> String {
    if value.fract() == 0.0 || value.abs() >= 1_000.0 {
        meso(value.round() as i64)
    } else {
        one_decimal(value)
    }
}

fn one_decimal(x: f64) -> String {
    let text = format!("{:.1}", (x * 10.0).round() / 10.0);
    text.strip_suffix(".0").map(str::to_string).unwrap_or(text)
}

/// Drop rate in percent: 100 -> "100%", 0.03 -> "0.03%", 0.005 -> "0.005%".
pub fn percent(rate: f64) -> String {
    let text = format!("{rate:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    format!("{text}%")
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
        assert_eq!(meso(450), "450");
        assert_eq!(meso(1_000), "1K");
        assert_eq!(meso(1_234), "1.2K");
        assert_eq!(meso(1_500_000), "1.5M");
        assert_eq!(meso(-2_000), "-2K");
        assert_eq!(meso_f(449.0), "449");
        assert_eq!(meso_f(12.5), "12.5");
        assert_eq!(meso_f(1_250.4), "1.3K");
    }

    #[test]
    fn percent_trims_zeros() {
        assert_eq!(percent(100.0), "100%");
        assert_eq!(percent(0.03), "0.03%");
        assert_eq!(percent(0.005), "0.005%");
        assert_eq!(percent(1.5), "1.5%");
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
