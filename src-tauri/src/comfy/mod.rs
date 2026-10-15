//! ComfyUI backend: process lifecycle, HTTP client, WebSocket event relay.

pub mod client;
pub mod process;
pub mod ws;

pub use client::ComfyClient;
pub use process::ComfyProcess;
