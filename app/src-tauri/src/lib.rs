// Glass desktop shell. The frontend calls these commands and receives every
// agent's events on one channel. See docs/architecture.md.

pub mod git;
pub mod live;
pub mod manager;
pub mod projects;
pub mod replay;
pub mod settings;
pub mod store;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager as _, RunEvent, State};

use live::{Emit, Settings};
use manager::{info, launch, live_session, stop_source, Agent, AgentInfo, Manager, Source};
use replay::Replay;

type Reply<T> = Result<T, String>;

fn text(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[derive(Serialize)]
struct Setup {
    worker: Option<String>,
    version: Option<String>,
    tested_version: &'static str,
    keys: Vec<&'static str>,
    api: String,
    model: String,
    base_url: Option<String>,
    /// How to install Mirror, shown when it is missing.
    mirror_command: &'static str,
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
        keys: settings::keys_present(),
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

/// Recorded runs the UI can replay with no worker.
#[tauri::command]
fn fixtures() -> Vec<&'static str> {
    replay::NAMES.to_vec()
}

#[tauri::command]
async fn start_replay(name: String, manager: State<'_, Manager>) -> Reply<String> {
    let id = manager.new_id("replay");
    let emit = manager.emitter(&id, None);
    let replay = Replay::start(&name, emit.clone()).map_err(text)?;
    manager.agents.lock().await.insert(id.clone(), Agent { emit, source: Source::Replay(replay) });
    Ok(id)
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
    spawn_launch(app, id, settings, None, Some(message), emit);
    Ok(agent_info)
}

/// Launch in the background and file the result under the agent.
fn spawn_launch(app: AppHandle, id: String, settings: Settings, resume: Option<String>, first: Option<String>, emit: Emit) {
    tauri::async_runtime::spawn(async move {
        let result = launch(settings, resume, first, emit.clone()).await;
        let manager = app.state::<Manager>();
        let mut agents = manager.agents.lock().await;
        match (result, agents.get_mut(&id)) {
            (Ok(new_live), Some(Agent { source: Source::Live { live, conversation_id, .. }, .. })) => {
                let conversation = new_live.conversation_id().to_string();
                if let Ok(data) = data_dir(&app) {
                    let _ = store::update(&data, &id, |saved| saved.conversation_id = Some(conversation.clone()));
                }
                *conversation_id = Some(conversation);
                *live = Some(new_live);
            }
            // The agent was closed while its worker was starting.
            (Ok(new_live), _) => {
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
        spawn_launch(app, agent, settings, resume, Some(message), emit);
        return Ok(String::new());
    }
    live_session(&agents, &agent).and_then(|live| live.session.send_user(&message)).map_err(text)
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
    if let Some(Agent { source: Source::Replay(replay), .. }) = agents.get(&agent) {
        replay.resolve(call_id, approved);
        return Ok(());
    }
    live_session(&agents, &agent).and_then(|live| live.session.resolve_approval(&call_id, approved)).map_err(text)
}

#[tauri::command]
async fn interrupt(agent: String, manager: State<'_, Manager>) -> Reply<()> {
    let mut agents = manager.agents.lock().await;
    if let Some(Agent { source: Source::Replay(_), emit }) = agents.get(&agent) {
        // A recording has no worker to confirm the interrupt, so confirm it here.
        let emit = emit.clone();
        if let Some(agent) = agents.remove(&agent) {
            stop_source(agent.source).await;
        }
        emit(json!({ "type": "turn_interrupted" }));
        return Ok(());
    }
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
    spawn_launch(app, agent, settings, resume, first, emit);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Manager::default())
        .invoke_handler(tauri::generate_handler![
            check_setup,
            subscribe,
            fixtures,
            start_replay,
            start_agent,
            send_message,
            resolve_approval,
            interrupt,
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
            restore_agents,
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
        RunEvent::Exit => tauri::async_runtime::block_on(app.state::<Manager>().stop_all()),
        _ => {}
    });
}
