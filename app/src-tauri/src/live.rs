//! One live agent: a `mirror-agent` process and its session, through glass-core.
//!
//! Nothing here knows about Tauri. Events leave through an `Emit` callback as
//! serialised `glass_core::Event`s, so the same code runs in the app and in
//! the `live_smoke` example.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use glass_core::{find_worker, ApprovalMode, Event, Inference, Session, Worker, WorkerConfig};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Which model answers and how the agent runs. Taken from the environment for now.
#[derive(Debug, Clone)]
pub struct Settings {
    pub workspace: PathBuf,
    pub api: String,
    pub model: String,
    pub base_url: Option<String>,
    pub effort: String,
    pub auto: bool,
    /// Memory for this worker regardless of the setting, for Glass's own memory edits.
    pub memory_dir: Option<PathBuf>,
    /// Mirror's sandbox config when the agent's tools run in a microVM.
    pub sandbox: Option<Value>,
}

impl Settings {
    /// `GLASS_API`, `GLASS_MODEL` and `GLASS_BASE_URL`, with the same defaults as the probe.
    pub fn from_env(workspace: PathBuf, effort: String, auto: bool) -> Settings {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Settings {
            workspace,
            api: env("GLASS_API").unwrap_or_else(|| "reflection".to_string()),
            model: env("GLASS_MODEL").unwrap_or_else(|| "Beam-1.0-501B-A23B".to_string()),
            base_url: env("GLASS_BASE_URL"),
            effort,
            auto,
            memory_dir: None,
            sandbox: None,
        }
    }

    pub fn new(workspace: PathBuf, choice: &crate::settings::Choice, effort: String, auto: bool) -> Settings {
        Settings {
            workspace,
            api: choice.api.clone(),
            model: choice.model.clone(),
            base_url: choice.base_url.clone().filter(|url| !url.is_empty()),
            effort,
            auto,
            memory_dir: None,
            sandbox: None,
        }
    }

    pub fn inference(&self) -> Inference {
        Inference {
            model: self.model.clone(),
            api: Some(self.api.clone()),
            base_url: self.base_url.clone(),
            reasoning_effort: Some(self.effort.clone()),
        }
    }
}

type Pending = Arc<Mutex<HashMap<String, (String, String)>>>;

pub struct Live {
    pub session: Session,
    /// Where the worker runs.
    pub workspace: PathBuf,
    /// Requests waiting for an answer, by call id: the tool and its arguments exactly
    /// as the worker sent them, which a remembered rule is made from.
    pending: Pending,
    interrupt_requested: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

fn send(emit: &Emit, event: &Event) {
    if let Ok(value) = serde_json::to_value(event) {
        emit(value);
    }
}

fn send_logs(emit: &Emit, lines: Vec<String>) {
    for text in lines {
        send(emit, &Event::Log { level: "stderr".to_string(), text: crate::secrets::redact(&text) });
    }
}

impl Live {
    /// Launch a worker in the workspace and open its session.
    ///
    /// With `resume`, reopen that conversation and replay its history first.
    /// With `hub`, its MCP tools are offered to the agent and their calls run there.
    pub async fn start(settings: &Settings, resume: Option<&str>, emit: Emit, hub: Option<Arc<crate::mcp::Hub>>) -> Result<Live> {
        // The shell's keys and PATH, read at startup in the background.
        tokio::task::spawn_blocking(crate::settings::wait_for_login_env).await.ok();
        let executable = find_worker().context(
            "mirror-agent not found. Install Mirror, or set MIRROR_RUST_WORKER to the worker's path.",
        )?;
        let mut config = WorkerConfig::new_conversation(&settings.workspace, &settings.api, &settings.model);
        config.base_url = settings.base_url.clone();
        if let Some(id) = resume {
            config = config.resume(id);
        }
        // MCP servers run in the worker, as with Mirror's CLI; OAuth ones use the saved sign-in.
        config.mcp_connections = tokio::task::spawn_blocking(crate::mcp::connections).await.unwrap_or_default();
        // Mirror's personal memory, when it is on in Mirror's settings.
        if crate::memory::enabled() {
            config.memory_dir = Some(crate::memory::store_dir());
        }
        if settings.memory_dir.is_some() {
            config.memory_dir = settings.memory_dir.clone();
        }
        // Tests and examples point memory somewhere private.
        if let Ok(dir) = std::env::var("GLASS_TEST_MEMORY_DIR") {
            config.memory_dir = Some(PathBuf::from(dir));
        }
        // A sandbox: tools in the VM, no host memory, no local-command MCP servers,
        // as Mirror's worker requires; the VM runtime's paths in its environment.
        let mut env = crate::secrets::env_for_child();
        if let Some(sandbox) = &settings.sandbox {
            config.sandbox = Some(sandbox.clone());
            config.memory_dir = None;
            config.mcp_connections.retain(|connection| connection["config"]["url"].is_string() && connection["config"]["command"].is_null());
            env.extend(tokio::task::spawn_blocking(crate::sandbox::worker_env).await.map_err(|error| anyhow::anyhow!("{error}"))??);
        }
        // Keys saved in Settings reach the worker through its environment only.
        let (worker, startup) = Worker::spawn_with_env(&executable, &config, &settings.workspace, &env).await?;
        // On resume the UI already has the transcript from Glass's own log, so the
        // worker's history is not replayed here.
        let (session, events) = Session::connect(worker.address(), &config.conversation_id).await?;
        session.set_inference(&settings.inference())?;
        session.set_approval_mode(if settings.auto { ApprovalMode::Auto } else { ApprovalMode::Manual })?;

        let interrupt_requested = Arc::new(AtomicBool::new(false));
        let (stop, stop_rx) = oneshot::channel();
        let pending: Pending = Arc::default();
        let task = tokio::spawn(run(worker, startup, events, emit, interrupt_requested.clone(), stop_rx, session.clone(), hub, settings.workspace.clone(), pending.clone()));
        Ok(Live { session, workspace: settings.workspace.clone(), pending, interrupt_requested, stop: Some(stop), task })
    }

    /// What "Always allow" or "Remember" would save for this request, if anything.
    pub fn approval_offer(&self, call_id: &str) -> Option<crate::approvals::Offer> {
        let pending = self.pending.lock().unwrap();
        let (tool, arguments) = pending.get(call_id)?;
        crate::approvals::suggestion(tool, arguments, &self.workspace).map(|rule| crate::approvals::offer(&rule))
    }

    /// Approve this request and save the rule, in Mirror's shared file, so the
    /// same call is approved without asking here and in Mirror's CLI.
    pub fn approve_and_remember(&self, call_id: &str) -> Result<()> {
        let (tool, arguments) = self.pending.lock().unwrap().get(call_id).cloned().context("that request is no longer waiting")?;
        let rule = crate::approvals::suggestion(&tool, &arguments, &self.workspace).context("this call cannot be remembered")?;
        crate::approvals::remember(&rule)?;
        self.session.resolve_approval(call_id, true)
    }

    pub fn conversation_id(&self) -> &str {
        self.session.conversation_id()
    }

    pub fn interrupt(&self) -> Result<()> {
        self.interrupt_requested.store(true, Ordering::SeqCst);
        self.session.interrupt()
    }

    /// Stop the worker and everything it started, and wait until it has.
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }
}

/// Forward events until the stream ends, and notice when the worker dies.
async fn run(
    mut worker: Worker,
    mut startup: mpsc::UnboundedReceiver<Event>,
    mut events: mpsc::UnboundedReceiver<Event>,
    emit: Emit,
    interrupt_requested: Arc<AtomicBool>,
    mut stop: oneshot::Receiver<()>,
    session: Session,
    hub: Option<Arc<crate::mcp::Hub>>,
    workspace: PathBuf,
    pending: Pending,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _ = &mut stop => {
                let _ = worker.stop().await;
                return;
            }
            Some(event) = startup.recv() => send(&emit, &event),
            next = events.recv() => {
                let Some(event) = next else {
                    let _ = worker.stop().await;
                    return;
                };
                // A hosted tool: run it beside the stream and answer the worker.
                if let Event::HostToolCall { call_id, name, arguments } = &event {
                    let (session, hub) = (session.clone(), hub.clone());
                    let (call_id, name, arguments) = (call_id.clone(), name.clone(), arguments.clone());
                    tokio::spawn(async move {
                        let (content, success) = match hub {
                            Some(hub) => hub.call(&name, &arguments).await,
                            None => ("host tools are not available".to_string(), false),
                        };
                        let _ = session.host_tool_result(&call_id, content, None, success);
                    });
                    continue;
                }
                match &event {
                    Event::ApprovalRequested { call_id, tool, arguments } => {
                        // A rule saved here or in Mirror's CLI answers it at once; the person
                        // never sees it waiting. The approval record says it was remembered.
                        let remembered = {
                            let (tool, arguments, workspace) = (tool.clone(), arguments.clone(), workspace.clone());
                            tokio::task::spawn_blocking(move || crate::approvals::check(&tool, &arguments, &workspace)).await.ok().flatten()
                        };
                        if let Some(source) = remembered {
                            if session.resolve_approval_as(call_id, true, source).is_ok() {
                                continue;
                            }
                        }
                        pending.lock().unwrap().insert(call_id.clone(), (tool.clone(), arguments.clone()));
                    }
                    Event::ApprovalResolved { call_id, .. } => {
                        pending.lock().unwrap().remove(call_id);
                    }
                    // The worker reports a failed model request as an interrupt with no
                    // reason. Its stderr is the only clue, so pass it on.
                    Event::TurnInterrupted if !interrupt_requested.swap(false, Ordering::SeqCst) => {
                        send_logs(&emit, worker.stderr_tail());
                    }
                    Event::TurnError { .. } | Event::Closed { error: Some(_) } => {
                        send_logs(&emit, worker.stderr_tail());
                    }
                    _ => {}
                }
                let closing = matches!(event, Event::Closed { .. });
                send(&emit, &event);
                if closing {
                    let _ = worker.stop().await;
                    return;
                }
            }
            _ = tick.tick() => {
                if !worker.is_running() {
                    send_logs(&emit, worker.stderr_tail());
                    send(&emit, &Event::Closed { error: Some("mirror-agent exited".to_string()) });
                    return;
                }
            }
        }
    }
}
