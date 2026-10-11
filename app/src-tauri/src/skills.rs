//! Mirror's skills, listed for the UI. Mirror's worker does the real work: it
//! tells the model which skills exist and expands a `$name` mention in a message
//! into the skill's text. Glass only finds them, the same way Mirror's client does,
//! so the composer can offer `$name` and Settings can show what is installed.
//!
//! Places, as Mirror searches them: `~/.mirror/skills`, then `.agents/skills` and
//! `.claude/skills` in every folder from the project root down to the workspace.
//! A skill is a folder with a `SKILL.md` that has a `description` in its front matter.

use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_DEPTH: usize = 6;
const MAX_DIRS: usize = 2000;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    /// "personal" for ~/.mirror/skills, "project" for the workspace's.
    pub scope: String,
}

pub fn global_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mirror").join("skills")
}

fn is_root(directory: &Path) -> bool {
    directory.join(".git").exists() || directory.join(".jj").exists()
}

/// Folders from the nearest project root down to `cwd`, as Mirror walks them.
fn walk(cwd: &Path) -> Vec<PathBuf> {
    let mut walked = Vec::new();
    for directory in cwd.ancestors() {
        walked.push(directory.to_path_buf());
        if is_root(directory) {
            walked.reverse();
            return walked;
        }
    }
    vec![cwd.to_path_buf()]
}

/// `name` and `description` from simple YAML front matter. Enough for listing;
/// the worker parses the file properly when it loads it.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches(|ch| ch == '"' || ch == '\'').to_string();
        match key.trim() {
            "name" if !value.is_empty() => name = Some(value),
            "description" if !value.is_empty() => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

fn valid_name(name: &str) -> bool {
    name.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric()) && name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn scan(root: &Path, scope: &str, out: &mut Vec<Skill>) {
    if !root.is_dir() {
        return;
    }
    let mut queue = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0;
    while let Some((directory, depth)) = queue.pop() {
        seen += 1;
        if seen > MAX_DIRS {
            return;
        }
        let file = directory.join("SKILL.md");
        if file.is_file() {
            if let Ok(text) = std::fs::read_to_string(&file) {
                let (name, description) = front_matter(&text);
                let name = name.unwrap_or_else(|| directory.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
                if let (true, Some(description)) = (valid_name(&name), description) {
                    out.push(Skill { name, description, path: file.display().to_string(), scope: scope.to_string() });
                }
            }
            // Files nested inside a skill are its resources, not more skills.
            continue;
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
        children.sort();
        for child in children.into_iter().rev() {
            let name = child.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            if !name.starts_with('.') && name != "node_modules" {
                queue.push((child, depth + 1));
            }
        }
    }
}

/// Every skill an agent in `workspace` can use. A later one with the same name
/// wins, as in Mirror: project skills over personal ones.
pub fn list(workspace: Option<&Path>) -> Vec<Skill> {
    let mut found = Vec::new();
    scan(&global_dir(), "personal", &mut found);
    if let Some(workspace) = workspace {
        for directory in walk(workspace) {
            for relative in [".agents/skills", ".claude/skills"] {
                scan(&directory.join(relative), "project", &mut found);
            }
        }
    }
    let mut by_name: Vec<Skill> = Vec::new();
    for skill in found {
        by_name.retain(|existing| existing.name != skill.name);
        by_name.push(skill);
    }
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    by_name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_project_skills_up_to_the_root_and_skips_undescribed_ones() {
        let root = std::env::temp_dir().join(format!("glass-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let skill = |dir: PathBuf, text: &str| {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), text).unwrap();
        };
        skill(root.join(".agents/skills/tidy"), "---\nname: tidy\ndescription: Clean up to house style.\n---\nbody");
        skill(root.join("app/.claude/skills/release"), "---\ndescription: \"Cut a release: tag, notes.\"\n---\n");
        skill(root.join(".agents/skills/empty"), "---\nname: empty\n---\nno description");
        std::fs::create_dir_all(root.join("app/src")).unwrap();
        let names: Vec<_> = list(Some(&root.join("app/src"))).into_iter().filter(|skill| skill.scope == "project").map(|skill| (skill.name, skill.description)).collect();
        assert_eq!(names, [("release".to_string(), "Cut a release: tag, notes.".to_string()), ("tidy".to_string(), "Clean up to house style.".to_string())]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
