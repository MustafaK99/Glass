// Glass desktop shell. The frontend calls these commands and receives every
// agent's events on one channel. See docs/architecture.md.

pub mod git;
pub mod live;
pub mod manager;
pub mod mcp;
pub mod projects;
pub mod secrets;
pub mod settings;
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

fn text(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[derive(Serialize)]
struct Setup {
    worker: Option<String>,
    version: Option<String>,
    tested_version: &'static str,
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
fn secrets_status() -> Vec<secrets::Status> {
    secrets::global().map(|secrets| secrets.status()).unwrap_or_default()
}

/// Save a key in the Keychain. The value is never returned or logged.
#[tauri::command]
fn secret_set(name: String, value: String) -> Reply<()> {
    let secrets = secrets::global().ok_or("secrets are not ready")?;
    secrets.set(&name, &value).map_err(|error| secrets.redact(&text(error)))
}

#[tauri::command]
fn secret_remove(name: String) -> Reply<()> {
    secrets::global().ok_or("secrets are not ready")?.remove(&name).map_err(text)
}

/// Remember the model new agents start with. Keys stay in the environment.
#[tauri::command]
fn set_default_model(api: String, model: String, base_url: Option<String>, app: AppHandle) -> Reply<()> {
    settings::save(&data_dir(&app)?, &settings::Choice { api, model, base_url: base_url.filter(|url| !url.is_empty()) }).map_err(text)
}

/// Is Mirror installed, which version, and which provider keys are set.
#[tauri::command]
fn check_setup(app: AppHandle) -> Setup {
    let worker = glass_core::find_worker();
    // The worker sits in site-packages/mirror/bin; the wheel's dist-info names the version.
    let version = worker.as_ref().and_then(|path| {
        let site = path.parent()?.parent()?.parent()?;
        std::fs::read_dir(site).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix("mirror-")?.strip_suffix(".dist-info").map(str::to_string)
        })
    });
    let choice = data_dir(&app).map(|data| settings::choice(&data)).unwrap_or_else(|_| settings::choice(Path::new("")));
    Setup {
        worker: worker.map(|path| path.display().to_string()),
        version,
        tested_version: glass_core::TESTED_MIRROR_VERSION,
        keys: secrets::global().map(|secrets| secrets.present()).unwrap_or_else(|| settings::keys_present().into_iter().map(str::to_string).collect()),
        api: choice.api,
        model: choice.model,
        base_url: choice.base_url,
        mirror_command: "curl -fsSL https://raw.githubusercontent.com/reflection-oss/mirror-beta/main/install.sh | bash",
    }
}

#[tauri::command]
fn subscribe(events: Channel<Value>, manager: State<Manager>) {
    manager.subscribe(events);
}


fn data_dir(app: &AppHandle) -> Reply<PathBuf> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Reply<Vec<projects::Project>> {
    Ok(projects::list(&data_dir(&app)?))
}

#[tauri::command]
fn add_project(path: String, app: AppHandle) -> Reply<projects::Project> {
    projects::add(&data_dir(&app)?, &path).map_err(text)
}

/// Take a project out of the sidebar. Its folder and agents' checkouts are left alone.
#[tauri::command]
fn remove_project(path: String, app: AppHandle) -> Reply<()> {
    projects::remove(&data_dir(&app)?, &path).map_err(text)
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
        tauri::async_runtime::spawn_blocking(move || projects::checkout(&data, &project, &title))
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
        project_path,
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
    spawn_launch(app, id, settings, None, Some(message), emit, snapshot);
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

/// `snapshot` is the files before `first`, recorded once the message has an id.
fn spawn_launch(app: AppHandle, id: String, settings: Settings, resume: Option<String>, first: Option<String>, emit: Emit, snapshot: Option<String>) {
    tauri::async_runtime::spawn(async move {
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
fn save_text(path: String, contents: String) -> Reply<()> {
    std::fs::write(&path, contents).map_err(|error| format!("{path}: {error}"))
}

/// Open a folder or file with the system's default app.
#[tauri::command]
fn open_in_editor(path: String) -> Reply<()> {
    std::process::Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|error| error.to_string())
}

pub fn run() {
    // Opened from the Dock, the app has none of the shell's variables. Take the
    // provider keys and paths from the login shell, once, before any worker starts.
    settings::import_login_env();
    let app = tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            secrets::install(Arc::new(secrets::Secrets::new(Box::new(secrets::Keychain), &data)));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Manager::default())
        .manage(Arc::new(mcp::Hub::default()))
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
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
