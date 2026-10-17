//! Compaction on request against the real worker and a real model: one short
//! turn, then Session::compact, printing what the worker reports.
//!
//!   OPENAI_API_KEY=... GLASS_API=openai-responses GLASS_MODEL=gpt-5-nano \
//!     cargo run -p glass-app --example compact_smoke -- <workspace>

use std::sync::Arc;
use std::time::Duration;

use glass_app::live::{Emit, Live, Settings};
use serde_json::Value;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: compact_smoke <workspace>"))?;
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, "low".into(), true);
    let (sender, mut events) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.send(event);
    });
    let live = Live::start(&settings, None, emit, None).await?;
    live.session.send_user("Read stats.py and say in one sentence what it does.")?;
    let mut compacted = false;
    loop {
        let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(120), events.recv()).await else {
            println!("timed out");
            break;
        };
        let kind = event["type"].as_str().unwrap_or_default().to_string();
        if matches!(kind.as_str(), "text" | "reasoning" | "tool_call_delta" | "speed") {
            continue;
        }
        println!("{}", event.to_string().chars().take(160).collect::<String>());
        if kind == "turn_completed" && !compacted {
            compacted = true;
            println!("--- compact");
            live.session.compact()?;
        } else if kind == "turn_completed" || kind == "turn_error" || kind == "turn_interrupted" || kind == "closed" {
            break;
        }
    }
    live.stop().await;
    Ok(())
}
