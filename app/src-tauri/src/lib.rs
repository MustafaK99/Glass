// Glass desktop shell. The frontend calls these commands and receives every
// agent's events on one channel. See docs/architecture.md.

pub mod git;
pub mod live;
pub mod manager;
pub mod projects;
pub mod replay;
pub mod settings;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, RunEvent, State};

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
    let emit = manager.emitter(&id);
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
    let workspace = if workspace.is_empty() {
        projects::scratch(&data, &title).map_err(text)?.display().to_string()
    } else {
        let _ = projects::add(&data, &workspace);
        workspace
    };
    let workspace = if checkout {
        let (data, project) = (data.clone(), workspace.clone());
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
    let emit = manager.emitter(&id);
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
                *conversation_id = Some(new_live.conversation_id().to_string());
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

#[tauri::command]
async fn send_message(agent: String, message: String, manager: State<'_, Manager>) -> Reply<String> {
    let agents = manager.agents.lock().await;
    live_session(&agents, &agent).and_then(|live| live.session.send_user(&message)).map_err(text)
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
    match live {
        Some(live) => live.session.set_inference(&settings.inference()).map_err(text),
        None => Ok(()),
    }
}

#[tauri::command]
async fn set_approval_mode(agent: String, auto: bool, manager: State<'_, Manager>) -> Reply<()> {
    let mut agents = manager.agents.lock().await;
    let Some(Agent { source: Source::Live { settings, live, .. }, .. }) = agents.get_mut(&agent) else {
        return Ok(());
    };
    settings.auto = auto;
    let mode = if auto { glass_core::ApprovalMode::Auto } else { glass_core::ApprovalMode::Manual };
    match live {
        Some(live) => live.session.set_approval_mode(mode).map_err(text),
        None => Ok(()),
    }
}

#[tauri::command]
async fn stop_agent(agent: String, manager: State<'_, Manager>) -> Reply<()> {
    let removed = manager.agents.lock().await.remove(&agent);
    if let Some(agent) = removed {
        stop_source(agent.source).await;
    }
    Ok(())
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
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Glass");
    app.run(|app, event| {
        // No orphans: every worker stops when the app quits.
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(app.state::<Manager>().stop_all());
        }
    });
}
