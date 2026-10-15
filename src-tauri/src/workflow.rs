//! Build ComfyUI API-format prompts for the YuE2 native nodes.
//! Node ids in links MUST be strings (`["1", 0]`); numeric ids fail validation (seen in P0).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const NODE_LOADER: &str = "loader";
pub const NODE_ABC: &str = "abc";
pub const NODE_ABC_PREVIEW: &str = "abc_preview";
pub const NODE_MUSIC: &str = "music";
pub const NODE_SECONDS_PREVIEW: &str = "seconds_preview";
pub const NODE_SAMPLER: &str = "sampler";
pub const NODE_DECODE: &str = "decode";
pub const NODE_SAVE: &str = "save";
pub const NODE_INFO: &str = "info";
pub const NODE_TRANSCRIBE: &str = "transcribe";
/// MCS_YuE2Status (bundled node pack): exact semantic truncation flag / frame count from the conditioning.
pub const NODE_STATUS: &str = "mcs_status";
/// YuE2GenerateABC token budget (node default). A planner that used all of it was cut off.
pub const MAX_ABC_TOKENS: u64 = 8192;
/// The official default song budget (seconds): the app's default max duration, and the longest decode
/// that stays on the official template node when the card is unknown.
pub const OFFICIAL_DEFAULT_SECONDS: u32 = 360;
/// SheetSage2 audio encoder file (models/audio_encoders), loaded by the transcription graph.
pub const SHEETSAGE2_FILE: &str = "sheetsage2_bf16.safetensors";

// Tool graphs (bundled node pack): the audio loader, vocal separation with its two savers, alignment.
pub const NODE_TOOL_SRC: &str = "src";
pub const NODE_SEP: &str = "sep";
pub const NODE_SEP_VOCALS: &str = "save_v";
pub const NODE_SEP_INST: &str = "save_i";
pub const NODE_ALIGN: &str = "align";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateParams {
    /// Title the user or the AI draft chose (empty = automatic, see jobs::default_title). Not part of the graph.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    pub style: String,
    pub lyrics: String,
    /// Lyrics as written (e.g. with kanji) when `lyrics` is a converted singing version; stored with the song.
    #[serde(default)]
    pub lyrics_display: String,
    /// "full" | "melody" | "off"
    pub mode: String,
    /// External ABC score (full/melody only). Empty = let the planner write one.
    #[serde(default)]
    pub abc: String,
    pub seed: u64,
    pub max_duration: f64,
    #[serde(default = "d_abc_temperature")]
    pub abc_temperature: f64,
    #[serde(default = "d_abc_top_p")]
    pub abc_top_p: f64,
    #[serde(default = "d_abc_top_k")]
    pub abc_top_k: u64,
    #[serde(default = "d_abc_rep")]
    pub abc_repetition_penalty: f64,
    #[serde(default = "d_temperature")]
    pub temperature: f64,
    #[serde(default = "d_top_p")]
    pub top_p: f64,
    #[serde(default = "d_top_k")]
    pub top_k: u64,
    #[serde(default = "d_rep")]
    pub repetition_penalty: f64,
    #[serde(default = "d_cfg")]
    pub cfg_scale: f64,
    #[serde(default = "d_steps")]
    pub steps: u64,
    /// Instrumental render: the untouched source score (the YuE2 plan or the editor's vocal score) before
    /// the Vocal notes were moved into Ins. Saved as score_source.abc (official instrumental skill: keep the
    /// plan and the original score next to the converted one). Empty = not an instrumental render.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_abc: String,
    /// Instrumental render: the Vocal -> Ins transfer record (official conversion/transfer.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrumental_transfer: Option<InstrumentalTransfer>,
    /// Instrumental render whose source was planned for it: the inputs actually sent to the planner (the
    /// render's own style and lyrics differ), so the plan can be reproduced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentalTransfer {
    pub moved_notes: u64,
    pub overlaps: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    pub style: String,
    pub lyrics: String,
    pub mode: String,
    pub seed: u64,
    pub abc_temperature: f64,
}

fn d_abc_temperature() -> f64 { 0.7 }
fn d_abc_top_p() -> f64 { 0.9 }
fn d_abc_top_k() -> u64 { 30 }
fn d_abc_rep() -> f64 { 1.005 }
fn d_temperature() -> f64 { 1.0 }
fn d_top_p() -> f64 { 0.95 }
fn d_top_k() -> u64 { 100 }
fn d_rep() -> f64 { 1.2 }
fn d_cfg() -> f64 { 1.0 }
fn d_steps() -> u64 { 32 }

pub struct BuildOptions<'a> {
    pub checkpoint: &'a str,
    pub filename_prefix: &'a str,
    /// Use the bundled MCS_SaveAudioWav node (32-bit float WAV) instead of SaveAudioAdvanced (FLAC).
    pub use_wav_saver: bool,
    /// Name of MCS_YuE2Status's CONDITIONING input when the node is installed (None = not wired).
    pub status_input: Option<&'a str>,
    /// How the latent is decoded (plan_vae_decode).
    pub vae_decode: VaeDecode,
}

/// The VAE decode node of a generation graph. `Plain` is VAEDecodeAudio (the official ComfyUI template);
/// `Tiled` is VAEDecodeAudioTiled, which decodes `tile_size` latent frames (1 frame = 1920 samples = 40 ms
/// at 48 kHz) at a time with `overlap` frames of context, like the official runtime's decode_tiled
/// (core 512 / 1024 frames, halo 16). Measured on an RTX 5090 (an A/B of plain and tiled decodes of the same
/// latents): the outputs differ by -54 dB or less and the differences do not sit on the tile seams, so tiling
/// costs time, not quality.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum VaeDecode {
    Plain,
    Tiled { tile_size: u32, overlap: u32 },
}

/// Latent frames per second of audio (EmptyYuE2LatentAudio: 1920 samples per frame at 48 kHz).
pub const LATENT_FRAMES_PER_SECOND: f64 = 25.0;
/// Extra VRAM a plain (untiled) FP16 decode needs, measured with zero latents of 120-480 s
/// (5.5 / 8.4 / 10.5 / 15.2 / 20.0 GB at 120 / 180 / 240 / 360 / 480 s): about 0.7 GB + 0.041 GB per second
/// (measured in the same A/B).
const PLAIN_DECODE_BASE_GIB: f64 = 0.7;
const PLAIN_DECODE_GIB_PER_SECOND: f64 = 0.041;
/// Headroom kept free for the sampler's own buffers and fragmentation.
const DECODE_MARGIN_GIB: f64 = 1.5;
/// VRAM the loaded YuE2 checkpoint (with its KV cache) holds while the latent is decoded, per precision.
pub fn model_resident_gib(precision: &str) -> f64 {
    if precision == "int8" { 5.5 } else { 9.0 }
}
/// Tile sizes tried from the largest (fewest seams, fastest) down; 512 is the official runtime's low-memory core.
const TILE_SIZES: [u32; 4] = [4096, 2048, 1024, 512];
const TILE_OVERLAP: u32 = 64;

/// VRAM a plain decode of `seconds` needs on top of the loaded models (FP32 doubles the activations).
pub fn plain_decode_gib(seconds: f64, fp32: bool) -> f64 {
    (PLAIN_DECODE_BASE_GIB + PLAIN_DECODE_GIB_PER_SECOND * seconds.max(0.0)) * if fp32 { 2.0 } else { 1.0 }
}

/// Choose the decode node for a generation budget of `seconds`.
/// `setting` is the config value: "plain" (always the official template node, ComfyUI retries tiled on OOM),
/// "tiled" (always tiled, largest tile that fits), or "auto": plain when the whole decode fits next to the
/// loaded model, otherwise tiled. `vram_total_gib` / `vram_free_gib` come from /system_stats (0 = unknown);
/// the resident estimate is the larger of what is in use now and the checkpoint (`model_gib`).
pub fn plan_vae_decode(setting: &str, seconds: f64, vram_total_gib: f64, vram_free_gib: f64, model_gib: f64, fp32: bool) -> VaeDecode {
    if setting == "plain" {
        return VaeDecode::Plain;
    }
    let tile_seconds = |tile: u32| tile as f64 / LATENT_FRAMES_PER_SECOND;
    if vram_total_gib <= 0.0 {
        // Unknown card: the official template path up to the official default budget, one 41 s tile beyond.
        return if setting == "tiled" || seconds > OFFICIAL_DEFAULT_SECONDS as f64 { VaeDecode::Tiled { tile_size: 1024, overlap: TILE_OVERLAP } } else { VaeDecode::Plain };
    }
    let resident = (vram_total_gib - vram_free_gib.max(0.0)).max(model_gib);
    let budget = vram_total_gib - resident - DECODE_MARGIN_GIB;
    if setting != "tiled" && plain_decode_gib(seconds, fp32) <= budget {
        return VaeDecode::Plain;
    }
    let tile_size = TILE_SIZES.iter().copied().find(|&t| plain_decode_gib(tile_seconds(t), fp32) <= budget).unwrap_or(512);
    VaeDecode::Tiled { tile_size, overlap: TILE_OVERLAP }
}

fn link(node: &str, slot: u64) -> Value {
    json!([node, slot])
}

/// True when build_generate adds the YuE2GenerateABC planner (full/melody without an external score).
pub fn plans_abc(p: &GenerateParams) -> bool {
    p.mode != "off" && p.abc.trim().is_empty()
}

#[allow(clippy::too_many_arguments)]
fn abc_node(style: &str, lyrics: &str, seed: u64, mode: &str, temperature: f64, top_p: f64, top_k: u64, repetition_penalty: f64) -> Value {
    json!({ "class_type": "YuE2GenerateABC", "inputs": {
        "clip": link(NODE_LOADER, 1), "style": style, "lyrics": lyrics, "seed": seed, "mode": mode,
        "max_abc_tokens": MAX_ABC_TOKENS, "temperature": temperature, "top_p": top_p, "top_k": top_k,
        "repetition_penalty": repetition_penalty, "penalty_window": 100 } })
}

/// Text-to-music graph (planner or external ABC). Covers transcribe first (build_transcribe) and
/// pass the score in `abc`. Returns the API prompt object.
pub fn build_generate(p: &GenerateParams, o: &BuildOptions) -> Value {
    let mut nodes = serde_json::Map::new();
    nodes.insert(NODE_LOADER.into(), json!({ "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": o.checkpoint } }));

    let mode = if p.mode == "off" { "full" } else { p.mode.as_str() };
    let mut abc_source: Value = Value::String(String::new());

    if plans_abc(p) {
        nodes.insert(NODE_ABC.into(), abc_node(&p.style, &p.lyrics, p.seed, mode, p.abc_temperature, p.abc_top_p, p.abc_top_k, p.abc_repetition_penalty));
        nodes.insert(NODE_ABC_PREVIEW.into(), json!({ "class_type": "PreviewAny", "inputs": { "source": link(NODE_ABC, 0) } }));
        abc_source = link(NODE_ABC, 0);
    } else if p.mode != "off" {
        abc_source = Value::String(p.abc.clone());
    }

    nodes.insert(
        NODE_MUSIC.into(),
        json!({ "class_type": "YuE2GenerateMusic", "inputs": {
            "clip": link(NODE_LOADER, 1), "style": p.style, "lyrics": p.lyrics, "abc": abc_source, "seed": p.seed, "mode": mode,
            "max_duration": p.max_duration, "temperature": p.temperature, "top_p": p.top_p, "top_k": p.top_k,
            "repetition_penalty": p.repetition_penalty, "cfg_scale": p.cfg_scale } }),
    );
    nodes.insert(NODE_SECONDS_PREVIEW.into(), json!({ "class_type": "PreviewAny", "inputs": { "source": link(NODE_MUSIC, 1) } }));
    if let Some(input) = o.status_input {
        nodes.insert(NODE_STATUS.into(), json!({ "class_type": "MCS_YuE2Status", "inputs": { input: link(NODE_MUSIC, 0) } }));
    }
    nodes.insert("negative".into(), json!({ "class_type": "ConditioningZeroOut", "inputs": { "conditioning": link(NODE_MUSIC, 0) } }));
    nodes.insert("latent".into(), json!({ "class_type": "EmptyYuE2LatentAudio", "inputs": { "seconds": link(NODE_MUSIC, 1), "batch_size": 1 } }));
    nodes.insert(
        NODE_SAMPLER.into(),
        json!({ "class_type": "KSampler", "inputs": {
            "model": link(NODE_LOADER, 0), "positive": link(NODE_MUSIC, 0), "negative": link("negative", 0), "latent_image": link("latent", 0),
            "seed": p.seed, "steps": p.steps, "cfg": 1.0, "sampler_name": "dpm_2", "scheduler": "sgm_uniform", "denoise": 1.0 } }),
    );
    let decode = match o.vae_decode {
        VaeDecode::Plain => json!({ "class_type": "VAEDecodeAudio", "inputs": { "samples": link(NODE_SAMPLER, 0), "vae": link(NODE_LOADER, 2) } }),
        VaeDecode::Tiled { tile_size, overlap } => json!({ "class_type": "VAEDecodeAudioTiled", "inputs": {
            "samples": link(NODE_SAMPLER, 0), "vae": link(NODE_LOADER, 2), "tile_size": tile_size, "overlap": overlap } }),
    };
    nodes.insert(NODE_DECODE.into(), decode);
    if o.use_wav_saver {
        nodes.insert(NODE_SAVE.into(), json!({ "class_type": "MCS_SaveAudioWav", "inputs": { "audio": link(NODE_DECODE, 0), "filename_prefix": o.filename_prefix } }));
        nodes.insert(NODE_INFO.into(), json!({ "class_type": "MCS_AudioInfo", "inputs": { "audio": link(NODE_DECODE, 0) } }));
    } else {
        // SaveAudio is deprecated in v0.37.0; the official template uses SaveAudioAdvanced
        // ("format" is a dynamic combo whose flac option has no sub-inputs).
        nodes.insert(NODE_SAVE.into(), json!({ "class_type": "SaveAudioAdvanced", "inputs": { "audio": link(NODE_DECODE, 0), "filename_prefix": o.filename_prefix, "format": "flac" } }));
    }
    Value::Object(nodes)
}

/// Plan-only graph (style + lyrics -> ABC) for the one-button instrumental flow.
pub fn build_plan(checkpoint: &str, style: &str, lyrics: &str, mode: &str, seed: u64, abc_temperature: f64) -> Value {
    let m = if mode == "melody" { "melody" } else { "full" };
    json!({
        NODE_LOADER: { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": checkpoint } },
        NODE_ABC: abc_node(style, lyrics, seed, m, abc_temperature, d_abc_top_p(), d_abc_top_k(), d_abc_rep()),
        NODE_ABC_PREVIEW: { "class_type": "PreviewAny", "inputs": { "source": [NODE_ABC, 0] } },
    })
}

/// Semantic truncation: exact from MCS_YuE2Status (`{"frames":..,"truncated":..}`), else inferred.
/// ComfyUI returns truncated exactly when all of the budget's frames were produced (yue2.py _generate).
/// The fallback compares frames with the budget actually used: `music_budget` is the music node's last
/// progress max (its ProgressBar total, already lowered by ComfyUI for a long prompt). Without it (the
/// node was served from the cache) the requested `round(max_duration*25)` is used.
pub fn semantic_truncated(status_json: Option<&str>, seconds: f64, max_duration: f64, music_budget: Option<u64>) -> Option<bool> {
    if let Some(v) = status_json.and_then(|s| serde_json::from_str::<Value>(s.trim()).ok()) {
        let valid = v.get("valid").and_then(|x| x.as_bool()) != Some(false);
        if let (true, Some(t)) = (valid, v.get("truncated").and_then(|t| t.as_bool())) {
            return Some(t);
        }
    }
    if seconds <= 0.0 {
        return None;
    }
    let budget = match music_budget {
        Some(m) if m > 0 => m as f64,
        _ => (max_duration * LATENT_FRAMES_PER_SECOND).round().max(1.0),
    };
    Some((seconds * LATENT_FRAMES_PER_SECOND).round() >= budget)
}

/// ABC truncation from the planner node's last progress event: the budget was used up.
/// (An end token sampled on exactly the last step is also flagged; harmless.)
pub fn abc_truncated(last_progress: Option<(u64, u64)>) -> Option<bool> {
    last_progress.map(|(v, m)| v == m && m == MAX_ABC_TOKENS)
}

/// ABC texts (sha256) of plans found cut off at the token budget in this session, by generate jobs and
/// plan_score alike (their planner nodes have the same inputs, so they share one ComfyUI cache entry). A
/// repeated identical graph is served from the cache without progress events, so the text is how a cached
/// copy of a truncated plan is recognised.
static TRUNCATED_PLANS: parking_lot::Mutex<Option<std::collections::HashSet<[u8; 32]>>> = parking_lot::Mutex::new(None);

fn abc_digest(abc: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(abc.as_bytes()).into()
}

/// Whether a finished plan was cut off: Some(true/false) from the planner node's last progress (a truncated
/// text is remembered in `known`); for a cached node (no progress) Some(true) when the text is known to be
/// truncated, else None (unknown). An empty text is never recorded or looked up.
pub fn plan_truncation_in(progress: Option<(u64, u64)>, abc: &str, known: &mut std::collections::HashSet<[u8; 32]>) -> Option<bool> {
    match abc_truncated(progress) {
        Some(true) => {
            if !abc.is_empty() {
                known.insert(abc_digest(abc));
            }
            Some(true)
        }
        Some(false) => Some(false),
        None => (!abc.is_empty() && known.contains(&abc_digest(abc))).then_some(true),
    }
}

/// plan_truncation_in with the session's shared set.
pub fn plan_truncation(progress: Option<(u64, u64)>, abc: &str) -> Option<bool> {
    plan_truncation_in(progress, abc, TRUNCATED_PLANS.lock().get_or_insert_with(Default::default))
}

/// Transcription-only graph (audio -> ABC) for the cover pane.
pub fn build_transcribe(input_name: &str, mode: &str) -> Value {
    json!({
        "cover_audio": { "class_type": "LoadAudio", "inputs": { "audio": input_name } },
        "audio_encoder": { "class_type": "AudioEncoderLoader", "inputs": { "audio_encoder_name": SHEETSAGE2_FILE } },
        NODE_TRANSCRIBE: { "class_type": "SheetSage2AudioToABC", "inputs": { "audio_encoder": ["audio_encoder", 0], "audio": ["cover_audio", 0], "mode": mode } },
        NODE_ABC_PREVIEW: { "class_type": "PreviewAny", "inputs": { "source": [NODE_TRANSCRIBE, 0] } }
    })
}

/// Vocal separation graph (MCS_VocalSeparate + two MCS_SaveAudioWav): `prefix` is the unique output prefix
/// (tools::separation_prefix), the stems are saved as <prefix>_vocals / <prefix>_instrumental.
pub fn build_separate(input_name: &str, model: &str, prefix: &str) -> Value {
    json!({
        NODE_TOOL_SRC: { "class_type": "LoadAudio", "inputs": { "audio": input_name } },
        NODE_SEP: { "class_type": "MCS_VocalSeparate", "inputs": { "audio": [NODE_TOOL_SRC, 0], "model": model } },
        NODE_SEP_VOCALS: { "class_type": "MCS_SaveAudioWav", "inputs": { "audio": [NODE_SEP, 0], "filename_prefix": format!("{prefix}_vocals") } },
        NODE_SEP_INST: { "class_type": "MCS_SaveAudioWav", "inputs": { "audio": [NODE_SEP, 1], "filename_prefix": format!("{prefix}_instrumental") } },
    })
}

/// Forced-alignment graph (MCS_AlignLyrics; its JSON result is the text output of NODE_ALIGN).
pub fn build_align(input_name: &str, lyrics: &str, language: &str) -> Value {
    json!({
        NODE_TOOL_SRC: { "class_type": "LoadAudio", "inputs": { "audio": input_name } },
        NODE_ALIGN: { "class_type": "MCS_AlignLyrics", "inputs": { "audio": [NODE_TOOL_SRC, 0], "lyrics": lyrics, "language": language } },
    })
}

/// Rough duration estimate from lyrics (seconds). P0: 8 lines -> 67 s, 48 lines -> 194 s.
pub fn estimate_seconds(lyrics: &str) -> f64 {
    let lines = lyrics.lines().filter(|l| !l.trim().is_empty() && !l.trim().starts_with('[')).count() as f64;
    let sections = lyrics.lines().filter(|l| l.trim().starts_with('[')).count() as f64;
    (20.0 + lines * 3.6 + sections * 4.0).clamp(20.0, 900.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(mode: &str) -> GenerateParams {
        serde_json::from_value(json!({ "style": "s", "lyrics": "l", "mode": mode, "seed": 1, "maxDuration": 60.0 })).unwrap()
    }

    #[test]
    fn instrumental_provenance_fields_are_optional_and_round_trip() {
        // Old params (params_json / song.json written before these fields) still load.
        let old = params("full");
        assert!(old.source_abc.is_empty() && old.instrumental_transfer.is_none() && old.plan.is_none());
        let v = serde_json::to_value(&old).unwrap();
        assert!(v.get("sourceAbc").is_none() && v.get("instrumentalTransfer").is_none() && v.get("plan").is_none());
        let p: GenerateParams = serde_json::from_value(json!({
            "style": "s", "lyrics": "[Verse]\n", "mode": "melody", "seed": 7, "maxDuration": 60.0, "abc": "X:1",
            "sourceAbc": "X:1\nsource", "instrumentalTransfer": { "movedNotes": 12, "overlaps": 2 },
            "plan": { "style": "pop", "lyrics": "la", "mode": "full", "seed": 7, "abcTemperature": 0.7 }
        }))
        .unwrap();
        assert_eq!(p.source_abc, "X:1\nsource");
        assert_eq!(p.instrumental_transfer, Some(InstrumentalTransfer { moved_notes: 12, overlaps: 2 }));
        let back: GenerateParams = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back.plan, p.plan);
        assert_eq!(back.source_abc, p.source_abc);
        assert_eq!(back.instrumental_transfer, p.instrumental_transfer);
    }

    #[test]
    fn plan_truncation_keeps_unknown_for_uncached_texts() {
        let mut known = std::collections::HashSet::new();
        assert_eq!(plan_truncation_in(Some((8192, 8192)), "X:1\nCDE", &mut known), Some(true));
        // cached copy of the same text (no progress): recognised
        assert_eq!(plan_truncation_in(None, "X:1\nCDE", &mut known), Some(true));
        // cached, never seen truncated: unknown, not "complete"
        assert_eq!(plan_truncation_in(None, "X:1\nGAB", &mut known), None);
        assert_eq!(plan_truncation_in(Some((700, 8192)), "X:1\nDEF", &mut known), Some(false));
        // an empty text is never recorded
        assert_eq!(plan_truncation_in(Some((8192, 8192)), "", &mut known), Some(true));
        assert_eq!(plan_truncation_in(None, "", &mut known), None);
    }

    fn opts(use_wav_saver: bool, status_input: Option<&str>) -> BuildOptions<'_> {
        BuildOptions { checkpoint: "x", filename_prefix: "p", use_wav_saver, status_input, vae_decode: VaeDecode::Plain }
    }

    #[test]
    fn tiled_decode_uses_the_tiled_node_with_its_tile() {
        let o = BuildOptions { vae_decode: VaeDecode::Tiled { tile_size: 2048, overlap: 64 }, ..opts(true, None) };
        let v = build_generate(&params("off"), &o);
        assert_eq!(v["decode"]["class_type"], "VAEDecodeAudioTiled");
        assert_eq!(v["decode"]["inputs"]["tile_size"], 2048);
        assert_eq!(v["decode"]["inputs"]["overlap"], 64);
        assert_eq!(v["decode"]["inputs"]["samples"], json!(["sampler", 0]));
        assert_eq!(v["save"]["inputs"]["audio"], json!(["decode", 0]));
        // song.json record
        assert_eq!(serde_json::to_value(o.vae_decode).unwrap(), json!({ "mode": "tiled", "tile_size": 2048, "overlap": 64 }));
        assert_eq!(serde_json::to_value(VaeDecode::Plain).unwrap(), json!({ "mode": "plain" }));
    }

    #[test]
    fn vae_decode_plan_follows_the_measurements() {
        let tiled = |t: u32| VaeDecode::Tiled { tile_size: t, overlap: 64 };
        // 24 GB card, BF16 resident (9 GB): a 60 s decode fits (3.2 GB), a 360 s one (15.5 GB) does not
        assert_eq!(plan_vae_decode("auto", 60.0, 24.0, 14.0, 9.0, false), VaeDecode::Plain);
        assert_eq!(plan_vae_decode("auto", 360.0, 24.0, 14.0, 9.0, false), tiled(4096));
        // ... unless the user forces the official template node / tiling
        assert_eq!(plan_vae_decode("plain", 900.0, 24.0, 14.0, 9.0, false), VaeDecode::Plain);
        assert_eq!(plan_vae_decode("tiled", 60.0, 24.0, 14.0, 9.0, false), tiled(4096));
        // FP32 doubles the activations: 360 s needs a smaller tile
        assert_eq!(plan_vae_decode("auto", 360.0, 24.0, 14.0, 9.0, true), tiled(2048));
        // 12 GB card, INT8 resident (5.5 GB): 60 s plain, 180 s tiled with 82 s tiles
        assert_eq!(plan_vae_decode("auto", 60.0, 12.0, 11.5, 5.5, false), VaeDecode::Plain);
        assert_eq!(plan_vae_decode("auto", 180.0, 12.0, 11.5, 5.5, false), tiled(2048));
        // what is in use now counts when it is more than the checkpoint (another model still loaded)
        assert_eq!(plan_vae_decode("auto", 120.0, 24.0, 4.0, 9.0, false), tiled(1024));
        // unknown card: official path up to the official default budget, one tile beyond
        assert_eq!(plan_vae_decode("auto", 360.0, 0.0, 0.0, 9.0, false), VaeDecode::Plain);
        assert_eq!(plan_vae_decode("auto", 361.0, 0.0, 0.0, 9.0, false), tiled(1024));
        // never below the smallest tile
        assert_eq!(plan_vae_decode("auto", 900.0, 8.0, 7.0, 5.5, true), tiled(512));
    }

    #[test]
    fn links_use_string_ids() {
        let p = params("full");
        let v = build_generate(&p, &opts(true, None));
        assert_eq!(v["music"]["inputs"]["abc"][0], "abc");
        assert!(v["music"]["inputs"]["abc"][0].is_string());
        assert_eq!(v["save"]["class_type"], "MCS_SaveAudioWav");
        assert_eq!(v["info"]["class_type"], "MCS_AudioInfo");
    }

    #[test]
    fn default_graph_matches_official_template() {
        let p = params("full");
        assert_eq!((p.abc_temperature, p.abc_top_p, p.abc_top_k, p.abc_repetition_penalty), (0.7, 0.9, 30, 1.005));
        assert_eq!((p.temperature, p.top_p, p.top_k, p.repetition_penalty, p.cfg_scale, p.steps), (1.0, 0.95, 100, 1.2, 1.0, 32));
        let v = build_generate(&p, &opts(true, None));
        let k = &v["sampler"]["inputs"];
        assert_eq!(v["sampler"]["class_type"], "KSampler");
        assert_eq!(k["steps"], 32);
        assert_eq!(k["sampler_name"], "dpm_2");
        assert_eq!(k["scheduler"], "sgm_uniform");
        assert_eq!(k["cfg"], 1.0);
        assert_eq!(k["denoise"], 1.0);
        assert_eq!(k["positive"], json!(["music", 0]));
        assert_eq!(k["negative"], json!(["negative", 0]));
        assert_eq!(k["latent_image"], json!(["latent", 0]));
        assert_eq!(v["negative"]["class_type"], "ConditioningZeroOut");
        assert_eq!(v["negative"]["inputs"]["conditioning"], json!(["music", 0]));
        assert_eq!(v["latent"]["class_type"], "EmptyYuE2LatentAudio");
        assert_eq!(v["latent"]["inputs"]["seconds"], json!(["music", 1]));
        assert_eq!(v["decode"]["class_type"], "VAEDecodeAudio");
        assert_eq!(v["abc"]["inputs"]["max_abc_tokens"], 8192);
        assert_eq!(v["abc"]["inputs"]["penalty_window"], 100);
        assert!(v.get(NODE_STATUS).is_none());
    }

    #[test]
    fn fallback_saver_is_save_audio_advanced_flac() {
        let v = build_generate(&params("full"), &opts(false, None));
        assert_eq!(v["save"]["class_type"], "SaveAudioAdvanced");
        assert_eq!(v["save"]["inputs"]["format"], "flac");
        assert_eq!(v["save"]["inputs"]["audio"], json!(["decode", 0]));
        assert_eq!(v["save"]["inputs"]["filename_prefix"], "p");
        assert!(v.get("info").is_none());
    }

    #[test]
    fn status_node_is_wired_to_music_conditioning() {
        let v = build_generate(&params("melody"), &opts(true, Some("conditioning")));
        assert_eq!(v[NODE_STATUS]["class_type"], "MCS_YuE2Status");
        assert_eq!(v[NODE_STATUS]["inputs"]["conditioning"], json!(["music", 0]));
    }

    #[test]
    fn old_payload_with_cover_fields_still_deserializes() {
        let p: GenerateParams = serde_json::from_value(json!({ "style": "s", "lyrics": "l", "mode": "full", "seed": 1, "maxDuration": 60.0, "coverInputName": "", "coverMode": "melody" })).unwrap();
        let v = build_generate(&p, &opts(true, None));
        assert!(v.get("cover_audio").is_none() && v.get(NODE_TRANSCRIBE).is_none());
    }

    #[test]
    fn off_mode_has_no_abc_node() {
        let mut p = params("off");
        assert!(!plans_abc(&p));
        let v = build_generate(&p, &opts(false, None));
        assert!(v.get("abc").is_none());
        assert_eq!(v["music"]["inputs"]["abc"], "");
        assert_eq!(v["music"]["inputs"]["mode"], "full");
        p.abc = "X:1".into();
        p.mode = "melody".into();
        assert!(!plans_abc(&p));
        let v = build_generate(&p, &opts(false, None));
        assert_eq!(v["music"]["inputs"]["abc"], "X:1");
    }

    #[test]
    fn plan_graph_uses_given_seed_and_temperature() {
        let v = build_plan("ck", "st", "ly", "melody", 42, 0.85);
        assert_eq!(v["abc"]["inputs"]["seed"], 42);
        assert_eq!(v["abc"]["inputs"]["temperature"], 0.85);
        assert_eq!(v["abc"]["inputs"]["mode"], "melody");
        assert_eq!(v["abc"]["inputs"]["max_abc_tokens"], 8192);
        assert_eq!(v["loader"]["inputs"]["ckpt_name"], "ck");
        assert_eq!(v[NODE_ABC_PREVIEW]["inputs"]["source"], json!(["abc", 0]));
        assert_eq!(build_plan("ck", "st", "ly", "off", 1, 0.7)["abc"]["inputs"]["mode"], "full");
    }

    #[test]
    fn separation_graph_wires_both_stems() {
        let v = build_separate("mcs_uploads/x_song.wav", "model.ckpt", "mcs_sep/abcd1234");
        assert_eq!(v.as_object().unwrap().len(), 4);
        assert_eq!(v[NODE_TOOL_SRC]["class_type"], "LoadAudio");
        assert_eq!(v[NODE_TOOL_SRC]["inputs"]["audio"], "mcs_uploads/x_song.wav");
        assert_eq!(v[NODE_SEP]["class_type"], "MCS_VocalSeparate");
        assert_eq!(v[NODE_SEP]["inputs"]["audio"], json!(["src", 0]));
        assert_eq!(v[NODE_SEP]["inputs"]["model"], "model.ckpt");
        for (node, slot, suffix) in [(NODE_SEP_VOCALS, 0, "vocals"), (NODE_SEP_INST, 1, "instrumental")] {
            assert_eq!(v[node]["class_type"], "MCS_SaveAudioWav");
            assert_eq!(v[node]["inputs"]["audio"], json!(["sep", slot]));
            assert_eq!(v[node]["inputs"]["filename_prefix"], format!("mcs_sep/abcd1234_{suffix}"));
        }
    }

    #[test]
    fn align_graph_passes_lyrics_and_language() {
        let v = build_align("mcs_uploads/x_vocals.wav", "一行目\n二行目", "ja");
        assert_eq!(v.as_object().unwrap().len(), 2);
        assert_eq!(v[NODE_TOOL_SRC]["inputs"]["audio"], "mcs_uploads/x_vocals.wav");
        assert_eq!(v[NODE_ALIGN]["class_type"], "MCS_AlignLyrics");
        assert_eq!(v[NODE_ALIGN]["inputs"]["audio"], json!(["src", 0]));
        assert_eq!(v[NODE_ALIGN]["inputs"]["lyrics"], "一行目\n二行目");
        assert_eq!(v[NODE_ALIGN]["inputs"]["language"], "ja");
        assert_eq!(build_transcribe("a.wav", "melody")["audio_encoder"]["inputs"]["audio_encoder_name"], SHEETSAGE2_FILE);
    }

    #[test]
    fn tool_graph_inputs_exist_in_the_node_pack() {
        // The bundled node pack defines the inputs these graphs send (a rename there breaks them).
        let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../comfy-nodes/mcs_yue2_nodes/nodes.py")).unwrap();
        for class in ["class MCS_VocalSeparate", "class MCS_SaveAudioWav", "class MCS_AlignLyrics"] {
            assert!(src.contains(class), "{class}");
        }
        for input in ["\"model\":", "\"filename_prefix\":", "\"lyrics\":", "\"language\":", "\"audio\":"] {
            assert!(src.contains(input), "input {input}");
        }
    }

    #[test]
    fn unknown_card_threshold_is_the_official_default() {
        let s = OFFICIAL_DEFAULT_SECONDS as f64;
        assert_eq!(plan_vae_decode("auto", s, 0.0, 0.0, 9.0, false), VaeDecode::Plain);
        assert!(matches!(plan_vae_decode("auto", s + 1.0, 0.0, 0.0, 9.0, false), VaeDecode::Tiled { .. }));
    }

    #[test]
    fn truncation_detection() {
        // Exact flag from the status node wins.
        assert_eq!(semantic_truncated(Some(r#"{"frames": 2225, "truncated": true}"#), 89.0, 360.0, None), Some(true));
        assert_eq!(semantic_truncated(Some(r#"{"frames": 2250, "truncated": false}"#), 90.0, 90.0, Some(2250)), Some(false));
        // Fallback: frames reached the requested budget (music node cached: no progress).
        assert_eq!(semantic_truncated(None, 90.0, 90.0, None), Some(true));
        assert_eq!(semantic_truncated(None, 89.96, 90.0, None), Some(false));
        assert_eq!(semantic_truncated(Some("not json"), 60.0, 60.0, None), Some(true));
        assert_eq!(semantic_truncated(Some(r#"{"valid": false, "truncated": false}"#), 60.0, 60.0, None), Some(true));
        assert_eq!(semantic_truncated(None, 0.0, 90.0, None), None);
        // Fallback with the budget ComfyUI lowered for a long prompt (progress max 2000 of 9000 requested).
        assert_eq!(semantic_truncated(None, 80.0, 360.0, Some(2000)), Some(true));
        assert_eq!(semantic_truncated(None, 79.96, 360.0, Some(2000)), Some(false));
        assert_eq!(semantic_truncated(None, 90.0, 90.0, Some(0)), Some(true));
        assert_eq!(abc_truncated(Some((8192, 8192))), Some(true));
        assert_eq!(abc_truncated(Some((750, 8192))), Some(false));
        assert_eq!(abc_truncated(None), None);
    }
}
