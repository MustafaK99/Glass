//! A shell per agent, in its workspace, for the terminal drawer. A real PTY, so
//! interactive programs work. Nothing here talks to Mirror.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Every open terminal, by agent id. Dropping one kills its shell.
#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<String, Terminal>>,
}

impl Terminals {
    /// Start a login shell in `cwd`. Output goes to `on_output` from a reader thread;
    /// `on_exit` runs when the shell ends.
    pub fn open(
        &self,
        id: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<()> {
        self.close(id);
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("could not open a terminal")?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut command = CommandBuilder::new(&shell);
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(command).with_context(|| format!("could not start {shell}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => on_output(buffer[..read].to_vec()),
                }
            }
            on_exit();
        });
        self.open.lock().unwrap().insert(id.to_string(), Terminal { master: pair.master, writer, child });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut open = self.open.lock().unwrap();
        let terminal = open.get_mut(id).ok_or_else(|| anyhow!("no terminal"))?;
        terminal.writer.write_all(data)?;
        terminal.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let open = self.open.lock().unwrap();
        let terminal = open.get(id).ok_or_else(|| anyhow!("no terminal"))?;
        terminal.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn close(&self, id: &str) {
        self.open.lock().unwrap().remove(id);
    }

    pub fn close_all(&self) {
        self.open.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn runs_a_command_in_the_workspace() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let terminals = Terminals::default();
        let (sender, output) = mpsc::channel::<Vec<u8>>();
        terminals.open("t1", &dir, 80, 24, move |bytes| { let _ = sender.send(bytes); }, || {}).unwrap();
        terminals.write("t1", b"echo glass-$((40+2)); pwd\r").unwrap();
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline && !(seen.contains("glass-42") && seen.contains(dir.to_str().unwrap())) {
            if let Ok(bytes) = output.recv_timeout(Duration::from_millis(200)) {
                seen.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        assert!(seen.contains("glass-42"), "{seen}");
        terminals.resize("t1", 100, 30).unwrap();
        terminals.close("t1");
        assert!(terminals.write("t1", b"x").is_err());
    }
}
