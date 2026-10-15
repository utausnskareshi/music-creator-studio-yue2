//! E2E harness, generation part (child of jobs.rs so it reaches the private helpers): the saved
//! /history of each generation scenario goes through the same steps as JobManager::run_one.

use super::*;
use crate::e2e::{e2e_dir, history, plan_truncation_flags, progress, read_json, write_json};
use serde_json::json;

#[test]
#[ignore = "reads the results of tools/e2e_comfy_driver.mjs (MCS_E2E_DIR)"]
fn e2e_parse_generate_results() {
    let dir = e2e_dir();
    let manifest = read_json(&dir.join("manifest.json")).expect("manifest.json");
    let mut failures: Vec<String> = crate::e2e::missing_final_scenarios(&manifest, true);
    let mut flags: Vec<(String, Option<bool>)> = Vec::new();
    for s in manifest["scenarios"].as_array().unwrap() {
        if s["kind"] != "generate" {
            continue;
        }
        let name = s["name"].as_str().unwrap().to_string();
        // add_generate stores it with the expectations (meta.expect.repeat_of)
        let repeat_of = s["meta"]["expect"]["repeat_of"].as_str().or(s["meta"]["repeat_of"].as_str());
        let params: GenerateParams = serde_json::from_value(s["meta"]["params"].clone()).expect("params round trip");
        let Some(entry) = history(&dir, &name) else {
            failures.push(format!("{name}: no history (not run or rejected)"));
            continue;
        };
        let prompt_id = read_json(&dir.join("results").join(&name).join("post_reply.json")).and_then(|v| v["body"]["prompt_id"].as_str().map(|s| s.to_string())).unwrap_or_default();
        let progress = progress(&dir, &name, &prompt_id);
        let cached: Vec<String> = read_json(&dir.join("results").join(&name).join("timing.json"))
            .and_then(|t| serde_json::from_value(t["cached_nodes"].clone()).ok())
            .unwrap_or_default();
        if let Some(msg) = extract_error(&entry) {
            failures.push(format!("{name}: {msg}"));
            write_json(&dir.join("parsed").join(format!("{name}.json")), &json!({ "name": name, "error": msg }));
            continue;
        }
        // Non-ASCII style/lyrics reach the nodes unchanged (the prompt ComfyUI stored with the entry).
        let stored = entry.pointer("/prompt/2").cloned().unwrap_or(Value::Null);
        if stored.pointer("/music/inputs/lyrics").and_then(|l| l.as_str()) != Some(params.lyrics.as_str()) || stored.pointer("/music/inputs/style").and_then(|l| l.as_str()) != Some(params.style.as_str()) {
            failures.push(format!("{name}: stored prompt lyrics/style differ from the request"));
        }
        if workflow::plans_abc(&params) && stored.pointer("/abc/inputs/lyrics").and_then(|l| l.as_str()) != Some(params.lyrics.as_str()) {
            failures.push(format!("{name}: planner lyrics differ from the request"));
        }
        // run_one's parsing of the outputs.
        let outputs = entry.get("outputs").cloned().unwrap_or(Value::Null);
        let GenOutputs { abc, seconds, info, duration, status_json, music_budget, effective_max_seconds, truncated_semantic, files } = parse_generate_outputs(&outputs, &progress, params.max_duration);
        // run_one: workflow::plan_truncation (progress + the session's truncated-plan texts, shared with plan_score)
        let truncated_abc = if workflow::plans_abc(&params) { plan_truncation_flags(&dir).get(&name).copied().flatten() } else { None };
        // The fallback inference (no status node, e.g. an older node pack) must agree with the node.
        let fallback = workflow::semantic_truncated(None, duration, params.max_duration, music_budget);
        let status: Option<Value> = status_json.as_deref().and_then(|t| serde_json::from_str(t.trim()).ok());
        let info_v: Option<Value> = info.as_deref().and_then(|t| serde_json::from_str(t).ok());

        let mut bad = |m: String| failures.push(format!("{name}: {m}"));
        let Some(first) = files.first() else {
            bad("出力音声が見つかりません".into());
            continue;
        };
        let ext = std::path::Path::new(&first.filename).extension().and_then(|e| e.to_str()).unwrap_or("wav");
        if ext != "wav" {
            bad(format!("saved as .{ext}, expected the 32-bit float WAV saver"));
        }
        if duration <= 0.0 {
            bad("duration 0".into());
        }
        if duration > params.max_duration + 1e-6 {
            bad(format!("duration {duration} over max_duration {}", params.max_duration));
        }
        match &status {
            Some(st) => {
                if st["valid"] != json!(true) {
                    bad(format!("status node not valid: {st}"));
                }
                let frames = st["frames"].as_f64().unwrap_or(-1.0);
                if (frames / workflow::LATENT_FRAMES_PER_SECOND - seconds).abs() > 1e-6 {
                    bad(format!("status frames {frames} vs seconds output {seconds}"));
                }
                if let Some(m) = music_budget {
                    // yue2.py: truncated exactly when every frame of the (possibly lowered) budget was produced.
                    let by_budget = frames as u64 >= m;
                    if st["truncated"].as_bool() != Some(by_budget) {
                        bad(format!("status truncated={} but frames {frames} / progress max {m}", st["truncated"]));
                    }
                }
            }
            None => bad(format!("no status JSON (status node output: {status_json:?})")),
        }
        if fallback != truncated_semantic {
            bad(format!("fallback truncation {fallback:?} disagrees with the status node {truncated_semantic:?}"));
        }
        if let Some(t) = s["meta"]["expect"].get("truncated").and_then(|t| t.as_bool()) {
            if truncated_semantic != Some(t) {
                bad(format!("expected truncated={t}, app classified {truncated_semantic:?}"));
            }
        }
        if let Some(iv) = &info_v {
            if (iv["seconds"].as_f64().unwrap_or(0.0) - seconds).abs() > 0.05 {
                bad(format!("audio info seconds {} vs semantic seconds {seconds}", iv["seconds"]));
            }
            if iv["clipped_samples"].as_u64().unwrap_or(0) > 0 {
                // Not an error (the saver clamps), but worth seeing in the report.
                eprintln!("{name}: {} samples above 1.0 before the clamp (peak {})", iv["clipped_samples"], iv["peak"]);
            }
        } else {
            bad("no MCS_AudioInfo JSON".into());
        }
        if workflow::plans_abc(&params) {
            if abc.trim().is_empty() {
                bad("planner ABC empty".into());
            }
            // A planner served from ComfyUI's cache sends no progress: run_one then stores "unknown", unless the
            // text was already found truncated this session. An executed planner is always classified, the same
            // way as from its progress alone.
            let abc_cached = cached.iter().any(|n| n == workflow::NODE_ABC);
            let from_progress = workflow::abc_truncated(progress.get(workflow::NODE_ABC).copied());
            let consistent = if abc_cached { truncated_abc.is_none() || truncated_abc == Some(true) } else { truncated_abc.is_some() && truncated_abc == from_progress };
            if !consistent {
                bad(format!("abc_truncated {truncated_abc:?} (progress alone {from_progress:?}) with the planner {}", if abc_cached { "cached" } else { "executed" }));
            }
            // A repeat whose original plan was cut off keeps that flag through the cache.
            if let Some(orig) = repeat_of {
                if abc_cached && plan_truncation_flags(&dir).get(orig).copied().flatten() == Some(true) && truncated_abc != Some(true) {
                    bad(format!("cached copy of the truncated plan of {orig} classified {truncated_abc:?}"));
                }
            }
        }
        let final_abc = if !abc.is_empty() { abc.clone() } else { params.abc.clone() };
        if !final_abc.is_empty() {
            std::fs::create_dir_all(dir.join("parsed")).unwrap();
            std::fs::write(dir.join("parsed").join(format!("{name}.abc")), &final_abc).unwrap();
        }
        // A repeated request must be classified like the original run (duration and truncation).
        if let Some(orig) = repeat_of.and_then(|o| read_json(&dir.join("parsed").join(format!("{o}.json")))) {
            if orig["duration"].as_f64() != Some(duration) || orig["truncated"]["semantic"] != json!(truncated_semantic) {
                bad(format!("repeat classified {duration} s / {truncated_semantic:?}, original {} s / {}", orig["duration"], orig["truncated"]["semantic"]));
            }
        }
        flags.push((name.clone(), truncated_semantic));
        write_json(
            &dir.join("parsed").join(format!("{name}.json")),
            &json!({
                "name": name, "seconds": seconds, "duration": duration, "info": info_v, "status": status,
                "music_budget": music_budget, "effective_max_seconds": effective_max_seconds,
                "truncated": { "semantic": truncated_semantic, "fallback": fallback, "abc": truncated_abc },
                "abc_progress": progress.get(workflow::NODE_ABC), "cached_nodes": cached, "file": first, "max_duration": params.max_duration,
            }),
        );
    }
    if !flags.iter().any(|(_, t)| *t == Some(false)) {
        failures.push(format!("no generation finished before its budget (truncated=false never seen): {flags:?}"));
    }
    write_json(&dir.join("parsed").join("generate_failures.json"), &json!(failures));
    assert!(failures.is_empty(), "generation results: {failures:#?}");
}
