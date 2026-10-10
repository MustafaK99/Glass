//! Replay a recorded event stream as if a worker were producing it.
//!
//! The approved and rejected recordings are identical up to the first approval
//! request. The replay pauses there, and the user's answer picks which recording
//! plays on. It pauses at every later request too, and continues on any answer.

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::time::Duration;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tokio::sync::mpsc;

pub const NAMES: &[&str] = &["fix-failing-test"];

const APPROVED: &str = include_str!("../../../fixtures/fix-failing-test.approved.jsonl");
const REJECTED: &str = include_str!("../../../fixtures/fix-failing-test.rejected.jsonl");

pub struct Replay {
    decisions: mpsc::UnboundedSender<(String, bool)>,
    task: JoinHandle<()>,
}

impl Replay {
    pub fn start(name: &str, events: Channel<Value>) -> Result<Replay> {
        if name != "fix-failing-test" {
            return Err(anyhow!("unknown recording {name}"));
        }
        let approved = parse(APPROVED)?;
        let rejected = parse(REJECTED)?;
        let (decisions, receiver) = mpsc::unbounded_channel();
        let task = async_runtime::spawn(run(approved, rejected, events, receiver));
        Ok(Replay { decisions, task })
    }

    pub fn resolve(&self, call_id: String, approved: bool) {
        let _ = self.decisions.send((call_id, approved));
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

fn parse(text: &str) -> Result<Vec<Value>> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Ok(serde_json::from_str(line)?))
        .collect()
}

async fn run(
    approved: Vec<Value>,
    rejected: Vec<Value>,
    events: Channel<Value>,
    mut decisions: mpsc::UnboundedReceiver<(String, bool)>,
) {
    let mut lines = &approved;
    let mut branch_chosen = false;
    let mut index = 0;
    while index < lines.len() {
        let event = &lines[index];
        let kind = event["type"].as_str().unwrap_or_default();
        tokio::time::sleep(pause_before(kind, event)).await;
        if events.send(event.clone()).is_err() {
            return;
        }
        if kind == "approval_requested" {
            // Wait for the user's answer to this request. Only the first answer
            // changes anything; after that the UI only offers the recorded one.
            let call_id = event["call_id"].as_str().unwrap_or_default().to_string();
            loop {
                match decisions.recv().await {
                    Some((id, yes)) if id == call_id => {
                        if !branch_chosen && !yes {
                            lines = &rejected;
                        }
                        branch_chosen = true;
                        break;
                    }
                    Some(_) => continue,
                    None => return,
                }
            }
        }
        index += 1;
    }
    let _ = events.send(serde_json::json!({ "type": "closed", "error": null }));
}

/// Rough pacing so the replay reads like a live run.
fn pause_before(kind: &str, event: &Value) -> Duration {
    let ms = match kind {
        "text" | "reasoning" => 60,
        "tool_call_delta" => 40,
        "message" if event["role"] == "tool" => 500,
        "message" => 150,
        "turn_started" => 300,
        _ => 30,
    };
    Duration::from_millis(ms)
}
