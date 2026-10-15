//! `mcs://` custom URI scheme: streams local audio files (with HTTP Range support for seeking)
//! from the library / data root, and files the UI registered through the `file_url` command, to the
//! WebView. On Windows the URL form is `http://mcs.localhost/<percent-encoded absolute path>`.

use crate::AppState;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{http, Manager, UriSchemeContext, UriSchemeResponder};

/// The whole path is one percent-encoded segment: '/' (UNC paths start with two), '#', '%' and '?' must
/// stay escaped, or the WebView would cut a fragment or query, merge slashes or decode twice.
/// path_from_uri_path is the inverse.
pub fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    format!("http://mcs.localhost/{}", utf8_percent_encode(&s, NON_ALPHANUMERIC))
}

/// The file path a request's URI path (`/<percent-encoded path>`, see file_url) names.
fn path_from_uri_path(uri_path: &str) -> PathBuf {
    let raw = uri_path.trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy().to_string();
    PathBuf::from(decoded.replace('/', "\\"))
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/ogg",
        Some("aac") => "audio/aac",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("json") | Some("abc") | Some("txt") | Some("lrc") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Served: files under the output folder or the data root, and files registered by `file_url`
/// (user-picked sources, export results, songs saved under an earlier output folder). Both sides are
/// canonicalized (crate::path_under_roots); a path that cannot be resolved is refused.
pub(crate) fn allowed(state: &AppState, path: &Path) -> bool {
    let roots = {
        let cfg = state.config.read();
        vec![cfg.output_dir.clone(), cfg.data_root.clone()]
    };
    if crate::path_under_roots(&roots, path) {
        return true;
    }
    let Ok(target) = std::fs::canonicalize(path) else { return false };
    state.served.lock().contains(&target)
}

/// The only page allowed to read mcs:// responses (CORS): the app itself — the dev server in debug
/// builds, Tauri's Windows origin in release builds. Any other page loaded into the WebView is refused.
/// Sent when the request names no known origin (see cors_origin).
pub const APP_ORIGIN: &str = if cfg!(debug_assertions) { "http://localhost:1420" } else { "http://tauri.localhost" };

/// Origins the app's own page can have in this build: a debug binary may also serve the bundled
/// frontend (`tauri build --debug`), whose origin is Tauri's; a release build only has that one.
const APP_ORIGINS: &[&str] = if cfg!(debug_assertions) { &["http://localhost:1420", "http://tauri.localhost"] } else { &["http://tauri.localhost"] };

/// Access-Control-Allow-Origin for a request: its Origin when that is one of the app's own, otherwise
/// APP_ORIGIN (so any other page still fails CORS). Responses carry `Vary: Origin`.
fn cors_origin(request_origin: Option<&str>) -> &'static str {
    request_origin.and_then(|o| APP_ORIGINS.iter().copied().find(|a| *a == o)).unwrap_or(APP_ORIGIN)
}

/// Largest body sent for one 206 response. Media elements accept a shorter 206 and request the next
/// chunk, so an open-ended `bytes=0-` no longer reads a whole (possibly several hundred MB) file at once.
const MAX_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

/// Asynchronous scheme handler: the file read runs on the blocking pool, so a large 200 body (the
/// WaveSurfer fetch) or a 206 chunk never stalls the thread that dispatches WebView requests.
pub fn handle(ctx: UriSchemeContext<'_, tauri::Wry>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(respond(&app, &request)));
}

/// Build the response for one request. Needs only the AppHandle, so it runs on a worker thread.
pub fn respond(app: &tauri::AppHandle, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let path = path_from_uri_path(request.uri().path());
    if !path.is_absolute() || !allowed(&state, &path) {
        return deny(403, "forbidden");
    }
    let Ok(file) = std::fs::File::open(&path) else { return deny(404, "not found") };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request.headers().get("range").and_then(|v| v.to_str().ok());
    let origin = cors_origin(request.headers().get("origin").and_then(|v| v.to_str().ok()));
    file_response(file, len, mime_for(&path), range, origin)
}

fn deny(code: u16, msg: &str) -> http::Response<Vec<u8>> {
    http::Response::builder().status(code).header("Content-Type", "text/plain").body(msg.as_bytes().to_vec()).unwrap()
}

/// Serve `file` (`len` bytes) for an optional Range header value.
fn file_response<F: Read + Seek>(mut file: F, len: u64, mime: &str, range: Option<&str>, origin: &str) -> http::Response<Vec<u8>> {
    match parse_range(range, len) {
        RangeSpec::Partial(start, end) => {
            let count = end - start + 1;
            let mut buf = vec![0u8; count as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return deny(500, "read error");
            }
            http::Response::builder()
                .status(206)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", count.to_string())
                .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                .header("Access-Control-Allow-Origin", origin)
                .header("Vary", "Origin")
                .body(buf)
                .unwrap()
        }
        RangeSpec::Unsatisfiable => http::Response::builder()
            .status(416)
            .header("Content-Type", "text/plain")
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes */{len}"))
            .header("Access-Control-Allow-Origin", origin)
            .header("Vary", "Origin")
            .body(b"range not satisfiable".to_vec())
            .unwrap(),
        // Full body: Response<Vec<u8>> cannot stream, and the WaveSurfer fetch() needs the whole file anyway.
        RangeSpec::Full => {
            let mut buf = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut buf).is_err() {
                return deny(500, "read error");
            }
            http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", buf.len().to_string())
                .header("Access-Control-Allow-Origin", origin)
                .header("Vary", "Origin")
                .body(buf)
                .unwrap()
        }
    }
}

#[derive(Debug, PartialEq)]
enum RangeSpec {
    /// No (usable) Range header: 200 with the whole file.
    Full,
    /// Inclusive byte range, already capped to `MAX_RANGE_CHUNK`.
    Partial(u64, u64),
    /// 416 with `Content-Range: bytes */len`.
    Unsatisfiable,
}

/// Parse a single `bytes=` range (RFC 9110 §14.1.2). Malformed and multi-range headers are ignored
/// (a server may ignore Range), which serves the full body.
fn parse_range(header: Option<&str>, len: u64) -> RangeSpec {
    let Some(h) = header else { return RangeSpec::Full };
    // The range unit is case-insensitive (RFC 9110 §14.1).
    let Some((unit, spec)) = h.trim().split_once('=') else { return RangeSpec::Full };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeSpec::Full;
    }
    if spec.contains(',') {
        return RangeSpec::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else { return RangeSpec::Full };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        // Suffix form: the last N bytes.
        let Ok(n) = b.parse::<u64>() else { return RangeSpec::Full };
        if n == 0 || len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let Ok(start) = a.parse::<u64>() else { return RangeSpec::Full };
        let last = if b.is_empty() {
            None
        } else {
            match b.parse::<u64>() {
                Ok(v) if v >= start => Some(v),
                _ => return RangeSpec::Full, // last-pos before first-pos is an invalid range: ignore it
            }
        };
        if start >= len {
            return RangeSpec::Unsatisfiable;
        }
        (start, last.map_or(len - 1, |v| v.min(len - 1)))
    };
    RangeSpec::Partial(start, end.min(start + MAX_RANGE_CHUNK - 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn range_forms() {
        assert_eq!(parse_range(None, 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=0-"), 1000), RangeSpec::Partial(0, 999));
        assert_eq!(parse_range(Some("bytes=100-199"), 1000), RangeSpec::Partial(100, 199));
        assert_eq!(parse_range(Some("Bytes=100-199"), 1000), RangeSpec::Partial(100, 199));
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), RangeSpec::Partial(900, 999));
        // Suffix: the last N bytes.
        assert_eq!(parse_range(Some("bytes=-500"), 1000), RangeSpec::Partial(500, 999));
        assert_eq!(parse_range(Some("bytes=-5000"), 1000), RangeSpec::Partial(0, 999));
        assert_eq!(parse_range(Some("bytes=-0"), 1000), RangeSpec::Unsatisfiable);
    }

    #[test]
    fn range_unsatisfiable_and_ignored() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=2000-3000"), 1000), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeSpec::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-10"), 0), RangeSpec::Unsatisfiable);
        // Malformed / multi-range / other units: ignored -> full body.
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=abc-"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=5-2"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("items=0-1"), 1000), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=-"), 1000), RangeSpec::Full);
    }

    #[test]
    fn range_is_capped() {
        let len = 100 * MIB;
        assert_eq!(parse_range(Some("bytes=0-"), len), RangeSpec::Partial(0, 8 * MIB - 1));
        assert_eq!(parse_range(Some("bytes=10-"), len), RangeSpec::Partial(10, 10 + 8 * MIB - 1));
        assert_eq!(parse_range(Some("bytes=-20971520"), len), RangeSpec::Partial(len - 20 * MIB, len - 12 * MIB - 1));
        // The last chunk ends at EOF.
        assert_eq!(parse_range(Some(&format!("bytes={}-", len - 100)), len), RangeSpec::Partial(len - 100, len - 1));
    }

    fn header<'a>(r: &'a http::Response<Vec<u8>>, k: &str) -> Option<&'a str> {
        r.headers().get(k).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn responses() {
        let data: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let full = file_response(Cursor::new(data.clone()), 1000, "audio/wav", None, APP_ORIGIN);
        assert_eq!(full.status(), 200);
        assert_eq!(header(&full, "Access-Control-Allow-Origin"), Some(APP_ORIGIN));
        assert_ne!(APP_ORIGIN, "*");
        assert_eq!(full.body(), &data);
        assert_eq!(header(&full, "Content-Length"), Some("1000"));

        let tail = file_response(Cursor::new(data.clone()), 1000, "audio/wav", Some("bytes=-10"), APP_ORIGIN);
        assert_eq!(tail.status(), 206);
        assert_eq!(tail.body().as_slice(), &data[990..]);
        assert_eq!(header(&tail, "Content-Range"), Some("bytes 990-999/1000"));
        assert_eq!(header(&tail, "Content-Length"), Some("10"));
        assert_eq!(header(&tail, "Access-Control-Allow-Origin"), Some(APP_ORIGIN));

        let bad = file_response(Cursor::new(data.clone()), 1000, "audio/wav", Some("bytes=1000-"), APP_ORIGIN);
        assert_eq!(bad.status(), 416);
        assert_eq!(header(&bad, "Content-Range"), Some("bytes */1000"));

        let multi = file_response(Cursor::new(data.clone()), 1000, "audio/wav", Some("bytes=0-1,5-6"), APP_ORIGIN);
        assert_eq!(multi.status(), 200);
        assert_eq!(multi.body().len(), 1000);
    }

    #[test]
    fn cors_origin_echoes_only_the_app_itself() {
        assert_eq!(cors_origin(Some("http://tauri.localhost")), "http://tauri.localhost");
        assert_eq!(cors_origin(Some("https://evil.example")), APP_ORIGIN);
        assert_eq!(cors_origin(None), APP_ORIGIN);
        if cfg!(debug_assertions) {
            // A debug binary serving the bundled frontend.
            assert_eq!(cors_origin(Some("http://localhost:1420")), "http://localhost:1420");
        } else {
            assert_eq!(cors_origin(Some("http://localhost:1420")), APP_ORIGIN);
        }
        let r = file_response(Cursor::new(vec![1u8; 10]), 10, "audio/wav", None, cors_origin(Some("http://tauri.localhost")));
        assert_eq!(header(&r, "Access-Control-Allow-Origin"), Some("http://tauri.localhost"));
        assert_eq!(header(&r, "Vary"), Some("Origin"));
    }

    #[test]
    fn mime_types_cover_the_picker_formats() {
        assert_eq!(mime_for(Path::new("a.AAC")), "audio/aac");
        assert_eq!(mime_for(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for(Path::new("a.webp")), "image/webp");
        assert_eq!(mime_for(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn file_url_round_trips_through_the_request_path() {
        let paths = [
            r"C:\a b\#1 100%.wav",
            r"C:\Users\山田\Music\Music Creator Studio YuE2\2026-10-05\101500_abcdef12\song.wav",
            r"D:\夜明け🎵\x.flac",
            r"\\server\share\a+b.wav",
            r"\\server\share\曲 #1\a%20b.wav",
            r"D:\100%\x?.flac",
            r"C:\x\..\y.wav",
            r"E:\a&b=c;d'e(f)[g]{h}~!$@,.wav",
        ];
        for p in paths {
            let url = file_url(Path::new(p));
            let encoded = url.strip_prefix("http://mcs.localhost/").unwrap();
            assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '%'), "{url}");
            // As the WebView sends it (WebView2: the http://mcs.localhost form; elsewhere mcs://localhost).
            for sent in [url.clone(), url.replacen("http://mcs.", "mcs://", 1)] {
                let uri: http::Uri = sent.parse().unwrap();
                assert_eq!(uri.query(), None, "{sent}");
                let back = path_from_uri_path(uri.path());
                assert_eq!(back.to_string_lossy(), p, "{sent}");
                if cfg!(windows) {
                    assert!(back.is_absolute(), "{p}");
                }
            }
        }
    }

    #[test]
    fn chunked_206_reports_real_end() {
        let len = 9 * MIB;
        let data = vec![7u8; len as usize];
        let r = file_response(Cursor::new(data), len, "audio/wav", Some("bytes=0-"), APP_ORIGIN);
        assert_eq!(r.status(), 206);
        assert_eq!(r.body().len() as u64, 8 * MIB);
        let want = format!("bytes 0-{}/{len}", 8 * MIB - 1);
        assert_eq!(header(&r, "Content-Range"), Some(want.as_str()));
    }
}
