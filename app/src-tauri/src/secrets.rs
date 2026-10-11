//! Provider keys and other secrets the person enters in Settings.
//!
//! Values live only in the macOS Keychain (the `keyring` crate), under the
//! service `dev.mustafak.glass`. Glass's own files hold the variable names, never
//! the values. A value goes in once and is never sent back to the UI; the UI only
//! sees where a key comes from and its last four characters. Values reach a
//! worker or MCP server through that process's environment when it starts, and
//! are blanked out of any worker output Glass shows.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::Serialize;

const SERVICE: &str = "dev.mustafak.glass";
const MAX_LENGTH: usize = 4096;

static GLOBAL: std::sync::OnceLock<std::sync::Arc<Secrets>> = std::sync::OnceLock::new();

/// Set once at startup, from the app's data folder.
pub fn install(secrets: std::sync::Arc<Secrets>) {
    let _ = GLOBAL.set(secrets);
}

/// The app's secrets. None in tests and examples, which use the environment only.
pub fn global() -> Option<&'static std::sync::Arc<Secrets>> {
    GLOBAL.get()
}

/// Saved secrets for a child process's environment; empty outside the app.
pub fn env_for_child() -> Vec<(String, String)> {
    global().map(|secrets| secrets.worker_env()).unwrap_or_default()
}

/// A saved value, else the environment's.
pub fn lookup(name: &str) -> Option<String> {
    match global() {
        Some(secrets) => secrets.value(name),
        None => std::env::var(name).ok().filter(|value| !value.is_empty()),
    }
}

/// Text with every known key value blanked out.
pub fn redact(text: &str) -> String {
    match global() {
        Some(secrets) => secrets.redact(text),
        None => text.to_string(),
    }
}

/// The provider keys Mirror's worker reads, in the order Settings shows them.
pub const PROVIDER_KEYS: &[(&str, &str)] = &[
    ("REFLECTION_API_KEY", "Reflection"),
    ("OPENAI_API_KEY", "OpenAI"),
    ("ANTHROPIC_API_KEY", "Anthropic"),
    ("OPENROUTER_API_KEY", "OpenRouter"),
    // Mirror's web_search and web_browse tools appear when this is set.
    ("FIRECRAWL_API_KEY", "Web search · Firecrawl"),
];

/// Where secret values are kept. The Keychain in the app; memory in tests.
pub trait Vault: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

pub struct Keychain;

impl Vault for Keychain {
    fn get(&self, name: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, name).ok()?.get_password().ok()
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, name)?.set_password(value).context("could not save to the Keychain")
    }
    fn delete(&self, name: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("could not remove from the Keychain"),
        }
    }
}

#[derive(Default)]
pub struct Memory(Mutex<std::collections::HashMap<String, String>>);

impl Vault for Memory {
    fn get(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned()
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Status {
    pub name: String,
    /// The provider, or null for other variables such as an MCP token.
    pub provider: Option<String>,
    /// keychain, environment or none. The Keychain wins when both are set.
    pub source: String,
    /// The last four characters, so the person can tell keys apart. Never more.
    pub hint: Option<String>,
}

/// An environment variable name: capitals, digits and underscores.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('A'..='Z')) && name.len() <= 64 && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}

fn hint(value: &str) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    (chars.len() >= 12).then(|| chars[chars.len() - 4..].iter().collect())
}

/// Secrets in the vault, plus the names file that says which ones exist.
pub struct Secrets {
    vault: Box<dyn Vault>,
    names_file: PathBuf,
    /// Values loaded at startup and after each change, for workers and redaction.
    cache: Mutex<Vec<(String, String)>>,
}

impl Secrets {
    pub fn new(vault: Box<dyn Vault>, data: &Path) -> Secrets {
        let secrets = Secrets { vault, names_file: data.join("secret-names.json"), cache: Mutex::new(Vec::new()) };
        secrets.reload();
        secrets
    }

    fn names(&self) -> Vec<String> {
        let saved: Vec<String> = std::fs::read_to_string(&self.names_file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        saved.into_iter().filter(|name| valid_name(name)).collect()
    }

    fn store_names(&self, names: &[String]) -> Result<()> {
        if let Some(parent) = self.names_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.names_file, serde_json::to_string_pretty(names)?)?;
        Ok(())
    }

    fn reload(&self) {
        let loaded = self.names().into_iter().filter_map(|name| self.vault.get(&name).map(|value| (name, value))).collect();
        *self.cache.lock().unwrap() = loaded;
    }

    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        let value = value.trim();
        if !valid_name(name) {
            bail!("{name} is not a valid variable name");
        }
        if value.is_empty() || value.len() > MAX_LENGTH || value.chars().any(char::is_whitespace) {
            bail!("That does not look like a key: it is empty, too long or has spaces in it.");
        }
        self.vault.set(name, value)?;
        let mut names = self.names();
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
            self.store_names(&names)?;
        }
        self.reload();
        Ok(())
    }

    pub fn remove(&self, name: &str) -> Result<()> {
        self.vault.delete(name)?;
        let names: Vec<String> = self.names().into_iter().filter(|existing| existing != name).collect();
        self.store_names(&names)?;
        self.reload();
        Ok(())
    }

    /// A saved value, else the environment's. For MCP servers that name a variable.
    pub fn value(&self, name: &str) -> Option<String> {
        self.cache
            .lock()
            .unwrap()
            .iter()
            .find(|(saved, _)| saved == name)
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var(name).ok().filter(|value| !value.is_empty()))
    }

    /// Saved secrets, for a worker's environment. They override the shell's.
    pub fn worker_env(&self) -> Vec<(String, String)> {
        self.cache.lock().unwrap().clone()
    }

    /// Every provider key, then other saved variables, with where each comes from.
    pub fn status(&self) -> Vec<Status> {
        let saved = self.cache.lock().unwrap().clone();
        let describe = |name: &str, provider: Option<&str>| {
            let from_keychain = saved.iter().find(|(saved, _)| saved == name).map(|(_, value)| value.clone());
            let from_env = std::env::var(name).ok().filter(|value| !value.is_empty());
            let (source, value) = match (from_keychain, from_env) {
                (Some(value), _) => ("keychain", Some(value)),
                (None, Some(value)) => ("environment", Some(value)),
                (None, None) => ("none", None),
            };
            Status { name: name.to_string(), provider: provider.map(str::to_string), source: source.to_string(), hint: value.as_deref().and_then(hint) }
        };
        let mut out: Vec<Status> = PROVIDER_KEYS.iter().map(|(name, provider)| describe(name, Some(provider))).collect();
        for (name, _) in &saved {
            if !PROVIDER_KEYS.iter().any(|(key, _)| key == name) {
                out.push(describe(name, None));
            }
        }
        out
    }

    /// Provider key names that are set anywhere.
    pub fn present(&self) -> Vec<String> {
        self.status().into_iter().filter(|status| status.provider.is_some() && status.source != "none").map(|status| status.name).collect()
    }

    /// Blank out any saved or environment key value in text Glass is about to show.
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();
        let mut values: Vec<String> = self.cache.lock().unwrap().iter().map(|(_, value)| value.clone()).collect();
        for (name, _) in PROVIDER_KEYS {
            if let Ok(value) = std::env::var(name) {
                values.push(value);
            }
        }
        for value in values.into_iter().filter(|value| value.len() >= 8) {
            out = out.replace(&value, "•••");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> (Secrets, PathBuf) {
        let data = std::env::temp_dir().join(format!("glass-secrets-test-{}-{}", std::process::id(), rand_suffix()));
        (Secrets::new(Box::new(Memory::default()), &data), data)
    }

    // Tests run in parallel; each needs its own folder.
    fn rand_suffix() -> usize {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn values_never_reach_the_names_file_or_the_status() {
        let (secrets, data) = secrets();
        secrets.set("ANTHROPIC_API_KEY", "  sk-ant-test-123456789abcd  ").unwrap();
        let file = std::fs::read_to_string(data.join("secret-names.json")).unwrap();
        assert!(file.contains("ANTHROPIC_API_KEY") && !file.contains("sk-ant"));
        let status = secrets.status();
        let anthropic = status.iter().find(|entry| entry.name == "ANTHROPIC_API_KEY").unwrap();
        assert_eq!((anthropic.source.as_str(), anthropic.hint.as_deref()), ("keychain", Some("abcd")));
        assert!(!serde_json::to_string(&status).unwrap().contains("sk-ant"));
        assert_eq!(secrets.worker_env(), vec![("ANTHROPIC_API_KEY".to_string(), "sk-ant-test-123456789abcd".to_string())]);
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn rejects_bad_names_and_values_and_removes_cleanly() {
        let (secrets, data) = secrets();
        assert!(secrets.set("lower", "value123456").is_err());
        assert!(secrets.set("OPENAI_API_KEY", "has a space").is_err());
        assert!(secrets.set("OPENAI_API_KEY", "").is_err());
        secrets.set("LINEAR_TOKEN", "lin_api_abcdefghijkl").unwrap();
        assert_eq!(secrets.value("LINEAR_TOKEN").as_deref(), Some("lin_api_abcdefghijkl"));
        assert!(secrets.status().iter().any(|entry| entry.name == "LINEAR_TOKEN" && entry.provider.is_none()));
        secrets.remove("LINEAR_TOKEN").unwrap();
        assert_eq!(secrets.value("LINEAR_TOKEN"), None);
        assert!(secrets.worker_env().is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn redacts_saved_values_from_worker_output() {
        let (secrets, data) = secrets();
        secrets.set("OPENROUTER_API_KEY", "sk-or-v1-secretvalue").unwrap();
        assert_eq!(secrets.redact("auth failed for sk-or-v1-secretvalue at /v1"), "auth failed for ••• at /v1");
        let _ = std::fs::remove_dir_all(&data);
    }
}
