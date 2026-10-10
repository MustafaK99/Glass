// Glass desktop shell. The UI talks to agents through these commands and one
// event channel per agent. Today the only agent source is a fixture replay;
// a live `glass_core::Session` slots in behind the same commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod replay;

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use replay::Replay;

#[derive(Default)]
struct Agents {
    next_id: Mutex<u64>,
    replays: Mutex<HashMap<String, Replay>>,
}

/// Recorded runs the UI can replay with no worker.
#[tauri::command]
fn fixtures() -> Vec<&'static str> {
    replay::NAMES.to_vec()
}

/// Start replaying a recording. Events arrive on `events` in recorded order.
#[tauri::command]
fn start_replay(name: String, events: Channel<Value>, agents: State<Agents>) -> Result<String, String> {
    let replay = Replay::start(&name, events).map_err(|error| error.to_string())?;
    let mut next = agents.next_id.lock().unwrap();
    *next += 1;
    let id = format!("replay-{next}");
    agents.replays.lock().unwrap().insert(id.clone(), replay);
    Ok(id)
}

#[tauri::command]
fn resolve_approval(agent: String, call_id: String, approved: bool, agents: State<Agents>) -> Result<(), String> {
    let replays = agents.replays.lock().unwrap();
    let replay = replays.get(&agent).ok_or("no such agent")?;
    replay.resolve(call_id, approved);
    Ok(())
}

#[tauri::command]
fn stop(agent: String, agents: State<Agents>) {
    if let Some(replay) = agents.replays.lock().unwrap().remove(&agent) {
        replay.stop();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Agents::default())
        .invoke_handler(tauri::generate_handler![fixtures, start_replay, resolve_approval, stop])
        .run(tauri::generate_context!())
        .expect("failed to run Glass");
}
