//! Snapshots of a workspace's files, taken before each message to an agent, so a
//! rewind can put the files back too. Built with git plumbing on a private index:
//! the person's index, branch and stash are never touched. Each snapshot is a
//! commit kept alive by a ref under refs/glass/snapshots/, so git never collects it.
//!
//! Covers tracked and untracked files that are not ignored, however they changed:
//! the agent's edits, its bash commands, or the person's own hand.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

fn git(workspace: &Path, index: Option<&Path>, args: &[&str]) -> Result<String> {
    crate::sandbox::guard(workspace)?;
    let mut command = Command::new("git");
    command.arg("-C").arg(workspace).args(args);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    // Snapshots are Glass's, not the person's: a fixed author, and no hooks.
    command.env("GIT_AUTHOR_NAME", "Glass").env("GIT_AUTHOR_EMAIL", "glass@localhost").env("GIT_COMMITTER_NAME", "Glass").env("GIT_COMMITTER_EMAIL", "glass@localhost");
    let output = command.output().context("could not run git")?;
    if !output.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn temp_index(workspace: &Path) -> Result<PathBuf> {
    let git_dir = PathBuf::from(git(workspace, None, &["rev-parse", "--absolute-git-dir"])?);
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    Ok(git_dir.join(format!("glass-index-{}-{id}", std::process::id())))
}

/// Snapshot the workspace's files. Returns the snapshot's commit id.
pub fn take(workspace: &Path, label: &str) -> Result<String> {
    let index = temp_index(workspace)?;
    let result = (|| {
        git(workspace, Some(&index), &["add", "--all", "--", "."])?;
        let tree = git(workspace, Some(&index), &["write-tree"])?;
        let mut args = vec!["commit-tree", tree.as_str(), "-m", label];
        let head = git(workspace, None, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok();
        if let Some(head) = head.as_deref() {
            args.extend(["-p", head]);
        }
        let commit = git(workspace, None, &args)?;
        git(workspace, None, &["update-ref", &format!("refs/glass/snapshots/{commit}"), &commit])?;
        Ok(commit)
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// Put the workspace's files back as they were in `commit`: changed files are
/// restored, files created since are removed. Ignored files are left alone, and
/// so are the branch, the index and any commits made since.
pub fn restore(workspace: &Path, commit: &str) -> Result<Vec<String>> {
    let wanted: std::collections::HashSet<String> = git(workspace, None, &["ls-tree", "-r", "--name-only", commit])?.lines().map(str::to_string).collect();
    let present = git(workspace, None, &["ls-files", "--cached", "--others", "--exclude-standard", "--", "."])?;
    let mut removed = Vec::new();
    for path in present.lines().filter(|path| !path.is_empty() && !wanted.contains(*path)) {
        if std::fs::remove_file(workspace.join(path)).is_ok() {
            removed.push(path.to_string());
        }
    }
    let index = temp_index(workspace)?;
    let result = git(workspace, Some(&index), &["read-tree", commit]).and_then(|_| git(workspace, Some(&index), &["checkout-index", "--all", "--force"]));
    let _ = std::fs::remove_file(&index);
    result?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_edits_new_files_and_deletions_without_touching_the_index() {
        let dir = std::env::temp_dir().join(format!("glass-snapshot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "secret.env\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init"]);
        std::fs::write(dir.join("draft.txt"), "untracked before\n").unwrap();

        let snapshot = take(&dir, "before message 1").unwrap();

        // The agent edits, deletes, creates, and the person stages something.
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::remove_file(dir.join("keep.txt")).unwrap();
        std::fs::write(dir.join("new.txt"), "made by the agent\n").unwrap();
        std::fs::write(dir.join("secret.env"), "ignored\n").unwrap();
        run(&["add", "a.txt"]);
        let staged_before = git(&dir, None, &["diff", "--cached", "--name-only"]).unwrap();

        let removed = restore(&dir, &snapshot).unwrap();
        assert_eq!(removed, vec!["new.txt".to_string()]);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "keep\n");
        assert_eq!(std::fs::read_to_string(dir.join("draft.txt")).unwrap(), "untracked before\n");
        assert!(dir.join("secret.env").exists(), "ignored files are left alone");
        assert_eq!(git(&dir, None, &["diff", "--cached", "--name-only"]).unwrap(), staged_before, "the person's index is untouched");
        assert_eq!(git(&dir, None, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "main");
        assert!(git(&dir, None, &["for-each-ref", "refs/glass/snapshots/"]).unwrap().contains(&snapshot));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
