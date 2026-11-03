//! Content codings for bodies compressed once and sent many times: the
//! cached market list and the text files under `web/`. Other answers are
//! compressed per response by `CompressionLayer`, which leaves a response
//! that already has `Content-Encoding` alone.

use std::io::Write as _;

use axum::http::{header, HeaderMap, HeaderValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Coding {
    Br,
    Gzip,
}

impl Coding {
    pub(crate) fn header(self) -> HeaderValue {
        HeaderValue::from_static(match self {
            Self::Br => "br",
            Self::Gzip => "gzip",
        })
    }
}

/// The q-values a request gives br and gzip (0 when not accepted). An
/// unparsable q-value refuses that coding, as `CompressionLayer` does.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Accepted {
    pub br: f32,
    pub gzip: f32,
}

impl Accepted {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Self {
        let (mut br, mut gzip, mut any) = (None, None, None);
        for value in headers.get_all(header::ACCEPT_ENCODING) {
            let Ok(value) = value.to_str() else { continue };
            for item in value.split(',') {
                let mut parts = item.split(';');
                let name = parts.next().unwrap_or_default().trim();
                let q = match parts
                    .map(str::trim)
                    .find(|p| p.len() > 1 && p[..2].eq_ignore_ascii_case("q="))
                {
                    None => 1.0,
                    Some(q) => q[2..]
                        .trim()
                        .parse::<f32>()
                        .ok()
                        .filter(|q| (0.0..=1.0).contains(q))
                        .unwrap_or(0.0),
                };
                if name.eq_ignore_ascii_case("br") {
                    br = Some(q);
                } else if name.eq_ignore_ascii_case("gzip") || name.eq_ignore_ascii_case("x-gzip") {
                    gzip = Some(q);
                } else if name == "*" {
                    any = Some(q);
                }
            }
        }
        Self {
            br: br.or(any).unwrap_or(0.0),
            gzip: gzip.or(any).unwrap_or(0.0),
        }
    }

    /// Higher q-value wins; br on a tie.
    pub(crate) fn preferred(self) -> Option<Coding> {
        if self.br > 0.0 && self.br >= self.gzip {
            Some(Coding::Br)
        } else if self.gzip > 0.0 {
            Some(Coding::Gzip)
        } else {
            None
        }
    }
}

pub(crate) fn brotli(data: &[u8], quality: i32) -> Vec<u8> {
    let params = brotli::enc::BrotliEncoderParams {
        quality,
        lgwin: 22,
        size_hint: data.len(),
        ..Default::default()
    };
    let mut out = Vec::with_capacity(data.len() / 4 + 64);
    brotli::BrotliCompress(&mut &data[..], &mut out, &params).expect("in-memory brotli");
    out
}

pub(crate) fn gzip(data: &[u8], level: u32) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(data.len() / 4 + 64),
        flate2::Compression::new(level),
    );
    encoder.write_all(data).expect("in-memory gzip");
    encoder.finish().expect("in-memory gzip")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    fn accepted(value: &str) -> Accepted {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_str(value).unwrap(),
        );
        Accepted::from_headers(&headers)
    }

    #[test]
    fn accept_encoding_follows_q_values() {
        assert_eq!(
            accepted("gzip, deflate, br, zstd").preferred(),
            Some(Coding::Br)
        );
        assert_eq!(accepted("gzip").preferred(), Some(Coding::Gzip));
        assert_eq!(accepted("br;q=0, gzip").preferred(), Some(Coding::Gzip));
        assert_eq!(
            accepted("gzip;q=1, br;q=0.5").preferred(),
            Some(Coding::Gzip)
        );
        assert_eq!(accepted("*").preferred(), Some(Coding::Br));
        assert_eq!(accepted("*;q=0, gzip").preferred(), Some(Coding::Gzip));
        assert_eq!(accepted("identity").preferred(), None);
        assert_eq!(accepted("br;q=x, deflate").preferred(), None);
        assert_eq!(Accepted::from_headers(&HeaderMap::new()).preferred(), None);
    }

    #[test]
    fn codings_round_trip() {
        let data = "市场 market ".repeat(500).into_bytes();
        let mut out = Vec::new();
        brotli::Decompressor::new(&brotli(&data, 5)[..], 4096)
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, data);
        out.clear();
        flate2::read::GzDecoder::new(&gzip(&data, 9)[..])
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, data);
    }
}
