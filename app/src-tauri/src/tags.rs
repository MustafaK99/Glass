//! Workspace tags, as Mirror's `/tag`: a small coloured icon on a workspace, and
//! a way to filter by it. The definitions are Mirror's own, the ordered
//! `workspace_tags` list in `~/.mirror/config.json` (Red and Blue when the key is
//! absent; `[]` turns the defaults off), read and written the way
//! `mirror-cli/src/mirror/cli/workspace_tags.py` does. Which agent has which tag is
//! Glass's, kept with the agent.

use std::fs::OpenOptions;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: String,
}

/// Mirror's palette for tags, in its order.
pub const COLORS: &[(&str, &str)] = &[("#d75f5f", "Red"), ("#5f87af", "Blue"), ("#72b58e", "Green"), ("#d7af5f", "Yellow"), ("#af87ff", "Purple")];
/// Mirror's icon choices.
pub const ICONS: &[(&str, &str)] = &[("■", "Square"), ("●", "Circle"), ("★", "Star"), ("⚑", "Flag"), ("✓", "Check"), ("!", "Alert"), ("🚀", "Rocket")];

fn defaults() -> Vec<Tag> {
    vec![
        Tag { id: "blocked".into(), name: "Red".into(), color: Some(COLORS[0].0.into()), icon: "■".into() },
        Tag { id: "in-progress".into(), name: "Blue".into(), color: Some(COLORS[1].0.into()), icon: "■".into() },
    ]
}

fn valid(tag: &Tag) -> Result<()> {
    let id_ok = tag.id.len() <= 64 && tag.id.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric()) && tag.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if !id_ok {
        bail!("tag ID must be 1-64 letters, numbers, underscores or dashes");
    }
    if tag.name.trim().is_empty() || tag.name.chars().count() > 64 || tag.name.chars().any(char::is_control) {
        bail!("tag name must be 1-64 printable characters");
    }
    if let Some(color) = &tag.color {
        if !(color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|ch| ch.is_ascii_hexdigit())) {
            bail!("tag color must be #RRGGBB or omitted");
        }
    }
    let count = tag.icon.chars().count();
    if tag.icon.is_empty() || count > 2 || tag.icon.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        bail!("tag icon must be one printable symbol");
    }
    Ok(())
}

fn definitions_in(settings: &Map<String, Value>) -> Result<Vec<Tag>> {
    let Some(raw) = settings.get("workspace_tags") else { return Ok(defaults()) };
    let Some(entries) = raw.as_array() else { bail!("workspace_tags must be a list") };
    let mut tags: Vec<Tag> = Vec::new();
    for entry in entries {
        let field = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
        let (Some(id), Some(name)) = (field("id"), field("name")) else { bail!("workspace tags require string id and name") };
        let tag = Tag { id, name, color: field("color"), icon: field("icon").unwrap_or_else(|| "■".into()) };
        valid(&tag)?;
        if tags.iter().any(|existing| existing.id == tag.id) {
            bail!("duplicate workspace tag ID {:?}", tag.id);
        }
        tags.push(tag);
    }
    Ok(tags)
}

fn read(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => serde_json::from_str::<Value>(&text)?.as_object().cloned().context("Mirror's config.json is not an object"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn definitions_at(path: &Path) -> Result<Vec<Tag>> {
    definitions_in(&read(path)?)
}

pub fn definitions() -> Result<Vec<Tag>> {
    definitions_at(&crate::memory::config_path())
}

/// Change Mirror's config under its lock (`config.lock`, as its CLI takes it),
/// keeping every other setting, then replace the file in one step.
fn update(path: &Path, change: impl FnOnce(&mut Vec<Tag>) -> Result<()>) -> Result<()> {
    let parent = path.parent().context("no folder for Mirror's config")?;
    std::fs::create_dir_all(parent)?;
    let lock = OpenOptions::new().create(true).append(true).open(path.with_extension("lock"))?;
    lock.lock()?;
    let mut settings = read(path)?;
    let mut tags = definitions_in(&settings)?;
    change(&mut tags)?;
    settings.insert("workspace_tags".into(), json!(tags.iter().map(|tag| json!({ "id": tag.id, "name": tag.name, "color": tag.color, "icon": tag.icon })).collect::<Vec<_>>()));
    let temporary = parent.join(format!(".config.{}.tmp", std::process::id()));
    std::fs::write(&temporary, serde_json::to_string_pretty(&Value::Object(settings))? + "\n")?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Create or edit a tag, keeping its place in the cycling order.
pub fn save_at(path: &Path, tag: Tag) -> Result<()> {
    valid(&tag)?;
    update(path, |tags| {
        match tags.iter().position(|existing| existing.id == tag.id) {
            Some(at) => tags[at] = tag,
            None => tags.push(tag),
        }
        Ok(())
    })
}

pub fn delete_at(path: &Path, id: &str) -> Result<()> {
    update(path, |tags| {
        tags.retain(|tag| tag.id != id);
        Ok(())
    })
}

pub fn save(tag: Tag) -> Result<()> {
    save_at(&crate::memory::config_path(), tag)
}

pub fn delete(id: &str) -> Result<()> {
    delete_at(&crate::memory::config_path(), id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_then_edits_kept_beside_other_settings() {
        let dir = std::env::temp_dir().join(format!("glass-tags-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"approval_mode": "auto"}"#).unwrap();
        assert_eq!(definitions_at(&path).unwrap().iter().map(|tag| tag.id.as_str()).collect::<Vec<_>>(), ["blocked", "in-progress"]);
        save_at(&path, Tag { id: "review".into(), name: "Review".into(), color: Some("#af87ff".into()), icon: "★".into() }).unwrap();
        save_at(&path, Tag { id: "blocked".into(), name: "Stuck".into(), color: None, icon: "!".into() }).unwrap();
        let tags = definitions_at(&path).unwrap();
        assert_eq!(tags.iter().map(|tag| (tag.id.as_str(), tag.name.as_str())).collect::<Vec<_>>(), [("blocked", "Stuck"), ("in-progress", "Blue"), ("review", "Review")]);
        delete_at(&path, "in-progress").unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["approval_mode"], "auto");
        assert_eq!(written["workspace_tags"].as_array().unwrap().len(), 2);
        assert!(save_at(&path, Tag { id: "bad id".into(), name: "x".into(), color: None, icon: "■".into() }).is_err());
        std::fs::write(&path, r#"{"workspace_tags": []}"#).unwrap();
        assert!(definitions_at(&path).unwrap().is_empty(), "[] turns the defaults off");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
