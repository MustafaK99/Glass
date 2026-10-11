//! `glass-probe`: run one prompt through mirror-agent and print every event as a JSON line.
//!
//! Usage:
//!   glass-probe [--auto | --approve] [--record FILE] <workspace-dir> <prompt>
//!
//! Settings come from the environment:
//!   MIRROR_RUST_WORKER  path to mirror-agent (otherwise the installed Mirror is used)
//!   GLASS_API           wire protocol, default `reflection`
//!   GLASS_MODEL         model id, default `Beam-501B-A23B`
//!   GLASS_BASE_URL      endpoint for a custom or self-hosted model
//!   GLASS_EFFORT        reasoning effort, default `high`
//!   GLASS_MEMORY_DIR    turn on Mirror's personal memory, kept in this folder
//!
//! `--auto` lets the agent run every tool without asking. `--approve` keeps manual mode and
//! answers yes to each request. With neither, the probe rejects every request, so it never
//! changes files.

use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use glass_core::{find_worker, ApprovalMode, Event, Inference, Session, Worker, WorkerConfig};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut auto = false;
    let mut approve = false;
    let mut record = None;
    let mut rest = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--auto" => auto = true,
            "--approve" => approve = true,
            "--record" => record = Some(PathBuf::from(args.next().context("--record needs a file")?)),
            _ => rest.push(arg),
        }
    }
    let [workspace, prompt] = rest.as_slice() else {
        bail!("usage: glass-probe [--auto | --approve] [--record FILE] <workspace-dir> <prompt>");
    };
    let workspace = std::fs::canonicalize(workspace).context("workspace directory not found")?;

    let executable = find_worker().context(
        "mirror-agent not found. Install Mirror, or set MIRROR_RUST_WORKER to the worker's path.",
    )?;
    let api = env("GLASS_API").unwrap_or_else(|| "reflection".to_string());
    let model = env("GLASS_MODEL").unwrap_or_else(|| "Beam-501B-A23B".to_string());
    let base_url = env("GLASS_BASE_URL");

    let mut config = WorkerConfig::new_conversation(&workspace, &api, &model);
    config.base_url = base_url.clone();
    // GLASS_MEMORY_DIR turns on Mirror's personal memory, stored in that folder.
    config.memory_dir = env("GLASS_MEMORY_DIR").map(PathBuf::from);
    let (mut worker, mut startup) = Worker::spawn(&executable, &config, &workspace).await?;
    eprintln!("worker ready at {}", worker.address());

    let (session, mut events) = Session::connect(worker.address(), &config.conversation_id).await?;
    session.set_inference(&Inference {
        model,
        api: Some(api),
        base_url,
        reasoning_effort: Some(env("GLASS_EFFORT").unwrap_or_else(|| "high".to_string())),
    })?;
    session.set_approval_mode(if auto { ApprovalMode::Auto } else { ApprovalMode::Manual })?;
    session.send_user(prompt)?;

    let mut recording = match &record {
        Some(path) => Some(std::fs::File::create(path)?),
        None => None,
    };
    let mut emit = |event: &Event| -> Result<()> {
        let line = serde_json::to_string(event)?;
        println!("{line}");
        if let Some(file) = recording.as_mut() {
            writeln!(file, "{line}")?;
        }
        Ok(())
    };

    let mut failed = false;
    loop {
        let event = tokio::select! {
            Some(event) = startup.recv() => event,
            next = events.recv() => match next {
                Some(event) => event,
                None => break,
            },
        };
        emit(&event)?;
        match event {
            Event::ApprovalRequested { call_id, .. } => session.resolve_approval(&call_id, approve)?,
            Event::TurnCompleted => break,
            // The probe never interrupts, so an interrupted turn means the worker gave up.
            Event::TurnInterrupted | Event::TurnError { .. } | Event::InputRejected { .. } => {
                failed = true;
                break;
            }
            Event::Closed { error } => {
                failed = error.is_some();
                break;
            }
            _ => {}
        }
    }

    if failed {
        for line in worker.stderr_tail() {
            eprintln!("worker: {line}");
        }
    }
    if !worker.is_running() {
        eprintln!("worker exited on its own");
    }
    worker.stop().await?;
    if failed {
        bail!("the turn did not finish cleanly");
    }
    Ok(())
}
