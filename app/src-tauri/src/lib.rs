// Glass desktop shell. The frontend calls these commands and receives every
// agent's events on one channel. See docs/architecture.md.

pub mod approvals;
mod demo;
pub mod git;
pub mod live;
pub mod manager;
pub mod mcp;
pub mod memory;
pub mod projects;
pub mod secrets;
pub mod settings;
pub mod skills;
pub mod snapshot;
pub mod store;
pub mod terminal;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager as _, RunEvent, State};

use live::{Emit, Settings};
use manager::{info, launch, live_session, stop_source, Agent, AgentInfo, Manager, Source};

type Reply<T> = Result<T, String>;

/// Run blocking work (git, files, the Keychain) off the main thread, so the window
/// never waits on it.
async fn off_main<T: Send + 'static>(work: impl FnOnce() -> Reply<T> + Send + 'static) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

fn text(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[derive(Serialize)]
struct Setup {
    worker: Option<String>,
    version: Option<String>,
    tested_version: &'static str,
    /// Mirror's saved approval mode for new sessions: auto, or manual (its `approve`).
    approval_mode: &'static str,
    keys: Vec<String>,
    api: String,
    model: String,
    base_url: Option<String>,
    /// How to install Mirror, shown when it is missing.
    mirror_command: &'static str,
}

/// Every provider key and saved variable: where it comes from and its last four
/// characters. Never a value.
#[tauri::command]
async fn secrets_status() -> Reply<Vec<secrets::Status>> {
    off_main(|| {
        settings::wait_for_login_env();
        Ok(secrets::global().map(|secrets| secrets.status()).unwrap_or_default())
    })
    .await
}

/// Save a key in the Keychain. The value is never returned or logged.
#[tauri::command]
async fn secret_set(name: String, value: String) -> Reply<()> {
    off_main(move || {
        let secrets = secrets::global().ok_or("secrets are not ready")?;
        secrets.set(&name, &value).map_err(|error| secrets.redact(&text(error)))
    })
    .await
}

#[tauri::command]
async fn secret_remove(name: String) -> Reply<()> {
    off_main(move || secrets::global().ok_or("secrets are not ready")?.remove(&name).map_err(text)).await
}

/// Remember the model new agents start with. Keys stay in the environment.
#[tauri::command]
async fn set_default_model(api: String, model: String, base_url: Option<String>, app: AppHandle) -> Reply<()> {
    let data = data_dir(&app)?;
    off_main(move || settings::save(&data, &settings::Choice { api, model, base_url: base_url.filter(|url| !url.is_empty()) }).map_err(text)).await
}

/// Is Mirror installed, which version, and which provider keys are set.
#[tauri::command]
async fn check_setup(app: AppHandle) -> Reply<Setup> {
    off_main(move || Ok(setup_now(&app))).await
}

fn setup_now(app: &AppHandle) -> Setup {
    settings::wait_for_login_env();
    let worker = glass_core::find_worker();
    // The worker reports its own version. Its package says which build it is: the
    // beta installer's `mirror` wheel or the released `reflection-mirror`, which can
    // carry the same worker version. A beta shows as one, so setup suggests the release.
    let version = worker.as_ref().and_then(|path| {
        let site = path.parent()?.parent()?.parent()?;
        let beta = std::fs::read_dir(site).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix("mirror-")?.strip_suffix(".dist-info").map(str::to_string)
        });
        let version = glass_core::worker_version(path).or_else(|| beta.clone())?;
        Some(if beta.is_some() { format!("pre-release {version}") } else { version })
    });
    let choice = data_dir(app).map(|data| settings::choice(&data)).unwrap_or_else(|_| settings::choice(Path::new("")));
    Setup {
        worker: worker.map(|path| path.display().to_string()),
        version,
        tested_version: glass_core::TESTED_MIRROR_VERSION,
        approval_mode: if memory::mirror_setting("approval_mode").as_deref() == Some("auto") { "auto" } else { "manual" },
        keys: {
            let mut keys = secrets::global().map(|secrets| secrets.present()).unwrap_or_else(|| settings::keys_present().into_iter().map(str::to_string).collect());
            for name in settings::mirror_logins() {
                if !keys.iter().any(|key| key == name) {
                    keys.push(name.to_string());
                }
            }
            keys
        },
        api: choice.api,
        model: choice.model,
        base_url: choice.base_url,
        mirror_command: "uv tool install reflection-mirror",
    }
}

#[tauri::command]
fn subscribe(events: Channel<Value>, manager: State<Manager>) {
    manager.subscribe(events);
}


fn data_dir(app: &AppHandle) -> Reply<PathBuf> {
    app_data(app).map_err(|error| error.to_string())
}

/// Glass's own files. `GLASS_DATA_DIR` points somewhere else, so a demo recording
/// starts clean and never shows the person's own projects.
fn app_data(app: &AppHandle) -> tauri::Result<PathBuf> {
    match std::env::var_os("GLASS_DATA_DIR").filter(|value| !value.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => app.path().app_data_dir(),
    }
}

#[tauri::command]
fn demo_script() -> Option<String> {
    demo::steps()
}

#[tauri::command]
fn demo_mark(name: String) {
    demo::mark(&name);
}

#[tauri::command]
async fn demo_wait_go() {
    let _ = tauri::async_runtime::spawn_blocking(demo::wait_for_go).await;
}

#[tauri::command]
async fn list_projects(app: AppHandle) -> Reply<Vec<projects::Project>> {
    let data = data_dir(&app)?;
    off_main(move || Ok(projects::list(&data))).await
}

#[tauri::command]
async fn add_project(path: String, app: AppHandle) -> Reply<projects::Project> {
    let data = data_dir(&app)?;
    off_main(move || projects::add(&data, &path).map_err(text)).await
}

/// Take a project out of the sidebar. Its folder and agents' checkouts are left alone.
#[tauri::command]
async fn remove_project(path: String, app: AppHandle) -> Reply<()> {
    let data = data_dir(&app)?;
    off_main(move || projects::remove(&data, &path).map_err(text)).await
}

/// Files in a workspace, for @ mentions in the composer.
#[tauri::command]
async fn list_files(workspace: String) -> Reply<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || projects::files(Path::new(&workspace), 20_000)).await.map_err(|error| error.to_string())
}

/// Start a live agent in `workspace` with its first message. With `checkout`, it
/// first gets its own git worktree from origin's default branch. An empty
/// `workspace` means no project: the agent gets a fresh scratch folder. Returns at
/// once; the worker launches in the background and its events arrive on the channel.
#[tauri::command]
async fn start_agent(
    workspace: String,
    message: String,
    effort: String,
    auto: bool,
    checkout: bool,
    title: String,
    api: String,
    model: String,
    base_url: Option<String>,
    race: Option<bool>,
    app: AppHandle,
    manager: State<'_, Manager>,
) -> Reply<AgentInfo> {
    let data = data_dir(&app)?;
    let scratch = workspace.is_empty();
    let workspace = if scratch {
        projects::scratch(&data, &title).map_err(text)?.display().to_string()
    } else {
        let _ = projects::add(&data, &workspace);
        workspace
    };
    let project_path = std::fs::canonicalize(&workspace).map(|path| path.display().to_string()).unwrap_or_else(|_| workspace.clone());
    let workspace = if checkout {
        let (data, project, title) = (data.clone(), workspace.clone(), title.clone());
        let local_ok = race.unwrap_or(false);
        tauri::async_runtime::spawn_blocking(move || projects::checkout_from(&data, &project, &title, local_ok))
            .await
            .map_err(|error| error.to_string())?
            .map_err(text)?
            .display()
            .to_string()
    } else {
        workspace
    };
    let workspace = std::fs::canonicalize(&workspace).map_err(|error| format!("{workspace}: {error}"))?;
    let id = manager.new_id("agent");
    let settings = Settings::new(workspace, &settings::Choice { api, model, base_url }, effort, auto);
    let agent_info = info(&id, &settings);
    let saved = store::SavedAgent {
        id: id.clone(),
        title,
        project: if scratch { "no project".to_string() } else { projects::describe(&project_path).name },
        project_path: project_path.clone(),
        workspace: agent_info.workspace.clone(),
        branch: agent_info.branch.clone(),
        api: settings.api.clone(),
        model: settings.model.clone(),
        base_url: settings.base_url.clone(),
        effort: settings.effort.clone(),
        auto: settings.auto,
        first_message: message.clone(),
        conversation_id: None,
        snapshots: vec![],
    };
    store::save(&data, &saved).map_err(text)?;
    let emit = manager.emitter(&id, Some(data));
    manager.agents.lock().await.insert(
        id.clone(),
        Agent {
            emit: emit.clone(),
            source: Source::Live { settings: settings.clone(), first_message: message.clone(), conversation_id: None, live: None },
        },
    );
    let snapshot = snapshot_before(&settings.workspace);
    // A new checkout gets the project's setup command, such as installing packages.
    let setup = if checkout { projects::setup_for(&data_dir(&app)?, &project_path) } else { None };
    spawn_launch_after(app, id, settings, None, Some(message), emit, snapshot, setup);
    Ok(agent_info)
}

/// Launch in the background and file the result under the agent.
/// Snapshot the workspace's files before a message, for rewinding. None outside git.
fn snapshot_before(workspace: &Path) -> Option<String> {
    snapshot::take(workspace, "Glass: before a message to the agent").ok()
}

fn record_snapshot(app: &AppHandle, agent: &str, message_id: &str, commit: Option<String>) {
    if let (Some(commit), Ok(data)) = (commit, data_dir(app)) {
        let _ = store::update(&data, agent, |saved| saved.snapshots.push((message_id.to_string(), commit)));
    }
}

/// Run a project's setup command in a new checkout, with its progress in the transcript.
async fn run_setup(workspace: &Path, command: &str, emit: &Emit) {
    emit(json!({ "type": "setup", "command": command, "status": "running", "exit_code": null, "tail": "" }));
    let started = std::time::Instant::now();
    let mut process = tokio::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    process.args(["-lc", command]).current_dir(workspace).kill_on_drop(true).envs(secrets::env_for_child());
    let result = tokio::time::timeout(std::time::Duration::from_secs(900), process.output()).await;
    let (status, code, tail) = match result {
        Err(_) => ("failed", None, "stopped after fifteen minutes".to_string()),
        Ok(Err(error)) => ("failed", None, error.to_string()),
        Ok(Ok(output)) => {
            let all = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            let lines: Vec<&str> = all.lines().collect();
            let tail = secrets::redact(&lines[lines.len().saturating_sub(12)..].join("\n"));
            (if output.status.success() { "done" } else { "failed" }, output.status.code(), tail)
        }
    };
    emit(json!({ "type": "setup", "command": command, "status": status, "exit_code": code, "tail": tail, "seconds": started.elapsed().as_secs() }));
}

/// `snapshot` is the files before `first`, recorded once the message has an id.
/// With `setup`, that command runs in the workspace first; the agent starts either way.
fn spawn_launch(app: AppHandle, id: String, settings: Settings, resume: Option<String>, first: Option<String>, emit: Emit, snapshot: Option<String>) {
    spawn_launch_after(app, id, settings, resume, first, emit, snapshot, None)
}

#[allow(clippy::too_many_arguments)]
fn spawn_launch_after(app: AppHandle, id: String, settings: Settings, resume: Option<String>, first: Option<String>, emit: Emit, snapshot: Option<String>, setup: Option<String>) {
    tauri::async_runtime::spawn(async move {
        if let Some(command) = &setup {
            run_setup(&settings.workspace, command, &emit).await;
        }
        let hub = app.state::<Arc<mcp::Hub>>().inner().clone();
        let result = launch(settings, resume, first, emit.clone(), Some(hub)).await;
        let manager = app.state::<Manager>();
        let mut agents = manager.agents.lock().await;
        match (result, agents.get_mut(&id)) {
            (Ok((new_live, sent)), Some(Agent { source: Source::Live { live, conversation_id, .. }, .. })) => {
                let conversation = new_live.conversation_id().to_string();
                if let Some(sent) = &sent {
                    record_snapshot(&app, &id, sent, snapshot);
                }
                if let Ok(data) = data_dir(&app) {
                    let _ = store::update(&data, &id, |saved| saved.conversation_id = Some(conversation.clone()));
                }
                *conversation_id = Some(conversation);
                *live = Some(new_live);
            }
            // The agent was closed while its worker was starting.
            (Ok((new_live, _)), _) => {
                drop(agents);
                new_live.stop().await;
            }
            (Err(error), _) => emit(json!({ "type": "closed", "error": text(error) })),
        }
    });
}

/// Send a message. A restored or crashed agent with no worker is relaunched first,
/// resuming its conversation, and the message goes as its first input. Returns the
/// message id, or an empty string when the worker is still starting.
#[tauri::command]
async fn send_message(agent: String, message: String, app: AppHandle, manager: State<'_, Manager>) -> Reply<String> {
    let mut agents = manager.agents.lock().await;
    if let Some(Agent { source: Source::Live { live: None, settings, conversation_id, .. }, emit }) = agents.get_mut(&agent) {
        let (settings, resume, emit) = (settings.clone(), conversation_id.clone(), emit.clone());
        drop(agents);
        let snapshot = snapshot_before(&settings.workspace);
        spawn_launch(app, agent, settings, resume, Some(message), emit, snapshot);
        return Ok(String::new());
    }
    let live = live_session(&agents, &agent).map_err(text)?;
    let snapshot = snapshot_before(&live.workspace);
    let id = live.session.send_user(&message).map_err(text)?;
    record_snapshot(&app, &agent, &id, snapshot);
    Ok(id)
}

#[derive(Serialize)]
struct Rewound {
    /// Whether the files were put back too.
    files_restored: bool,
    /// Files that did not exist before the message and were removed.
    removed: Vec<String>,
}

/// Rewind an agent to just before one of its messages, as Mirror's own client does:
/// fork the conversation there and continue on the fork, so the original is kept.
/// With `restore_files`, also put the workspace's files back as they were then.
#[tauri::command]
async fn rewind_agent(agent: String, entry_id: String, restore_files: bool, app: AppHandle, manager: State<'_, Manager>) -> Reply<Rewound> {
    let data = data_dir(&app)?;
    let mut agents = manager.agents.lock().await;
    let Some(Agent { source: Source::Live { settings, conversation_id, live, .. }, emit }) = agents.get_mut(&agent) else {
        return Err("no such agent".into());
    };
    let (settings, emit, resume) = (settings.clone(), emit.clone(), conversation_id.clone());
    let current = match live.take() {
        Some(current) => current,
        // A restored agent has no worker yet; start one on its conversation to fork it.
        None => {
            drop(agents);
            let resume = resume.ok_or("this agent never started, so there is nothing to rewind")?;
            let hub = app.state::<Arc<mcp::Hub>>().inner().clone();
            let (started, _) = launch(settings.clone(), Some(resume), None, emit.clone(), Some(hub)).await.map_err(text)?;
            agents = manager.agents.lock().await;
            started
        }
    };
    let Some(Agent { source: Source::Live { conversation_id, live, .. }, .. }) = agents.get_mut(&agent) else {
        current.stop().await;
        return Err("the agent was closed".into());
    };
    let forked = match current.session.fork(&entry_id).await {
        Ok(forked) => forked,
        Err(error) => {
            *live = Some(current);
            return Err(text(error));
        }
    };
    *conversation_id = Some(forked.clone());
    drop(agents);
    current.stop().await;
    let _ = store::update(&data, &agent, |saved| {
        saved.conversation_id = Some(forked.clone());
        if let Some(at) = saved.snapshots.iter().position(|(message, _)| message == &entry_id) {
            saved.snapshots.truncate(at + 1);
        }
    });
    let mut result = Rewound { files_restored: false, removed: vec![] };
    if restore_files {
        let commit = store::load(&data).into_iter().find(|saved| saved.id == agent).and_then(|saved| saved.snapshots.into_iter().find(|(message, _)| message == &entry_id)).map(|(_, commit)| commit);
        let commit = commit.ok_or("Glass has no snapshot of the files from before that message, so only the conversation was rewound.")?;
        let workspace = settings.workspace.clone();
        result.removed = tauri::async_runtime::spawn_blocking(move || snapshot::restore(&workspace, &commit)).await.map_err(|error| error.to_string())?.map_err(text)?;
        result.files_restored = true;
    }
    // The transcript drops this message and everything after; the log keeps the marker.
    emit(json!({ "type": "truncate", "from": entry_id }));
    spawn_launch(app, agent, settings, Some(forked), None, emit, None);
    Ok(result)
}

/// Agents saved by an earlier run, with their event logs. Registered with no worker;
/// the first message or a restart relaunches one. Call once, at startup.
#[tauri::command]
async fn restore_agents(app: AppHandle, manager: State<'_, Manager>) -> Reply<Vec<store::Restored>> {
    let data = data_dir(&app)?;
    let restored = store::restore(&data);
    let mut agents = manager.agents.lock().await;
    for entry in &restored {
        let saved = &entry.agent;
        if agents.contains_key(&saved.id) {
            continue;
        }
        let settings = Settings::new(
            PathBuf::from(&saved.workspace),
            &settings::Choice { api: saved.api.clone(), model: saved.model.clone(), base_url: saved.base_url.clone() },
            saved.effort.clone(),
            saved.auto,
        );
        agents.insert(
            saved.id.clone(),
            Agent {
                emit: manager.emitter(&saved.id, Some(data.clone())),
                source: Source::Live { settings, first_message: saved.first_message.clone(), conversation_id: saved.conversation_id.clone(), live: None },
            },
        );
    }
    Ok(restored)
}

#[tauri::command]
async fn resolve_approval(agent: String, call_id: String, approved: bool, manager: State<'_, Manager>) -> Reply<()> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.session.resolve_approval(&call_id, approved)).map_err(text)
}

/// What remembering this request would save, for the approval card.
#[tauri::command]
async fn approval_offer(agent: String, call_id: String, manager: State<'_, Manager>) -> Reply<Option<approvals::Offer>> {
    let agents = manager.agents.lock().await;
    Ok(live_session(&agents, &agent).ok().and_then(|live| live.approval_offer(&call_id)))
}

/// Approve and remember, in Mirror's shared tool_approvals.json.
#[tauri::command]
async fn approve_and_remember(agent: String, call_id: String, manager: State<'_, Manager>) -> Reply<()> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.approve_and_remember(&call_id)).map_err(text)
}

/// Ask Mirror to compact this agent's context now.
#[tauri::command]
async fn compact(agent: String, manager: State<'_, Manager>) -> Reply<()> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.session.compact()).map_err(text)
}

/// Cancel one background task, such as a subagent.
#[tauri::command]
async fn cancel_task(agent: String, task_id: String, manager: State<'_, Manager>) -> Reply<()> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.session.cancel_task(&task_id)).map_err(text)
}

#[tauri::command]
async fn interrupt(agent: String, manager: State<'_, Manager>) -> Reply<()> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.interrupt()).map_err(text)
}

/// Model, endpoint and reasoning effort for the agent's next turn.
#[tauri::command]
async fn set_inference(
    agent: String,
    api: String,
    model: String,
    base_url: Option<String>,
    effort: String,
    app: AppHandle,
    manager: State<'_, Manager>,
) -> Reply<()> {
    let mut agents = manager.agents.lock().await;
    let Some(Agent { source: Source::Live { settings, live, .. }, .. }) = agents.get_mut(&agent) else {
        return Ok(());
    };
    settings.api = api;
    settings.model = model;
    settings.base_url = base_url.filter(|url| !url.is_empty());
    settings.effort = effort;
    if let Ok(data) = data_dir(&app) {
        let copy = settings.clone();
        let _ = store::update(&data, &agent, |saved| {
            saved.api = copy.api;
            saved.model = copy.model;
            saved.base_url = copy.base_url;
            saved.effort = copy.effort;
        });
    }
    match live {
        Some(live) => live.session.set_inference(&settings.inference()).map_err(text),
        None => Ok(()),
    }
}

#[tauri::command]
async fn set_approval_mode(agent: String, auto: bool, app: AppHandle, manager: State<'_, Manager>) -> Reply<()> {
    let mut agents = manager.agents.lock().await;
    let Some(Agent { source: Source::Live { settings, live, .. }, .. }) = agents.get_mut(&agent) else {
        return Ok(());
    };
    settings.auto = auto;
    if let Ok(data) = data_dir(&app) {
        let _ = store::update(&data, &agent, |saved| saved.auto = auto);
    }
    let mode = if auto { glass_core::ApprovalMode::Auto } else { glass_core::ApprovalMode::Manual };
    match live {
        Some(live) => live.session.set_approval_mode(mode).map_err(text),
        None => Ok(()),
    }
}

#[tauri::command]
/// Close an agent: stop its worker and forget it. Its checkout and Mirror's copy of
/// the conversation are left alone.
async fn stop_agent(agent: String, app: AppHandle, manager: State<'_, Manager>) -> Reply<()> {
    let removed = manager.agents.lock().await.remove(&agent);
    if let Some(removed) = removed {
        stop_source(removed.source).await;
    }
    store::remove(&data_dir(&app)?, &agent).map_err(text)
}

/// Relaunch a live agent's worker. Resumes the conversation if it ever started.
#[tauri::command]
async fn restart_agent(agent: String, app: AppHandle, manager: State<'_, Manager>) -> Reply<()> {
    let mut agents = manager.agents.lock().await;
    let Some(Agent { source: Source::Live { settings, first_message, conversation_id, live }, emit }) = agents.get_mut(&agent) else {
        return Err("only a live agent can restart".to_string());
    };
    let old = live.take();
    let (settings, resume, emit) = (settings.clone(), conversation_id.clone(), emit.clone());
    let first = if resume.is_none() { Some(first_message.clone()) } else { None };
    drop(agents);
    if let Some(old) = old {
        old.stop().await;
    }
    spawn_launch(app, agent, settings, resume, first, emit, None);
    Ok(())
}

/// What changed in the workspace compared with its base, from git.
#[tauri::command]
async fn workspace_changes(workspace: String, context: u32) -> Reply<git::Changes> {
    tauri::async_runtime::spawn_blocking(move || git::changes(std::path::Path::new(&workspace), context))
        .await
        .map_err(|error| error.to_string())?
        .map_err(text)
}

static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Quit for real, after the UI has asked or found nothing running.
#[tauri::command]
fn quit_app(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// MCP servers from Mirror's config, connected on first use, with their tools.
#[tauri::command]
async fn mcp_servers(hub: State<'_, Arc<mcp::Hub>>) -> Reply<Vec<mcp::ServerInfo>> {
    Ok(hub.servers().await)
}

/// Open a shell in `cwd` for the terminal drawer. Output arrives on `output` as
/// base64 chunks; `{"exit": true}` when the shell ends.
#[tauri::command]
fn terminal_open(id: String, cwd: String, cols: u16, rows: u16, output: Channel<Value>, terminals: State<'_, terminal::Terminals>) -> Reply<()> {
    use base64::Engine as _;
    let exit = output.clone();
    // No folder means the home folder: the terminal before any agent is open.
    let cwd = if cwd.is_empty() { std::env::var("HOME").unwrap_or_else(|_| "/".into()) } else { cwd };
    terminals
        .open(
            &id,
            Path::new(&cwd),
            cols.max(2),
            rows.max(2),
            move |bytes| {
                let _ = output.send(json!({ "data": base64::engine::general_purpose::STANDARD.encode(bytes) }));
            },
            move || {
                let _ = exit.send(json!({ "exit": true }));
            },
        )
        .map_err(text)
}

#[tauri::command]
fn terminal_write(id: String, data: String, terminals: State<'_, terminal::Terminals>) -> Reply<()> {
    terminals.write(&id, data.as_bytes()).map_err(text)
}

#[tauri::command]
fn terminal_resize(id: String, cols: u16, rows: u16, terminals: State<'_, terminal::Terminals>) -> Reply<()> {
    terminals.resize(&id, cols.max(2), rows.max(2)).map_err(text)
}

#[tauri::command]
fn terminal_close(id: String, terminals: State<'_, terminal::Terminals>) {
    terminals.close(&id);
}

/// Write an exported session where the person chose, from the save dialog.
#[tauri::command]
async fn save_text(path: String, contents: String) -> Reply<()> {
    off_main(move || std::fs::write(&path, contents).map_err(|error| format!("{path}: {error}"))).await
}

#[derive(Serialize)]
struct Check {
    exit_code: Option<i32>,
    /// The last lines of its output, keys blanked out.
    tail: String,
    /// To a tenth of a second: most checks take under one.
    seconds: f64,
}

/// Run an effort race's check command, such as the tests, in one runner's workspace.
#[tauri::command]
async fn run_check(workspace: String, command: String) -> Reply<Check> {
    let started = std::time::Instant::now();
    let mut process = tokio::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
    process.args(["-lc", &command]).current_dir(&workspace).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(600), process.output())
        .await
        .map_err(|_| "the check ran for more than ten minutes".to_string())?
        .map_err(|error| error.to_string())?;
    let all = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let lines: Vec<&str> = all.lines().collect();
    let tail = lines[lines.len().saturating_sub(12)..].join("\n");
    Ok(Check { exit_code: output.status.code(), tail: secrets::redact(&tail), seconds: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0 })
}

/// Commit the agent's workspace; with a title, also push and open a pull request.
#[tauri::command]
async fn commit_changes(workspace: String, message: String, push: bool, pr_title: Option<String>, pr_body: Option<String>) -> Reply<git::Committed> {
    tauri::async_runtime::spawn_blocking(move || {
        let pull_request = pr_title.as_deref().map(|title| (title, pr_body.as_deref().unwrap_or("")));
        git::commit(Path::new(&workspace), &message, push, pull_request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(text)
}

/// Skills an agent in `workspace` can use, or the personal ones with no workspace.
#[tauri::command]
async fn list_skills(workspace: Option<String>) -> Reply<Vec<skills::Skill>> {
    tauri::async_runtime::spawn_blocking(move || skills::list(workspace.as_deref().filter(|path| !path.is_empty()).map(Path::new)))
        .await
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
struct MemoryInfo {
    enabled: bool,
    store: String,
    skills_dir: String,
    records: Vec<memory::Record>,
}

/// Whether Mirror's personal memory is on, and what it holds. Read-only.
#[tauri::command]
async fn memory_info() -> Reply<MemoryInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = memory::store_dir();
        Ok(MemoryInfo {
            enabled: memory::enabled(),
            records: memory::records(&store, 500).unwrap_or_default(),
            store: store.display().to_string(),
            skills_dir: skills::global_dir().display().to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Entries from Mirror's `~/.mirror/models.json`, for the model picker.
#[tauri::command]
async fn mirror_models() -> Reply<Vec<settings::MirrorModel>> {
    off_main(|| Ok(settings::mirror_models())).await
}

/// Import the memories Claude Code and Codex keep on this Mac, with Mirror's own
/// `mirror-agent memory import`, as Mirror's "Import memories" does. Returns what it said.
#[tauri::command]
async fn memory_import() -> Reply<String> {
    off_main(|| {
        settings::wait_for_login_env();
        let worker = glass_core::find_worker().ok_or("Mirror is not installed")?;
        let output = std::process::Command::new(worker).args(["memory", "import"]).stdin(std::process::Stdio::null()).output().map_err(|error| error.to_string())?;
        let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let said = secrets::redact(said.trim());
        if output.status.success() { Ok(said) } else { Err(if said.is_empty() { "the import failed".to_string() } else { said }) }
    })
    .await
}

/// Mirror's pinned memories file, always in front of the model while memory is on.
/// Created empty if missing, so it can be opened and edited.
#[tauri::command]
async fn pinned_memories_path() -> Reply<String> {
    off_main(|| {
        let path = memory::config_path().with_file_name("PINNED_MEMORIES.md");
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(&path, "").map_err(|error| error.to_string())?;
        }
        Ok(path.display().to_string())
    })
    .await
}

/// Turn memory on or off, in Mirror's own settings. Applies to agents started after.
#[tauri::command]
async fn set_memory(enabled: bool) -> Reply<()> {
    off_main(move || memory::set_enabled(enabled).map_err(text)).await
}

/// Create or edit a skill. `scope` is personal or project; `previous` is the skill
/// being edited. Returns where it was written.
#[tauri::command]
async fn skill_save(scope: String, project: Option<String>, name: String, description: String, instructions: String, previous: Option<String>) -> Reply<String> {
    off_main(move || {
        let folder = skills::folder_for(&scope, project.as_deref().map(Path::new)).map_err(text)?;
        skills::save(&folder, name.trim(), &description, &instructions, previous.as_deref().map(Path::new)).map(|path| path.display().to_string()).map_err(text)
    })
    .await
}

#[tauri::command]
async fn skill_instructions(path: String) -> Reply<String> {
    off_main(move || skills::instructions(Path::new(&path)).map_err(text)).await
}

#[tauri::command]
async fn skill_delete(path: String) -> Reply<()> {
    off_main(move || skills::remove(Path::new(&path)).map_err(text)).await
}

/// Add, change or forget a memory through Mirror's own memory tool.
#[tauri::command]
async fn memory_save(arguments: Value, app: AppHandle) -> Reply<String> {
    memory::call(&data_dir(&app)?, arguments).await.map_err(text)
}

#[tauri::command]
async fn set_project_setup(path: String, command: Option<String>, app: AppHandle) -> Reply<()> {
    let data = data_dir(&app)?;
    off_main(move || projects::set_setup(&data, &path, command).map_err(text)).await
}

/// Open a folder or file with the system's default app.
#[tauri::command]
fn open_in_editor(path: String) -> Reply<()> {
    // The personal skills folder may not exist yet; make it so it can be opened.
    if Path::new(&path) == skills::global_dir() {
        let _ = std::fs::create_dir_all(&path);
    }
    std::process::Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|error| error.to_string())
}

pub fn run() {
    // Opened from the Dock, the app has none of the shell's variables. Take the
    // provider keys and paths from the login shell, in the background; anything
    // that needs them waits for it.
    settings::start_login_env_import();
    let app = tauri::Builder::default()
        .setup(|app| {
            let data = app_data(app.handle())?;
            secrets::install(Arc::new(secrets::Secrets::new(Box::new(secrets::Keychain), &data)));
            // A demo recording fills the screen below the menu bar, the same every time.
            if demo::enabled() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_position(tauri::LogicalPosition::new(0.0, 25.0));
                    let _ = window.set_size(tauri::LogicalSize::new(1440.0, 875.0));
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Manager::default())
        .manage(Arc::new(mcp::Hub::default()))
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            approval_offer,
            memory_import,
            mirror_models,
            pinned_memories_path,
            approve_and_remember,
            compact,
            demo_script,
            demo_mark,
            demo_wait_go,
            check_setup,
            subscribe,
            start_agent,
            send_message,
            resolve_approval,
            interrupt,
            cancel_task,
            set_inference,
            set_default_model,
            set_approval_mode,
            stop_agent,
            restart_agent,
            open_in_editor,
            workspace_changes,
            list_projects,
            add_project,
            remove_project,
            list_files,
            mcp_servers,
            secrets_status,
            secret_set,
            secret_remove,
            save_text,
            list_skills,
            memory_info,
            set_memory,
            skill_save,
            skill_instructions,
            skill_delete,
            memory_save,
            set_project_setup,
            commit_changes,
            run_check,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            restore_agents,
            rewind_agent,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Glass");
    app.run(|app, event| match event {
        // Quitting stops every worker, so the UI asks first when agents are working.
        RunEvent::ExitRequested { api, .. } if !QUIT_CONFIRMED.load(Ordering::SeqCst) => {
            api.prevent_exit();
            let _ = app.emit("quit-requested", ());
        }
        // No orphans: every worker stops when the app quits.
        RunEvent::Exit => {
            app.state::<terminal::Terminals>().close_all();
            tauri::async_runtime::block_on(app.state::<Manager>().stop_all());
        }
        _ => {}
    });
}
