//! Stops workers when Glass itself dies.
//!
//! A worker exits when its stdin closes, but only once it is idle: one busy with
//! a model request or a long command carries on, and so does everything it
//! started. When Glass quits normally it stops each worker. When it crashes or is
//! killed it cannot, so a small shell process does it instead. Glass tells it, over
//! a pipe, which process groups belong to workers; when the pipe closes, however
//! Glass ended, the guardian stops those groups: TERM, then KILL two seconds later.

use std::io::Write;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;

const SCRIPT: &str = r#"
groups=""
while IFS= read -r line; do
  case "$line" in
    +*) groups="$groups ${line#+}" ;;
    -*) kept=""; for g in $groups; do [ "$g" = "${line#-}" ] || kept="$kept $g"; done; groups="$kept" ;;
  esac
done
[ -n "$groups" ] || exit 0
for g in $groups; do kill -TERM -"$g" 2>/dev/null; done
sleep 2
for g in $groups; do kill -KILL -"$g" 2>/dev/null; done
"#;

/// The guardian's end of the pipe. Closing it, by dropping this, is what tells the
/// guardian to act.
pub struct Guardian {
    stdin: Mutex<ChildStdin>,
}

impl Guardian {
    pub fn start() -> std::io::Result<Guardian> {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", SCRIPT]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        // Its own group, so a Ctrl-C meant for Glass does not stop it first.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        // Reap it in the background; it outlives Glass only by the seconds it needs.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(Guardian { stdin: Mutex::new(stdin) })
    }

    /// Watch a process group. A worker leads its own, so this is its pid.
    pub fn add(&self, group: u32) {
        let _ = writeln!(self.stdin.lock().unwrap(), "+{group}");
    }

    /// Stop watching a group that has already been stopped.
    pub fn remove(&self, group: u32) {
        let _ = writeln!(self.stdin.lock().unwrap(), "-{group}");
    }
}

/// The one guardian for this process, started with the first worker.
pub(crate) fn global() -> Option<&'static Guardian> {
    static GUARDIAN: std::sync::OnceLock<Option<Guardian>> = std::sync::OnceLock::new();
    GUARDIAN.get_or_init(|| Guardian::start().ok()).as_ref()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    fn alive(child: &mut std::process::Child) -> bool {
        matches!(child.try_wait(), Ok(None))
    }

    fn sleeper() -> std::process::Child {
        let mut command = Command::new("sleep");
        command.arg("30").process_group(0);
        command.spawn().unwrap()
    }

    #[test]
    fn stops_watched_groups_when_its_owner_goes_away() {
        let guardian = Guardian::start().unwrap();
        let (mut watched, mut released) = (sleeper(), sleeper());
        guardian.add(watched.id());
        guardian.add(released.id());
        guardian.remove(released.id());
        // As if Glass had been killed: the pipe closes.
        drop(guardian);
        let until = Instant::now() + Duration::from_secs(5);
        while alive(&mut watched) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(&mut watched), "a watched worker group is stopped");
        assert!(alive(&mut released), "a released group is left alone");
        released.kill().unwrap();
        released.wait().unwrap();
    }
}
