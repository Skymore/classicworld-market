//! Python-compatible serialisation and float arithmetic.
//!
//! Fingerprints, shop keys and sale ids are sha256 of `json.dumps` output, and
//! the pricing rules round through `repr(float)` and `format(x, 'g')`. These
//! helpers reproduce CPython's output byte for byte for the values we use.

use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Options of `json.dumps(value, sort_keys=True, ...)`.
#[derive(Debug, Clone, Copy)]
pub struct Dumps {
    pub ensure_ascii: bool,
    /// `separators=(',', ':')` instead of the default `(', ', ': ')`.
    pub compact: bool,
}

impl Dumps {
    /// `separators=(',',':'), ensure_ascii=False`: `shared_protocol.digest`.
    pub const CANONICAL: Dumps = Dumps {
        ensure_ascii: false,
        compact: true,
    };
    /// Default separators, `ensure_ascii=False`: `market_dashboard.listing_shop`.
    pub const UNICODE: Dumps = Dumps {
        ensure_ascii: false,
        compact: false,
    };
    /// Plain `json.dumps(value, sort_keys=True)`: watchlist listing ids.
    pub const ASCII: Dumps = Dumps {
        ensure_ascii: true,
        compact: false,
    };
}

/// `json.dumps(value, sort_keys=True, ...)`. Object keys are always sorted.
pub fn dumps(value: &Value, opts: Dumps) -> String {
    let mut out = String::new();
    write_value(&mut out, value, opts);
    out
}

/// `shared_protocol.digest`: sha256 hex of the canonical JSON.
pub fn digest(value: &Value) -> String {
    sha256_hex(dumps(value, Dumps::CANONICAL).as_bytes())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn write_value(out: &mut String, value: &Value, opts: Dumps) {
    let (item_sep, key_sep) = if opts.compact {
        (",", ":")
    } else {
        (", ", ": ")
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => write!(out, "{i}").unwrap(),
            (None, Some(u)) => write!(out, "{u}").unwrap(),
            _ => out.push_str(&float_repr(n.as_f64().unwrap_or(f64::NAN))),
        },
        Value::String(s) => write_str(out, s, opts.ensure_ascii),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_value(out, item, opts);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_str(out, key, opts.ensure_ascii);
                out.push_str(key_sep);
                write_value(out, &map[key], opts);
            }
            out.push('}');
        }
    }
}

fn write_str(out: &mut String, s: &str, ensure_ascii: bool) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            // ensure_ascii escapes everything outside ' '..'~', DEL included.
            c if ensure_ascii && !(' '..='~').contains(&c) => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    write!(out, "\\u{unit:04x}").unwrap();
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Shortest round-trip digits of `|x|`: (digits, exponent) with
/// `|x| = d.ddd × 10^exponent`. Same digits as CPython's `repr`.
fn shortest(x: f64) -> (String, i32) {
    let text = format!("{:e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').expect("LowerExp has an exponent");
    (
        mantissa.replace('.', ""),
        exponent.parse().expect("LowerExp exponent is an integer"),
    )
}

/// `repr(float)`.
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x == 0.0 {
        return format!("{sign}0.0");
    }
    let (digits, exponent) = shortest(x);
    let point = exponent + 1; // digits before the decimal point
    let len = digits.len() as i32;
    let body = if !(-4 < point && point <= 16) {
        let (head, tail) = digits.split_at(1);
        let mantissa = if tail.is_empty() {
            head.to_string()
        } else {
            format!("{head}.{tail}")
        };
        let exp_sign = if exponent < 0 { '-' } else { '+' };
        format!("{mantissa}e{exp_sign}{:02}", exponent.abs())
    } else if point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else if point >= len {
        format!("{digits}{}.0", "0".repeat((point - len) as usize))
    } else {
        let (head, tail) = digits.split_at(point as usize);
        format!("{head}.{tail}")
    };
    format!("{sign}{body}")
}

/// `format(x, 'g')`: 6 significant digits, trailing zeros removed.
pub fn format_g(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "nan".into()
        } else if x > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0" } else { "0" }.into();
    }
    let scientific = format!("{x:.5e}");
    let (mantissa, exponent) = scientific.split_once('e').expect("LowerExp");
    let exponent: i32 = exponent.parse().expect("LowerExp exponent");
    if (-4..6).contains(&exponent) {
        strip_zeros(&format!("{x:.*}", (5 - exponent) as usize))
    } else {
        let exp_sign = if exponent < 0 { '-' } else { '+' };
        format!("{}e{exp_sign}{:02}", strip_zeros(mantissa), exponent.abs())
    }
}

fn strip_zeros(text: &str) -> String {
    if !text.contains('.') {
        return text.to_string();
    }
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `round(x, ndigits)`: correctly rounded, ties to even on the exact value.
pub fn round(x: f64, ndigits: usize) -> f64 {
    format!("{x:.ndigits$}")
        .parse()
        .expect("formatted float parses")
}

/// Python's float `a // b`, which is not always `(a / b).floor()`.
pub fn floordiv(a: f64, b: f64) -> f64 {
    let rem = a % b;
    let mut div = (a - rem) / b;
    if rem != 0.0 && ((b < 0.0) != (rem < 0.0)) {
        div -= 1.0;
    }
    if div == 0.0 {
        return 0.0_f64.copysign(a / b);
    }
    let mut floor = div.floor();
    if div - floor > 0.5 {
        floor += 1.0;
    }
    floor
}

/// `math.fsum`: correctly rounded sum (Shewchuk partials, as in CPython).
pub fn fsum(values: &[f64]) -> f64 {
    let mut partials: Vec<f64> = Vec::new();
    for &value in values {
        let mut x = value;
        let mut kept = 0;
        for j in 0..partials.len() {
            let mut y = partials[j];
            if x.abs() < y.abs() {
                std::mem::swap(&mut x, &mut y);
            }
            let hi = x + y;
            let lo = y - (hi - x);
            if lo != 0.0 {
                partials[kept] = lo;
                kept += 1;
            }
            x = hi;
        }
        partials.truncate(kept);
        partials.push(x);
    }
    let Some(mut k) = partials.len().checked_sub(1) else {
        return 0.0;
    };
    let mut hi = partials[k];
    let mut lo = 0.0;
    while k > 0 {
        k -= 1;
        let x = hi;
        let y = partials[k];
        hi = x + y;
        lo = y - (hi - x);
        if lo != 0.0 {
            break;
        }
    }
    // Half-even rounding across partials.
    if k > 0 && ((lo < 0.0 && partials[k - 1] < 0.0) || (lo > 0.0 && partials[k - 1] > 0.0)) {
        let y = lo * 2.0;
        let x = hi + y;
        if y == x - hi {
            hi = x;
        }
    }
    hi
}

/// Exact decimal of `repr(x)` for x > 0: `x == digits × 10^scale`.
pub(crate) fn repr_decimal(x: f64) -> (u128, i32) {
    let (digits, exponent) = shortest(x);
    let scale = exponent - (digits.len() as i32 - 1);
    (digits.parse().expect("digits"), scale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_matches_python_separators_and_escapes() {
        let value =
            json!({"b": [1, 2.5, null], "a": "雪\"\n\u{7f}", "c": {"z": true, "y": 1791704332.0}});
        assert_eq!(
            dumps(&value, Dumps::CANONICAL),
            "{\"a\":\"雪\\\"\\n\u{7f}\",\"b\":[1,2.5,null],\"c\":{\"y\":1791704332.0,\"z\":true}}"
        );
        assert_eq!(
            dumps(&value, Dumps::ASCII),
            "{\"a\": \"\\u96ea\\\"\\n\\u007f\", \"b\": [1, 2.5, null], \"c\": {\"y\": 1791704332.0, \"z\": true}}"
        );
        assert_eq!(dumps(&json!("😀"), Dumps::ASCII), "\"\\ud83d\\ude00\"");
        assert_eq!(dumps(&json!([]), Dumps::UNICODE), "[]");
    }

    #[test]
    fn digest_of_python_value() {
        // python3 -c "from shared_protocol import digest; print(digest(['fixture','oid']))"
        assert_eq!(
            digest(&json!(["fixture", "oid"])),
            "cf6091435839990cff5daa8d9039e1a37ebd539c908e1655323550cc20e36622"
        );
    }

    #[test]
    fn float_repr_matches_python() {
        for (x, expected) in [
            (1791704332.1309783, "1791704332.1309783"),
            (1791704332.0, "1791704332.0"),
            (0.1, "0.1"),
            (1e16, "1e+16"),
            (1.5e16, "1.5e+16"),
            (1e15, "1000000000000000.0"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (-2.5, "-2.5"),
            (0.0, "0.0"),
        ] {
            assert_eq!(float_repr(x), expected, "{x}");
        }
    }

    #[test]
    fn format_g_matches_python() {
        for (x, expected) in [
            (149.5, "149.5"),
            (100.0, "100"),
            (1234567.0, "1.23457e+06"),
            (1234565.0, "1.23456e+06"),
            (0.0001, "0.0001"),
            (0.00001234, "1.234e-05"),
            (999999.5, "1e+06"),
            (0.39, "0.39"),
        ] {
            assert_eq!(format_g(x), expected, "{x}");
        }
    }

    #[test]
    fn round_and_floordiv_match_python() {
        assert_eq!(round(12.25, 1), 12.2);
        assert_eq!(round(0.25, 1), 0.2);
        assert_eq!(round(-3.35, 1), -3.4);
        assert_eq!(floordiv(1791704332.5, 60.0), 29861738.0);
        assert_eq!(floordiv(-1.0, 60.0), -1.0);
    }

    #[test]
    fn fsum_is_exact() {
        assert_eq!(fsum(&[0.1, 0.2, 0.3]), 0.6);
        assert_eq!(fsum(&[1e100, 1.0, -1e100]), 1.0);
        assert_eq!(fsum(&[]), 0.0);
    }
}
