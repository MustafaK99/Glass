//! One live agent: a `mirror-agent` process and its session, through glass-core.
//!
//! Nothing here knows about Tauri. Events leave through an `Emit` callback as
//! serialised `glass_core::Event`s, so the same code runs in the app and in
//! the `live_smoke` example.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
}

impl Settings {
    /// `GLASS_API`, `GLASS_MODEL` and `GLASS_BASE_URL`, with the same defaults as the probe.
    pub fn from_env(workspace: PathBuf, effort: String, auto: bool) -> Settings {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Settings {
            workspace,
            api: env("GLASS_API").unwrap_or_else(|| "reflection".to_string()),
            model: env("GLASS_MODEL").unwrap_or_else(|| "Beam-501B-A23B".to_string()),
            base_url: env("GLASS_BASE_URL"),
            effort,
            auto,
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

pub struct Live {
    pub session: Session,
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
        send(emit, &Event::Log { level: "stderr".to_string(), text });
    }
}

impl Live {
    /// Launch a worker in the workspace and open its session.
    ///
    /// With `resume`, reopen that conversation and replay its history first.
    pub async fn start(settings: &Settings, resume: Option<&str>, emit: Emit) -> Result<Live> {
        let executable = find_worker().context(
            "mirror-agent not found. Install Mirror, or set MIRROR_RUST_WORKER to the worker's path.",
        )?;
        let mut config = WorkerConfig::new_conversation(&settings.workspace, &settings.api, &settings.model);
        config.base_url = settings.base_url.clone();
        if let Some(id) = resume {
            config = config.resume(id);
        }
        let (worker, startup) = Worker::spawn(&executable, &config, &settings.workspace).await?;
        // On resume the UI already has the transcript from Glass's own log, so the
        // worker's history is not replayed here.
        let (session, events) = Session::connect(worker.address(), &config.conversation_id).await?;
        session.set_inference(&settings.inference())?;
        session.set_approval_mode(if settings.auto { ApprovalMode::Auto } else { ApprovalMode::Manual })?;

        let interrupt_requested = Arc::new(AtomicBool::new(false));
        let (stop, stop_rx) = oneshot::channel();
        let task = tokio::spawn(run(worker, startup, events, emit, interrupt_requested.clone(), stop_rx));
        Ok(Live { session, interrupt_requested, stop: Some(stop), task })
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
                match &event {
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
