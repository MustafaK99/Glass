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
        Choice { api: "reflection".to_string(), model: "Beam-501B-A23B".to_string(), base_url: None }
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
    fn a_saved_choice_round_trips() {
        let data = std::env::temp_dir().join(format!("glass-settings-test-{}", std::process::id()));
        let choice = Choice { api: "openai-responses".into(), model: "gpt-5-nano".into(), base_url: None };
        save(&data, &choice).unwrap();
        let read: Choice = serde_json::from_str(&std::fs::read_to_string(file(&data)).unwrap()).unwrap();
        assert_eq!(read, choice);
        std::fs::remove_dir_all(&data).unwrap();
    }
}
