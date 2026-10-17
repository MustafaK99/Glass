//! Agents survive a restart. Glass keeps each live agent's settings and its event
//! log in its own data folder; the UI folds the log back into the same screen.
//! Mirror keeps the conversation itself, which a relaunched worker resumes.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Pieces of a stream that the finished records repeat. Not worth keeping.
const TRANSIENT: &[&str] = &["text", "reasoning", "tool_call_delta", "speed", "log"];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SavedAgent {
    pub id: String,
    pub title: String,
    pub project: String,
    pub project_path: String,
    pub workspace: String,
    pub branch: String,
    pub api: String,
    pub model: String,
    pub base_url: Option<String>,
    pub effort: String,
    pub auto: bool,
    pub first_message: String,
    pub conversation_id: Option<String>,
    /// (user message id, snapshot commit) for each message, oldest first, so a
    /// rewind can put the files back as they were before that message.
    #[serde(default)]
    pub snapshots: Vec<(String, String)>,
    /// A workspace tag's id, from Mirror's `workspace_tags`.
    #[serde(default)]
    pub tag: Option<String>,
    /// Mirror's sandbox config, when the agent works in a sandbox; the same id
    /// brings back the same VM.
    #[serde(default)]
    pub sandbox: Option<Value>,
}

#[derive(Serialize)]
pub struct Restored {
    pub agent: SavedAgent,
    pub events: Vec<Value>,
}

fn index(data: &Path) -> PathBuf {
    data.join("agents.json")
}

fn log(data: &Path, id: &str) -> PathBuf {
    data.join("logs").join(format!("{id}.jsonl"))
}

pub fn load(data: &Path) -> Vec<SavedAgent> {
    std::fs::read_to_string(index(data)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn store(data: &Path, agents: &[SavedAgent]) -> Result<()> {
    std::fs::create_dir_all(data)?;
    let temp = data.join("agents.json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(agents)?)?;
    std::fs::rename(temp, index(data))?;
    Ok(())
}

/// Add or replace one agent's record.
pub fn save(data: &Path, agent: &SavedAgent) -> Result<()> {
    let mut agents = load(data);
    match agents.iter_mut().find(|entry| entry.id == agent.id) {
        Some(entry) => *entry = agent.clone(),
        None => agents.push(agent.clone()),
    }
    store(data, &agents)
}

pub fn update(data: &Path, id: &str, change: impl FnOnce(&mut SavedAgent)) -> Result<()> {
    let mut agents = load(data);
    if let Some(entry) = agents.iter_mut().find(|entry| entry.id == id) {
        change(entry);
        store(data, &agents)?;
    }
    Ok(())
}

/// Forget an agent and its log.
pub fn remove(data: &Path, id: &str) -> Result<()> {
    let mut agents = load(data);
    agents.retain(|entry| entry.id != id);
    let _ = std::fs::remove_file(log(data, id));
    store(data, &agents)
}

/// Append one event to the agent's log, unless it is a transient stream piece.
pub fn append(data: &Path, id: &str, event: &Value) {
    if TRANSIENT.contains(&event["type"].as_str().unwrap_or_default()) {
        return;
    }
    let path = log(data, id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{event}");
    }
}

/// Every saved agent with its log, oldest first.
pub fn restore(data: &Path) -> Vec<Restored> {
    load(data)
        .into_iter()
        .map(|agent| {
            let events = std::fs::read_to_string(log(data, &agent.id))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            Restored { agent, events }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent(id: &str) -> SavedAgent {
        SavedAgent {
            id: id.into(),
            title: "Fix the test".into(),
            project: "demo".into(),
            project_path: "/tmp/demo".into(),
            workspace: "/tmp/demo".into(),
            branch: "main".into(),
            api: "openai-responses".into(),
            model: "gpt-5-nano".into(),
            base_url: None,
            effort: "high".into(),
            auto: false,
            first_message: "Fix the test.".into(),
            conversation_id: None,
            snapshots: vec![],
            tag: None,
            sandbox: None,
        }
    }

    #[test]
    fn agents_and_their_logs_survive_and_can_be_forgotten() {
        let data = std::env::temp_dir().join(format!("glass-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        save(&data, &agent("a1")).unwrap();
        update(&data, "a1", |entry| entry.conversation_id = Some("c1".into())).unwrap();
        append(&data, "a1", &json!({ "type": "turn_started" }));
        append(&data, "a1", &json!({ "type": "text", "delta": "skipped" }));
        append(&data, "a1", &json!({ "type": "turn_completed" }));

        let restored = restore(&data);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].agent.conversation_id.as_deref(), Some("c1"));
        let kinds: Vec<_> = restored[0].events.iter().map(|event| event["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["turn_started", "turn_completed"]);

        remove(&data, "a1").unwrap();
        assert!(restore(&data).is_empty());
        std::fs::remove_dir_all(&data).unwrap();
    }
}
