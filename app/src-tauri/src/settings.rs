//! Which model new agents use, and the provider keys from the person's shell.
//!
//! Keys are never stored by Glass. They come from the environment, as Mirror
//! expects. An app opened from the Dock does not inherit a terminal's
//! environment, so at startup Glass asks the login shell for it once.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Provider key variables the worker reads, by wire protocol.
pub const KEYS: &[(&str, &str)] = &[
    ("reflection", "REFLECTION_API_KEY"),
    ("openai-responses", "OPENAI_API_KEY"),
    ("openai-chat-completions", "OPENROUTER_API_KEY"),
    ("anthropic-messages", "ANTHROPIC_API_KEY"),
];

/// Variables worth taking from the login shell when the app did not inherit them.
const IMPORTED: &[&str] = &[
    "REFLECTION_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "MIRROR_RUST_WORKER",
    "MIRROR_CODEX_AUTH_PATH",
    "MIRROR_CODEX_BASE_URL",
    "UV_TOOL_DIR",
    "XDG_DATA_HOME",
    "PATH",
];

static LOGIN_ENV: (std::sync::Mutex<bool>, std::sync::Condvar) = (std::sync::Mutex::new(false), std::sync::Condvar::new());
static LOGIN_ENV_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Read the login shell's keys and paths in the background, so the window opens at
/// once. A login shell with nvm or similar can take well over a second.
pub fn start_login_env_import() {
    LOGIN_ENV_STARTED.store(true, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(|| {
        import_login_env();
        let (done, ready) = &LOGIN_ENV;
        *done.lock().unwrap() = true;
        ready.notify_all();
    });
}

/// Block until the login shell's variables are in, before anything that needs a
/// key or a path: starting a worker, an MCP server, the setup check. Off the main thread.
pub fn wait_for_login_env() {
    // Tests and examples never start the read; they use their own environment.
    if !LOGIN_ENV_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let (done, ready) = &LOGIN_ENV;
    let guard = done.lock().unwrap();
    let _ = ready.wait_timeout_while(guard, Duration::from_secs(6), |done| !*done);
}

/// Copy provider keys and paths from the login shell into this process, without
/// overriding anything already set. Gives up quietly after a few seconds.
pub fn import_login_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(4) => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return;
            }
        }
    }
    let Ok(output) = child.wait_with_output() else { return };
    for entry in output.stdout.split(|byte| *byte == 0) {
        let entry = String::from_utf8_lossy(entry);
        let Some((name, value)) = entry.split_once('=') else { continue };
        if IMPORTED.contains(&name) && !value.is_empty() && std::env::var_os(name).map_or(true, |current| current.is_empty()) {
            std::env::set_var(name, value);
        }
    }
}

/// The model new agents start with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Choice {
    pub api: String,
    pub model: String,
    pub base_url: Option<String>,
}

impl Choice {
    /// `GLASS_API`, `GLASS_MODEL` and `GLASS_BASE_URL` override everything, for development.
    fn from_env() -> Option<Choice> {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let api = env("GLASS_API")?;
        Some(Choice { model: env("GLASS_MODEL").unwrap_or_default(), base_url: env("GLASS_BASE_URL"), api })
    }

    /// Mirror's own default.
    fn fallback() -> Choice {
        Choice { api: "reflection".to_string(), model: "Beam-1.0-501B-A23B".to_string(), base_url: None }
    }
}

fn file(data: &Path) -> PathBuf {
    data.join("settings.json")
}

/// The saved choice, unless the environment overrides it.
pub fn choice(data: &Path) -> Choice {
    Choice::from_env()
        .or_else(|| std::fs::read_to_string(file(data)).ok().and_then(|text| serde_json::from_str(&text).ok()))
        .unwrap_or_else(Choice::fallback)
}

pub fn save(data: &Path, choice: &Choice) -> Result<()> {
    std::fs::create_dir_all(data)?;
    std::fs::write(file(data), serde_json::to_string_pretty(choice)?)?;
    Ok(())
}

/// Sign-ins Mirror saved itself, which its worker reads on its own: a Reflection
/// or Anthropic key saved by Mirror's CLI, and a Codex login for ChatGPT plan
/// billing. Named like keys (the login as CODEX_LOGIN); only whether they exist
/// is checked, never what they hold.
pub fn mirror_logins() -> Vec<&'static str> {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let saved = |name: &str| std::fs::metadata(home.join(".mirror").join(name)).map(|meta| meta.is_file() && meta.len() > 0).unwrap_or(false);
    let codex = std::env::var_os("MIRROR_CODEX_AUTH_PATH").map(PathBuf::from).unwrap_or_else(|| home.join(".codex").join("auth.json"));
    let mut found = Vec::new();
    if saved("reflection_api_key") {
        found.push("REFLECTION_API_KEY");
    }
    if saved("anthropic_api_key") {
        found.push("ANTHROPIC_API_KEY");
    }
    if codex.is_file() {
        found.push("CODEX_LOGIN");
    }
    found
}

/// One entry of Mirror's model picker file, `~/.mirror/models.json` (or
/// `MIRROR_MODELS_CONFIG`), which Glass shows beside its own suggestions.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MirrorModel {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// Empty means "the session's provider".
    pub api: Option<String>,
    pub base_url: Option<String>,
}

pub fn mirror_models_in(path: &Path) -> Vec<MirrorModel> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(serde_json::Value::Array(entries)) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let field = |entry: &serde_json::Value, key: &str| entry.get(key).and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    entries
        .iter()
        .filter_map(|entry| {
            Some(MirrorModel {
                id: field(entry, "id")?,
                label: field(entry, "label")?,
                description: field(entry, "description"),
                api: field(entry, "api"),
                base_url: field(entry, "base_url"),
            })
        })
        .collect()
}

pub fn mirror_models() -> Vec<MirrorModel> {
    let path = std::env::var_os("MIRROR_MODELS_CONFIG").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mirror").join("models.json"));
    mirror_models_in(&path)
}

/// Which provider keys are set, by variable name. Never the values.
pub fn keys_present() -> Vec<&'static str> {
    KEYS.iter()
        .map(|(_, name)| *name)
        .filter(|name| std::env::var(name).map(|value| !value.is_empty()).unwrap_or(false))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mirrors_model_picker_file() {
        let path = std::env::temp_dir().join(format!("glass-models-test-{}.json", std::process::id()));
        std::fs::write(&path, r#"[{"id": "anthropic/claude-opus-4.8", "label": "Opus via OpenRouter", "api": "openai-chat-completions"}, {"id": "local", "label": "Local", "api": "openai-chat-completions", "base_url": "http://127.0.0.1:8000/v1"}, {"label": "no id"}]"#).unwrap();
        let models = mirror_models_in(&path);
        assert_eq!(models.len(), 2, "an entry without an id is skipped");
        assert_eq!(models[1].base_url.as_deref(), Some("http://127.0.0.1:8000/v1"));
        assert!(mirror_models_in(Path::new("/nonexistent/models.json")).is_empty());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_saved_choice_round_trips() {
        let data = std::env::temp_dir().join(format!("glass-settings-test-{}", std::process::id()));
        let choice = Choice { api: "openai-responses".into(), model: "gpt-5-nano".into(), base_url: None };
        save(&data, &choice).unwrap();
        let read: Choice = serde_json::from_str(&std::fs::read_to_string(file(&data)).unwrap()).unwrap();
        assert_eq!(read, choice);
        std::fs::remove_dir_all(&data).unwrap();
    }
}
