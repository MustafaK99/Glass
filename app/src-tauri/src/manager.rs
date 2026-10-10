//! Every agent the app is running.
//!
//! All events reach the frontend on one channel as `{ agent_id, seq, event }`.
//! `seq` goes up by one per agent, across restarts, so the UI can spot a gap.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::live::{Emit, Live, Settings};

pub enum Source {
    Live {
        settings: Settings,
        /// The first message, kept so a worker that never started can be retried.
        first_message: String,
        /// Set once the worker has accepted a conversation; restarts resume it.
        conversation_id: Option<String>,
        live: Option<Live>,
    },
}

pub struct Agent {
    pub emit: Emit,
    pub source: Source,
}

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    pub id: String,
    pub workspace: String,
    pub project: String,
    pub branch: String,
    pub model: String,
    pub api: String,
    pub base_url: Option<String>,
}

#[derive(Default)]
pub struct Manager {
    channel: Arc<Mutex<Option<Channel<Value>>>>,
    next_id: AtomicU64,
    pub agents: tokio::sync::Mutex<HashMap<String, Agent>>,
}

impl Manager {
    pub fn subscribe(&self, channel: Channel<Value>) {
        *self.channel.lock().unwrap() = Some(channel);
    }

    /// Unique across launches, since saved agents keep their ids.
    pub fn new_id(&self, prefix: &str) -> String {
        let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
        format!("{prefix}-{millis}-{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// A sender that stamps events with this agent's id and sequence number.
    /// With `log`, it also keeps the agent's event log in that data folder.
    pub fn emitter(&self, agent_id: &str, log: Option<PathBuf>) -> Emit {
        let channel = self.channel.clone();
        let agent_id = agent_id.to_string();
        let seq = Arc::new(AtomicU64::new(0));
        Arc::new(move |event: Value| {
            if let Some(data) = &log {
                crate::store::append(data, &agent_id, &event);
            }
            let seq = seq.fetch_add(1, Ordering::SeqCst);
            if let Some(channel) = channel.lock().unwrap().as_ref() {
                let _ = channel.send(json!({ "agent_id": agent_id, "seq": seq, "event": event }));
            }
        })
    }

    /// Stop every worker. Called when the app quits.
    pub async fn stop_all(&self) {
        let mut agents = self.agents.lock().await;
        for (_, agent) in agents.drain() {
            stop_source(agent.source).await;
        }
    }
}

pub async fn stop_source(source: Source) {
    match source {
        Source::Live { live: Some(live), .. } => live.stop().await,
        Source::Live { .. } => {}
    }
}

pub fn info(id: &str, settings: &Settings) -> AgentInfo {
    let workspace = settings.workspace.clone();
    AgentInfo {
        id: id.to_string(),
        workspace: workspace.display().to_string(),
        project: workspace.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        branch: git_branch(&workspace).unwrap_or_else(|| "no git".to_string()),
        model: settings.model.clone(),
        api: settings.api.clone(),
        base_url: settings.base_url.clone(),
    }
}

fn git_branch(workspace: &PathBuf) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Launch (or relaunch) a live agent's worker and send its first message if this is a new start.
pub async fn launch(
    settings: Settings,
    resume: Option<String>,
    first_message: Option<String>,
    emit: Emit,
    hub: Option<Arc<crate::mcp::Hub>>,
) -> Result<Live> {
    let live = Live::start(&settings, resume.as_deref(), emit, hub).await?;
    if let Some(text) = first_message {
        live.session.send_user(&text)?;
    }
    Ok(live)
}

pub fn live_session<'a>(agents: &'a HashMap<String, Agent>, id: &str) -> Result<&'a Live> {
    match agents.get(id).map(|agent| &agent.source) {
        Some(Source::Live { live: Some(live), .. }) => Ok(live),
        Some(Source::Live { live: None, .. }) => Err(anyhow!("the worker is not running")),
        None => Err(anyhow!("no such agent")),
    }
}
