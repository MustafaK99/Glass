//! Does forking at a user message make the agent forget it? One turn, fork at its
//! user message, relaunch on the fork, send again; the scripted model logs both
//! requests so the second can be checked for the first prompt.

use std::sync::Arc;

use glass_app::live::{Emit, Live, Settings};
use serde_json::Value;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: rewind_smoke <workspace>"))?;
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, "low".into(), true);
    let (sender, mut events) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.send(event);
    });
    let first = Live::start(&settings, None, emit.clone(), None).await?;
    let sent = first.session.send_user("FIRST PROMPT, to be forgotten")?;
    let mut user_record = None;
    while let Some(event) = events.recv().await {
        if event["type"] == "message" && event["role"] == "user" {
            user_record = event["id"].as_str().map(str::to_string);
        }
        if event["type"] == "turn_completed" {
            break;
        }
    }
    let user_record = user_record.ok_or_else(|| anyhow::anyhow!("no user record"))?;
    println!("sent id {sent} · record id {user_record} · same: {}", sent == user_record);
    let forked = first.session.fork(&user_record).await?;
    println!("forked {} -> {forked}", first.conversation_id());
    first.stop().await;
    let second = Live::start(&settings, Some(&forked), emit, None).await?;
    second.session.send_user("SECOND PROMPT")?;
    while let Some(event) = events.recv().await {
        if event["type"] == "turn_completed" {
            break;
        }
    }
    second.stop().await;
    println!("done");
    Ok(())
}
