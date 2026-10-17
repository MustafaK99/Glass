//! Mirror's personal memory. The worker owns it: with a `memory_dir` it gives the
//! model `search_memory` and `save_memory`, kept in `memory.sqlite3` there. Glass
//! uses the same switch as Mirror's `/memory on`, in `~/.mirror/config.json`, so
//! the CLI and Glass agree, and lists the memories read-only for Settings.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Map, Value};

const KEY: &str = "builtin/memory";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

pub fn config_path() -> PathBuf {
    home().join(".mirror").join("config.json")
}

/// Where the worker keeps memories when they are on.
pub fn store_dir() -> PathBuf {
    home().join(".mirror").join("memory")
}

fn read_config(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).and_then(|value| value.as_object().cloned()).unwrap_or_default()
}

/// A top-level string setting in Mirror's `~/.mirror/config.json`, such as
/// `approval_mode`, which Mirror's CLI saves when you choose a mode.
pub fn mirror_setting(key: &str) -> Option<String> {
    read_config(&config_path()).get(key).and_then(Value::as_str).map(str::to_string)
}

/// On only when the entry's `config.enabled` is `true` and the entry is not
/// disabled, exactly as Mirror's client decides.
pub fn enabled_in(path: &Path) -> bool {
    let config = read_config(path);
    let entry = config.get("extensions").and_then(|extensions| extensions.get(KEY));
    match entry {
        Some(Value::Object(entry)) => entry.get("enabled") != Some(&Value::Bool(false)) && entry.get("config").and_then(|config| config.get("enabled")) == Some(&Value::Bool(true)),
        _ => false,
    }
}

pub fn enabled() -> bool {
    enabled_in(&config_path())
}

/// Turn memory on or off in Mirror's settings file, changing nothing else in it.
pub fn set_enabled_in(path: &Path, on: bool) -> Result<()> {
    let mut config = read_config(path);
    let extensions = config.entry("extensions").or_insert_with(|| json!({}));
    if !extensions.is_object() {
        bail!("{} has an extensions value that is not an object; edit it by hand", path.display());
    }
    let extensions = extensions.as_object_mut().unwrap();
    let entry = extensions.entry(KEY).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let entry = entry.as_object_mut().unwrap();
    if on {
        entry.remove("enabled");
    }
    let settings = entry.entry("config").or_insert_with(|| json!({}));
    if !settings.is_object() {
        *settings = json!({});
    }
    settings.as_object_mut().unwrap().insert("enabled".into(), Value::Bool(on));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.glass-tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(&Value::Object(config))? + "\n")?;
    std::fs::rename(&temp, path).context("could not update Mirror's settings")?;
    Ok(())
}

pub fn set_enabled(on: bool) -> Result<()> {
    set_enabled_in(&config_path(), on)
}

#[derive(Serialize, Debug)]
pub struct Record {
    pub id: String,
    /// The kebab-case handle the memory tool uses to replace or forget it.
    pub key: String,
    /// When it applies, if said.
    pub situation: String,
    /// preference, fact, procedure, pitfall or reference.
    pub kind: String,
    pub content: String,
    pub repository: String,
    /// Who wrote it: user, extractor, consolidator or import.
    pub actor: String,
    pub updated_at: i64,
}

/// Active memories, newest first, read-only. Empty when there is no store yet.
pub fn records(dir: &Path, limit: usize) -> Result<Vec<Record>> {
    let database = dir.join("memory.sqlite3");
    if !database.exists() {
        return Ok(Vec::new());
    }
    let query = format!(
        "SELECT id, key, situation, type AS kind, content, repository, actor, updated_at FROM memory_record WHERE status = 'active' ORDER BY updated_at DESC LIMIT {limit};"
    );
    let output = Command::new("sqlite3").args(["-readonly", "-json"]).arg(&database).arg(&query).output().context("could not run sqlite3")?;
    if !output.status.success() {
        bail!("could not read memories: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = serde_json::from_str(&text)?;
    Ok(rows
        .into_iter()
        .map(|row| Record {
            id: row["id"].as_str().unwrap_or_default().to_string(),
            key: row["key"].as_str().unwrap_or_default().to_string(),
            situation: row["situation"].as_str().unwrap_or_default().to_string(),
            kind: row["kind"].as_str().unwrap_or_default().to_string(),
            content: row["content"].as_str().unwrap_or_default().to_string(),
            repository: row["repository"].as_str().unwrap_or_default().to_string(),
            actor: row["actor"].as_str().unwrap_or_default().to_string(),
            updated_at: row["updated_at"].as_i64().unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_memory_like_mirror_and_keeps_other_settings() {
        let dir = std::env::temp_dir().join(format!("glass-memory-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"approval_mode": "hitl", "extensions": {"core/todo": true}}"#).unwrap();
        assert!(!enabled_in(&path));
        set_enabled_in(&path, true).unwrap();
        assert!(enabled_in(&path));
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["approval_mode"], "hitl");
        assert_eq!(written["extensions"]["core/todo"], true);
        assert_eq!(written["extensions"][KEY], json!({ "config": { "enabled": true } }));
        set_enabled_in(&path, false).unwrap();
        assert!(!enabled_in(&path));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_store_means_no_memories() {
        assert!(records(Path::new("/nonexistent/glass"), 10).unwrap().is_empty());
    }
}

/// Run Mirror's own memory tool, with no model: a short-lived worker in a private
/// folder, with the memory store, one `save_memory` call, then stopped. This is how
/// Glass adds, edits and forgets memories without touching Mirror's database itself.
pub async fn call(data: &Path, arguments: Value) -> Result<String> {
    let workspace = data.join("memory-worker");
    std::fs::create_dir_all(&workspace)?;
    let mut settings = crate::live::Settings::new(workspace, &crate::settings::choice(data), "low".into(), true);
    settings.memory_dir = Some(store_dir());
    let emit: crate::live::Emit = std::sync::Arc::new(|_| {});
    let live = crate::live::Live::start(&settings, None, emit, None).await?;
    let result = live.session.call_tool("save_memory", &arguments).await;
    live.stop().await;
    let (content, success) = result?;
    if !success {
        bail!("{content}");
    }
    Ok(content)
}
