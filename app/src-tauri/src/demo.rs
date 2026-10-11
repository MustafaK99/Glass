//! Recording the demo video and screenshots from the real app. Off unless
//! `GLASS_DEMO` names a script: then the UI plays it, pressing the keys and typing
//! as a person would, against real workers. `<script>.marks` gets a timestamp per
//! step for cutting the recording, and the script can wait for `<script>.go`, so
//! recording starts after setup.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn script() -> Option<PathBuf> {
    std::env::var_os("GLASS_DEMO").filter(|value| !value.is_empty()).map(PathBuf::from)
}

pub fn enabled() -> bool {
    script().is_some()
}

fn sibling(extension: &str) -> Option<PathBuf> {
    script().map(|path| {
        let mut name = path.into_os_string();
        name.push(extension);
        PathBuf::from(name)
    })
}

/// The script's steps, as JSON text, or nothing when the demo is off.
pub fn steps() -> Option<String> {
    std::fs::read_to_string(script()?).ok()
}

/// Note when a step happened, in milliseconds since 1970.
pub fn mark(name: &str) {
    let Some(path) = sibling(".marks") else { return };
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", serde_json::json!({ "name": name, "ms": ms as u64 }));
    }
}

/// Wait until `<script>.go` exists, for up to ten minutes.
pub fn wait_for_go() {
    let Some(path) = sibling(".go") else { return };
    for _ in 0..6000 {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
