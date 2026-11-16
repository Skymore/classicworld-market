//! Native pieces of the collector's grind replay. Step 1: reading recordings
//! (captures/grind/frames, plain or gzipped JSON lines) into Python tuples, so the
//! tracker's Python code is fed without per-line JSON and hex work in Python.
use flate2::read::MultiGzDecoder;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

/// One recorded line: (time, session, client, index, payload) for a message, or
/// (time, None, False, None, action) for a pause/resume/toggle/end command.
pub enum Frame {
    Message {
        t: f64,
        session: String,
        client: bool,
        index: Option<i64>,
        payload: Vec<u8>,
    },
    Command {
        t: f64,
        action: String,
    },
}

pub fn hex(text: &str) -> Option<Vec<u8>> {
    let b = text.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    (0..b.len() / 2)
        .map(|i| Some((digit(b[2 * i])? << 4) | digit(b[2 * i + 1])?))
        .collect()
}

pub fn parse(line: &[u8]) -> Option<Frame> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let t = value.get("t")?.as_f64()?;
    if let Some(action) = value.get("a").and_then(|a| a.as_str()) {
        return Some(Frame::Command {
            t,
            action: action.to_string(),
        });
    }
    let session = match value.get("s")? {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let payload = hex(value.get("h")?.as_str()?)?;
    let client = value
        .get("c")
        .map(|c| c.as_bool().unwrap_or(c.as_i64().unwrap_or(0) != 0))
        .unwrap_or(false);
    let index = value.get("i").and_then(|i| i.as_i64());
    Some(Frame::Message {
        t,
        session,
        client,
        index,
        payload,
    })
}

/// Lines of a recording up to `size` uncompressed bytes (a live file is read only as far
/// as it was when listed); a partial last line is dropped.
pub fn read(path: &str, size: u64) -> std::io::Result<Vec<Frame>> {
    let file = File::open(path)?;
    let raw: Box<dyn Read> = if path.ends_with(".gz") {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut reader = BufReader::with_capacity(1 << 20, raw.take(size));
    let mut out = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 || line.last() != Some(&b'\n') {
            break;
        }
        if let Some(frame) = parse(&line) {
            out.push(frame);
        }
    }
    Ok(out)
}

#[cfg(feature = "python")]
#[allow(clippy::useless_conversion)] // PyO3 0.22's macros, flagged by newer clippy
mod python {
    use super::{read, Frame};
    use pyo3::prelude::*;
    use pyo3::types::PyBytes;

    #[pyfunction]
    fn read_frames(py: Python<'_>, path: &str, size: u64) -> PyResult<Vec<PyObject>> {
        let frames = py.allow_threads(|| read(path, size))?;
        Ok(frames
            .into_iter()
            .map(|f| match f {
                Frame::Message {
                    t,
                    session,
                    client,
                    index,
                    payload,
                } => (t, session, client, index, PyBytes::new_bound(py, &payload)).into_py(py),
                Frame::Command { t, action } => {
                    (t, py.None(), false, py.None(), action).into_py(py)
                }
            })
            .collect())
    }

    #[pymodule]
    fn grind_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(read_frames, m)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_become_frames() {
        assert_eq!(hex("0aff"), Some(vec![10, 255]));
        assert!(hex("0g").is_none());
        match parse(br#"{"t": 1.5, "s": "abc", "h": "7204", "c": 1, "i": 73}"#) {
            Some(Frame::Message {
                t,
                session,
                client,
                index,
                payload,
            }) => {
                assert_eq!(
                    (t, session.as_str(), client, index, payload),
                    (1.5, "abc", true, Some(73), vec![0x72, 4])
                );
            }
            _ => panic!("message"),
        }
        assert!(matches!(
            parse(br#"{"t": 2, "a": "toggle"}"#),
            Some(Frame::Command { .. })
        ));
    }
}
