//! E2E harness, tools part (child of tools.rs so it reaches the private helpers): tool graphs over
//! generated audio, and the parsing of their results with the functions tools.rs uses.

use super::*;
use crate::e2e::{history, progress, read_json, result_audio, staged_upload, write_json, Manifest, LYRICS_EN};
use crate::workflow::{build_align, build_separate, NODE_SEP_INST, NODE_SEP_VOCALS};
use serde_json::json;

/// The separation default of the UI (SeparatePage / ExportPage).
const SEPARATION_MODEL: &str = "model_bs_roformer_ep_317_sdr_12.9755.ckpt";

/// tools::separate's graph, from the same builder and prefix helper.
fn separation_graph(name: &str, model: &str) -> Value {
    build_separate(name, model, &separation_prefix())
}

pub(crate) fn add_tool_scenarios(m: &mut Manifest) {
    let dir = m.dir.clone();
    // The app stages the library copy "song.wav" / "vocals.wav" (client::stage_input -> staged_name).
    if let Some(song) = result_audio(&dir, "gen_b_full_plan", crate::workflow::NODE_SAVE) {
        for mode in ["melody", "full"] {
            let (up, value) = staged_upload(&song, "song.wav");
            let g = crate::workflow::build_transcribe(&value, mode);
            m.add(&format!("tr_g_{mode}"), "transcribe", &g, vec![up], json!({ "source": "gen_b_full_plan", "mode": mode }));
        }
    }
    // Two different songs with the default model in one ComfyUI session (the second run used to fail),
    // the first one again as the app would repeat it (new prefix), and the instrumental render (its vocal
    // stem should be close to silent). The first three are one session group: the driver runs them together
    // whenever one of them has to run.
    for (name, src, group) in [
        ("sep_h1", "gen_a_off_en", Some("sep_two_songs")),
        ("sep_h2", "gen_j_japanese", Some("sep_two_songs")),
        ("sep_h3_repeat", "gen_a_off_en", Some("sep_two_songs")),
        ("sep_h4_instrumental", "gen_d2_fixture_instrumental", None),
    ] {
        if let Some(song) = result_audio(&dir, src, crate::workflow::NODE_SAVE) {
            let (up, value) = staged_upload(&song, "song.wav");
            let mut meta = json!({ "source": src, "model": SEPARATION_MODEL });
            if let Some(g) = group {
                meta["session_group"] = json!(g);
            }
            m.add(name, "separate", &separation_graph(&value, SEPARATION_MODEL), vec![up], meta);
        }
    }
    if let Some(vocals) = result_audio(&dir, "sep_h1", NODE_SEP_VOCALS) {
        let (up, value) = staged_upload(&vocals, "vocals.wav");
        m.add("align_i_en", "align", &build_align(&value, LYRICS_EN, "en"), vec![up], json!({ "source": "sep_h1", "language": "en", "lyrics": LYRICS_EN }));
    }
    // Japanese: the text ExportPage sends (alignmentText over the hiragana lines, tools/e2e/ts_steps.test.ts).
    let ja = std::fs::read_to_string(dir.join("inputs").join("align_ja.txt")).ok();
    if let (Some(vocals), Some(text)) = (result_audio(&dir, "sep_h2", NODE_SEP_VOCALS), ja) {
        let (up, value) = staged_upload(&vocals, "vocals.wav");
        m.add("align_i_ja", "align", &build_align(&value, &text, "ja"), vec![up], json!({ "source": "sep_h2", "language": "ja", "lyrics": text }));
    }
    // Japanese, song without a hiragana version: the kanji lyrics as kuromoji's hiragana reading
    // (toAlignmentReading(lyrics, lyrics), tools/e2e/ts_steps.test.ts), over the same vocals.
    let ja_kanji = std::fs::read_to_string(dir.join("inputs").join("align_ja_kanji.txt")).ok();
    if let (Some(vocals), Some(text)) = (result_audio(&dir, "sep_h2", NODE_SEP_VOCALS), ja_kanji) {
        let (up, value) = staged_upload(&vocals, "vocals.wav");
        m.add("align_i_ja_kanji", "align", &build_align(&value, &text, "ja"), vec![up], json!({ "source": "sep_h2", "language": "ja", "lyrics": text }));
    }
}

#[test]
#[ignore = "reads the results of tools/e2e_comfy_driver.mjs (MCS_E2E_DIR)"]
fn e2e_parse_tool_results() {
    let dir = crate::e2e::e2e_dir();
    let manifest = read_json(&dir.join("manifest.json")).expect("manifest.json");
    let mut failures: Vec<String> = crate::e2e::missing_final_scenarios(&manifest, false);
    for s in manifest["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let kind = s["kind"].as_str().unwrap();
        if kind == "generate" {
            continue;
        }
        let Some(entry) = history(&dir, name) else {
            failures.push(format!("{name}: no history (not run or rejected)"));
            continue;
        };
        let prompt_id = read_json(&dir.join("results").join(name).join("post_reply.json")).and_then(|v| v["body"]["prompt_id"].as_str().map(|s| s.to_string())).unwrap_or_default();
        // The LoadAudio value the graph uses is what client::upload_input returns for the reply.
        if let Some(replies) = read_json(&dir.join("results").join(name).join("uploads.json")) {
            for (u, r) in s["uploads"].as_array().unwrap().iter().zip(replies.as_array().unwrap()) {
                let got = client::load_value_from_upload(&r["body"], u["name"].as_str().unwrap());
                if got != u["load_value"].as_str().unwrap() {
                    failures.push(format!("{name}: upload reply maps to {got}, graph loads {}", u["load_value"]));
                }
            }
        }
        let mut out = json!({ "name": name, "kind": kind });
        // What tools::run_prompt reports for a failed history entry.
        if let Some(e) = failure_message(&entry) {
            out["error"] = json!(e);
            failures.push(format!("{name}: {e}"));
            write_json(&dir.join("parsed").join(format!("{name}.json")), &out);
            continue;
        }
        let outputs = entry.get("outputs").cloned().unwrap_or(Value::Null);
        match kind {
            "plan" | "transcribe" => {
                let abc = text_output(&outputs, crate::workflow::NODE_ABC_PREVIEW).unwrap_or_default();
                if abc.trim().is_empty() {
                    failures.push(format!("{name}: empty ABC"));
                }
                if kind == "plan" {
                    let p = progress(&dir, name, &prompt_id).get(crate::workflow::NODE_ABC).copied();
                    // plan_score: workflow::plan_truncation (shared with generate jobs), refused when Some(true)
                    let t = crate::e2e::plan_truncation_flags(&dir).get(name).copied().flatten().unwrap_or(false);
                    if t != plan_truncated(p, &abc, &mut std::collections::HashSet::new()) && p.is_some() {
                        failures.push(format!("{name}: shared-set truncation {t} differs from the progress alone"));
                    }
                    out["abc_progress"] = json!(p);
                    out["abc_truncated"] = json!(t);
                    if t {
                        failures.push(format!("{name}: plan_score would refuse this plan (token budget used up)"));
                    }
                }
                std::fs::create_dir_all(dir.join("parsed")).unwrap();
                std::fs::write(dir.join("parsed").join(format!("{name}.abc")), &abc).unwrap();
                out["abc_chars"] = json!(abc.len());
            }
            "separate" => {
                let v = audio_outputs(&outputs, NODE_SEP_VOCALS);
                let i = audio_outputs(&outputs, NODE_SEP_INST);
                match (v.first(), i.first()) {
                    (Some(vf), Some(inf)) => out["files"] = json!({ "vocals": vf, "instrumental": inf }),
                    _ => failures.push(format!("{name}: separate() would fail with 分離結果のファイルが見つかりません")),
                }
            }
            "align" => {
                // align_lyrics's own parsing (a missing output or a schema drift is an error there too).
                match parse_alignment(&outputs) {
                    Ok(lines) => {
                        if lines.is_empty() {
                            failures.push(format!("{name}: no aligned lines"));
                        }
                        let mut prev = f64::MIN;
                        for l in &lines {
                            if l.start.partial_cmp(&l.end).is_none_or(|o| o.is_gt()) || l.start < prev {
                                failures.push(format!("{name}: line {} not monotonic ({} - {}, previous start {prev})", l.index, l.start, l.end));
                            }
                            prev = l.start;
                            let mut wp = f64::MIN;
                            for w in &l.words {
                                if w.start.partial_cmp(&w.end).is_none_or(|o| o.is_gt()) || w.start < wp || w.start < l.start - 1e-6 || w.end > l.end + 1e-6 {
                                    failures.push(format!("{name}: word {:?} of line {} out of order", w.text, l.index));
                                }
                                wp = w.start;
                            }
                        }
                        out["lines"] = serde_json::to_value(&lines).unwrap();
                    }
                    Err(e) => failures.push(format!("{name}: {e:#}")),
                }
            }
            _ => {}
        }
        write_json(&dir.join("parsed").join(format!("{name}.json")), &out);
    }
    write_json(&dir.join("parsed").join("tools_failures.json"), &json!(failures));
    assert!(failures.is_empty(), "tool results: {failures:#?}");
}
