//! Running Mirror's own Python code, the client half of `reflection-mirror`, with
//! the interpreter its install ships. Glass uses it where Mirror's CLI already does
//! the work and the result must match it exactly: signing in to MCP services, and
//! setting up sandboxes. Glass passes arguments and reads lines; Mirror's code
//! decides what happens.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

/// The tool's interpreter: `<tool>/bin/python`, from the worker at
/// `<tool>/lib/python3.x/site-packages/mirror/bin/mirror-agent`.
pub fn python() -> Option<PathBuf> {
    let worker = glass_core::find_worker()?;
    let root = worker.ancestors().nth(6)?;
    let python = root.join("bin").join("python");
    python.is_file().then_some(python)
}

/// Run `script` with `args`. Each stdout line goes to `on_line` as it arrives;
/// the result is all of stdout, or an error with stderr's last lines.
pub fn run(script: &str, args: &[&str], timeout: Duration, mut on_line: impl FnMut(&str)) -> Result<String> {
    crate::settings::wait_for_login_env();
    let python = python().context("Mirror is not installed, or this install has no Python client (uv tool install reflection-mirror)")?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    // Isolated (-I) and from the home folder, so nothing nearby shadows Mirror's modules.
    let mut child = Command::new(python)
        .arg("-I")
        .arg("-c")
        .arg(script)
        .args(args)
        .current_dir(home)
        .envs(crate::secrets::env_for_child())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not start Mirror's Python")?;
    let mut stderr = child.stderr.take().context("no stderr")?;
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let mut output = String::new();
    let lines = BufReader::new(child.stdout.take().context("no stdout")?);
    for line in lines.lines() {
        let line = line?;
        on_line(&line);
        output.push_str(&line);
        output.push('\n');
        if started.elapsed() > timeout {
            let _ = child.kill();
            bail!("timed out");
        }
    }
    let status = child.wait()?;
    let errors = errors.join().unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = errors.trim().lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        bail!("{}", crate::secrets::redact(&tail.join("\n")).trim().to_string());
    }
    Ok(output)
}
