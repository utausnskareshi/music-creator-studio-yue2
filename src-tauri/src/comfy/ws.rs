//! WebSocket relay: ComfyUI /ws events -> Tauri events ("comfy://event").
//! Only the messages the UI needs are forwarded (progress_state is dropped: too chatty).
//! The latest `progress` per (prompt_id, node) is also kept in AppState: jobs use it to detect a
//! token budget that ran out (value == max) and the effective music budget (max / 25).

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyEvent {
    pub kind: String,
    pub prompt_id: Option<String>,
    pub node: Option<String>,
    pub value: Option<u64>,
    pub max: Option<u64>,
    pub output: Option<Value>,
    pub message: Option<String>,
    pub queue_remaining: Option<u64>,
}

/// Client id of this app instance for /prompt and /ws (ComfyUI sends a prompt's progress only to the
/// socket with its client id). Unique per start, so two instances (or a stale one) never receive each
/// other's progress.
pub fn client_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| format!("mcs-yue2-{}", uuid::Uuid::new_v4().simple()))
}

/// (prompt_id, node) -> (value, max) of the last `progress` event.
pub type ProgressMap = HashMap<(String, String), (u64, u64)>;

/// Remember a progress event (no-op for other kinds).
pub fn record_progress(map: &mut ProgressMap, ev: &ComfyEvent) {
    if ev.kind != "progress" {
        return;
    }
    if let (Some(p), Some(n), Some(v), Some(m)) = (&ev.prompt_id, &ev.node, ev.value, ev.max) {
        map.insert((p.clone(), n.clone()), (v, m));
    }
}

/// Remove and return the progress recorded for one prompt, keyed by node id.
pub fn take_progress(map: &mut ProgressMap, prompt_id: &str) -> HashMap<String, (u64, u64)> {
    let keys: Vec<(String, String)> = map.keys().filter(|(p, _)| p == prompt_id).cloned().collect();
    keys.into_iter().filter_map(|k| map.remove(&k).map(|v| (k.1, v))).collect()
}

/// Keep a WebSocket connection to `port` open while this relay's own token `active` is true and the
/// app still talks to ComfyUI on that port; reconnect on drop. Each relay gets its own token (see
/// AppState::ws_relay), so a retired relay can never resume when a new one is started, and a relay
/// for a port the app no longer uses (port change, restart elsewhere) ends by itself.
pub async fn relay(app: AppHandle, port: u16, active: Arc<AtomicBool>) {
    let url = format!("ws://127.0.0.1:{port}/ws?clientId={}", client_id());
    let current = |active: &AtomicBool| active.load(Ordering::SeqCst) && app.state::<crate::AppState>().effective_comfy_port() == port;
    while current(&active) {
        if let Ok((stream, _)) = tokio_tungstenite::connect_async(&url).await {
            let _ = app.emit("comfy://event", ComfyEvent { kind: "ws_connected".into(), prompt_id: None, node: None, value: None, max: None, output: None, message: None, queue_remaining: None });
            let (_, mut read) = stream.split();
            while current(&active) {
                let next = tokio::time::timeout(std::time::Duration::from_secs(30), read.next()).await;
                // Checked again after every message and idle tick: a retired relay forwards nothing more.
                if !current(&active) {
                    break;
                }
                match next {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        if let Some(ev) = parse(&text) {
                            if ev.kind == "progress" {
                                record_progress(&mut app.state::<crate::AppState>().last_progress.lock(), &ev);
                            }
                            let _ = app.emit("comfy://event", ev);
                        }
                    }
                    Ok(Some(Ok(Message::Binary(_)))) => {} // previews: ignored
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
                    Ok(Some(Err(e))) => {
                        log::warn!("comfy ws error: {e}");
                        break;
                    }
                    Ok(Some(Ok(_))) => {}
                    Err(_) => {} // idle timeout, keep waiting
                }
            }
            let _ = app.emit("comfy://event", ComfyEvent { kind: "ws_disconnected".into(), prompt_id: None, node: None, value: None, max: None, output: None, message: None, queue_remaining: None });
        }
        if current(&active) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
    // Leaving for a port change: mark the token dead so after_up starts a relay for the new port.
    active.store(false, Ordering::SeqCst);
}

/// One /ws text frame -> the event the UI gets (None for kinds it does not need). Public so the e2e
/// harness can read progress the same way.
pub fn parse(text: &str) -> Option<ComfyEvent> {
    let v: Value = serde_json::from_str(text).ok()?;
    let kind = v.get("type")?.as_str()?.to_string();
    let d = v.get("data").cloned().unwrap_or(Value::Null);
    let s = |k: &str| d.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let n = |k: &str| d.get(k).and_then(|x| x.as_u64());
    match kind.as_str() {
        "status" => Some(ComfyEvent { kind, prompt_id: None, node: None, value: None, max: None, output: None, message: None, queue_remaining: d.pointer("/status/exec_info/queue_remaining").and_then(|x| x.as_u64()) }),
        "execution_start" | "execution_success" | "execution_interrupted" | "execution_cached" => Some(ComfyEvent { kind, prompt_id: s("prompt_id"), node: None, value: None, max: None, output: None, message: None, queue_remaining: None }),
        "executing" => Some(ComfyEvent { kind, prompt_id: s("prompt_id"), node: s("node"), value: None, max: None, output: None, message: None, queue_remaining: None }),
        "progress" => Some(ComfyEvent { kind, prompt_id: s("prompt_id"), node: s("node"), value: n("value"), max: n("max"), output: None, message: None, queue_remaining: None }),
        "executed" => Some(ComfyEvent { kind, prompt_id: s("prompt_id"), node: s("node"), value: None, max: None, output: d.get("output").cloned(), message: None, queue_remaining: None }),
        "execution_error" => {
            let msg = format!("{} ({}): {}", s("node_type").unwrap_or_default(), s("node_id").unwrap_or_default(), s("exception_message").unwrap_or_default());
            Some(ComfyEvent { kind, prompt_id: s("prompt_id"), node: s("node_id"), value: None, max: None, output: d.get("traceback").cloned(), message: Some(msg), queue_remaining: None })
        }
        _ => None, // progress_state and others
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_recorded_per_prompt_and_node() {
        let mut m = ProgressMap::new();
        for (v, node) in [(10, "abc"), (8192, "abc"), (500, "music")] {
            let ev = parse(&format!(r#"{{"type":"progress","data":{{"value":{v},"max":8192,"prompt_id":"p1","node":"{node}"}}}}"#)).unwrap();
            record_progress(&mut m, &ev);
        }
        let other = parse(r#"{"type":"progress","data":{"value":1,"max":2,"prompt_id":"p2","node":"sampler"}}"#).unwrap();
        record_progress(&mut m, &other);
        let exec = parse(r#"{"type":"executing","data":{"prompt_id":"p1","node":"abc"}}"#).unwrap();
        record_progress(&mut m, &exec);
        let p1 = take_progress(&mut m, "p1");
        assert_eq!(p1.get("abc"), Some(&(8192, 8192)));
        assert_eq!(p1.get("music"), Some(&(500, 8192)));
        assert_eq!(m.len(), 1, "other prompts are kept");
        assert!(take_progress(&mut m, "p1").is_empty());
    }

    #[test]
    fn parse_keeps_only_the_kinds_the_ui_uses() {
        let st = parse(r#"{"type":"status","data":{"status":{"exec_info":{"queue_remaining":2}}}}"#).unwrap();
        assert_eq!((st.kind.as_str(), st.queue_remaining), ("status", Some(2)));
        let err = parse(r#"{"type":"execution_error","data":{"prompt_id":"p","node_id":"7","node_type":"KSampler","exception_message":"oom","traceback":["a"]}}"#).unwrap();
        assert_eq!(err.message.as_deref(), Some("KSampler (7): oom"));
        assert_eq!(err.node.as_deref(), Some("7"));
        assert_eq!(err.output, Some(serde_json::json!(["a"])), "the traceback");
        // A status frame without exec_info has no queue count (not 0).
        let st = parse(r#"{"type":"status","data":{"status":{}}}"#).unwrap();
        assert_eq!(st.queue_remaining, None);
        let done = parse(r#"{"type":"executed","data":{"prompt_id":"p","node":"9","output":{"audio":[{"filename":"a.wav"}]}}}"#).unwrap();
        assert_eq!((done.kind.as_str(), done.prompt_id.as_deref(), done.node.as_deref()), ("executed", Some("p"), Some("9")));
        assert_eq!(done.output, Some(serde_json::json!({"audio":[{"filename":"a.wav"}]})));
        assert!(parse(r#"{"type":"progress_state","data":{}}"#).is_none());
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"data":{}}"#).is_none());
    }

    #[test]
    fn client_id_is_unique_per_start_and_stable_within_it() {
        let id = client_id();
        assert!(id.starts_with("mcs-yue2-") && id.len() == "mcs-yue2-".len() + 32);
        assert_eq!(client_id(), id);
    }
}
