//! Mirror's sandbox workspaces: a private clone under `~/.mirror/sandboxes` whose
//! file and shell tools run in a microVM. All setup is Mirror's own code, driven by
//! `sandbox.py` through Mirror's Python.
//!
//! The VM can write any file in the clone, including its Git configuration, so
//! hooks, filters and fsmonitor programs there are the guest's. Mirror never runs
//! Git or a shell in a clone on the host, and neither does Glass: every Git helper
//! and the terminal check [`guard`] first.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::Value;

/// Where Mirror keeps sandbox clones.
pub fn root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mirror").join("sandboxes")
}

/// Whether `path` is inside a sandbox clone. Checked on the resolved path, so a
/// link into a clone counts too.
pub fn contains(path: &Path) -> bool {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let root = std::fs::canonicalize(root()).unwrap_or_else(|_| root());
    resolved.starts_with(&root) && resolved != root
}

/// Refuse to run Git or a shell on the host in a sandbox clone.
pub fn guard(path: &Path) -> Result<()> {
    if contains(path) {
        bail!("This is a sandbox. Its files can be changed by the VM, including Git's settings, so Glass does not run Git or a shell in it on this Mac.");
    }
    Ok(())
}

const DRIVER: &str = include_str!("sandbox.py");

/// Run one step of Mirror's sandbox code and read its JSON answer.
pub fn run(args: &[&str], timeout: Duration, on_line: impl FnMut(&str)) -> Result<Value> {
    let output = crate::mirror_py::run(DRIVER, args, timeout, on_line)?;
    let last = output.lines().rev().find(|line| line.trim_start().starts_with('{')).context("Mirror's sandbox code gave no answer")?;
    Ok(serde_json::from_str(last)?)
}

/// The environment the worker needs to reach the VM runtime: MIRROR_MSB and
/// Microsandbox's paths, as Mirror's CLI sets them. No credentials.
pub fn worker_env() -> Result<Vec<(String, String)>> {
    let env = run(&["env"], Duration::from_secs(30), |_| {})?;
    let keys = ["MIRROR_MSB", "MSB_HOME", "MSB_CONFIG_PATH", "MSB_LIBKRUNFW_PATH"];
    Ok(keys.iter().filter_map(|key| env[*key].as_str().map(|value| (key.to_string(), value.to_string()))).collect())
}

/// Stop a sandbox's VM, as Mirror does when a workspace closes.
pub fn stop(id: &str) -> Result<()> {
    let worker = glass_core::find_worker().context("Mirror is not installed")?;
    run(&["stop", &worker.display().to_string(), id], Duration::from_secs(90), |_| {}).map(|_| ())
}

/// Delete a sandbox's VM and its clone, as Mirror's /drop.
pub fn drop(id: &str, clone: &Path) -> Result<()> {
    let worker = glass_core::find_worker().context("Mirror is not installed")?;
    run(&["delete", &worker.display().to_string(), id], Duration::from_secs(120), |_| {})?;
    run(&["remove-clone", &clone.display().to_string()], Duration::from_secs(120), |_| {}).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_clones_only() {
        let clone = root().join("example-glass-test");
        assert!(guard(&clone).is_err());
        assert!(guard(&clone.join("src")).is_err());
        assert!(guard(&root()).is_ok(), "the folder itself holds no checkout");
        assert!(guard(Path::new("/tmp")).is_ok());
    }
}
