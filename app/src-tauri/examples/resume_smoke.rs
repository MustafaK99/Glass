//! Does a relaunched worker resume its conversation? Run a turn, stop the worker,
//! relaunch with the same conversation id, send again, and let the scripted model
//! log the request it receives.
//!
//!   GLASS_API=openai-chat-completions GLASS_MODEL=fake GLASS_BASE_URL=http://127.0.0.1:18431/v1 \
//!     cargo run -p glass-app --example resume_smoke -- tmp/stats-demo

use std::sync::Arc;

use glass_app::live::{Emit, Live, Settings};
use serde_json::Value;
use tokio::sync::mpsc;

async fn turn(live: &Live, events: &mut mpsc::UnboundedReceiver<Value>, prompt: &str) -> anyhow::Result<String> {
    live.session.send_user(prompt)?;
    while let Some(event) = events.recv().await {
        let kind = event["type"].as_str().unwrap_or_default().to_string();
        if matches!(kind.as_str(), "turn_completed" | "turn_interrupted" | "turn_error" | "closed") {
            return Ok(kind);
        }
    }
    Ok("ended".into())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: resume_smoke <workspace>"))?;
    // Auto mode: this checks resuming, not approvals.
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, "low".into(), true);
    let (sender, mut events) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.send(event);
    });

    let first = Live::start(&settings, None, emit.clone()).await?;
    let conversation = first.conversation_id().to_string();
    println!("first turn: {}", turn(&first, &mut events, "Fix the failing test.").await?);
    first.stop().await;
    println!("worker stopped; resuming {conversation}");

    let second = Live::start(&settings, Some(&conversation), emit).await?;
    println!("same conversation: {}", second.conversation_id() == conversation);
    println!("second turn: {}", turn(&second, &mut events, "What did you change?").await?);
    second.stop().await;
    Ok(())
}
