//! Export: ffmpeg format conversion + metadata / synced lyrics tagging (lofty) + .lrc sidecar.

use crate::config::AppConfig;
use anyhow::{bail, Context, Result};
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::id3::v2::{BinaryFrame, Frame, FrameId, Id3v2Tag, SyncTextContentType, SynchronizedTextFrame, TimestampFormat, UnsynchronizedTextFrame};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};
use lofty::TextEncoding;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    /// milliseconds
    pub time_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportRequest {
    pub source: String,
    pub dest: String,
    /// wav16 | wav24 | wav32f | flac | mp3 | m4a | ogg | opus
    pub format: String,
    /// kbps for lossy formats (mp3/m4a/ogg/opus)
    pub bitrate_kbps: u32,
    /// MP3 rate control. Some(q): libmp3lame VBR `-q:a q` (0 = best … 9 = smallest; larger values are
    /// clamped to 9). None: CBR at `bitrate_kbps`.
    pub mp3_vbr: Option<u32>,
    pub loudnorm: bool,
    pub target_lufs: f64,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
    pub trim_silence: bool,
    /// Hard-clip samples above 0 dBFS at the end of the chain (only when loudnorm is off; opt-in).
    pub hard_clip: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: String,
    pub genre: String,
    pub comment: String,
    pub cover_image: Option<String>,
    /// Plain lyrics (USLT / ©lyr / LYRICS)
    pub lyrics: String,
    /// Timed lines (SYLT / LRC). Empty = no synced lyrics.
    pub synced: Vec<LyricLine>,
    pub write_lrc: bool,
    pub language: String,
}

impl Default for ExportRequest {
    fn default() -> Self {
        Self {
            source: String::new(),
            dest: String::new(),
            format: "mp3".into(),
            bitrate_kbps: 320,
            mp3_vbr: None,
            loudnorm: false,
            target_lufs: -14.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            trim_silence: false,
            hard_clip: false,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            year: String::new(),
            genre: String::new(),
            comment: String::new(),
            cover_image: None,
            lyrics: String::new(),
            synced: Vec::new(),
            write_lrc: true,
            language: "jpn".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dest: String,
    pub lrc_path: Option<String>,
    pub bytes: u64,
    pub ffmpeg_seconds: f64,
    /// Notes for the user (e.g. the trim analysis failed, synced lines were dropped by the trim).
    pub warnings: Vec<String>,
}

/// Test helper: file extension of an export format. The app picks the extension in ExportPage.doExport
/// (its mapping must stay the same); run_export never changes the extension of `dest`.
#[cfg(test)]
fn extension_for(format: &str) -> &'static str {
    match format {
        "wav16" | "wav24" | "wav32f" => "wav",
        "flac" => "flac",
        "mp3" => "mp3",
        "m4a" => "m4a",
        "ogg" => "ogg",
        "opus" => "opus",
        _ => "wav",
    }
}

/// "Trim silence": threshold, minimum silence length and the padding kept at each side
/// (the same values as the former silenceremove chain).
const TRIM_THRESHOLD: &str = "-50dB";
const TRIM_MIN_SILENCE_SEC: f64 = 0.2;
const TRIM_PAD_SEC: f64 = 0.2;
/// A silence_start / silence_end this close to 0 or to the end counts as "at the edge".
const EDGE_EPS_SEC: f64 = 0.05;

/// Section of the source kept by "trim silence", in ms on the source timeline. `end_ms: None` = up to EOF.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TrimWindow {
    start_ms: u64,
    end_ms: Option<u64>,
}

impl TrimWindow {
    fn is_noop(&self) -> bool {
        self.start_ms == 0 && self.end_ms.is_none()
    }
    /// Length of the trimmed output in seconds (needs the source duration when the end is open).
    fn output_duration(&self, duration: Option<f64>) -> Option<f64> {
        let end = match self.end_ms {
            Some(e) => e as f64 / 1000.0,
            None => duration?,
        };
        Some((end - self.start_ms as f64 / 1000.0).max(0.0))
    }
}

/// Parse ffmpeg `silencedetect` output into the kept window. Leading silence counts only when it
/// starts at ~0; trailing silence is a silence_start without silence_end, or one whose end is at EOF.
/// `TRIM_PAD_SEC` of silence is kept at each side. Returns None when the whole file is silent.
fn parse_silence(log: &str, duration: Option<f64>) -> Option<TrimWindow> {
    let num = |line: &str, key: &str| -> Option<f64> {
        let rest = line.split(key).nth(1)?;
        rest.trim().split(|c: char| c.is_whitespace() || c == '|').next()?.parse().ok()
    };
    // (start, end) in order; end None = the silence runs to EOF without a closing event.
    let mut spans: Vec<(f64, Option<f64>)> = Vec::new();
    for line in log.lines() {
        if let Some(v) = num(line, "silence_start:") {
            spans.push((v.max(0.0), None));
        } else if let Some(v) = num(line, "silence_end:") {
            if let Some(last) = spans.last_mut() {
                if last.1.is_none() {
                    last.1 = Some(v);
                }
            }
        }
    }
    let at_eof = |end: Option<f64>| match (end, duration) {
        (None, _) => true,
        (Some(e), Some(d)) => e >= d - EDGE_EPS_SEC,
        (Some(_), None) => false,
    };
    let mut start = 0.0;
    let mut end: Option<f64> = None;
    let leading = spans.first().copied().filter(|&(s0, _)| s0 <= EDGE_EPS_SEC);
    if let Some((_, e0)) = leading {
        if at_eof(e0) {
            return None; // silent from start to end: nothing sensible to trim to
        }
        start = (e0.unwrap_or(0.0) - TRIM_PAD_SEC).max(0.0);
    }
    if let Some(&(sl, el)) = spans.last() {
        let is_the_leading_span = spans.len() == 1 && leading.is_some();
        if !is_the_leading_span && at_eof(el) {
            let e = sl + TRIM_PAD_SEC;
            end = Some(match duration {
                Some(d) => e.min(d),
                None => e,
            });
        }
    }
    Some(TrimWindow { start_ms: (start * 1000.0).round() as u64, end_ms: end.map(|e| (e * 1000.0).round() as u64) })
}

/// Run ffmpeg silencedetect over the whole source. Uses its own Command because run_hidden keeps only
/// the tail of the output, and the leading silence is reported first.
fn detect_trim_window(ffmpeg: &Path, src: &Path, duration: Option<f64>) -> Result<Option<TrimWindow>> {
    let af = format!("silencedetect=n={TRIM_THRESHOLD}:d={TRIM_MIN_SILENCE_SEC}");
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "info", "-i"]).arg(src).args(["-vn", "-af", &af, "-f", "null", "-"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().context("ffmpeg (silencedetect) を起動できません")?;
    if !out.status.success() {
        bail!("ffmpeg silencedetect が失敗しました");
    }
    Ok(parse_silence(&String::from_utf8_lossy(&out.stderr), duration))
}

/// ms -> "S.mmm" for ffmpeg filter options.
fn secs(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// Build the -af chain. `trim` is the analysed window (None = no trim), `out_rate` the sample rate of the
/// exported file (output_rate).
fn audio_filter_chain(req: &ExportRequest, duration: Option<f64>, trim: Option<TrimWindow>, out_rate: u32) -> Option<String> {
    let mut filters: Vec<String> = Vec::new();
    // Duration of the stream the fade-out sees: the trimmed one when trimming.
    let mut out_duration = duration;
    if let Some(w) = trim.filter(|w| !w.is_noop()) {
        let mut f = format!("atrim=start={}", secs(w.start_ms));
        if let Some(e) = w.end_ms {
            f.push_str(&format!(":end={}", secs(e)));
        }
        filters.push(f);
        filters.push("asetpts=PTS-STARTPTS".into());
        out_duration = w.output_duration(duration);
    }
    if req.loudnorm {
        filters.push(format!("loudnorm=I={}:TP=-1.0:LRA=11", req.target_lufs));
        // loudnorm (dynamic mode) upsamples to 192 kHz internally: go back to the output rate (the source rate
        // except for OGG) so WAV/FLAC keep it, AAC is not moved to 96 kHz and the Vorbis encoder can open at all.
        filters.push(format!("aresample={out_rate}"));
    }
    if req.fade_in_sec > 0.0 {
        filters.push(format!("afade=t=in:st=0:d={}", req.fade_in_sec));
    }
    if req.fade_out_sec > 0.0 {
        if let Some(d) = out_duration {
            let st = (d - req.fade_out_sec).max(0.0);
            filters.push(format!("afade=t=out:st={st:.3}:d={}", req.fade_out_sec));
        }
    }
    if req.hard_clip && !req.loudnorm {
        // Zero-latency clamp to ±1.0 (no limiter lookahead, so the LRC/SYLT timing does not move).
        filters.push("asoftclip=type=hard:threshold=1".into());
    }
    if filters.is_empty() { None } else { Some(filters.join(",")) }
}

/// Move synced lines onto the trimmed timeline and drop the ones that fall after its end.
/// Returns the lines and how many were dropped.
fn shift_synced(lines: &[LyricLine], trim: Option<TrimWindow>, out_duration: Option<f64>) -> (Vec<LyricLine>, usize) {
    let Some(w) = trim else { return (lines.to_vec(), 0) };
    let limit_ms = if w.end_ms.is_some() { out_duration.map(|d| (d * 1000.0).round() as u64) } else { None };
    let mut out = Vec::with_capacity(lines.len());
    let mut dropped = 0;
    for l in lines {
        let t = l.time_ms.saturating_sub(w.start_ms);
        if limit_ms.is_some_and(|lim| t > lim) {
            dropped += 1;
            continue;
        }
        out.push(LyricLine { time_ms: t, text: l.text.clone() });
    }
    (out, dropped)
}

/// Run a console program without a window; returns (success, stdout, stderr), complete and separate.
/// The probes need this instead of setup::run_hidden, which merges both streams and keeps only the tail:
/// ffprobe prints its value on stdout but non-fatal demuxer errors ("CRC mismatch!") on stderr.
fn run_hidden_output(exe: &Path, args: &[&str]) -> Result<(bool, String, String)> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().with_context(|| format!("{} を起動できません", exe.display()))?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

/// First line of ffprobe's stdout that reads as a finite number > 0 ("N/A" and stray lines are skipped).
fn parse_probe_number(out: &str) -> Option<f64> {
    out.lines().find_map(|l| l.trim().parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0))
}

/// `  Duration: 00:03:05.12, start: 0.000000, bitrate: 1536 kb/s` (ffmpeg -i) -> 185.12 s
fn parse_duration_from_ffmpeg_info(out: &str) -> Option<f64> {
    let line = out.lines().find(|l| l.contains("Duration:"))?;
    let t = line.split("Duration:").nth(1)?.trim().split(',').next()?.trim();
    let parts: Vec<f64> = t.split(':').filter_map(|p| p.parse().ok()).collect();
    let d = if parts.len() == 3 { parts[0] * 3600.0 + parts[1] * 60.0 + parts[2] } else { return None };
    (d.is_finite() && d > 0.0).then_some(d)
}

/// Probe duration in seconds with ffprobe (falls back to ffmpeg -i parsing when ffprobe gives no number).
pub fn probe_duration(cfg: &AppConfig, src: &Path) -> Option<f64> {
    let ffmpeg = cfg.ffmpeg_exe()?;
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    let src_s = src.to_string_lossy();
    if ffprobe.is_file() {
        let args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", &src_s];
        if let Some(d) = run_hidden_output(&ffprobe, &args).ok().and_then(|(_, out, _)| parse_probe_number(&out)) {
            return Some(d);
        }
    }
    // ffmpeg -i always exits with an error ("At least one output file must be specified"); the info is on stderr.
    let (_, _, info) = run_hidden_output(&ffmpeg, &["-hide_banner", "-i", &src_s]).ok()?;
    parse_duration_from_ffmpeg_info(&info)
}

/// YuE2 native output rate, used when the source rate cannot be probed.
const FALLBACK_SAMPLE_RATE: u32 = 48_000;

/// Probe the sample rate of the first audio stream with ffprobe (falls back to ffmpeg -i parsing).
pub fn probe_sample_rate(cfg: &AppConfig, src: &Path) -> Option<u32> {
    let ffmpeg = cfg.ffmpeg_exe()?;
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    let src_s = src.to_string_lossy();
    if ffprobe.is_file() {
        let args = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "default=noprint_wrappers=1:nokey=1", &src_s];
        let rate = run_hidden_output(&ffprobe, &args).ok().and_then(|(_, out, _)| parse_probe_number(&out));
        if let Some(r) = rate.filter(|r| r.fract() == 0.0 && *r <= u32::MAX as f64) {
            return Some(r as u32);
        }
    }
    let (_, _, info) = run_hidden_output(&ffmpeg, &["-hide_banner", "-i", &src_s]).ok()?;
    parse_rate_from_ffmpeg_info(&info)
}

/// `Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, stereo, flt, 3072 kb/s` -> 48000
fn parse_rate_from_ffmpeg_info(out: &str) -> Option<u32> {
    let line = out.lines().find(|l| l.contains("Audio:"))?;
    line.split(',').find_map(|p| p.trim().strip_suffix(" Hz").and_then(|n| n.trim().parse().ok()))
}

/// Probe the channel count of the first audio stream with ffprobe (falls back to ffmpeg -i parsing).
fn probe_channels(cfg: &AppConfig, src: &Path) -> Option<u32> {
    let ffmpeg = cfg.ffmpeg_exe()?;
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    let src_s = src.to_string_lossy();
    if ffprobe.is_file() {
        let args = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "default=noprint_wrappers=1:nokey=1", &src_s];
        let ch = run_hidden_output(&ffprobe, &args).ok().and_then(|(_, out, _)| parse_probe_number(&out));
        if let Some(c) = ch.filter(|c| c.fract() == 0.0 && *c <= u32::MAX as f64) {
            return Some(c as u32);
        }
    }
    let (_, _, info) = run_hidden_output(&ffmpeg, &["-hide_banner", "-i", &src_s]).ok()?;
    parse_channels_from_ffmpeg_info(&info)
}

/// `Stream #0:0: Audio: flac, 96000 Hz, mono, s16` -> 1 ("stereo" 2, "N channels" N; other layouts such as
/// "5.1(side)" are not parsed).
fn parse_channels_from_ffmpeg_info(out: &str) -> Option<u32> {
    let line = out.lines().find(|l| l.contains("Audio:"))?;
    line.split(',').find_map(|p| match p.trim() {
        "mono" => Some(1),
        "stereo" => Some(2),
        t => t.strip_suffix(" channels").and_then(|n| n.trim().parse().ok()),
    })
}

/// The .lrc marker line build_lrc writes: an .lrc with it was made by this app.
const LRC_MARKER: &str = "[by:Music Creator Studio YuE2]";

/// Whether `dest` (existing or not) is the source file itself, spelled differently or not (case, `/` vs `\`,
/// 8.3 names: canonicalize resolves them all). A dest that does not exist yet cannot be the source.
fn is_same_file(src: &Path, dest: &Path) -> bool {
    match (std::fs::canonicalize(src), std::fs::canonicalize(dest)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The names being exported to (dest_key), shared by every export (AppState::export_dests). After a page reload the
/// export the old page started runs on, unseen; a second export to its name would replace dest after it or before
/// it (the last run to finish wins, after the page showed the other's result) and could delete the other's .lrc,
/// so it is refused (claim). While an export holds its names, no other run can own the temp files of that name or
/// of its .lrc files, so what an interrupted export left there can go (remove_stale_temps).
#[derive(Default)]
pub struct ExportDests(parking_lot::Mutex<std::collections::HashSet<String>>);

/// An export's hold on its names (ExportDests::claim), released when dropped.
struct DestClaim<'a> {
    dests: &'a ExportDests,
    keys: [String; 2],
}

impl ExportDests {
    /// Holds `<name>` (dest and `<name>.lrc`) and `<name>.mcs`: beside a foreign `<name>.lrc` this export's .lrc goes
    /// to `<name>.mcs.lrc`, the own .lrc of `<name>.mcs.<ext>`. Refused, holding nothing, when another export holds
    /// either.
    fn claim(&self, dest: &Path) -> Result<DestClaim<'_>> {
        let name = dest_key(dest);
        let keys = [format!("{name}.mcs"), name];
        let mut held = self.0.lock();
        if keys.iter().any(|k| held.contains(k)) {
            bail!(
                "同じ名前（{}）への書き出しがまだ実行中です（画面を再読み込みする前に始めた書き出しなど。拡張子だけが違う名前や、拡張子の前に .mcs が付いただけの名前も .lrc が同じになるため同時には書き出せません）。終わってから、もう一度書き出してください",
                dest.display()
            );
        }
        held.extend(keys.iter().cloned());
        Ok(DestClaim { dests: self, keys })
    }
}

impl Drop for DestClaim<'_> {
    fn drop(&mut self) {
        let mut held = self.dests.0.lock();
        for k in &self.keys {
            held.remove(k);
        }
    }
}

/// The name an export writes: dest's folder resolved (letter case, `..`, links; run_export has created it) and the
/// file name without its extension, lowercased (Windows compares names without case). `<name>.flac` and
/// `<name>.mp3` are one name: they share `<name>.lrc` and its temp files. (`<name>.mcs.mp3` is another name, but it
/// shares `<name>.mcs.lrc` with both: ExportDests::claim holds that too.)
fn dest_key(dest: &Path) -> String {
    let folder = dest.parent().map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())).unwrap_or_default();
    folder.join(dest.file_stem().unwrap_or_default()).to_string_lossy().to_lowercase()
}

/// Remove what an interrupted export to this name left next to `dest` (a forced quit kills ffmpeg before TempFile
/// can remove its file): the temp files of `dest` and of its .lrc (`<stem>.lrc`, `<stem>.mcs.lrc`), named as
/// temp_path_for names them or as older builds did (`<stem>.mcs-tmp.<ext>`). Nothing else is touched. Only while
/// this export holds its names (ExportDests::claim): none of them belongs to an export still running then.
fn remove_stale_temps(dest: &Path) {
    let Some(dir) = dest.parent() else { return };
    let targets = [dest.to_path_buf(), dest.with_extension("lrc"), dest.with_extension("mcs.lrc")];
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        if e.file_type().is_ok_and(|t| t.is_file()) && targets.iter().any(|t| is_temp_name_of(&name.to_string_lossy(), t)) {
            match std::fs::remove_file(e.path()) {
                Ok(()) => log::info!("removed {} (left by an interrupted export)", e.path().display()),
                Err(err) => log::warn!("could not remove {} (left by an interrupted export): {err}", e.path().display()),
            }
        }
    }
}

/// `name` is a temp file name of `target`: `<stem>.mcs-tmp.<8 hex>.<ext>` (temp_path_for) or `<stem>.mcs-tmp.<ext>`
/// (older builds), ASCII letter case ignored as Windows does.
fn is_temp_name_of(name: &str, target: &Path) -> bool {
    let stem = target.file_stem().map(|s| s.to_string_lossy()).unwrap_or_default();
    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let name = name.to_ascii_lowercase();
    let Some(rest) = name.strip_prefix(&format!("{stem}.mcs-tmp").to_ascii_lowercase()).and_then(|r| r.strip_suffix(&ext.to_ascii_lowercase())) else {
        return false;
    };
    rest.is_empty() || rest.strip_prefix('.').is_some_and(|t| t.len() == 8 && t.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Sibling of `dest` that ffmpeg writes first: `<stem>.mcs-tmp.<8 random hex>.<ext>`, new for every call, so no run
/// ever writes into a file another run has open. It keeps the real extension last, because ffmpeg picks the muxer
/// and lofty the tag format from it.
fn temp_path_for(dest: &Path) -> PathBuf {
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    let token = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let name = match dest.extension() {
        Some(ext) => format!("{stem}.mcs-tmp.{token}.{}", ext.to_string_lossy()),
        None => format!("{stem}.mcs-tmp.{token}"),
    };
    dest.with_file_name(name)
}

/// Removes the temporary file on every early return (ffmpeg / tag / rename failure) unless disarmed.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Whether the .lrc at `path` was made by this app (LRC_MARKER). An unreadable file counts as foreign.
fn is_own_lrc(path: &Path) -> bool {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).contains(LRC_MARKER)).unwrap_or(false)
}

/// An existing `<dest>.lrc` when this export writes none. One made by this app (LRC_MARKER) is deleted when
/// this export replaced an earlier file of the same name (`dest_existed`), so players do not show the old
/// timing next to the new audio; a sibling export with another extension (`song.flac` next to `song.mp3`)
/// keeps its sidecar. A foreign .lrc is never deleted, only reported.
fn handle_stale_lrc(lrc: &Path, dest_existed: bool, warnings: &mut Vec<String>) {
    if !lrc.is_file() {
        return;
    }
    let own = is_own_lrc(lrc);
    if own && dest_existed {
        match std::fs::remove_file(lrc) {
            Ok(()) => warnings.push(format!("以前の書き出しで作成された古い .lrc（{}）を削除しました（今回は同期歌詞なしで書き出したため）", lrc.display())),
            Err(e) => warnings.push(format!("以前の書き出しで作成された古い .lrc（{}）を削除できませんでした（{e}）。今回の書き出しとは時刻が合いません", lrc.display())),
        }
    } else {
        warnings.push(format!("同名の .lrc（{}）が残っています。今回の書き出しとは時刻が合わない可能性があります", lrc.display()));
    }
}

/// Read the cover image once. A missing or unreadable file is a warning, not an export error: the audio and
/// the other tags are still written.
fn load_cover(req: &ExportRequest, warnings: &mut Vec<String>) -> Option<Picture> {
    let img = req.cover_image.as_deref().filter(|p| !p.trim().is_empty())?;
    match std::fs::read(img) {
        Ok(bytes) => {
            let mime = match Path::new(img).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
                Some("png") => MimeType::Png,
                _ => MimeType::Jpeg,
            };
            // An explicit empty description: with `None` lofty writes a single 0x00, which in the UTF-16 APIC
            // frame of ID3v2.3 is no terminator (see sylt_frame_bytes). FLAC/OGG store a length of 0 either way.
            Some(Picture::new_unchecked(PictureType::CoverFront, Some(mime), Some(String::new()), bytes))
        }
        Err(e) => {
            warnings.push(format!("ジャケット画像を読み込めなかったため、画像なしで書き出しました（{img}: {e}）"));
            None
        }
    }
}

fn is_wav(format: &str) -> bool {
    matches!(format, "wav16" | "wav24" | "wav32f")
}

/// The bitrate (kbps) for the lossy encoders: the page's value with a floor of 32, moved into the range the
/// encoder takes for the source's channel count (None = unknown: kept). libvorbis takes at 44.1/48 kHz
/// (output_rate) at most 240 kbps per channel (250 for stereo) and at least 32 per channel, except 22.5 for
/// stereo and 14 for 5.1; libopus takes at most 256 kbps per channel.
fn lossy_kbps(req: &ExportRequest, channels: Option<u32>) -> u32 {
    let kbps = req.bitrate_kbps.max(32);
    let Some(ch) = channels.filter(|&c| c > 0) else { return kbps };
    match req.format.as_str() {
        "ogg" => {
            let least = match ch {
                2 => 45,
                6 => 84,
                c => c.saturating_mul(32),
            };
            kbps.clamp(least, ch.saturating_mul(240))
        }
        "opus" => kbps.min(ch.saturating_mul(256)),
        _ => kbps,
    }
}

/// Sample rate of the exported file: the source's, except for OGG and MP3. libvorbis has bitrate modes only for
/// 40-50 kHz at the bitrates the page offers (none at all above 50 kHz, only low ones below 40 kHz), so OGG
/// is written at 48 kHz unless the source is already in that band. Below 32 kHz LAME writes MPEG-2 / 2.5,
/// which has no rate above 160 kbps (64 below 16 kHz) and would silently write the page's 192-320 at that,
/// so MP3 goes to 48 kHz there (higher rates are converted by ffmpeg itself to one LAME takes).
fn output_rate(format: &str, src_rate: u32) -> u32 {
    match format {
        "ogg" if !(40_000..=50_000).contains(&src_rate) => 48_000,
        "mp3" if src_rate < 32_000 => 48_000,
        _ => src_rate,
    }
}

/// The format's name in the notes below.
fn format_name(format: &str) -> &'static str {
    match format {
        "ogg" => "OGG Vorbis",
        "opus" => "Opus",
        "mp3" => "MP3",
        _ => "この形式",
    }
}

/// Notes for the user where the export differs from the page's settings: the sample rate (output_rate) and
/// the bitrate (lossy_kbps).
fn encoder_notes(req: &ExportRequest, channels: Option<u32>, src_rate: u32, out_rate: u32) -> Vec<String> {
    let mut notes = Vec::new();
    let name = format_name(&req.format);
    if out_rate != src_rate {
        notes.push(format!("{name} で書き出すため、サンプルレートを {src_rate} Hz から {out_rate} Hz に変換しました"));
    }
    let kbps = lossy_kbps(req, channels);
    let asked = req.bitrate_kbps.max(32);
    if let Some(ch) = channels.filter(|_| kbps != asked) {
        let limit = if kbps < asked { "までの" } else { "以上が必要な" };
        notes.push(format!("この音源（{ch} チャンネル）では {name} のビットレートは {kbps} kbps {limit}ため、{kbps} kbps で書き出しました"));
    }
    notes
}

/// A Japanese hint for an ffmpeg failure the user can act on: the encoder refused the bitrate for this
/// source (libvorbis "encoder setup failed", libopus "The bit rate … is unsupported"). lossy_kbps and
/// output_rate avoid both where the source's channel count and rate are known; what is left (a probe failed)
/// can be a bitrate too high or too low, so the hint names no direction.
fn ffmpeg_error_hint(out: &str) -> Option<&'static str> {
    let refused = out.contains("encoder setup failed") || (out.contains("bit rate") && out.contains("unsupported"));
    refused.then_some("この音源のチャンネル数・サンプルレートでは、選んだビットレートで書き出せません。ビットレートを変えるか、別の形式を選んでください")
}

/// Encoder arguments of a format (after the filter chain, before the metadata). `channels` is the source's
/// channel count (None = unknown).
fn codec_args(req: &ExportRequest, channels: Option<u32>) -> Result<Vec<String>> {
    let kbps = lossy_kbps(req, channels);
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    Ok(match req.format.as_str() {
        "wav16" => v(&["-c:a", "pcm_s16le"]),
        "wav24" => v(&["-c:a", "pcm_s24le"]),
        "wav32f" => v(&["-c:a", "pcm_f32le"]),
        "flac" => v(&["-c:a", "flac", "-compression_level", "8"]),
        "mp3" => {
            let mut a = v(&["-c:a", "libmp3lame"]);
            match req.mp3_vbr {
                Some(q) => a.extend(["-q:a".into(), q.min(9).to_string()]),
                None => a.extend(["-b:a".into(), format!("{kbps}k")]),
            }
            a.extend(v(&["-id3v2_version", "3"]));
            a
        }
        "m4a" => v(&["-c:a", "aac", "-b:a", &format!("{kbps}k"), "-movflags", "+faststart"]),
        "ogg" => v(&["-c:a", "libvorbis", "-b:a", &format!("{kbps}k")]),
        "opus" => v(&["-c:a", "libopus", "-b:a", &format!("{kbps}k"), "-vbr", "on"]),
        other => bail!("未対応の形式: {other}"),
    })
}

/// The ffmpeg command line of an export, without the program name. `filter` is the -af chain, `codec` the
/// encoder arguments and `rate` the output sample rate when it differs from the source's.
fn ffmpeg_args(req: &ExportRequest, src: &Path, out: &Path, filter: Option<String>, codec: Vec<String>, rate: Option<u32>) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(), "-i".into(), src.to_string_lossy().to_string()];
    // The first audio stream only, without the source's tags and chapters. An embedded cover is a video stream
    // (Theora in OGG, refused by the M4A muxer, kept ahead of the new cover in MP3/FLAC), and copied tags would
    // keep fields the user cleared, old SYNCEDLYRICS or ComfyUI's `prompt` graph. Cover and tags come from the
    // request only (below and write_tags).
    for a in ["-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1"] {
        args.push(a.into());
    }
    if let Some(chain) = filter {
        args.push("-af".into());
        args.push(chain);
    }
    args.extend(codec);
    if let Some(r) = rate {
        args.push("-ar".into());
        args.push(r.to_string());
    }
    if is_wav(&req.format) {
        // WAV gets no tags: the wav muxer would write -metadata as RIFF INFO, and bitexact drops its encoder tag (ISFT).
        args.push("-fflags".into());
        args.push("+bitexact".into());
    } else {
        // Basic text metadata through ffmpeg too (belt and braces; lofty rewrites below).
        for (k, v) in [("title", &req.title), ("artist", &req.artist), ("album", &req.album), ("date", &req.year), ("genre", &req.genre), ("comment", &req.comment)] {
            if !v.is_empty() {
                args.push("-metadata".into());
                args.push(format!("{k}={v}"));
            }
        }
    }
    args.push(out.to_string_lossy().to_string());
    args
}

/// `dests`: the names being exported to (ExportDests, one set for the whole app).
pub fn run_export(cfg: &AppConfig, req: &ExportRequest, dests: &ExportDests) -> Result<ExportResult> {
    let ffmpeg = cfg.ffmpeg_exe().context("ffmpeg が見つかりません（セットアップで導入してください）")?;
    let src = PathBuf::from(&req.source);
    if !src.is_file() {
        bail!("元ファイルが見つかりません: {}", src.display());
    }
    let dest = PathBuf::from(&req.dest);
    // ffmpeg's own "same as Input" check compares strings only: the same file spelled differently would be
    // truncated while it is being read, and the rename below would replace the source with the export.
    if is_same_file(&src, &dest) {
        bail!("書き出し先が元の音源と同じファイルです。別の名前か場所を指定してください");
    }
    // The channel count bounds the Vorbis / Opus bitrate (lossy_kbps).
    let channels = if matches!(req.format.as_str(), "ogg" | "opus") { probe_channels(cfg, &src) } else { None };
    let codec = codec_args(req, channels)?;
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p)?;
    }
    // Held until the end: no other export to this name runs meanwhile, so what an interrupted one left can go.
    let _claim = dests.claim(&dest)?;
    remove_stale_temps(&dest);
    let dest_existed = dest.exists();
    let duration = probe_duration(cfg, &src);
    // Only loudnorm, OGG and MP3 (output_rate) resample, so only then is the source rate needed.
    let src_rate = if req.loudnorm || matches!(req.format.as_str(), "ogg" | "mp3") { probe_sample_rate(cfg, &src).unwrap_or(FALLBACK_SAMPLE_RATE) } else { FALLBACK_SAMPLE_RATE };
    let out_rate = output_rate(&req.format, src_rate);
    let mut warnings: Vec<String> = encoder_notes(req, channels, src_rate, out_rate);
    // Trim: analyse first and cut with atrim, so the fade-out and the synced lyrics use the same window.
    // If the analysis fails the file is exported untrimmed (never with shifted lyrics).
    let trim = if req.trim_silence {
        match detect_trim_window(&ffmpeg, &src, duration) {
            Ok(w) => {
                if w.is_none() {
                    warnings.push("全体が無音と判定されたため、無音トリムは行いませんでした".into());
                } else if duration.is_none() {
                    // Without the length a silence closed at EOF cannot be told from one in the middle.
                    warnings.push("曲の長さを取得できなかったため、末尾の無音はトリムしませんでした（先頭のみ）".into());
                }
                w.filter(|w| !w.is_noop())
            }
            Err(e) => {
                warnings.push(format!("無音の検出に失敗したため、無音トリムは行いませんでした（{e}）"));
                None
            }
        }
    } else {
        None
    };
    let out_duration = match trim {
        Some(w) => w.output_duration(duration),
        None => duration,
    };
    if req.fade_out_sec > 0.0 && out_duration.is_none() {
        // audio_filter_chain needs the length to place the fade-out.
        warnings.push("曲の長さを取得できなかったため、フェードアウトは適用しませんでした".into());
    }
    let (synced, dropped) = shift_synced(&req.synced, trim, out_duration);
    if dropped > 0 {
        warnings.push(format!("トリム後の曲の長さを超える同期歌詞 {dropped} 行を除外しました"));
    }
    // Tags and the .lrc below use the timeline of the exported (possibly trimmed) file.
    let eff = ExportRequest { synced, ..req.clone() };
    let req = &eff;
    // WAV gets no tags (RIFF INFO support is limited; keep files clean), so its cover is not read either.
    let tags = !is_wav(&req.format);
    let cover = if tags { load_cover(req, &mut warnings) } else { None };

    // Encode into a temporary sibling and replace dest only when everything succeeded: a failed run
    // leaves an earlier export at dest untouched and no partial file behind.
    let mut tmp = TempFile { path: temp_path_for(&dest), keep: false };
    let filter = audio_filter_chain(req, duration, trim, out_rate);
    let args = ffmpeg_args(req, &src, &tmp.path, filter, codec, (out_rate != src_rate).then_some(out_rate));
    let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let t0 = std::time::Instant::now();
    let (ok, out) = crate::setup::run_hidden(&ffmpeg, &argv)?;
    if !ok {
        match ffmpeg_error_hint(&out) {
            Some(hint) => bail!("ffmpeg に失敗しました（{hint}）: {out}"),
            None => bail!("ffmpeg に失敗しました: {out}"),
        }
    }
    let ffmpeg_seconds = t0.elapsed().as_secs_f64();

    if tags {
        write_tags(req, &tmp.path, cover.as_ref()).with_context(|| "タグの書き込みに失敗")?;
    }
    // std::fs::rename replaces an existing file on Windows (MoveFileEx with REPLACE_EXISTING).
    std::fs::rename(&tmp.path, &dest)
        .with_context(|| format!("書き出し先に保存できませんでした（{}。他のアプリで開いていないか確認してください）", dest.display()))?;
    tmp.keep = true;

    // The .lrc belongs to the final name and is written only after the audio is in place.
    let lrc_path = write_lrc_sidecar(req, &dest, dest_existed, &mut warnings)?;
    let bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult { dest: dest.to_string_lossy().to_string(), lrc_path, bytes, ffmpeg_seconds, warnings })
}

/// The .lrc sidecar of `dest`, after the audio is in place: written when this export has synced lines,
/// otherwise a stale one is handled (handle_stale_lrc). Returns the path written.
fn write_lrc_sidecar(req: &ExportRequest, dest: &Path, dest_existed: bool, warnings: &mut Vec<String>) -> Result<Option<String>> {
    if !req.write_lrc {
        return Ok(None);
    }
    let mut lrc = dest.with_extension("lrc");
    // Where this export's .lrc goes when a foreign <stem>.lrc is in the way.
    let alt = dest.with_extension("mcs.lrc");
    if req.synced.is_empty() {
        handle_stale_lrc(&lrc, dest_existed, warnings);
        handle_stale_lrc(&alt, dest_existed, warnings);
        return Ok(None);
    }
    // A foreign .lrc (another editor, hand timing) is never replaced, like in handle_stale_lrc: this export's
    // goes next to it as <stem>.mcs.lrc, and the user decides which one to keep.
    if lrc.exists() && !is_own_lrc(&lrc) {
        if alt.exists() && !is_own_lrc(&alt) {
            warnings.push(format!("同名の .lrc（{} と {}）はこのアプリで作成したものではないため上書きせず、.lrc は出力しませんでした", lrc.display(), alt.display()));
            return Ok(None);
        }
        warnings.push(format!("同名の .lrc（{}）はこのアプリで作成したものではないため上書きせず、今回の .lrc は {} に保存しました", lrc.display(), alt.display()));
        lrc = alt;
    }
    let part = temp_path_for(&lrc);
    std::fs::write(&part, build_lrc(req)).and_then(|_| std::fs::rename(&part, &lrc)).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        anyhow::anyhow!("音声は書き出しましたが、.lrc を保存できませんでした（{}: {e}）", lrc.display())
    })?;
    Ok(Some(lrc.to_string_lossy().to_string()))
}

pub fn build_lrc(req: &ExportRequest) -> String {
    let mut s = String::new();
    if !req.title.is_empty() { s.push_str(&format!("[ti:{}]\n", req.title)); }
    if !req.artist.is_empty() { s.push_str(&format!("[ar:{}]\n", req.artist)); }
    if !req.album.is_empty() { s.push_str(&format!("[al:{}]\n", req.album)); }
    s.push_str(LRC_MARKER);
    s.push('\n');
    for l in &req.synced {
        let total_cs = l.time_ms / 10;
        let m = total_cs / 6000;
        let sec = (total_cs % 6000) / 100;
        let cs = total_cs % 100;
        s.push_str(&format!("[{m:02}:{sec:02}.{cs:02}]{}\n", l.text));
    }
    s
}

fn write_tags(req: &ExportRequest, dest: &Path, picture: Option<&Picture>) -> Result<()> {
    let mut tagged = lofty::read_from_path(dest)?;
    let file_type = tagged.file_type();
    let primary_type = file_type.primary_tag_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(primary_type));
    }
    let lrc_text = build_lrc(req);
    let has_synced = !req.synced.is_empty();
    match primary_type {
        TagType::Id3v2 => {
            // Work on the concrete ID3v2 tag to add SYLT/USLT frames.
            let mut id3: Id3v2Tag = match tagged.primary_tag() {
                Some(t) => Id3v2Tag::from(t.clone()),
                None => Id3v2Tag::default(),
            };
            fill_common(&mut id3, req);
            if let Some(pic) = picture {
                id3.insert_picture(pic.clone());
            }
            let lang: [u8; 3] = lang_code(&req.language);
            if !req.lyrics.is_empty() {
                id3.insert(Frame::UnsynchronizedText(UnsynchronizedTextFrame::new(TextEncoding::UTF8, lang, String::new(), req.lyrics.clone())));
            }
            if has_synced {
                let bytes = sylt_frame_bytes(lang, &req.synced)?;
                id3.insert(Frame::Binary(BinaryFrame::new(FrameId::Valid(std::borrow::Cow::Borrowed("SYLT")), bytes)));
            }
            // ID3v2.3 for the widest player compatibility (Windows Media Player, car stereos). lofty converts the
            // typed frames (USLT, TIT2, ...) to UTF-16 for v2.3, but SYLT is a pre-serialized Binary frame that is
            // written byte for byte, so sylt_frame_bytes encodes it as UTF-16 itself.
            let mut opts = WriteOptions::default();
            let opts = opts.use_id3v23(true);
            id3.save_to_path(dest, opts)?;
            return Ok(());
        }
        TagType::Mp4Ilst => {
            let tag = tagged.primary_tag_mut().unwrap();
            fill_common(tag, req);
            if let Some(pic) = picture {
                tag.push_picture(pic.clone());
            }
            // No synced-lyrics atom exists: store LRC-formatted text in ©lyr when timing is available.
            if has_synced {
                tag.insert_text(ItemKey::Lyrics, lrc_text.clone());
            } else if !req.lyrics.is_empty() {
                tag.insert_text(ItemKey::Lyrics, req.lyrics.clone());
            }
        }
        TagType::VorbisComments => {
            let tag = tagged.primary_tag_mut().unwrap();
            fill_common(tag, req);
            if let Some(pic) = picture {
                tag.push_picture(pic.clone());
            }
            // insert_text drops an ItemKey::Unknown (no mapping to check): those go in unchecked (the Vorbis key is
            // still verified when written).
            let unknown = |key: &str, text: &str| TagItem::new(ItemKey::Unknown(key.into()), ItemValue::Text(text.into()));
            if !req.lyrics.is_empty() {
                tag.insert_text(ItemKey::Lyrics, req.lyrics.clone());
                tag.insert_unchecked(unknown("UNSYNCEDLYRICS", &req.lyrics));
            }
            if has_synced {
                // Mp3tag / Picard conventions: LYRICS (LRC text) and SYNCEDLYRICS.
                tag.insert_text(ItemKey::Lyrics, lrc_text.clone());
                tag.insert_unchecked(unknown("SYNCEDLYRICS", &lrc_text));
            }
        }
        _ => {
            let tag = tagged.primary_tag_mut().unwrap();
            fill_common(tag, req);
        }
    }
    tagged.save_to_path(dest, WriteOptions::default())?;
    Ok(())
}

/// SYLT body (without the frame header) as UTF-16 with BOM: encoding byte 0x01, valid in ID3v2.3 (UCS-2)
/// and v2.4. The description is an explicit empty string because with `None` lofty writes a single 0x00
/// terminator, which is not a valid UTF-16 terminator.
fn sylt_frame_bytes(lang: [u8; 3], synced: &[LyricLine]) -> Result<Vec<u8>> {
    let content: Vec<(u32, String)> = synced.iter().map(|l| (l.time_ms.min(u32::MAX as u64) as u32, l.text.clone())).collect();
    let sylt = SynchronizedTextFrame::new(TextEncoding::UTF16, lang, TimestampFormat::MS, SyncTextContentType::Lyrics, Some(String::new()), content);
    sylt.as_bytes().context("SYLT frame")
}

fn fill_common<T: Accessor + TagExt>(tag: &mut T, req: &ExportRequest) {
    if !req.title.is_empty() { tag.set_title(req.title.clone()); }
    if !req.artist.is_empty() { tag.set_artist(req.artist.clone()); }
    if !req.album.is_empty() { tag.set_album(req.album.clone()); }
    if !req.genre.is_empty() { tag.set_genre(req.genre.clone()); }
    if !req.comment.is_empty() { tag.set_comment(req.comment.clone()); }
    if let Ok(y) = req.year.trim().parse::<u32>() { tag.set_year(y); }
}

fn lang_code(s: &str) -> [u8; 3] {
    let b = s.as_bytes();
    if b.len() == 3 && b.iter().all(|c| c.is_ascii_alphabetic()) { [b[0], b[1], b[2]] } else { *b"jpn" }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A FLAC with only its STREAMINFO and a PADDING block (48 kHz stereo 16-bit, no frames), as ffmpeg writes the
    /// metadata: enough for lofty to read and tag, so the Vorbis-comment branch of write_tags is tested without
    /// ffmpeg (test_cfg needs the app's own ffmpeg).
    fn bare_flac(path: &Path) {
        let mut b = b"fLaC".to_vec();
        b.extend_from_slice(&[0x00, 0x00, 0x00, 34]); // STREAMINFO, 34 bytes
        b.extend_from_slice(&[0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0]); // block sizes 4096, frame sizes unknown
        let packed: u64 = (48_000u64 << 44) | (1 << 41) | (15 << 36); // rate, channels - 1, bits - 1, 0 samples
        b.extend_from_slice(&packed.to_be_bytes());
        b.extend_from_slice(&[0u8; 16]); // MD5 unknown
        b.extend_from_slice(&[0x81, 0x00, 0x00, 16]); // last metadata block, PADDING, 16 bytes
        b.extend_from_slice(&[0u8; 16]);
        std::fs::write(path, b).unwrap();
    }

    /// FLAC / OGG / Opus take LYRICS plus the Mp3tag / Picard keys UNSYNCEDLYRICS and SYNCEDLYRICS. lofty's insert_text
    /// drops an ItemKey::Unknown it cannot map (it returned false), so those two were never written.
    #[test]
    fn vorbis_comments_carry_synced_and_unsynced_lyrics() {
        let dir = test_dir("vorbis_lyrics");
        let synced = vec![LyricLine { time_ms: 1_000, text: "あ".into() }, LyricLine { time_ms: 2_500, text: "い".into() }];
        for (name, lines) in [("synced", synced), ("plain", Vec::new())] {
            let dest = dir.join(format!("{name}.flac"));
            bare_flac(&dest);
            let req = ExportRequest { title: "T".into(), lyrics: "あ\nい".into(), synced: lines.clone(), ..Default::default() };
            write_tags(&req, &dest, None).unwrap();
            let tagged = lofty::read_from_path(&dest).unwrap();
            let tag = tagged.tag(TagType::VorbisComments).expect("Vorbis comments");
            let text = |k: &str| {
                tag.items().find(|i| matches!(i.key(), ItemKey::Unknown(u) if u.eq_ignore_ascii_case(k))).and_then(|i| i.value().text()).map(str::to_owned)
            };
            assert_eq!(text("UNSYNCEDLYRICS").as_deref(), Some("あ\nい"), "{name}");
            if lines.is_empty() {
                assert_eq!(tag.get_string(&ItemKey::Lyrics), Some("あ\nい"));
                assert_eq!(text("SYNCEDLYRICS"), None);
            } else {
                let lrc = build_lrc(&req);
                assert_eq!(tag.get_string(&ItemKey::Lyrics), Some(lrc.as_str()));
                assert_eq!(text("SYNCEDLYRICS").as_deref(), Some(lrc.as_str()));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lrc_formatting() {
        let req = ExportRequest { title: "T".into(), synced: vec![LyricLine { time_ms: 0, text: "a".into() }, LyricLine { time_ms: 61_230, text: "b".into() }], ..Default::default() };
        let lrc = build_lrc(&req);
        assert!(lrc.contains("[ti:T]"));
        assert!(lrc.contains("[00:00.00]a"));
        assert!(lrc.contains("[01:01.23]b"));
    }

    fn line(ms: u64, t: &str) -> LyricLine {
        LyricLine { time_ms: ms, text: t.into() }
    }

    #[test]
    fn silence_parse_leading_and_trailing() {
        // Real ffmpeg n9 output for 2 s silence + 4 s tone + 2 s silence (trailing silence closed at EOF).
        let log = "[Parsed_silencedetect_0 @ 0000] silence_start: 0\n\
                   [Parsed_silencedetect_0 @ 0000] silence_end: 2.000042 | silence_duration: 2.000042\n\
                   [Parsed_silencedetect_0 @ 0000] silence_start: 6\n\
                   [Parsed_silencedetect_0 @ 0000] silence_end: 8 | silence_duration: 2\n";
        let w = parse_silence(log, Some(8.0)).unwrap();
        assert_eq!(w, TrimWindow { start_ms: 1800, end_ms: Some(6200) });
        assert!((w.output_duration(Some(8.0)).unwrap() - 4.4).abs() < 1e-9);
        // Trailing silence without a closing silence_end, and no duration known.
        let log2 = "silence_start: 0\nsilence_end: 0.5 | silence_duration: 0.5\nsilence_start: 3.25\n";
        assert_eq!(parse_silence(log2, None).unwrap(), TrimWindow { start_ms: 300, end_ms: Some(3450) });
    }

    #[test]
    fn silence_parse_ignores_inner_gaps_and_short_lead() {
        // First silence does not start at 0 and the last one ends before EOF: nothing to trim.
        let log = "silence_start: 12.5\nsilence_end: 13.0 | silence_duration: 0.5\n";
        assert_eq!(parse_silence(log, Some(60.0)).unwrap(), TrimWindow { start_ms: 0, end_ms: None });
        assert!(parse_silence(log, Some(60.0)).unwrap().is_noop());
        // Leading silence shorter than the pad keeps the start at 0; an inner gap is not trailing silence.
        let log2 = "silence_start: 0\nsilence_end: 0.15 | silence_duration: 0.15\nsilence_start: 30\nsilence_end: 31 | silence_duration: 1\n";
        assert_eq!(parse_silence(log2, Some(60.0)).unwrap(), TrimWindow { start_ms: 0, end_ms: None });
        // No silence at all.
        assert!(parse_silence("", Some(10.0)).unwrap().is_noop());
        // Whole file silent.
        assert_eq!(parse_silence("silence_start: 0\nsilence_end: 10 | silence_duration: 10\n", Some(10.0)), None);
        assert_eq!(parse_silence("silence_start: 0\n", None), None);
    }

    #[test]
    fn filter_chain_trim_fade_and_rate() {
        let req = ExportRequest { trim_silence: true, loudnorm: true, fade_in_sec: 1.0, fade_out_sec: 2.0, ..Default::default() };
        let w = TrimWindow { start_ms: 1800, end_ms: Some(6200) };
        let chain = audio_filter_chain(&req, Some(8.0), Some(w), 44_100).unwrap();
        assert_eq!(
            chain,
            "atrim=start=1.800:end=6.200,asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.0:LRA=11,aresample=44100,afade=t=in:st=0:d=1,afade=t=out:st=2.400:d=2"
        );
        // Without trim the fade-out uses the source duration; no aresample without loudnorm.
        let plain = ExportRequest { fade_out_sec: 2.0, ..Default::default() };
        assert_eq!(audio_filter_chain(&plain, Some(8.0), None, 48_000).unwrap(), "afade=t=out:st=6.000:d=2");
        assert_eq!(audio_filter_chain(&ExportRequest::default(), Some(8.0), None, 48_000), None);
        // Open-ended trim (leading silence only).
        let lead = TrimWindow { start_ms: 300, end_ms: None };
        assert_eq!(audio_filter_chain(&plain, Some(8.0), Some(lead), 48_000).unwrap(), "atrim=start=0.300,asetpts=PTS-STARTPTS,afade=t=out:st=5.700:d=2");
    }

    #[test]
    fn filter_chain_hard_clip_only_without_loudnorm() {
        let clip = ExportRequest { hard_clip: true, ..Default::default() };
        assert_eq!(audio_filter_chain(&clip, Some(8.0), None, 48_000).unwrap(), "asoftclip=type=hard:threshold=1");
        let both = ExportRequest { hard_clip: true, loudnorm: true, ..Default::default() };
        assert!(!audio_filter_chain(&both, Some(8.0), None, 48_000).unwrap().contains("asoftclip"));
    }

    #[test]
    fn synced_shift_and_drop() {
        let lines = vec![line(1000, "a"), line(2500, "b"), line(6000, "c"), line(7900, "d")];
        let w = TrimWindow { start_ms: 1800, end_ms: Some(6200) };
        let (out, dropped) = shift_synced(&lines, Some(w), w.output_duration(Some(8.0)));
        assert_eq!(out.iter().map(|l| (l.time_ms, l.text.as_str())).collect::<Vec<_>>(), vec![(0, "a"), (700, "b"), (4200, "c")]);
        assert_eq!(dropped, 1);
        let (same, none) = shift_synced(&lines, None, Some(8.0));
        assert_eq!(same.len(), 4);
        assert_eq!(none, 0);
    }

    #[test]
    fn rate_from_ffmpeg_info() {
        let out = "  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 44100 Hz, stereo, flt, 2822 kb/s\n";
        assert_eq!(parse_rate_from_ffmpeg_info(out), Some(44_100));
        assert_eq!(parse_rate_from_ffmpeg_info("no audio"), None);
    }

    #[test]
    fn sylt_is_utf16_and_round_trips() {
        let lines = vec![line(0, "こんにちは"), line(4_250, "世界 world"), line(61_230, "end")];
        let bytes = sylt_frame_bytes(*b"jpn", &lines).unwrap();
        assert_eq!(bytes[0], 0x01, "encoding byte must be UTF-16 (valid in ID3v2.3)");
        let parsed = SynchronizedTextFrame::parse(&bytes, lofty::id3::v2::FrameFlags::default()).unwrap();
        assert_eq!(parsed.encoding, TextEncoding::UTF16);
        assert_eq!(&parsed.language, b"jpn");
        let want: Vec<(u32, String)> = lines.iter().map(|l| (l.time_ms as u32, l.text.clone())).collect();
        assert_eq!(parsed.content, want);
    }

    #[test]
    fn probe_output_parsing() {
        // ffprobe's stdout only (stderr with "CRC mismatch!" etc. is no longer mixed in); first number wins.
        assert_eq!(parse_probe_number("6.945125\n"), Some(6.945125));
        assert_eq!(parse_probe_number("\n  10.02  \n[mov @ x] Sample size 1920894129 is too large\n"), Some(10.02));
        assert_eq!(parse_probe_number("N/A\n"), None);
        assert_eq!(parse_probe_number("0\n"), None);
        assert_eq!(parse_probe_number(""), None);
        let info = "Input #0, wav, from 'x.wav':\n  Duration: 00:03:05.12, bitrate: 3072 kb/s\n  Stream #0:0: Audio: pcm_f32le, 48000 Hz\n";
        assert!((parse_duration_from_ffmpeg_info(info).unwrap() - 185.12).abs() < 1e-9);
        assert_eq!(parse_duration_from_ffmpeg_info("  Duration: N/A, bitrate: N/A\n"), None);
        assert_eq!(parse_duration_from_ffmpeg_info("nothing"), None);
    }

    #[test]
    fn mp3_rate_control_args() {
        let cbr = codec_args(&ExportRequest { format: "mp3".into(), bitrate_kbps: 256, ..Default::default() }, None).unwrap();
        assert_eq!(cbr, ["-c:a", "libmp3lame", "-b:a", "256k", "-id3v2_version", "3"]);
        // Some(0) is VBR at the best quality, not CBR; values above 9 are clamped.
        let best = codec_args(&ExportRequest { format: "mp3".into(), mp3_vbr: Some(0), ..Default::default() }, None).unwrap();
        assert_eq!(best, ["-c:a", "libmp3lame", "-q:a", "0", "-id3v2_version", "3"]);
        let small = codec_args(&ExportRequest { format: "mp3".into(), mp3_vbr: Some(12), ..Default::default() }, None).unwrap();
        assert!(small.windows(2).any(|w| w == ["-q:a", "9"]), "{small:?}");
        // The bitrate floor for the lossy formats, and an unknown format is an error.
        let low = codec_args(&ExportRequest { format: "ogg".into(), bitrate_kbps: 8, ..Default::default() }, None).unwrap();
        assert_eq!(low, ["-c:a", "libvorbis", "-b:a", "32k"]);
        assert!(codec_args(&ExportRequest { format: "aiff".into(), ..Default::default() }, None).is_err());
    }

    /// The export's ffmpeg command line for `req` (no filter chain).
    fn args_for(req: &ExportRequest, rate: Option<u32>) -> Vec<String> {
        let codec = codec_args(req, None).unwrap();
        ffmpeg_args(req, Path::new("C:/in/src.flac"), Path::new("C:/out/x.mcs-tmp.ext"), None, codec, rate)
    }

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn ffmpeg_args_take_only_the_audio_and_no_source_tags() {
        // A source's embedded cover is a video stream (Theora in OGG, refused by the M4A muxer, an old cover in
        // MP3/FLAC), and its tags (cleared fields, old SYNCEDLYRICS, ComfyUI's `prompt`) would be copied.
        for fmt in ["wav16", "wav24", "wav32f", "flac", "mp3", "m4a", "ogg", "opus"] {
            let args = args_for(&ExportRequest { format: fmt.into(), ..Default::default() }, None);
            let input = args.iter().position(|a| a == "-i").unwrap();
            let map = args.windows(2).position(|w| w[0] == "-map" && w[1] == "0:a:0").unwrap_or_else(|| panic!("{fmt}: {args:?}"));
            assert!(map > input, "{fmt}: -map must be an output option: {args:?}");
            assert!(has_pair(&args, "-map_metadata", "-1"), "{fmt}: {args:?}");
            assert!(has_pair(&args, "-map_chapters", "-1"), "{fmt}: {args:?}");
            assert_eq!(args.last().map(|s| s.as_str()), Some("C:/out/x.mcs-tmp.ext"));
        }
    }

    #[test]
    fn wav_args_carry_no_tags() {
        // The page's defaults fill the year and the comment; WAV must still get no RIFF INFO (nor ISFT).
        let meta = ExportRequest { title: "テスト".into(), artist: "Me".into(), year: "2026".into(), comment: "Generated with YuE2 / Music Creator Studio YuE2".into(), ..Default::default() };
        for fmt in ["wav16", "wav24", "wav32f"] {
            let args = args_for(&ExportRequest { format: fmt.into(), ..meta.clone() }, None);
            assert!(!args.iter().any(|a| a == "-metadata"), "{fmt}: {args:?}");
            assert!(has_pair(&args, "-fflags", "+bitexact"), "{fmt}: {args:?}");
        }
        // The tagged formats still get the text fields through ffmpeg as well.
        let mp3 = args_for(&ExportRequest { format: "mp3".into(), ..meta.clone() }, None);
        assert!(has_pair(&mp3, "-metadata", "title=テスト") && has_pair(&mp3, "-metadata", "date=2026"), "{mp3:?}");
        assert!(!mp3.iter().any(|a| a == "-fflags"), "{mp3:?}");
    }

    #[test]
    fn ogg_rate_and_lossy_bitrate_caps() {
        // libvorbis has bitrate modes only for 40-50 kHz: other rates go to 48 kHz, for OGG only.
        assert_eq!(output_rate("ogg", 96_000), 48_000);
        assert_eq!(output_rate("ogg", 88_200), 48_000);
        assert_eq!(output_rate("ogg", 22_050), 48_000);
        assert_eq!(output_rate("ogg", 44_100), 44_100);
        assert_eq!(output_rate("ogg", 48_000), 48_000);
        for fmt in ["wav24", "flac", "mp3", "m4a", "opus"] {
            assert_eq!(output_rate(fmt, 96_000), 96_000, "{fmt}");
        }
        // Mono: Vorbis takes at most 240 kbps per channel, Opus 256.
        let ogg = ExportRequest { format: "ogg".into(), bitrate_kbps: 320, ..Default::default() };
        let opus = ExportRequest { format: "opus".into(), bitrate_kbps: 320, ..Default::default() };
        assert_eq!(codec_args(&ogg, Some(1)).unwrap(), ["-c:a", "libvorbis", "-b:a", "240k"]);
        assert_eq!(codec_args(&opus, Some(1)).unwrap(), ["-c:a", "libopus", "-b:a", "256k", "-vbr", "on"]);
        // Stereo, more channels and an unknown count keep the page's value; so do the other lossy formats.
        for ch in [Some(2), Some(6), Some(8), None] {
            assert!(has_pair(&codec_args(&ogg, ch).unwrap(), "-b:a", "320k"), "{ch:?}");
            assert!(has_pair(&codec_args(&opus, ch).unwrap(), "-b:a", "320k"), "{ch:?}");
        }
        for fmt in ["mp3", "m4a"] {
            assert!(has_pair(&codec_args(&ExportRequest { format: fmt.into(), bitrate_kbps: 320, ..Default::default() }, Some(1)).unwrap(), "-b:a", "320k"), "{fmt}");
        }
        // A changed output rate reaches ffmpeg as -ar; with loudnorm the aresample goes to it as well.
        assert!(has_pair(&args_for(&ogg, Some(48_000)), "-ar", "48000"));
        assert!(!args_for(&ogg, None).iter().any(|a| a == "-ar"));
        let ln = ExportRequest { loudnorm: true, ..ogg.clone() };
        assert!(audio_filter_chain(&ln, Some(8.0), None, output_rate("ogg", 96_000)).unwrap().ends_with("aresample=48000"));
    }

    #[test]
    fn vorbis_bitrate_is_raised_to_what_multichannel_sources_need() {
        // libvorbis (44.1/48 kHz) needs at least 14 kbps per channel for 5.1 and 32 for 3, 4, 5, 7 and 8 channels;
        // below that "encoder setup failed" (5.1 at 64/80, quad up to 112, 7.1 up to 240 with the page's slider).
        let ogg = |kbps: u32| ExportRequest { format: "ogg".into(), bitrate_kbps: kbps, ..Default::default() };
        for (ch, asked, sent) in [(6, 64, 84), (6, 80, 84), (6, 96, 96), (3, 64, 96), (3, 80, 96), (4, 112, 128), (5, 64, 160), (7, 64, 224), (8, 240, 256), (8, 256, 256)] {
            assert!(has_pair(&codec_args(&ogg(asked), Some(ch)).unwrap(), "-b:a", &format!("{sent}k")), "{ch} ch at {asked}");
        }
        // Stereo (45) and mono (32) are below the slider's 64 already; an unknown count keeps the page's value.
        for ch in [Some(1), Some(2), None] {
            assert!(has_pair(&codec_args(&ogg(64), ch).unwrap(), "-b:a", "64k"), "{ch:?}");
        }
        // Opus and the other lossy formats take a low multichannel bitrate as it is.
        for fmt in ["opus", "m4a", "mp3"] {
            let req = ExportRequest { format: fmt.into(), bitrate_kbps: 64, ..Default::default() };
            assert!(has_pair(&codec_args(&req, Some(6)).unwrap(), "-b:a", "64k"), "{fmt}");
        }
    }

    #[test]
    fn changed_rates_and_bitrates_are_noted() {
        let req = |fmt: &str, kbps: u32| ExportRequest { format: fmt.into(), bitrate_kbps: kbps, ..Default::default() };
        // Raised for a multichannel Vorbis source, lowered for a mono one: the note says which.
        assert_eq!(encoder_notes(&req("ogg", 64), Some(6), 48_000, 48_000), ["この音源（6 チャンネル）では OGG Vorbis のビットレートは 84 kbps 以上が必要なため、84 kbps で書き出しました"]);
        assert_eq!(encoder_notes(&req("ogg", 320), Some(1), 48_000, 48_000), ["この音源（1 チャンネル）では OGG Vorbis のビットレートは 240 kbps までのため、240 kbps で書き出しました"]);
        assert_eq!(encoder_notes(&req("opus", 320), Some(1), 48_000, 48_000), ["この音源（1 チャンネル）では Opus のビットレートは 256 kbps までのため、256 kbps で書き出しました"]);
        // A converted sample rate, for OGG and for MP3.
        assert_eq!(encoder_notes(&req("ogg", 320), Some(2), 96_000, 48_000), ["OGG Vorbis で書き出すため、サンプルレートを 96000 Hz から 48000 Hz に変換しました"]);
        assert_eq!(encoder_notes(&req("mp3", 320), None, 22_050, 48_000), ["MP3 で書き出すため、サンプルレートを 22050 Hz から 48000 Hz に変換しました"]);
        // Nothing changed, an unknown channel count, or the page's value below the global floor of 32: no note.
        assert!(encoder_notes(&req("ogg", 320), Some(2), 48_000, 48_000).is_empty());
        assert!(encoder_notes(&req("ogg", 64), None, 48_000, 48_000).is_empty());
        assert!(encoder_notes(&req("ogg", 8), Some(1), 48_000, 48_000).is_empty());
        assert!(encoder_notes(&req("mp3", 320), None, 44_100, 44_100).is_empty());
    }

    #[test]
    fn mp3_is_written_at_mpeg1_rates() {
        // Below 32 kHz LAME writes MPEG-2 / 2.5, which has no rate above 160 (64 below 16 kHz): the 192-320 the page
        // shows would silently be 160. Such sources go to 48 kHz like OGG's; the MPEG-1 rates stay as they are.
        for rate in [8_000, 11_025, 12_000, 16_000, 22_050, 24_000] {
            assert_eq!(output_rate("mp3", rate), 48_000, "{rate}");
        }
        for rate in [32_000, 44_100, 48_000] {
            assert_eq!(output_rate("mp3", rate), rate);
        }
        // Low rates are left alone for the formats that take them.
        for fmt in ["wav16", "flac", "m4a", "opus"] {
            assert_eq!(output_rate(fmt, 22_050), 22_050, "{fmt}");
        }
    }

    #[test]
    fn encoder_errors_get_a_japanese_hint() {
        let vorbis = "[libvorbis @ 0000] encoder setup failed\n[aost#0:0/libvorbis @ 0000] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\n";
        let opus = "[libopus @ 0000] The bit rate 320000 bps is unsupported. Please choose a value between 500 and 256000.\n";
        assert!(ffmpeg_error_hint(vorbis).is_some_and(|h| h.contains("ビットレート")), "{:?}", ffmpeg_error_hint(vorbis));
        // What is left after lossy_kbps is an unknown channel count or sample rate: too high or too low, so the
        // hint names no direction (lowering never helps a multichannel source, which needs more).
        assert!(ffmpeg_error_hint(vorbis).is_some_and(|h| !h.contains("下げ") && !h.contains("上げ")), "{:?}", ffmpeg_error_hint(vorbis));
        assert!(ffmpeg_error_hint(opus).is_some());
        assert_eq!(ffmpeg_error_hint("C:/x.wav: Invalid data found when processing input\n"), None);
        // Other encoders failing to open are not about the bitrate.
        assert_eq!(ffmpeg_error_hint("[aost#0:0/flac @ 0000] [enc:flac @ 0000] Error while opening encoder\n"), None);
    }

    #[test]
    fn channels_from_ffmpeg_info() {
        assert_eq!(parse_channels_from_ffmpeg_info("  Stream #0:0: Audio: flac, 96000 Hz, mono, s16\n"), Some(1));
        assert_eq!(parse_channels_from_ffmpeg_info("  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 44100 Hz, stereo, flt, 2822 kb/s\n"), Some(2));
        assert_eq!(parse_channels_from_ffmpeg_info("  Stream #0:0: Audio: pcm_s16le, 48000 Hz, 3 channels, s16, 2304 kb/s\n"), Some(3));
        assert_eq!(parse_channels_from_ffmpeg_info("  Stream #0:0: Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s\n"), None);
        assert_eq!(parse_channels_from_ffmpeg_info("no audio"), None);
    }

    #[test]
    fn synced_lrc_never_replaces_a_foreign_lrc() {
        let dir = test_dir("foreignlrc");
        let dest = dir.join("MySong.flac");
        let lrc = dir.join("MySong.lrc");
        let alt = dir.join("MySong.mcs.lrc");
        let read = |p: &Path| std::fs::read_to_string(p).unwrap();
        let first = ExportRequest { synced: vec![line(1_000, "new")], ..Default::default() };
        let second = ExportRequest { synced: vec![line(2_000, "newer")], ..Default::default() };
        // No .lrc yet: written under the audio's name; our own one is replaced by the next export.
        let mut w = Vec::new();
        assert_eq!(write_lrc_sidecar(&first, &dest, false, &mut w).unwrap(), Some(lrc.to_string_lossy().into()));
        write_lrc_sidecar(&second, &dest, true, &mut w).unwrap();
        assert!(read(&lrc).contains("[00:02.00]newer"));
        assert!(w.is_empty(), "{w:?}");
        // A hand-made .lrc stays as it is; this export's goes next to it as <stem>.mcs.lrc, with a note.
        let hand = "[00:01.00]my own lyrics\n";
        std::fs::write(&lrc, hand).unwrap();
        let mut w = Vec::new();
        assert_eq!(write_lrc_sidecar(&first, &dest, false, &mut w).unwrap(), Some(alt.to_string_lossy().into()));
        assert_eq!(read(&lrc), hand);
        assert!(read(&alt).contains("[00:01.00]new"));
        assert!(w.len() == 1 && w[0].contains("上書きせず"), "{w:?}");
        // The next export replaces our <stem>.mcs.lrc and still keeps the hand-made one.
        let mut w = Vec::new();
        write_lrc_sidecar(&second, &dest, true, &mut w).unwrap();
        assert_eq!(read(&lrc), hand);
        assert!(read(&alt).contains("[00:02.00]newer"));
        // Without synced lines our stale <stem>.mcs.lrc goes as well; the hand-made one is only reported.
        let mut w = Vec::new();
        assert_eq!(write_lrc_sidecar(&ExportRequest::default(), &dest, true, &mut w).unwrap(), None);
        assert!(!alt.exists());
        assert_eq!(read(&lrc), hand);
        assert!(w.iter().any(|m| m.contains("残っています")) && w.iter().any(|m| m.contains("削除しました")), "{w:?}");
        // A foreign file under the other name too: no .lrc at all, both files untouched.
        std::fs::write(&alt, hand).unwrap();
        let mut w = Vec::new();
        assert_eq!(write_lrc_sidecar(&first, &dest, true, &mut w).unwrap(), None);
        assert_eq!(read(&lrc), hand);
        assert_eq!(read(&alt), hand);
        assert!(w.len() == 1 && w[0].contains("出力しませんでした"), "{w:?}");
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_file_and_temp_names() {
        let dir = test_dir("samefile");
        let src = dir.join("song.wav");
        std::fs::write(&src, b"x").unwrap();
        assert!(is_same_file(&src, &src));
        // Another spelling of the same file: letter case and forward slashes (Windows paths are case-insensitive).
        let upper = PathBuf::from(src.to_string_lossy().replace("song.wav", "SONG.WAV").replace('\\', "/"));
        assert!(is_same_file(&src, &upper), "{}", upper.display());
        assert!(!is_same_file(&src, &dir.join("other.wav")), "a dest that does not exist is never the source");
        std::fs::write(dir.join("other.wav"), b"x").unwrap();
        assert!(!is_same_file(&src, &dir.join("other.wav")));
        // <stem>.mcs-tmp.<8 hex>.<ext>: the real extension stays last (ffmpeg's muxer, lofty's tag format).
        for (name, stem, ext) in [("曲 1.mp3", "曲 1", ".mp3"), ("a.b.flac", "a.b", ".flac"), ("song.lrc", "song", ".lrc"), ("noext", "noext", "")] {
            let p = temp_path_for(&dir.join(name));
            assert_eq!(p.parent(), Some(dir.as_path()), "{}", p.display());
            let file = p.file_name().unwrap().to_string_lossy().into_owned();
            let token = file.strip_prefix(&format!("{stem}.mcs-tmp.")).and_then(|r| r.strip_suffix(ext)).unwrap_or_else(|| panic!("{file}"));
            assert!(token.len() == 8 && token.chars().all(|c| c.is_ascii_hexdigit()), "{file}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_exports_to_one_dest_never_share_a_temp_file() {
        // Each run writes (ffmpeg -y) into a file of its own; a second export to a name in flight is refused besides
        // (a_second_export_to_one_name_is_refused_while_the_first_runs).
        let dest = Path::new("D:/Out/Song.flac");
        let names: std::collections::HashSet<PathBuf> = (0..50).map(|_| temp_path_for(dest)).collect();
        assert_eq!(names.len(), 50);
        let lrc = Path::new("D:/Out/Song.lrc");
        assert_ne!(temp_path_for(lrc), temp_path_for(lrc));
    }

    /// After a page reload the export the old page started runs on, unseen. A new export to the same name would
    /// replace dest after it (the last run to finish wins, after the page showed the other's result) or delete its
    /// .lrc, so it is refused until the first one ends.
    #[test]
    fn a_second_export_to_one_name_is_refused_while_the_first_runs() {
        let dir = test_dir("claim");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let dests = ExportDests::default();
        let first = dests.claim(&dir.join("Song.flac")).unwrap();
        // The same file spelled another way, or the same name with another extension (it shares Song.lrc), or the name
        // whose own .lrc is Song.mcs.lrc, where Song.flac's goes beside a foreign Song.lrc.
        for other in ["Song.flac", "SONG.FLAC", "Song.mp3", "sub/../Song.wav", "Song.mcs.mp3", "song.MCS.flac"] {
            let e = dests.claim(&dir.join(other)).err().unwrap_or_else(|| panic!("{other} is refused")).to_string();
            assert!(e.contains("書き出しがまだ実行中です"), "{e}");
        }
        // Other names and folders are not held, nor what a refused claim would have held (Song.mcs.mcs.lrc).
        let _other = dests.claim(&dir.join("Song 2.flac")).unwrap();
        let _sub = dests.claim(&dir.join("sub").join("Song.flac")).unwrap();
        let mcs2 = dests.claim(&dir.join("Song.mcs.mcs.flac")).unwrap();
        // The name is free again once the first export ends, and both of its .lrc names with it.
        drop(first);
        let again = dests.claim(&dir.join("song.mp3")).unwrap();
        drop((again, mcs2));
        let held = dests.claim(&dir.join("Song.mcs.wav")).unwrap();
        // The other way round: Song.flac would write Song.mcs.lrc, which Song.mcs.wav writes.
        assert!(dests.claim(&dir.join("Song.flac")).is_err());
        drop(held);
        let _free = dests.claim(&dir.join("Song.flac")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A forced quit kills ffmpeg before TempFile removes its file. The next export to that name clears it (and the
    /// .lrc temp files and the fixed temp names of older builds) and touches nothing else.
    #[test]
    fn an_export_clears_the_temp_files_an_interrupted_one_left() {
        let dir = test_dir("staletmp");
        let stale = [
            "Song.mcs-tmp.deadbeef.flac",
            "SONG.MCS-TMP.0123ABCD.FLAC",
            "Song.mcs-tmp.flac",
            "Song.mcs-tmp.0123abcd.lrc",
            "Song.mcs-tmp.lrc",
            "Song.mcs.mcs-tmp.0123abcd.lrc",
            "Song.mcs.mcs-tmp.lrc",
        ];
        let kept = [
            "Song.flac",
            "Song.lrc",
            "Song.mcs.lrc",
            "Song.mcs-tmp.txt",
            "Song.mcs-tmp.deadbeef.mp3",
            "Song.mcs-tmp.deadbee.flac",
            "Song.mcs-tmp.deadbeef0.flac",
            "Song.mcs-tmp.deadbeeg.flac",
            "Song.mcs-tmp.deadbeef.flac.bak",
            "Song 2.mcs-tmp.deadbeef.flac",
            "My Song.mcs-tmp.deadbeef.flac",
            "Song.mcs-tmp..flac",
        ];
        for f in stale.iter().chain(&kept) {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::create_dir(dir.join("Song.mcs-tmp.89abcdef.flac")).unwrap();
        remove_stale_temps(&dir.join("Song.flac"));
        let gone: Vec<&str> = stale.iter().chain(&kept).copied().filter(|f| !dir.join(f).exists()).collect();
        assert_eq!(gone, stale);
        assert!(dir.join("Song.mcs-tmp.89abcdef.flac").is_dir(), "only files are removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_lrc_only_own_file_is_removed() {
        let dir = test_dir("stalelrc");
        let own = dir.join("own.lrc");
        let lrc = build_lrc(&ExportRequest { synced: vec![line(1000, "a")], ..Default::default() });
        assert!(lrc.contains(LRC_MARKER));
        // Our .lrc next to a file this export replaced: deleted.
        std::fs::write(&own, &lrc).unwrap();
        let mut w = Vec::new();
        handle_stale_lrc(&own, true, &mut w);
        assert!(!own.exists());
        assert!(w.len() == 1 && w[0].contains("削除しました"), "{w:?}");
        // Our .lrc, but the audio is new under this name (e.g. song.flac next to song.mp3): kept, reported.
        std::fs::write(&own, &lrc).unwrap();
        let mut w = Vec::new();
        handle_stale_lrc(&own, false, &mut w);
        assert!(own.exists() && w.len() == 1 && w[0].contains("残っています"), "{w:?}");
        // A hand-made .lrc is never deleted.
        let foreign = dir.join("foreign.lrc");
        std::fs::write(&foreign, "[00:01.00]my own lyrics\n").unwrap();
        let mut w = Vec::new();
        handle_stale_lrc(&foreign, true, &mut w);
        assert!(foreign.exists() && w.len() == 1 && w[0].contains("残っています"), "{w:?}");
        // Nothing there: nothing to say.
        let mut w = Vec::new();
        handle_stale_lrc(&dir.join("none.lrc"), true, &mut w);
        assert!(w.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_cover_is_a_warning() {
        let dir = test_dir("cover");
        let mut w = Vec::new();
        let missing = dir.join("gone.png").to_string_lossy().to_string();
        assert!(load_cover(&ExportRequest { cover_image: Some(missing), ..Default::default() }, &mut w).is_none());
        assert!(w.len() == 1 && w[0].contains("ジャケット画像を読み込めなかった"), "{w:?}");
        let mut w = Vec::new();
        assert!(load_cover(&ExportRequest::default(), &mut w).is_none() && w.is_empty());
        let png = dir.join("c.PNG");
        std::fs::write(&png, b"\x89PNG").unwrap();
        let pic = load_cover(&ExportRequest { cover_image: Some(png.to_string_lossy().into()), ..Default::default() }, &mut w).unwrap();
        assert_eq!(pic.mime_type(), Some(&MimeType::Png));
        assert!(w.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mp3_cover_frame_round_trips_in_id3v23() {
        // write_tags inserts the cover as a UTF-8 APIC frame, which ID3v2.3 writes as UTF-16. The description
        // must then be a UTF-16 string: a bare 0x00 makes readers take the PNG header for the description.
        let dir = test_dir("apic");
        let png = dir.join("c.png");
        let img = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10".to_vec();
        std::fs::write(&png, &img).unwrap();
        let pic = load_cover(&ExportRequest { cover_image: Some(png.to_string_lossy().into()), ..Default::default() }, &mut Vec::new()).unwrap();
        let v3 = lofty::id3::v2::Id3v2Version::V3;
        let bytes = lofty::id3::v2::AttachedPictureFrame::new(TextEncoding::UTF8, pic).as_bytes(v3).unwrap();
        assert_eq!(bytes[0], 0x01, "UTF-16 in ID3v2.3");
        let parsed = lofty::id3::v2::AttachedPictureFrame::parse(&mut &bytes[..], lofty::id3::v2::FrameFlags::default(), v3).unwrap();
        assert_eq!(parsed.picture.data(), img.as_slice());
        assert_eq!(parsed.picture.pic_type(), PictureType::CoverFront);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- ffmpeg integration tests ----
    // They run where the bundled ffmpeg is installed (C:/MCSYuE2 or MCS_TEST_DATA_ROOT) and are skipped
    // otherwise, with a "SKIPPED (no ffmpeg under …)" line (shown with -- --nocapture). A missing ffmpeg
    // fails them instead when MCS_REQUIRE_FFMPEG=1 is set or MCS_TEST_DATA_ROOT names a root explicitly.

    fn test_cfg() -> Option<AppConfig> {
        let explicit = std::env::var("MCS_TEST_DATA_ROOT").ok();
        let root = explicit.clone().unwrap_or_else(|| "C:/MCSYuE2".into());
        let cfg = AppConfig { data_root: PathBuf::from(root), ..Default::default() };
        if cfg.ffmpeg_exe().is_none() {
            let required = std::env::var("MCS_REQUIRE_FFMPEG").is_ok_and(|v| v == "1") || explicit.is_some();
            assert!(!required, "ffmpeg not found under {} (MCS_REQUIRE_FFMPEG=1 or MCS_TEST_DATA_ROOT set)", cfg.data_root.display());
            println!("SKIPPED (no ffmpeg under {})", cfg.data_root.display());
            return None;
        }
        Some(cfg)
    }

    fn test_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mcs_export_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ffmpeg_gen(cfg: &AppConfig, args: &[&str]) {
        let ffmpeg = cfg.ffmpeg_exe().unwrap();
        let mut all = vec!["-y", "-hide_banner", "-loglevel", "error"];
        all.extend_from_slice(args);
        let (ok, out) = crate::setup::run_hidden(&ffmpeg, &all).unwrap();
        assert!(ok, "ffmpeg failed: {out}");
    }

    /// 3 s stereo float WAV tone at `rate`.
    fn tone(cfg: &AppConfig, dir: &Path, rate: u32) -> PathBuf {
        let p = dir.join(format!("src_{rate}.wav"));
        let lavfi = format!("sine=f=440:r={rate}:d=3");
        ffmpeg_gen(cfg, &["-f", "lavfi", "-i", &lavfi, "-ac", "2", "-c:a", "pcm_f32le", &p.to_string_lossy()]);
        p
    }

    #[test]
    fn loudnorm_keeps_source_rate_for_every_format() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("loudnorm");
        for rate in [48_000u32, 44_100] {
            let src = tone(&cfg, &dir, rate);
            for fmt in ["wav16", "wav24", "wav32f", "flac", "mp3", "m4a", "ogg", "opus"] {
                let dest = dir.join(format!("out_{rate}_{fmt}.{}", extension_for(fmt)));
                let req = ExportRequest {
                    source: src.to_string_lossy().into(),
                    dest: dest.to_string_lossy().into(),
                    format: fmt.into(),
                    bitrate_kbps: 256,
                    loudnorm: true,
                    ..Default::default()
                };
                let r = run_export(&cfg, &req, &ExportDests::default()).unwrap_or_else(|e| panic!("{fmt} @ {rate}: {e}"));
                assert!(r.bytes > 0, "{fmt} @ {rate}: empty file");
                // Opus only runs at 48 kHz (ffmpeg resamples to it with or without loudnorm).
                let want = if fmt == "opus" { 48_000 } else { rate };
                assert_eq!(probe_sample_rate(&cfg, &dest), Some(want), "{fmt} @ {rate}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_moves_fade_and_lyrics() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("trim");
        let src = dir.join("gap.wav");
        ffmpeg_gen(
            &cfg,
            &[
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
                "-f", "lavfi", "-i", "sine=f=440:r=48000:d=4",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
                "-filter_complex", "[1]aformat=channel_layouts=stereo[s];[0][s][2]concat=n=3:v=0:a=1",
                "-c:a", "pcm_f32le", &src.to_string_lossy(),
            ],
        );
        let dest = dir.join("trimmed.wav");
        let req = ExportRequest {
            source: src.to_string_lossy().into(),
            dest: dest.to_string_lossy().into(),
            format: "wav32f".into(),
            trim_silence: true,
            fade_out_sec: 2.0,
            synced: vec![line(2_500, "a"), line(7_900, "b")],
            ..Default::default()
        };
        let r = run_export(&cfg, &req, &ExportDests::default()).unwrap();
        let d = probe_duration(&cfg, &dest).unwrap();
        assert!((d - 4.4).abs() < 0.02, "trimmed duration {d}");
        // WAV gets a .lrc too; timestamps are on the trimmed timeline and the line past the end is dropped.
        let lrc = std::fs::read_to_string(r.lrc_path.as_ref().expect("lrc for wav")).unwrap();
        assert!(lrc.contains("[00:00.70]a"), "{lrc}");
        assert!(!lrc.contains("]b"), "{lrc}");
        assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
        // The fade-out is applied: near the end of the tone the level is well below the steady tone (-18 dBFS).
        let ffmpeg = cfg.ffmpeg_exe().unwrap();
        let out = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostats", "-ss", "3.9", "-t", "0.2", "-i"])
            .arg(&dest)
            .args(["-af", "volumedetect", "-f", "null", "-"])
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&out.stderr);
        let max_db: f64 = log.lines().find_map(|l| l.split("max_volume:").nth(1)).and_then(|v| v.trim().trim_end_matches("dB").trim().parse().ok()).expect("max_volume");
        assert!(max_db < -28.0, "tail max {max_db} dB: fade-out missing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mp3_sylt_in_id3v23_is_utf16() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("sylt");
        let src = tone(&cfg, &dir, 48_000);
        let dest = dir.join("out.mp3");
        let synced = vec![line(0, "はじまり"), line(1_500, "二行目 line")];
        let req = ExportRequest {
            source: src.to_string_lossy().into(),
            dest: dest.to_string_lossy().into(),
            format: "mp3".into(),
            title: "テスト".into(),
            lyrics: "はじまり\n二行目 line".into(),
            synced: synced.clone(),
            ..Default::default()
        };
        run_export(&cfg, &req, &ExportDests::default()).unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        assert_eq!(&bytes[..3], b"ID3");
        assert_eq!(bytes[3], 3, "ID3v2.3 header");
        let pos = bytes.windows(4).position(|w| w == b"SYLT").expect("SYLT frame");
        let size = u32::from_be_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize; // v2.3: plain size
        let body = &bytes[pos + 10..pos + 10 + size];
        assert_eq!(body[0], 0x01, "SYLT encoding byte");
        let parsed = SynchronizedTextFrame::parse(body, lofty::id3::v2::FrameFlags::default()).unwrap();
        assert_eq!(parsed.content, synced.iter().map(|l| (l.time_ms as u32, l.text.clone())).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".mcs-tmp")).collect()
    }

    #[test]
    fn export_replaces_dest_atomically_and_handles_lrc() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("atomic");
        let src = tone(&cfg, &dir, 48_000);
        let src_bytes = std::fs::read(&src).unwrap();
        let dest = dir.join("song.mp3");
        let dests = ExportDests::default();
        let base = ExportRequest { source: src.to_string_lossy().into(), dest: dest.to_string_lossy().into(), format: "mp3".into(), ..Default::default() };

        // 1) With synced lines: audio + .lrc, the missing cover is one warning, no temp file left.
        let gone = dir.join("gone.jpg").to_string_lossy().to_string();
        let first = ExportRequest { synced: vec![line(0, "a"), line(1_000, "b")], cover_image: Some(gone), ..base.clone() };
        let r = run_export(&cfg, &first, &dests).unwrap();
        assert_eq!(r.lrc_path.as_deref(), Some(dir.join("song.lrc").to_string_lossy().as_ref()));
        assert!(r.warnings.len() == 1 && r.warnings[0].contains("ジャケット画像"), "{:?}", r.warnings);
        assert_eq!(r.bytes, std::fs::metadata(&dest).unwrap().len());
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        let good = std::fs::read(&dest).unwrap();

        // 2) A failed run (the source is not audio) keeps the earlier export and leaves nothing behind.
        let junk = dir.join("junk.wav");
        std::fs::write(&junk, b"not audio").unwrap();
        let bad = ExportRequest { source: junk.to_string_lossy().into(), ..base.clone() };
        assert!(run_export(&cfg, &bad, &dests).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), good, "a failed export must not touch the earlier file");
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));

        // 3) Re-export under the same name without synced lines: our old .lrc goes, with a note.
        let r = run_export(&cfg, &base, &dests).unwrap();
        assert!(r.lrc_path.is_none() && !dir.join("song.lrc").exists());
        assert!(r.warnings.iter().any(|w| w.contains("古い .lrc")), "{:?}", r.warnings);

        // 4) The source itself as dest, spelled differently: refused before ffmpeg runs, source intact.
        let same = ExportRequest { dest: src.to_string_lossy().replace("src_48000.wav", "SRC_48000.WAV"), format: "wav32f".into(), ..base.clone() };
        let e = run_export(&cfg, &same, &dests).unwrap_err().to_string();
        assert!(e.contains("元の音源と同じファイル"), "{e}");
        assert_eq!(std::fs::read(&src).unwrap(), src_bytes);

        // 5) What an interrupted export to this name left (a forced quit kills ffmpeg before its temp file goes) is
        //    cleared by the next one; another file with a similar name stays.
        std::fs::write(dir.join("song.mcs-tmp.deadbeef.mp3"), b"partial").unwrap();
        std::fs::write(dir.join("song.mcs-tmp.txt"), b"mine").unwrap();
        run_export(&cfg, &base, &dests).unwrap();
        assert_eq!(leftovers(&dir), ["song.mcs-tmp.txt"]);

        // 6) While an export to the name runs (one a page reload left running), a new one is refused and touches
        //    nothing, also with another extension (they share song.lrc).
        let good = std::fs::read(&dest).unwrap();
        let held = dests.claim(&dest).unwrap();
        std::fs::write(dir.join("song.mcs-tmp.0123abcd.mp3"), b"in use").unwrap();
        for other in [base.clone(), ExportRequest { dest: dir.join("song.flac").to_string_lossy().into(), format: "flac".into(), ..base.clone() }] {
            let e = run_export(&cfg, &other, &dests).err().unwrap_or_else(|| panic!("{} is refused", other.dest)).to_string();
            assert!(e.contains("書き出しがまだ実行中です"), "{e}");
        }
        assert_eq!(std::fs::read(&dest).unwrap(), good);
        assert!(dir.join("song.mcs-tmp.0123abcd.mp3").exists() && !dir.join("song.flac").exists());
        drop(held);
        run_export(&cfg, &base, &dests).unwrap();
        assert_eq!(leftovers(&dir), ["song.mcs-tmp.txt"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RIFF chunk ids of a WAV file in order.
    fn riff_chunks(bytes: &[u8]) -> Vec<String> {
        let mut ids = Vec::new();
        let mut pos = 12;
        while pos + 8 <= bytes.len() {
            ids.push(String::from_utf8_lossy(&bytes[pos..pos + 4]).into_owned());
            let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
            pos += 8 + size + (size & 1);
        }
        ids
    }

    #[test]
    fn cover_and_tags_of_the_source_are_not_copied() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("srctags");
        let wav = tone(&cfg, &dir, 48_000);
        let cover = dir.join("cover.png");
        ffmpeg_gen(&cfg, &["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", &cover.to_string_lossy()]);
        let cover_bytes = std::fs::read(&cover).unwrap();
        // A FLAC with an embedded cover, an artist, old synced lyrics and ComfyUI's `prompt` graph (an earlier
        // export, a tagged library file or a SaveAudioAdvanced song).
        let src = dir.join("tagged.flac");
        ffmpeg_gen(&cfg, &["-i", &wav.to_string_lossy(), "-c:a", "flac", &src.to_string_lossy()]);
        let mut vc = lofty::ogg::VorbisComments::default();
        vc.insert("ARTIST".into(), "OldArtist".into());
        vc.insert("SYNCEDLYRICS".into(), "[00:01.00]old".into());
        vc.insert("prompt".into(), r#"{"3":{"inputs":{"lyrics":"secret"}}}"#.into());
        lofty::ogg::OggPictureStorage::insert_picture(&mut vc, Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Png), None, cover_bytes.clone()), None).unwrap();
        vc.save_to_path(&src, WriteOptions::default()).unwrap();
        let ffmpeg = cfg.ffmpeg_exe().unwrap();
        for fmt in ["wav16", "wav24", "wav32f", "flac", "mp3", "m4a", "ogg", "opus"] {
            for with_cover in [false, true] {
                if is_wav(fmt) && with_cover {
                    continue;
                }
                let dest = dir.join(format!("out_{fmt}_{with_cover}.{}", extension_for(fmt)));
                let req = ExportRequest {
                    source: src.to_string_lossy().into(),
                    dest: dest.to_string_lossy().into(),
                    format: fmt.into(),
                    title: "T".into(),
                    year: "2026".into(),
                    comment: "c".into(),
                    cover_image: with_cover.then(|| cover.to_string_lossy().into()),
                    ..Default::default()
                };
                // M4A failed (h264 cover) and OGG failed at tagging (Theora stream first) before.
                run_export(&cfg, &req, &ExportDests::default()).unwrap_or_else(|e| panic!("{fmt}: {e}"));
                if is_wav(fmt) {
                    let chunks = riff_chunks(&std::fs::read(&dest).unwrap());
                    assert!(!chunks.iter().any(|c| c == "LIST"), "{fmt}: RIFF INFO written: {chunks:?}");
                    continue;
                }
                if !with_cover {
                    let (_, _, info) = run_hidden_output(&ffmpeg, &["-hide_banner", "-i", &dest.to_string_lossy()]).unwrap();
                    assert!(info.contains("Audio:") && !info.contains("Video:"), "{fmt}: the source's cover was copied: {info}");
                }
                let tagged = lofty::read_from_path(&dest).unwrap_or_else(|e| panic!("{fmt}: {e}"));
                for tag in tagged.tags() {
                    assert!(tag.artist().is_none(), "{fmt}: artist copied from the source");
                    let unknown: Vec<String> = tag.items().filter_map(|i| match i.key() { ItemKey::Unknown(k) => Some(k.to_ascii_lowercase()), _ => None }).collect();
                    assert!(!unknown.iter().any(|k| k == "prompt" || k == "syncedlyrics"), "{fmt}: {unknown:?}");
                }
                let pics: Vec<&Picture> = tagged.tags().iter().flat_map(|t| t.pictures().iter()).collect();
                if with_cover {
                    assert!(pics.len() == 1 && pics[0].data() == cover_bytes.as_slice(), "{fmt}: {} pictures", pics.len());
                } else {
                    assert!(pics.is_empty(), "{fmt}: {} pictures", pics.len());
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ogg_and_opus_take_hires_and_mono_sources() {
        let Some(cfg) = test_cfg() else { return };
        let dir = test_dir("hires");
        let hires = tone(&cfg, &dir, 96_000);
        let low = tone(&cfg, &dir, 22_050);
        let mono = dir.join("mono.wav");
        ffmpeg_gen(&cfg, &["-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-ac", "1", "-c:a", "pcm_f32le", &mono.to_string_lossy()]);
        let surround = dir.join("surround.wav");
        ffmpeg_gen(&cfg, &["-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-ac", "6", "-c:a", "pcm_f32le", &surround.to_string_lossy()]);
        // (source, format, loudnorm, bitrate, the note expected in the warnings or "" for none)
        let cases = [
            (&hires, "ogg", false, 320, "Hz"),
            (&hires, "ogg", true, 320, "Hz"),
            (&low, "ogg", false, 320, "Hz"),
            (&mono, "ogg", false, 320, "kbps"),
            (&mono, "opus", false, 320, "kbps"),
            (&hires, "opus", false, 320, ""),
            // 5.1 at the slider's lowest value: libvorbis needs 84 ("encoder setup failed" at 64 and 80).
            (&surround, "ogg", false, 64, "kbps"),
            (&surround, "opus", false, 64, ""),
            // MP3 below 32 kHz would be MPEG-2, written at 160 kbps instead of 320.
            (&low, "mp3", false, 320, "Hz"),
            (&low, "mp3", true, 320, "Hz"),
        ];
        for (i, (src, fmt, loudnorm, kbps, note)) in cases.iter().enumerate() {
            let dest = dir.join(format!("out_{i}.{}", extension_for(fmt)));
            let req = ExportRequest {
                source: src.to_string_lossy().into(),
                dest: dest.to_string_lossy().into(),
                format: fmt.to_string(),
                bitrate_kbps: *kbps,
                loudnorm: *loudnorm,
                ..Default::default()
            };
            let r = run_export(&cfg, &req, &ExportDests::default()).unwrap_or_else(|e| panic!("case {i} ({fmt}): {e}"));
            assert_eq!(probe_sample_rate(&cfg, &dest), Some(48_000), "case {i}");
            if *fmt == "mp3" {
                // The CBR rate chosen on the page, in the stream itself.
                let (_, _, info) = run_hidden_output(&cfg.ffmpeg_exe().unwrap(), &["-hide_banner", "-i", &dest.to_string_lossy()]).unwrap();
                assert!(info.lines().any(|l| l.contains("Audio: mp3") && l.contains("320 kb/s")), "case {i}: {info}");
            }
            if note.is_empty() {
                assert!(r.warnings.is_empty(), "case {i}: {:?}", r.warnings);
            } else {
                assert!(r.warnings.len() == 1 && r.warnings[0].contains(note), "case {i}: {:?}", r.warnings);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
