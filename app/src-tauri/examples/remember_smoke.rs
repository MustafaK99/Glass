//! Remembered approvals against the real worker. The scripted model asks to run
//! the tests twice: the first request is approved with "Always allow", the second
//! must then run without reaching the UI, recorded as remembered. Run with a
//! scratch HOME so the rule lands in a scratch ~/.mirror/tool_approvals.json.
//!
//!   python3 dev/fake_model.py 18431 dev/fix-failing-test.script.json /tmp/glass-log "$PWD/tmp/stats-demo" &
//!   HOME=/tmp/scratch-home GLASS_API=openai-chat-completions GLASS_MODEL=fake GLASS_BASE_URL=http://127.0.0.1:18431/v1 \
//!     cargo run -p glass-app --example remember_smoke -- tmp/stats-demo

use std::sync::Arc;

use glass_app::live::{Emit, Live, Settings};
use serde_json::Value;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: remember_smoke <workspace>"))?;
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, "high".into(), false);
    let (sender, mut events) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.send(event);
    });
    let live = Live::start(&settings, None, emit, None).await?;
    live.session.send_user("Fix the failing test.")?;
    let (mut asked, mut remembered) = (Vec::new(), Vec::new());
    while let Some(event) = events.recv().await {
        let call = event["call_id"].as_str().unwrap_or_default().to_string();
        match event["type"].as_str().unwrap_or_default() {
            "approval_requested" => {
                let tool = event["tool"].as_str().unwrap_or_default().to_string();
                println!("asked: {tool} {}", event["arguments"]);
                if tool == "bash" && asked.iter().all(|(name, _)| name != "bash") {
                    println!("  offer: {:?}", live.approval_offer(&call).map(|offer| format!("{} · {}", offer.label, offer.detail)));
                    live.approve_and_remember(&call)?;
                } else {
                    live.session.resolve_approval(&call, true)?;
                }
                asked.push((tool, call));
            }
            "approval_recorded" if event["source"].as_str().unwrap_or_default().starts_with("remembered") => {
                println!("remembered: {} {} ({})", event["tool"], call, event["source"]);
                remembered.push(call);
            }
            "turn_completed" | "turn_interrupted" | "turn_error" | "closed" => {
                println!("end: {}", event["type"]);
                break;
            }
            _ => {}
        }
    }
    live.stop().await;
    println!("asked {} times, remembered {} times", asked.len(), remembered.len());
    Ok(())
}
