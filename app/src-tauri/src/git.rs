//! What changed in a workspace, from git. The changes panel shows this, so it also
//! catches edits made by bash commands or by hand, not only the agent's edit tool.

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::Serialize;

/// Git's id for the empty tree, to diff a repository that has no commits yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// Untracked files bigger than this are listed without a diff.
const MAX_UNTRACKED_BYTES: u64 = 512 * 1024;
const MAX_UNTRACKED_FILES: usize = 200;

#[derive(Serialize, Default)]
pub struct Changes {
    /// False when the folder is not a git repository. Then nothing else is set.
    pub git: bool,
    pub branch: String,
    /// What the workspace is compared with, in words: "HEAD" or "origin/main".
    pub base: String,
    /// The repository's top folder. Diffs are limited to the workspace inside it.
    pub root: String,
    /// Set when the repository is the person's home folder, which is almost never meant.
    pub warning: Option<String>,
    pub files: Vec<FileDiff>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub path: String,
    /// modified, added, deleted, renamed or untracked.
    pub status: String,
    pub diff: String,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
}

fn git(workspace: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git").arg("-C").arg(workspace).args(args).output().context("could not run git")
}

fn text(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = git(workspace, args).ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The commit to compare with. A checkout Glass made from origin/main is compared with
/// where it branched off, so the agent's own commits still show. Otherwise HEAD.
fn base(workspace: &Path) -> (String, String) {
    let on_branch = text(workspace, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if on_branch != "main" && on_branch != "master" {
        if let Some(fork) = text(workspace, &["merge-base", "HEAD", "origin/main"]) {
            return (fork, "origin/main".to_string());
        }
    }
    match text(workspace, &["rev-parse", "--verify", "HEAD"]) {
        Some(head) => (head, "HEAD".to_string()),
        None => (EMPTY_TREE.to_string(), "an empty repository".to_string()),
    }
}

fn count(diff: &str) -> (u32, u32) {
    let mut add = 0;
    let mut del = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            add += 1;
        } else if line.starts_with('-') {
            del += 1;
        }
    }
    (add, del)
}

/// Split `git diff` output into one entry per file.
fn split(output: &str) -> Vec<FileDiff> {
    let mut files = Vec::new();
    for section in output.split("\ndiff --git ").filter(|section| !section.trim().is_empty()) {
        let section = section.strip_prefix("diff --git ").unwrap_or(section);
        let header = section.lines().next().unwrap_or_default();
        // "a/path b/path"; the new path is after the last " b/".
        let path = header.rsplit_once(" b/").map(|(_, path)| path).unwrap_or(header).to_string();
        let status = if section.contains("\nnew file mode") {
            "added"
        } else if section.contains("\ndeleted file mode") {
            "deleted"
        } else if section.contains("\nrename from") {
            "renamed"
        } else {
            "modified"
        };
        let binary = section.contains("\nBinary files ");
        let body = section.find("\n@@").map(|at| &section[at + 1..]).unwrap_or("").to_string();
        let (add, del) = count(&body);
        files.push(FileDiff { path, status: status.to_string(), diff: body, add, del, binary });
    }
    files
}

pub fn changes(workspace: &Path, context: u32) -> Result<Changes> {
    if text(workspace, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return Ok(Changes::default());
    }
    let (commit, base_name) = base(workspace);
    let unified = format!("-U{context}");
    // --relative and "." keep the diff to this folder, with paths relative to it.
    let output = git(workspace, &["diff", "--no-color", "--no-ext-diff", "--relative", "-M", &unified, &commit, "--", "."])?;
    if !output.status.success() {
        bail!("git diff failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    let mut files = split(&String::from_utf8_lossy(&output.stdout));

    let untracked = text(workspace, &["ls-files", "--others", "--exclude-standard", "--", "."]).unwrap_or_default();
    for path in untracked.lines().filter(|line| !line.is_empty()).take(MAX_UNTRACKED_FILES) {
        let size = std::fs::metadata(workspace.join(path)).map(|meta| meta.len()).unwrap_or(0);
        let (diff, binary) = if size > MAX_UNTRACKED_BYTES {
            (String::new(), true)
        } else {
            // Exits 1 when the files differ, which they always do here.
            let output = git(workspace, &["diff", "--no-color", "--no-index", &unified, "/dev/null", path])?;
            let raw = String::from_utf8_lossy(&output.stdout).into_owned();
            let binary = raw.contains("\nBinary files ");
            (raw.find("\n@@").map(|at| raw[at + 1..].to_string()).unwrap_or_default(), binary)
        };
        let (add, del) = count(&diff);
        files.push(FileDiff { path: path.to_string(), status: "untracked".to_string(), diff, add, del, binary });
    }

    let root = text(workspace, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let warning = (!home.is_empty() && Path::new(&root) == Path::new(&home)).then(|| {
        "This folder is inside a git repository at your home folder, not its own. Run git init here to give it its own history.".to_string()
    });
    Ok(Changes {
        git: true,
        root,
        warning,
        branch: text(workspace, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default(),
        base: base_name,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn reports_modified_and_untracked_files() {
        let dir = std::env::temp_dir().join(format!("glass-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("stats.py"), "def average(nums):\n    return sum(nums) / (len(nums) + 1)\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init"]);
        std::fs::write(dir.join("stats.py"), "def average(nums):\n    return sum(nums) / len(nums)\n").unwrap();
        std::fs::write(dir.join("notes.md"), "hello\n").unwrap();

        let changes = changes(&dir, 3).unwrap();
        assert!(changes.git);
        assert_eq!(changes.branch, "main");
        assert_eq!(changes.base, "HEAD");
        let stats = changes.files.iter().find(|file| file.path == "stats.py").unwrap();
        assert_eq!((stats.status.as_str(), stats.add, stats.del), ("modified", 1, 1));
        assert!(stats.diff.starts_with("@@ -1,2 +1,2 @@"));
        let notes = changes.files.iter().find(|file| file.path == "notes.md").unwrap();
        assert_eq!((notes.status.as_str(), notes.add, notes.del), ("untracked", 1, 0));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_plain_folder_is_not_git() {
        let dir = std::env::temp_dir().join(format!("glass-nogit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!changes(&dir, 3).unwrap().git);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[derive(Serialize, Debug)]
pub struct Committed {
    pub sha: String,
    pub branch: String,
    /// The pull request's address, when one was opened.
    pub pull_request: Option<String>,
}

/// Commit everything in the workspace that is not ignored, as the person's own git
/// identity. With `pull_request`, push the branch to origin and open a pull request
/// with the GitHub CLI. Refuses to open one from main or master.
pub fn commit(workspace: &Path, message: &str, pull_request: Option<(&str, &str)>) -> Result<Committed> {
    let message = message.trim();
    if message.is_empty() {
        bail!("Write a commit message first.");
    }
    let branch = text(workspace, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if pull_request.is_some() && (branch == "main" || branch == "master" || branch == "HEAD") {
        bail!("This agent works on {branch}. A pull request needs its own branch: start the agent with its own checkout.");
    }
    let run = |args: &[&str]| -> Result<String> {
        let output = git(workspace, args)?;
        if !output.status.success() {
            bail!("git {}: {}", args[0], String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    run(&["add", "--all", "--", "."])?;
    if text(workspace, &["diff", "--cached", "--quiet"]).is_some() {
        bail!("Nothing to commit.");
    }
    run(&["commit", "--quiet", "-m", message])?;
    let sha = run(&["rev-parse", "--short", "HEAD"])?;
    let mut pull_request_url = None;
    if let Some((title, body)) = pull_request {
        run(&["push", "--quiet", "-u", "origin", "HEAD"])?;
        let output = Command::new("gh")
            .current_dir(workspace)
            .args(["pr", "create", "--title", title, "--body", body, "--head", &branch])
            .output()
            .context("the GitHub CLI (gh) is not installed")?;
        if !output.status.success() {
            bail!("Committed and pushed {sha}, but gh could not open the pull request: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        pull_request_url = String::from_utf8_lossy(&output.stdout).lines().rev().find(|line| line.starts_with("http")).map(str::to_string);
    }
    Ok(Committed { sha, branch, pull_request: pull_request_url })
}

#[cfg(test)]
mod commit_tests {
    use super::*;

    #[test]
    fn commits_everything_but_refuses_a_pull_request_from_main() {
        let dir = std::env::temp_dir().join(format!("glass-commit-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "t"]);
        run(&["config", "user.email", "t@localhost"]);
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        assert!(commit(&dir, "x", Some(("t", "b"))).unwrap_err().to_string().contains("own branch"));
        std::fs::write(dir.join("a.txt"), "2\n").unwrap();
        std::fs::write(dir.join("new.txt"), "n\n").unwrap();
        let done = commit(&dir, "Change a, add new", None).unwrap();
        assert_eq!(done.branch, "main");
        assert_eq!(text(&dir, &["log", "-1", "--format=%s"]).unwrap(), "Change a, add new");
        assert_eq!(text(&dir, &["status", "--porcelain"]).unwrap(), "");
        assert!(commit(&dir, "again", None).unwrap_err().to_string().contains("Nothing to commit"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
