//! Projects the person has opened, and the extra checkouts Glass makes for them.
//!
//! Stored in Glass's own file in the app data folder, never in Mirror's database.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Saved {
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub git: bool,
    /// The branch on origin that new checkouts start from, such as `origin/main`.
    pub origin: Option<String>,
}

fn file(data: &Path) -> PathBuf {
    data.join("projects.json")
}

pub fn load(data: &Path) -> Vec<Saved> {
    std::fs::read_to_string(file(data)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn store(data: &Path, saved: &[Saved]) -> Result<()> {
    std::fs::create_dir_all(data)?;
    std::fs::write(file(data), serde_json::to_string_pretty(saved)?)?;
    Ok(())
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The folder's own git top, so a project never borrows a repository above it.
fn own_repo(path: &Path) -> bool {
    git(path, &["rev-parse", "--show-toplevel"]).map(|top| Path::new(&top) == path).unwrap_or(false)
}

/// origin's default branch, such as `origin/main`, if the project has an origin.
fn origin_branch(path: &Path) -> Option<String> {
    git(path, &["remote", "get-url", "origin"])?;
    if let Some(head) = git(path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        return Some(head);
    }
    ["origin/main", "origin/master"]
        .into_iter()
        .find(|name| git(path, &["rev-parse", "--verify", "--quiet", name]).is_some())
        .map(str::to_string)
}

pub fn describe(path: &str) -> Project {
    let dir = Path::new(path);
    let git = own_repo(dir);
    Project {
        path: path.to_string(),
        name: dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string()),
        git,
        origin: if git { origin_branch(dir) } else { None },
    }
}

pub fn list(data: &Path) -> Vec<Project> {
    load(data).iter().filter(|saved| Path::new(&saved.path).is_dir()).map(|saved| describe(&saved.path)).collect()
}

/// Remember a folder. Returns it described. Most recent first.
pub fn add(data: &Path, path: &str) -> Result<Project> {
    let canonical = std::fs::canonicalize(path).with_context(|| format!("{path} not found"))?;
    let path = canonical.display().to_string();
    let mut saved = load(data);
    saved.retain(|entry| entry.path != path);
    saved.insert(0, Saved { path: path.clone() });
    store(data, &saved)?;
    Ok(describe(&path))
}

/// Forget a folder. Its files are not touched.
pub fn remove(data: &Path, path: &str) -> Result<()> {
    let mut saved = load(data);
    saved.retain(|entry| entry.path != path);
    store(data, &saved)
}

/// Files in a workspace, for @ mentions: tracked and untracked but not ignored,
/// relative to the workspace. Outside git, a shallow walk that skips hidden folders.
pub fn files(workspace: &Path, limit: usize) -> Vec<String> {
    if let Some(list) = git(workspace, &["ls-files", "--cached", "--others", "--exclude-standard", "--", "."]) {
        return list.lines().filter(|line| !line.is_empty()).take(limit).map(str::to_string).collect();
    }
    let mut out = Vec::new();
    let mut stack = vec![(workspace.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if depth < 6 {
                    stack.push((path, depth + 1));
                }
            } else if let Ok(relative) = path.strip_prefix(workspace) {
                out.push(relative.display().to_string());
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

/// A branch-safe name from a task title: "Add a median function" -> "add-a-median-function".
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "task".to_string() } else { out }
}

/// A fresh checkout of origin's default branch, on its own branch, in a folder Glass owns.
///
/// The branch name comes from the title once and is never changed afterwards.
pub fn checkout(data: &Path, project: &str, title: &str) -> Result<PathBuf> {
    checkout_from(data, project, title, false)
}

/// With `local_ok`, a project with no origin branches from its own HEAD instead, as an
/// effort race needs: every runner starts from the same commit.
pub fn checkout_from(data: &Path, project: &str, title: &str, local_ok: bool) -> Result<PathBuf> {
    let project_dir = Path::new(project);
    let info = describe(project);
    if !info.git {
        bail!("{} is not a git repository, so it cannot get a second checkout", info.name);
    }
    let base = match info.origin {
        Some(origin) => {
            // Best effort: start from origin as it is now. Offline, use what is already fetched.
            let _ = Command::new("git").arg("-C").arg(project_dir).args(["fetch", "--quiet", "origin"]).status();
            origin
        }
        None if local_ok && git(project_dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_some() => "HEAD".to_string(),
        None => bail!("{} has no origin remote, so it cannot get its own checkout", info.name),
    };

    let root = data.join("checkouts");
    std::fs::create_dir_all(&root)?;
    let stem = format!("{}-{}", info.name, slug(title));
    let mut attempt = 1;
    let (dir, branch) = loop {
        let suffix = if attempt == 1 { String::new() } else { format!("-{attempt}") };
        let dir = root.join(format!("{stem}{suffix}"));
        let branch = format!("glass/{}{suffix}", slug(title));
        let taken = dir.exists() || git(project_dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_some();
        if !taken {
            break (dir, branch);
        }
        attempt += 1;
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(project_dir)
        .args(["worktree", "add", "--quiet", "-b", &branch])
        .arg(&dir)
        .arg(&base)
        .output()
        .context("could not run git worktree")?;
    if !output.status.success() {
        bail!("git worktree add failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    copy_env_files(project_dir, &dir);
    Ok(dir)
}

/// A checkout from git has none of the project's ignored files, so `.env` files go
/// missing and the project will not run. Copy those across (Conductor does the same).
/// Only small `.env*` files; never anything else that is ignored.
fn copy_env_files(project: &Path, checkout: &Path) -> Vec<String> {
    let mut copied = Vec::new();
    let Some(list) = git(project, &["ls-files", "--others", "--ignored", "--exclude-standard"]) else { return copied };
    for relative in list.lines().filter(|line| !line.is_empty()).take(5000) {
        let name = Path::new(relative).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if !name.starts_with(".env") || relative.split('/').any(|part| part == "node_modules") {
            continue;
        }
        let source = project.join(relative);
        if std::fs::metadata(&source).map(|meta| !meta.is_file() || meta.len() > 256 * 1024).unwrap_or(true) {
            continue;
        }
        let target = checkout.join(relative);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&source, &target).is_ok() {
            copied.push(relative.to_string());
        }
        if copied.len() >= 50 {
            break;
        }
    }
    copied
}

/// A fresh folder for an agent with no project, in Glass's own data folder.
/// It is a git repository from the start, so the changes panel works there too.
pub fn scratch(data: &Path, title: &str) -> Result<PathBuf> {
    let root = data.join("scratch");
    std::fs::create_dir_all(&root)?;
    let stem = slug(title);
    let mut attempt = 1;
    let dir = loop {
        let dir = root.join(if attempt == 1 { stem.clone() } else { format!("{stem}-{attempt}") });
        if !dir.exists() {
            break dir;
        }
        attempt += 1;
    };
    std::fs::create_dir_all(&dir)?;
    let output = Command::new("git").arg("-C").arg(&dir).args(["init", "--quiet", "-b", "main"]).output().context("could not run git init")?;
    if !output.status.success() {
        bail!("git init failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_folders_are_fresh_git_repos() {
        let data = std::env::temp_dir().join(format!("glass-scratch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let first = scratch(&data, "Explain monads").unwrap();
        let second = scratch(&data, "Explain monads").unwrap();
        assert_ne!(first, second);
        assert!(own_repo(&std::fs::canonicalize(&first).unwrap()));
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn lists_files_and_forgets_projects() {
        let base = std::env::temp_dir().join(format!("glass-files-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src/a.py"), "").unwrap();
        std::fs::write(base.join(".hidden"), "").unwrap();
        let path = std::fs::canonicalize(&base).unwrap();
        assert_eq!(files(&path, 100), vec!["src/a.py".to_string()]);
        let data = base.join("data");
        add(&data, path.to_str().unwrap()).unwrap();
        remove(&data, path.to_str().unwrap()).unwrap();
        assert!(load(&data).is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn slugs_are_short_and_safe() {
        assert_eq!(slug("Add a median function with tests!"), "add-a-median-function-with-tests");
        assert_eq!(slug("   "), "task");
        assert!(slug(&"x".repeat(100)).len() <= 40);
    }

    #[test]
    fn a_second_agent_gets_its_own_checkout_from_origin() {
        let base = std::env::temp_dir().join(format!("glass-checkout-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin.git");
        let project = base.join("demo");
        let data = base.join("data");
        let run = |dir: &Path, args: &[&str]| assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success(), "{args:?}");
        std::fs::create_dir_all(&project).unwrap();
        run(&base, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        run(&project, &["init", "-q", "-b", "main"]);
        std::fs::write(project.join("a.txt"), "a\n").unwrap();
        run(&project, &["add", "."]);
        run(&project, &["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init"]);
        std::fs::write(project.join(".gitignore"), ".env\n.env.local\nbuild/\n").unwrap();
        run(&project, &["add", ".gitignore"]);
        run(&project, &["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "ignore"]);
        run(&project, &["remote", "add", "origin", origin.to_str().unwrap()]);
        run(&project, &["push", "-q", "origin", "main"]);
        run(&project, &["fetch", "-q", "origin"]);

        let project_path = std::fs::canonicalize(&project).unwrap().display().to_string();
        let described = add(&data, &project_path).unwrap();
        assert!(described.git);
        assert_eq!(described.origin.as_deref(), Some("origin/main"));
        assert_eq!(list(&data).len(), 1);

        std::fs::write(project.join(".env"), "KEY=1\n").unwrap();
        std::fs::create_dir_all(project.join("build")).unwrap();
        std::fs::write(project.join("build/out.bin"), "x").unwrap();
        let first = checkout(&data, &project_path, "Add a median").unwrap();
        assert_eq!(std::fs::read_to_string(first.join(".env")).unwrap(), "KEY=1\n");
        assert!(!first.join("build/out.bin").exists());
        let second = checkout(&data, &project_path, "Add a median").unwrap();
        assert_ne!(first, second);
        assert!(first.join("a.txt").exists());
        assert_eq!(git(&first, &["rev-parse", "--abbrev-ref", "HEAD"]).as_deref(), Some("glass/add-a-median"));
        assert_eq!(git(&second, &["rev-parse", "--abbrev-ref", "HEAD"]).as_deref(), Some("glass/add-a-median-2"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_race_branches_from_head_when_there_is_no_origin() {
        let base = std::env::temp_dir().join(format!("glass-race-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&base).args(args).status().unwrap().success());
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(base.join("a.txt"), "a\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "init"]);
        let path = std::fs::canonicalize(&base).unwrap().display().to_string();
        let data = base.join(".glass-data");
        let low = checkout_from(&data, &path, "Race · low", true).unwrap();
        let high = checkout_from(&data, &path, "Race · high", true).unwrap();
        assert!(low.join("a.txt").exists() && high.join("a.txt").exists());
        assert_ne!(low, high);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn no_origin_means_no_checkout() {
        let base = std::env::temp_dir().join(format!("glass-noorigin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert!(Command::new("git").arg("-C").arg(&base).args(["init", "-q"]).status().unwrap().success());
        let path = std::fs::canonicalize(&base).unwrap().display().to_string();
        let error = checkout(&base.join("data"), &path, "x").unwrap_err().to_string();
        assert!(error.contains("no origin remote"), "{error}");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
