//! Client for Mirror's agent worker.
//!
//! Mirror's terminal app is a client of a separate worker process, `mirror-agent`.
//! This crate does the same job from Rust: find the worker, launch it, open the
//! session stream, and turn what comes back into plain [`Event`]s a UI can render.
//!
//! Everything that depends on Mirror's wire protocol lives in this crate, so a
//! protocol change in a new Mirror release is contained here.

pub mod proto {
    /// `AgentRPC`: the session stream between a client and the worker.
    pub mod agent {
        tonic::include_proto!("mirror.agent.v1");
    }
    /// `MirrorRPC` and friends: session management on a remote Mirror server.
    pub mod mirror {
        tonic::include_proto!("mirror.v1");
    }
}

pub mod event;
pub mod guardian;
pub mod session;
pub mod worker;

pub use event::Event;
pub use session::{ApprovalMode, ApprovalSource, Inference, Session};
pub use worker::{find_worker, worker_version, Worker, WorkerConfig};

/// The `mirror-agent` release this crate was last tested against: the worker in
/// `reflection-mirror` 0.1.0 on PyPI.
pub const TESTED_MIRROR_VERSION: &str = "0.1.8";
