//! LLM end-to-end harness against a real llama-server (every test here is `#[ignore]`). The requests go through the
//! app's own code (llm::chat_retrying with the request bodies, sampling, thinking budget and retry the app sends;
//! llm::edit_messages and llm::parse_edit_reply as llm_edit uses them); the prompts and schemas of the drafts come
//! from the page code (src/lyrics/songwriter.ts) through tools/e2e/llm_steps.test.ts, which also checks the replies
//! with the page's own parsing and validation.
//!
//! Flow (MCS_LLM_E2E_DIR = work dir; a llama-server with the app's model on MCS_LLM_E2E_PORT, default 8111, started
//! as the app starts it: -ngl 99 -c 16384 -fa on --jinja):
//!   npx vitest run --config tools/e2e/vitest.config.ts          (writes inputs/llm_cases.json)
//!   cargo test --lib e2e_llm_run -- --ignored --nocapture      (results/<case>.json; a case with a result is skipped
//!                                                                unless MCS_LLM_E2E_FORCE=1)
//!   npx vitest run --config tools/e2e/vitest.config.ts          (checks the results -> results/report.json, and writes
//!                                                                inputs/llm_cases_reask.json: the edit page's re-asks)
//!   cargo test ... and vitest once more                         (sends the re-asks and checks the replies to them)
//!
//! A re-ask belongs to the first reply it was built from (its history holds that reply; its result records it as
//! basedOn): it is sent only while that reply is still the case's result, and sent again when its stored result was
//! built from another one. A run stops, without writing a result, when the llama-server stops answering (restart it
//! and run again).

use crate::config::AppConfig;
use crate::e2e::{read_json, write_json};
use crate::llm::{self, ChatMessage, LlmSettings, Secrets, ThinkingPurpose};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn llm_dir() -> PathBuf {
    PathBuf::from(std::env::var("MCS_LLM_E2E_DIR").expect("set MCS_LLM_E2E_DIR to the LLM e2e work directory"))
}

fn llm_port() -> u16 {
    std::env::var("MCS_LLM_E2E_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8111)
}

/// The settings of a case: the defaults (local provider) with the case's overrides (camelCase, as config.json).
fn case_settings(case: &Value) -> LlmSettings {
    let mut s = serde_json::to_value(LlmSettings::defaults()).unwrap();
    if let Some(o) = case["settings"].as_object() {
        for (k, v) in o {
            s[k] = v.clone();
        }
    }
    s["provider"] = json!("local");
    serde_json::from_value(s).expect("case settings")
}

fn text(case: &Value, k: &str) -> String {
    case[k].as_str().unwrap_or_default().to_string()
}

/// A re-ask case's first case and the first reply it was built from (the last assistant message of its history).
fn reask_of(case: &Value) -> Option<(&str, &str)> {
    let first = case["name"].as_str()?.strip_suffix("__reask")?;
    let reply = case["history"].as_array()?.iter().rev().find(|m| m["role"] == "assistant")?["content"].as_str()?;
    Some((first, reply))
}

#[derive(Debug, PartialEq)]
enum Plan {
    Run,
    Keep,
    /// a re-ask built from an earlier first reply (the first case was sent again since): not sent
    Stale,
}

/// What the run does with a case, given its stored result and, for a re-ask, its first case's stored result.
fn plan(case: &Value, existing: Option<&Value>, first_result: Option<&Value>, force: bool) -> Plan {
    match reask_of(case) {
        Some((_, reply)) => {
            if first_result.and_then(|r| r["content"].as_str()) != Some(reply) {
                Plan::Stale
            } else if !force && existing.is_some_and(|e| e["basedOn"].as_str() == Some(reply)) {
                Plan::Keep
            } else {
                Plan::Run
            }
        }
        None if existing.is_some() && !force => Plan::Keep,
        None => Plan::Run,
    }
}

#[tokio::test]
#[ignore = "needs a llama-server (MCS_LLM_E2E_PORT, default 8111) and MCS_LLM_E2E_DIR; see the module docs"]
async fn e2e_llm_run() {
    let dir = llm_dir();
    let mut cases = read_json(&dir.join("inputs").join("llm_cases.json")).expect("inputs/llm_cases.json (run the TypeScript steps first)").as_array().expect("an array of cases").clone();
    // the edit page's automatic re-asks, written by the check step for the replies that get one
    if let Some(reasks) = read_json(&dir.join("inputs").join("llm_cases_reask.json")) {
        cases.extend(reasks.as_array().expect("an array of re-ask cases").iter().cloned());
    }
    let force = std::env::var("MCS_LLM_E2E_FORCE").ok().as_deref() == Some("1");
    let port = llm_port();
    assert!(llm::llama_health(port).await, "no llama-server answers on 127.0.0.1:{port}");
    for case in &cases {
        let name = case["name"].as_str().expect("case name");
        let out = dir.join("results").join(format!("{name}.json"));
        let first_result = reask_of(case).and_then(|(first, _)| read_json(&dir.join("results").join(format!("{first}.json"))));
        match plan(case, read_json(&out).as_ref(), first_result.as_ref(), force) {
            Plan::Keep => {
                println!("{name}: kept (has a result)");
                continue;
            }
            Plan::Stale => {
                println!("{name}: not sent (built from an earlier reply of its first case: run the check step, then this again)");
                continue;
            }
            Plan::Run => {}
        }
        let settings = case_settings(case);
        let cfg = AppConfig { llm_port: port, llm: settings.clone(), ..Default::default() };
        let (messages, schema, purpose) = match case["kind"].as_str() {
            Some("draft") => (vec![ChatMessage { role: "system".into(), content: text(case, "system") }, ChatMessage { role: "user".into(), content: text(case, "user") }], Some(case["schema"].clone()), ThinkingPurpose::Draft),
            Some("edit") => {
                let history: Vec<ChatMessage> = serde_json::from_value(case["history"].clone()).unwrap_or_default();
                let sung = case["sungLyrics"].as_str();
                (llm::edit_messages(&text(case, "abc"), &text(case, "style"), &text(case, "lyrics"), sung, history, text(case, "instruction")), Some(llm::edit_schema()), ThinkingPurpose::Edit)
            }
            other => panic!("{name}: unknown kind {other:?}"),
        };
        let retries = AtomicUsize::new(0);
        let r = llm::chat_retrying(&cfg, &settings, &Secrets::default(), messages, schema, purpose, || {
            retries.fetch_add(1, Ordering::SeqCst);
        })
        .await;
        let mut result = json!({ "name": name, "kind": case["kind"], "settings": serde_json::to_value(&settings).unwrap(), "retriesAnnounced": retries.load(Ordering::SeqCst) });
        if let Some((_, reply)) = reask_of(case) {
            result["basedOn"] = json!(reply);
        }
        match r {
            Ok(r) => {
                result["ok"] = json!(true);
                result["content"] = json!(r.content);
                result["attempts"] = json!(r.attempts);
                result["promptTokens"] = json!(r.prompt_tokens);
                result["completionTokens"] = json!(r.completion_tokens);
                result["seconds"] = json!(r.seconds);
                if purpose == ThinkingPurpose::Edit {
                    match llm::parse_edit_reply(&r.content) {
                        Ok([abc, style, lyrics, explanation]) => result["reply"] = json!({ "abc": abc, "style": style, "lyrics": lyrics, "explanation": explanation }),
                        Err(e) => result["parseError"] = json!(e),
                    }
                }
            }
            Err(e) => {
                // a server that went away is not the case's result: stop, so that running again sends it
                assert!(llm::llama_health(port).await, "{name}: the llama-server on 127.0.0.1:{port} stopped answering ({e:#}); restart it and run again (cases with a result are kept)");
                result["ok"] = json!(false);
                result["error"] = json!(format!("{e:#}"));
            }
        }
        println!("{name}: ok={} attempts={} completion={} seconds={:.1}{}", result["ok"], result["attempts"], result["completionTokens"], result["seconds"].as_f64().unwrap_or(0.0), result["error"].as_str().map(|e| format!(" error={e}")).unwrap_or_default());
        write_json(&out, &result);
    }
}

#[test]
fn a_reask_is_sent_only_for_the_first_reply_it_was_built_from() {
    let first = json!({ "name": "e_x", "kind": "edit" });
    let reask = json!({ "name": "e_x__reask", "kind": "edit", "history": [{ "role": "user", "content": "i" }, { "role": "assistant", "content": "A" }] });
    let result = |content: &str| json!({ "content": content });
    // a first case: kept with a result unless forced
    assert_eq!(plan(&first, None, None, false), Plan::Run);
    assert_eq!(plan(&first, Some(&result("A")), None, false), Plan::Keep);
    assert_eq!(plan(&first, Some(&result("A")), None, true), Plan::Run);
    // a re-ask of the current first reply: sent, then kept (sent again when forced)
    assert_eq!(plan(&reask, None, Some(&result("A")), false), Plan::Run);
    let done = json!({ "basedOn": "A" });
    assert_eq!(plan(&reask, Some(&done), Some(&result("A")), false), Plan::Keep);
    assert_eq!(plan(&reask, Some(&done), Some(&result("A")), true), Plan::Run);
    // its stored result was built from an earlier first reply (or does not say): sent again
    assert_eq!(plan(&reask, Some(&json!({ "basedOn": "Z" })), Some(&result("A")), false), Plan::Run);
    assert_eq!(plan(&reask, Some(&json!({})), Some(&result("A")), false), Plan::Run);
    // built from another first reply than the current one (the first case was sent again): not sent, even forced
    assert_eq!(plan(&reask, None, Some(&result("B")), true), Plan::Stale);
    assert_eq!(plan(&reask, None, None, false), Plan::Stale);
    assert_eq!(reask_of(&reask), Some(("e_x", "A")));
    assert_eq!(reask_of(&first), None);
}

#[test]
fn a_case_overrides_the_default_settings_and_stays_local() {
    let s = case_settings(&json!({ "settings": { "thinking": false, "temperature": 0.7, "provider": "openai" } }));
    assert_eq!((s.provider.as_str(), s.thinking, s.temperature, s.limit_thinking), ("local", false, 0.7, true));
    assert_eq!(case_settings(&json!({})).local_model, LlmSettings::defaults().local_model);
}
