//! End-to-end harness against a real ComfyUI (every test here is `#[ignore]`; plain `cargo test`
//! skips them). The graphs come from the app's own builders (workflow.rs, and tools.rs through
//! tools::e2e_tools); tools/e2e_comfy_driver.mjs uploads the inputs, queues the graphs and saves
//! /history, the WS progress and the output files; the parse tests (jobs::e2e_jobs,
//! tools::e2e_tools) feed those results back through the app's parsing code.
//!
//! Flow (MCS_E2E_DIR = work dir, MCS_E2E_COMFY = server, GET only here, default :8198):
//!   npx vitest run --config tools/e2e/vitest.config.ts   (inputs/: instrumental request, ja alignment text)
//!   3 rounds of                                   (each round builds what the earlier ones made possible:
//!     cargo test e2e_build_graphs -- --ignored     1: the generations and plans,
//!     node tools/e2e_comfy_driver.mjs run ...      2: transcription and separation of their audio,
//!                                                  3: the cover of the transcription and the alignments)
//!   MCS_E2E_FINAL=1 cargo test e2e_parse -- --ignored   (MCS_E2E_FINAL: every EXPECTED_SCENARIOS entry must be built)
//!   npx vitest run --config tools/e2e/vitest.config.ts   (again: alignment through applyAlignment)
//!   node tools/e2e_comfy_driver.mjs check ...    (--python <python.exe> --abc-tools <official abc_tools.py>)
//! The manifest lists every scenario of a complete run ("expected") and the ones not built yet
//! ("missing": { "name", "waits_for" }). `run` re-runs by itself every scenario whose graph changed
//! since its result (prompt.json compared without filename_prefix), together with the repeat_of
//! scenarios of those and the other members of their session group (meta.session_group); a failed
//! re-run leaves no old result behind. A run whose execution failed in ComfyUI is kept (`check`
//! reports it as "execution failed") and is not re-run by itself: `run --retry-failed` runs it again,
//! together with its repeat_of scenarios and session group, and the scenarios built from their outputs
//! then wait for the next build + run round. Driver errors and failed downloads are still retried
//! by themselves. `--force` re-runs every scenario whose inputs still exist. A scenario whose input
//! was re-made by a scenario that ran again after the build (in the same pass, or in an earlier
//! `--force` / `--retry-failed` one) is not run and keeps its result: `run` lists it ("not run, their
//! input was re-made …") with the rebuild advice and exits with code 1, and `check` FAILs it as
//! "stale input", until the next build + run round. `check` also FAILs every expected scenario that
//! was never built, and every result of an older graph.

// The LLM harness (a llama-server instead of ComfyUI): see its module docs.
mod llm_e2e;

use crate::comfy::client::{self, ComfyClient, OutputFile};
use crate::workflow::{self, BuildOptions, GenerateParams, VaeDecode};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) const CLIENT_BASE_DEFAULT: &str = "http://127.0.0.1:8198";

pub(crate) const STYLE_EN: &str = "pop, upbeat, bright female vocal, acoustic guitar, piano, 100 BPM";
pub(crate) const LYRICS_EN: &str = "[Verse]\nMorning light across the window\nCity waking down below\n\n[Chorus]\nSing it loud and let it go\nHearts are shining, feel the glow\n";
/// Lyrics sung over src/abc/__fixtures__/full_en.abc (sections intro / verse / chorus / outro).
pub(crate) const LYRICS_FIXTURE_EN: &str = "[Intro]\n\n[Verse]\nWalking down the empty road tonight\nStars are falling\nEvery step I take is leading home\nTo you\nSummer rain is washing all the lights\nSoftly calling\nEvery dream I had is coming true\nFor you\n\n[Chorus]\nHold me close and never let me go\nStay with me\nWe will sing until the morning light is here\nShining bright\nHold me close and never let me go\nStay with me\nAll the stars above\nAre shining on\n\n[Outro]\nHome\n";
pub(crate) const STYLE_JA: &str = "J-pop, ballad, gentle female vocal, piano, strings, 90 BPM";
/// What the model sings (hiragana, the app's lyrics_sung) and what the user wrote (lyrics_display).
pub(crate) const LYRICS_JA_SUNG: &str = "[Verse]\nよぞらにひかるほしをみて\nきみのなまえをよんでいる\n\n[Chorus]\nわたしはうたう あしたへむかって\nこのこえがとどくまで\n";
pub(crate) const LYRICS_JA_DISPLAY: &str = "[Verse]\n夜空に光る星を見て\n君の名前を呼んでいる\n\n[Chorus]\n私は歌う 明日へ向かって\nこの声が届くまで\n";

/// Every scenario of a complete run: (name, kind, what it waits for; "" = built in round 1).
pub(crate) const EXPECTED_SCENARIOS: &[(&str, &str, &str)] = &[
    ("gen_a_off_en", "generate", ""),
    ("gen_a2_tiled", "generate", ""),
    ("gen_b_full_plan", "generate", ""),
    ("gen_c_melody_plan", "generate", ""),
    ("gen_d1_fixture_abc", "generate", ""),
    ("gen_d2_fixture_instrumental", "generate", "inputs/instrumental.json (tools/e2e ts_steps)"),
    ("gen_f_tiny_budget", "generate", ""),
    ("gen_j_japanese", "generate", ""),
    ("plan_e_score", "plan", ""),
    ("gen_k_repeat_of_b", "generate", ""),
    ("plan_e2_repeat", "plan", ""),
    ("plan_e3_repeat", "plan", ""),
    ("gen_k2_repeat_of_b", "generate", ""),
    ("gen_k3_repeat_of_b", "generate", ""),
    ("gen_l_cover_from_transcription", "generate", "the ABC of tr_g_melody"),
    ("tr_g_melody", "transcribe", "the audio of gen_b_full_plan"),
    ("tr_g_full", "transcribe", "the audio of gen_b_full_plan"),
    ("sep_h1", "separate", "the audio of gen_a_off_en"),
    ("sep_h2", "separate", "the audio of gen_j_japanese"),
    ("sep_h3_repeat", "separate", "the audio of gen_a_off_en"),
    ("sep_h4_instrumental", "separate", "the audio of gen_d2_fixture_instrumental"),
    ("align_i_en", "align", "the vocals of sep_h1"),
    ("align_i_ja", "align", "the vocals of sep_h2 and inputs/align_ja.txt"),
    ("align_i_ja_kanji", "align", "the vocals of sep_h2 and inputs/align_ja_kanji.txt"),
];

/// With MCS_E2E_FINAL=1 (the parse after the last round): one failure per expected scenario of the
/// generate kind (`generate`) or of the other kinds that is not in the manifest. Without it, nothing
/// (the parse also runs between rounds).
pub(crate) fn missing_final_scenarios(manifest: &Value, generate: bool) -> Vec<String> {
    if std::env::var("MCS_E2E_FINAL").ok().as_deref() != Some("1") {
        return Vec::new();
    }
    let built: Vec<&str> = manifest["scenarios"].as_array().map(|a| a.iter().filter_map(|s| s["name"].as_str()).collect()).unwrap_or_default();
    EXPECTED_SCENARIOS
        .iter()
        .filter(|(name, kind, _)| (*kind == "generate") == generate && !built.contains(name))
        .map(|(name, _, needs)| format!("{name}: not built (waits for {needs})"))
        .collect()
}

pub(crate) fn e2e_dir() -> PathBuf {
    PathBuf::from(std::env::var("MCS_E2E_DIR").expect("set MCS_E2E_DIR to the e2e work directory"))
}

pub(crate) fn comfy_base() -> String {
    std::env::var("MCS_E2E_COMFY").unwrap_or_else(|_| CLIENT_BASE_DEFAULT.to_string())
}

pub(crate) fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

pub(crate) fn write_json(p: &Path, v: &Value) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
}

pub(crate) fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

/// The /history entry the driver saved for a scenario (None when it has not run).
pub(crate) fn history(dir: &Path, scenario: &str) -> Option<Value> {
    read_json(&dir.join("results").join(scenario).join("history.json"))
}

/// Last `progress` (value, max) per node as the driver recorded it from /ws (ws::record_progress).
pub(crate) fn progress(dir: &Path, scenario: &str, prompt_id: &str) -> std::collections::HashMap<String, (u64, u64)> {
    let mut map = crate::comfy::ws::ProgressMap::new();
    let events = read_json(&dir.join("results").join(scenario).join("ws_events.json")).unwrap_or(json!([]));
    for m in events.as_array().cloned().unwrap_or_default() {
        if m.get("type").and_then(|t| t.as_str()) != Some("progress") {
            continue;
        }
        // Through the relay's own parser, as a /ws text frame.
        if let Some(ev) = crate::comfy::ws::parse(&m.to_string()) {
            crate::comfy::ws::record_progress(&mut map, &ev);
        }
    }
    crate::comfy::ws::take_progress(&mut map, prompt_id)
}

/// The planner's truncation flag per planning scenario (generate scenarios that plan an ABC, and plan
/// scenarios), as run_one and plan_score compute it: workflow::plan_truncation with the planner's last
/// progress and the plan text, through the one session-wide set of truncated plans the two share. The
/// scenarios are replayed in manifest order, which is the order the driver ran them in (one ComfyUI session,
/// like one app session). Computed once per process, so both parse tests (parallel threads) see the same
/// session. Scenarios without a successful history are left out.
pub(crate) fn plan_truncation_flags(dir: &Path) -> &'static std::collections::HashMap<String, Option<bool>> {
    static FLAGS: std::sync::OnceLock<std::collections::HashMap<String, Option<bool>>> = std::sync::OnceLock::new();
    FLAGS.get_or_init(|| {
        let manifest = read_json(&dir.join("manifest.json")).expect("manifest.json");
        let mut flags = std::collections::HashMap::new();
        for s in manifest["scenarios"].as_array().unwrap() {
            let name = s["name"].as_str().unwrap();
            let plans = match s["kind"].as_str() {
                Some("plan") => true,
                Some("generate") => serde_json::from_value::<GenerateParams>(s["meta"]["params"].clone()).is_ok_and(|p| workflow::plans_abc(&p)),
                _ => false,
            };
            let Some(entry) = history(dir, name).filter(|e| e.pointer("/status/status_str").and_then(|x| x.as_str()) == Some("success")) else {
                continue;
            };
            if !plans {
                continue;
            }
            let prompt_id = read_json(&dir.join("results").join(name).join("post_reply.json")).and_then(|v| v["body"]["prompt_id"].as_str().map(|s| s.to_string())).unwrap_or_default();
            let outputs = entry.get("outputs").cloned().unwrap_or(Value::Null);
            let abc = client::text_output(&outputs, workflow::NODE_ABC_PREVIEW).unwrap_or_default();
            let last = progress(dir, name, &prompt_id).get(workflow::NODE_ABC).copied();
            flags.insert(name.to_string(), workflow::plan_truncation(last, &abc));
        }
        flags
    })
}

/// Local copy of the first file of `node`'s "audio" output of a successful scenario.
pub(crate) fn result_audio(dir: &Path, scenario: &str, node: &str) -> Option<PathBuf> {
    let h = history(dir, scenario)?;
    if h.pointer("/status/status_str").and_then(|s| s.as_str()) != Some("success") {
        return None;
    }
    let files: Vec<OutputFile> = serde_json::from_value(h.pointer(&format!("/outputs/{node}/audio"))?.clone()).ok()?;
    let f = files.first()?;
    let p = dir.join("results").join(scenario).join("files").join(&f.subfolder).join(&f.filename);
    p.is_file().then_some(p)
}

/// An input the driver uploads like client::upload_input (the app's HTTP staging path): the
/// content-addressed name of client::staged_name for the file the app would stage (`basename`).
pub(crate) fn staged_upload(local: &Path, basename: &str) -> (Value, String) {
    let name = client::staged_name(&client::file_sha256(local).unwrap(), basename);
    let value = format!("{}/{name}", client::UPLOAD_SUBFOLDER);
    (json!({ "path": local.to_string_lossy(), "subfolder": client::UPLOAD_SUBFOLDER, "name": name, "load_value": value }), value)
}

pub(crate) struct Manifest {
    pub dir: PathBuf,
    pub entries: Vec<Value>,
}

impl Manifest {
    /// Write graphs/<name>.json (the exact API prompt) and remember the scenario.
    pub fn add(&mut self, name: &str, kind: &str, prompt: &Value, uploads: Vec<Value>, meta: Value) {
        write_json(&self.dir.join("graphs").join(format!("{name}.json")), prompt);
        self.entries.push(json!({ "name": name, "kind": kind, "graph": format!("graphs/{name}.json"), "uploads": uploads, "meta": meta }));
    }
}

/// Generation scenario: GenerateParams from the camelCase payload the UI sends, graph from build_generate
/// with the options run_one uses (checkpoint of the default config, "mcs/<id8>", the detected nodes) and
/// the given decode node (run_one plans it from the VRAM; fixed here so the manifest is reproducible).
fn add_generate(m: &mut Manifest, name: &str, payload: Value, o: (&str, bool, Option<&str>), vae_decode: VaeDecode, expect: Value) {
    let p: GenerateParams = serde_json::from_value(payload).expect("GenerateParams payload");
    let id = uuid::Uuid::new_v4().to_string();
    let prefix = format!("mcs/{}", &id[..8]);
    let prompt = workflow::build_generate(&p, &BuildOptions { checkpoint: o.0, filename_prefix: &prefix, use_wav_saver: o.1, status_input: o.2, vae_decode });
    let meta = json!({ "params": serde_json::to_value(&p).unwrap(), "plans_abc": workflow::plans_abc(&p), "vae_decode": vae_decode, "expect": expect });
    m.add(name, "generate", &prompt, vec![], meta);
}

#[tokio::test]
#[ignore = "needs a running ComfyUI (MCS_E2E_COMFY) and MCS_E2E_DIR; see the module docs"]
async fn e2e_build_graphs() {
    let dir = e2e_dir();
    let client = ComfyClient::new(comfy_base());
    // What after_up detects on the server (the same calls).
    let use_wav = client.has_node("MCS_SaveAudioWav").await;
    let status_input = client.object_info("MCS_YuE2Status").await.ok().and_then(|i| crate::conditioning_input_name(&i));
    let mut missing = Vec::new();
    for n in crate::REQUIRED_YUE2_NODES {
        if !client.has_node(n).await {
            missing.push(n.to_string());
        }
    }
    assert!(crate::missing_yue2_nodes_message(&missing).is_none(), "server lacks YuE2 nodes: {missing:?}");
    assert!(use_wav, "MCS_SaveAudioWav missing on the server");
    assert_eq!(status_input.as_deref(), Some("conditioning"));
    let cfg = crate::config::AppConfig::default();
    let ckpt = cfg.checkpoint_file();
    let o = (ckpt, use_wav, status_input.as_deref());
    let mut m = Manifest { dir: dir.clone(), entries: Vec::new() };

    let fixture = std::fs::read_to_string(repo_root().join("src/abc/__fixtures__/full_en.abc")).unwrap();
    add_generate(&mut m, "gen_a_off_en", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "off", "seed": 1001, "maxDuration": 20.0 }), o, VaeDecode::Plain, json!({}));
    // The tiled decode auto picks for most default budgets, with a tile smaller than the latent (20 s is
    // up to 500 frames: 2-3 tiles with seams). Same request as gen_a, so everything before the decoder can
    // come from ComfyUI's cache, and the song must be classified like gen_a.
    let tiled = VaeDecode::Tiled { tile_size: 256, overlap: 64 };
    add_generate(&mut m, "gen_a2_tiled", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "off", "seed": 1001, "maxDuration": 20.0 }), o, tiled, json!({ "repeat_of": "gen_a_off_en" }));
    add_generate(&mut m, "gen_b_full_plan", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "full", "seed": 1002, "maxDuration": 45.0 }), o, VaeDecode::Plain, json!({}));
    add_generate(&mut m, "gen_c_melody_plan", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "melody", "seed": 1003, "maxDuration": 45.0 }), o, VaeDecode::Plain, json!({}));
    add_generate(&mut m, "gen_d1_fixture_abc", json!({ "style": "pop, female vocal, piano, acoustic guitar, 86 BPM", "lyrics": LYRICS_FIXTURE_EN, "mode": "full", "abc": fixture, "seed": 1004, "maxDuration": 60.0 }), o, VaeDecode::Plain, json!({}));
    // The instrumental request exactly as ComposePage.renderInstrumentalFromAbc builds it (tools/e2e/ts_steps.test.ts).
    if let Some(ins) = read_json(&dir.join("inputs").join("instrumental.json")) {
        // With the provenance fields ComposePage sends (provenanceParams): they must deserialize into
        // GenerateParams and leave the graph unchanged.
        let mut payload = json!({ "style": ins["style"], "lyrics": ins["lyrics"], "mode": ins["mode"], "abc": ins["abc"], "seed": 1005, "maxDuration": 60.0 });
        for k in ["sourceAbc", "instrumentalTransfer", "plan"] {
            if !ins[k].is_null() {
                payload[k] = ins[k].clone();
            }
        }
        let p: GenerateParams = serde_json::from_value(payload.clone()).expect("instrumental payload");
        assert_eq!(p.source_abc, ins["sourceAbc"].as_str().unwrap_or_default(), "sourceAbc round trip");
        assert_eq!(serde_json::to_value(&p.instrumental_transfer).unwrap(), ins["instrumentalTransfer"], "instrumentalTransfer round trip");
        let bare = json!({ "style": ins["style"], "lyrics": ins["lyrics"], "mode": ins["mode"], "abc": ins["abc"], "seed": 1005, "maxDuration": 60.0 });
        let opts = BuildOptions { checkpoint: o.0, filename_prefix: "mcs/cmp", use_wav_saver: o.1, status_input: o.2, vae_decode: VaeDecode::Plain };
        assert_eq!(
            workflow::build_generate(&p, &opts),
            workflow::build_generate(&serde_json::from_value(bare).unwrap(), &opts),
            "provenance fields change the graph"
        );
        add_generate(&mut m, "gen_d2_fixture_instrumental", payload, o, VaeDecode::Plain, json!({}));
    }
    add_generate(&mut m, "gen_f_tiny_budget", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "off", "seed": 1006, "maxDuration": 4.0 }), o, VaeDecode::Plain, json!({ "truncated": true }));
    add_generate(&mut m, "gen_j_japanese", json!({ "style": STYLE_JA, "lyrics": LYRICS_JA_SUNG, "lyricsDisplay": LYRICS_JA_DISPLAY, "mode": "full", "seed": 1007, "maxDuration": 40.0 }), o, VaeDecode::Plain, json!({}));
    // plan_score's graph, planned with the official default seed.
    let plan = workflow::build_plan(ckpt, STYLE_EN, LYRICS_EN, "full", crate::tools::PLAN_DEFAULT_SEED, 0.7);
    m.add("plan_e_score", "plan", &plan, vec![], json!({ "seed": crate::tools::PLAN_DEFAULT_SEED }));
    // Repeats as the app sends them: the same song request again (new output prefix, so everything up to the
    // decoder may come from ComfyUI's cache: no progress events) and the same plan again (fully cached).
    add_generate(&mut m, "gen_k_repeat_of_b", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "full", "seed": 1002, "maxDuration": 45.0 }), o, VaeDecode::Plain, json!({ "repeat_of": "gen_b_full_plan" }));
    m.add("plan_e2_repeat", "plan", &plan, vec![], json!({ "seed": crate::tools::PLAN_DEFAULT_SEED, "repeat_of": "plan_e_score" }));
    m.add("plan_e3_repeat", "plan", &plan, vec![], json!({ "seed": crate::tools::PLAN_DEFAULT_SEED, "repeat_of": "plan_e_score" }));
    for n in ["gen_k2_repeat_of_b", "gen_k3_repeat_of_b"] {
        add_generate(&mut m, n, json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "full", "seed": 1002, "maxDuration": 45.0 }), o, VaeDecode::Plain, json!({ "repeat_of": "gen_b_full_plan" }));
    }

    // Cover (CoverPage): the melody transcription of gen_b rendered as an external score (no chords -> melody).
    // Read from the driver's result as transcribe() does (no e2e_parse run needed between rounds).
    let melody = history(&dir, "tr_g_melody")
        .filter(|h| h.pointer("/status/status_str").and_then(|s| s.as_str()) == Some("success"))
        .and_then(|h| client::text_output(&h["outputs"], workflow::NODE_ABC_PREVIEW))
        .filter(|a| !a.trim().is_empty())
        .or_else(|| std::fs::read_to_string(dir.join("parsed").join("tr_g_melody.abc")).ok());
    if let Some(abc) = melody {
        add_generate(&mut m, "gen_l_cover_from_transcription", json!({ "style": STYLE_EN, "lyrics": LYRICS_EN, "mode": "melody", "abc": abc, "seed": 1008, "maxDuration": 45.0 }), o, VaeDecode::Plain, json!({}));
    }

    // Tool graphs over the audio of the scenarios above (built once that audio exists).
    crate::tools::e2e_tools::add_tool_scenarios(&mut m);

    let built: Vec<String> = m.entries.iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    for n in &built {
        assert!(EXPECTED_SCENARIOS.iter().any(|(e, _, _)| e == n), "scenario {n} is not in EXPECTED_SCENARIOS");
    }
    let expected: Vec<&str> = EXPECTED_SCENARIOS.iter().map(|(n, _, _)| *n).collect();
    let missing: Vec<Value> = EXPECTED_SCENARIOS
        .iter()
        .filter(|(n, _, _)| !built.iter().any(|b| b == n))
        .map(|(n, _, needs)| json!({ "name": n, "waits_for": needs }))
        .collect();
    write_json(
        &dir.join("manifest.json"),
        &json!({ "server": comfy_base(), "checkpoint": ckpt, "status_input": status_input, "scenarios": m.entries, "expected": expected, "missing": missing }),
    );
    eprintln!("built {} graphs: {built:?}", built.len());
    if !missing.is_empty() {
        eprintln!("not built yet ({}; run the driver and build again): {missing:?}", missing.len());
    }
}

#[test]
fn expected_scenarios_are_unique_and_final_check_is_opt_in() {
    let mut names: Vec<&str> = EXPECTED_SCENARIOS.iter().map(|(n, _, _)| *n).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), EXPECTED_SCENARIOS.len());
    assert!(EXPECTED_SCENARIOS.iter().all(|(_, k, _)| ["generate", "plan", "transcribe", "separate", "align"].contains(k)));
    // Between rounds (no MCS_E2E_FINAL) a partial manifest is fine.
    if std::env::var("MCS_E2E_FINAL").is_err() {
        assert!(missing_final_scenarios(&json!({ "scenarios": [] }), true).is_empty());
    }
}
