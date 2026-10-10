//! Drive the app's live-agent code against the real worker, approving every request.
//!
//!   python3 dev/fake_model.py 18431 dev/fix-failing-test.script.json /tmp/glass-log "$PWD/tmp/stats-demo" &
//!   GLASS_API=openai-chat-completions GLASS_MODEL=fake GLASS_BASE_URL=http://127.0.0.1:18431/v1 \
//!     cargo run -p glass-app --example live_smoke -- tmp/stats-demo "Fix the failing test."

use std::sync::Arc;

use glass_app::live::{Emit, Live, Settings};
use serde_json::Value;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [workspace, prompt] = args.as_slice() else { anyhow::bail!("usage: live_smoke <workspace> <prompt>") };
    let effort = std::env::var("GLASS_EFFORT").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "high".into());
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, effort, false);
    let (sender, mut events) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.send(event);
    });
    // MCP servers from Mirror's config (or $MIRROR_MCP_DIR) are offered too.
    let hub = Some(Arc::new(glass_app::mcp::Hub::default()));
    let live = Live::start(&settings, None, emit, hub).await?;
    live.session.send_user(prompt)?;
    while let Some(event) = events.recv().await {
        println!("{event}");
        match event["type"].as_str().unwrap_or_default() {
            "approval_requested" => live.session.resolve_approval(event["call_id"].as_str().unwrap(), true)?,
            "turn_completed" | "turn_interrupted" | "turn_error" | "closed" => break,
            _ => {}
        }
    }
    live.stop().await;
    Ok(())
}
