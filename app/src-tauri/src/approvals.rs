//! Remembered approvals, shared with Mirror's own CLI.
//!
//! Mirror keeps them in `~/.mirror/tool_approvals.json`: a rule is one exact call
//! (tool name and a hash of its arguments) or, for `bash`, a literal command
//! prefix, each limited to one workspace. Glass reads and writes the same file the
//! same way (`mirror-cli/src/mirror/cli/tool_approvals.py`, `bash_approvals.py`),
//! so a rule saved in Glass works in the terminal and the other way round. A call
//! that matches a rule is answered at once, and the worker is told it was remembered.
//!
//! Glass reads commands more strictly than the CLI: only plain words and simple
//! quoted strings count as literal, so a rule never matches a command the CLI
//! would not.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use glass_core::ApprovalSource;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The longest arguments the CLI will consider for a prefix rule.
const MAX_ARGUMENTS: usize = 16_384;
const MAX_ARGV: usize = 128;

pub fn path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mirror").join("tool_approvals.json")
}

/// A JSON string as Python's `json.dumps` writes it (ASCII only), so scopes match
/// the CLI's byte for byte.
fn py_string(text: &str) -> String {
    let mut out = String::from("\"");
    for unit in text.encode_utf16() {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x20..=0x7e => out.push(unit as u8 as char),
            _ => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
    out
}

/// The CLI's local scope: `json.dumps(('local-v1', workspace, MIRROR_WORKSPACE))`.
/// Glass never sets MIRROR_WORKSPACE for its workers, so the last item is null.
pub fn scope(workspace: &Path) -> String {
    // The CLI uses the process's working directory, which macOS reports resolved.
    let workspace = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    format!("[\"local-v1\", {}, null]", py_string(&workspace.to_string_lossy()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rule {
    Exact { scope: String, tool: String, sha256: String },
    Prefix { scope: String, tool: String, argv: Vec<String> },
}

impl Rule {
    fn to_json(&self) -> Value {
        match self {
            Rule::Exact { scope, tool, sha256 } => json!({ "kind": "exact_arguments", "scope": scope, "tool": tool, "arguments_sha256": sha256 }),
            Rule::Prefix { scope, tool, argv } => json!({ "kind": "argv_prefix", "scope": scope, "tool": tool, "argv": argv }),
        }
    }
}

fn exact(tool: &str, arguments: &str, scope: &str) -> Option<Rule> {
    (!tool.is_empty() && !scope.is_empty()).then(|| Rule::Exact {
        scope: scope.to_string(),
        tool: tool.to_string(),
        sha256: format!("{:x}", Sha256::digest(arguments.as_bytes())),
    })
}

fn word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || "_./:@%+,=-".contains(ch)
}

/// The command's words, if it is one command made only of literal words: plain
/// words, 'single-quoted' and "double-quoted" text without `\`, `$` or backquotes,
/// and words joined from those. Anything else is not literal and gets no prefixes.
pub fn literal_argv(command: &str) -> Option<Vec<String>> {
    if command.is_empty() || command.chars().any(|ch| ch.is_control()) {
        return None;
    }
    let mut argv = Vec::new();
    let mut chars = command.chars().peekable();
    loop {
        while chars.peek() == Some(&' ') {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut word = String::new();
        while let Some(&ch) = chars.peek() {
            match ch {
                ' ' => break,
                '\'' => {
                    chars.next();
                    loop {
                        match chars.next()? {
                            '\'' => break,
                            inner => word.push(inner),
                        }
                    }
                }
                '"' => {
                    chars.next();
                    loop {
                        match chars.next()? {
                            '"' => break,
                            '\\' | '$' | '`' => return None,
                            inner => word.push(inner),
                        }
                    }
                }
                ch if word_char(ch) => {
                    word.push(ch);
                    chars.next();
                }
                _ => return None,
            }
        }
        argv.push(word);
    }
    // A leading NAME=value is an assignment to the shell, not a program.
    if argv.first().map_or(true, |first| first.is_empty() || first.contains('=')) || argv.len() > MAX_ARGV {
        return None;
    }
    Some(argv)
}

/// The bash command in a call's arguments: exactly `{"command": "..."}`.
fn bash_command(arguments: &str) -> Option<String> {
    if arguments.len() > MAX_ARGUMENTS || arguments.matches("\"command\"").count() != 1 {
        return None;
    }
    let value: Value = serde_json::from_str(arguments).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get("command")?.as_str().map(str::to_string)
}

/// Every literal prefix of a bash call, the whole command first.
fn prefixes(arguments: &str, scope: &str) -> Vec<Rule> {
    let Some(argv) = bash_command(arguments).as_deref().and_then(literal_argv) else { return Vec::new() };
    (1..=argv.len()).rev().map(|length| Rule::Prefix { scope: scope.to_string(), tool: "bash".to_string(), argv: argv[..length].to_vec() }).collect()
}

/// What the CLI would offer to remember: a command's own prefix (a few read-only
/// programs by name alone), else the exact call.
pub fn suggestion(tool: &str, arguments: &str, workspace: &Path) -> Option<Rule> {
    let scope = scope(workspace);
    if tool == "bash" {
        if let Some(Rule::Prefix { scope, tool, argv }) = prefixes(arguments, &scope).into_iter().next() {
            let argv = if ["cat", "head", "tail", "wc", "printf"].contains(&argv[0].as_str()) { argv[..1].to_vec() } else { argv };
            return Some(Rule::Prefix { scope, tool, argv });
        }
    }
    exact(tool, arguments, &scope)
}

fn read_entries(settings: &Value) -> Result<Vec<Rule>> {
    let Some(object) = settings.as_object() else { bail!("tool approvals must be a JSON object") };
    if object.is_empty() {
        return Ok(Vec::new());
    }
    if object.len() != 2 || object.get("version") != Some(&json!(1)) || !object.get("entries").is_some_and(Value::is_array) {
        bail!("unsupported tool approvals format");
    }
    let mut rules = Vec::new();
    for entry in object["entries"].as_array().unwrap() {
        let Some(entry) = entry.as_object() else { bail!("invalid tool approval entry") };
        let text = |key: &str| entry.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
        let keys: Vec<&str> = {
            let mut keys: Vec<&str> = entry.keys().map(String::as_str).collect();
            keys.sort();
            keys
        };
        // Untagged entries from the first version are exact grants.
        let kind = if keys == ["arguments_sha256", "scope", "tool"] { Some("exact_arguments".to_string()) } else { text("kind") };
        let (Some(kind), Some(scope), Some(tool)) = (kind, text("scope"), text("tool")) else { bail!("invalid tool approval kind, scope or name") };
        match kind.as_str() {
            "exact_arguments" => {
                let sha256 = text("arguments_sha256").unwrap_or_default();
                if sha256.len() != 64 || !sha256.chars().all(|ch| "0123456789abcdef".contains(ch)) {
                    bail!("invalid tool approval argument digest");
                }
                rules.push(Rule::Exact { scope, tool, sha256 });
            }
            "argv_prefix" => {
                let argv: Option<Vec<String>> = entry.get("argv").and_then(Value::as_array).map(|words| words.iter().filter_map(|word| word.as_str().map(str::to_string)).collect());
                let argv = argv.filter(|argv| !argv.is_empty() && !argv[0].is_empty() && argv.iter().all(|word| !word.chars().any(char::is_control)));
                let Some(argv) = argv else { bail!("invalid argv prefix approval entry") };
                rules.push(Rule::Prefix { scope, tool, argv });
            }
            // Unknown kinds grant nothing.
            _ => {}
        }
    }
    Ok(rules)
}

fn read(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str(&text).context("tool_approvals.json is not valid JSON"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.into()),
    }
}

/// Whether a saved rule allows this call, and which kind. An unreadable file
/// allows nothing, as in the CLI.
pub fn check_in(path: &Path, tool: &str, arguments: &str, workspace: &Path) -> Option<ApprovalSource> {
    let rules = read(path).and_then(|settings| read_entries(&settings)).ok()?;
    let scope = scope(workspace);
    if exact(tool, arguments, &scope).is_some_and(|rule| rules.contains(&rule)) {
        return Some(ApprovalSource::RememberedExact);
    }
    (tool == "bash" && prefixes(arguments, &scope).iter().any(|rule| rules.contains(rule))).then_some(ApprovalSource::RememberedPrefix)
}

pub fn check(tool: &str, arguments: &str, workspace: &Path) -> Option<ApprovalSource> {
    check_in(&path(), tool, arguments, workspace)
}

/// Add a rule under the CLI's lock, keeping every entry already there.
pub fn remember_in(path: &Path, rule: &Rule) -> Result<()> {
    let parent = path.parent().context("no folder for tool approvals")?;
    std::fs::create_dir_all(parent)?;
    let lock: File = OpenOptions::new().create(true).append(true).open(path.with_extension("lock"))?;
    lock.lock()?;
    let mut settings = read(path)?;
    let rules = read_entries(&settings)?;
    if rules.contains(rule) {
        return Ok(());
    }
    if settings.as_object().is_some_and(|object| object.is_empty()) {
        settings = json!({ "version": 1, "entries": [] });
    }
    settings["entries"].as_array_mut().context("tool approvals entries must be a list")?.push(rule.to_json());
    let temporary = parent.join(format!(".tool_approvals.{}.tmp", std::process::id()));
    std::fs::write(&temporary, serde_json::to_string_pretty(&settings)? + "\n")?;
    std::fs::rename(&temporary, path).context("could not save the approval")?;
    Ok(())
}

pub fn remember(rule: &Rule) -> Result<()> {
    remember_in(&path(), rule)
}

/// How the approval card describes a rule, in the CLI's words.
#[derive(Serialize)]
pub struct Offer {
    /// "Always allow" for a command prefix, "Remember" for one exact call.
    pub label: String,
    pub detail: String,
}

pub fn offer(rule: &Rule) -> Offer {
    match rule {
        Rule::Prefix { argv, .. } => Offer { label: "Always allow".into(), detail: format!("{} · this workspace", shell_join(argv)) },
        Rule::Exact { .. } => Offer { label: "Remember".into(), detail: "this exact call · this workspace".into() },
    }
}

/// Python's `shlex.join`, for showing a prefix.
fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|word| {
            if !word.is_empty() && word.chars().all(|ch| ch.is_ascii_alphanumeric() || "@%+=:,./-_".contains(ch)) {
                word.clone()
            } else {
                format!("'{}'", word.replace('\'', "'\"'\"'"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_matches_python_json_dumps() {
        assert_eq!(scope(Path::new("/nonexistent/proj")), "[\"local-v1\", \"/nonexistent/proj\", null]");
        assert_eq!(py_string("caf\u{e9} \"x\"\\"), "\"caf\\u00e9 \\\"x\\\"\\\\\"");
        assert_eq!(py_string("\u{1F600}"), "\"\\ud83d\\ude00\"");
    }

    #[test]
    fn reads_only_literal_commands() {
        assert_eq!(literal_argv("python3 -m unittest"), Some(vec!["python3".into(), "-m".into(), "unittest".into()]));
        assert_eq!(literal_argv("git commit -m 'fix it' --author=\"A B\""), Some(vec!["git".into(), "commit".into(), "-m".into(), "fix it".into(), "--author=A B".into()]));
        for refused in ["ls | wc", "echo $HOME", "rm -rf ~", "a && b", "FOO=1 make", "echo \"$x\"", "cat 'open", "x\ny", "ls *.py", "echo `id`"] {
            assert_eq!(literal_argv(refused), None, "{refused}");
        }
    }

    #[test]
    fn suggests_like_the_cli() {
        let ws = Path::new("/nonexistent/proj");
        assert!(matches!(suggestion("bash", r#"{"command": "cat a.txt"}"#, ws), Some(Rule::Prefix { argv, .. }) if argv == ["cat"]));
        assert!(matches!(suggestion("bash", r#"{"command": "npm test"}"#, ws), Some(Rule::Prefix { argv, .. }) if argv == ["npm", "test"]));
        assert!(matches!(suggestion("bash", r#"{"command": "ls | wc"}"#, ws), Some(Rule::Exact { .. })));
        assert!(matches!(suggestion("mcp__x__search", r#"{"q": 1}"#, ws), Some(Rule::Exact { .. })));
        assert_eq!(offer(&suggestion("bash", r#"{"command": "git commit -m 'a b'"}"#, ws).unwrap()).detail, "git commit -m 'a b' · this workspace");
    }

    #[test]
    fn remembers_alongside_the_clis_entries_and_matches() {
        let dir = std::env::temp_dir().join(format!("glass-approvals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tool_approvals.json");
        let ws = dir.join("proj");
        std::fs::create_dir_all(&ws).unwrap();
        // An entry the CLI wrote, and one of a kind Glass does not know.
        let cli = format!("{{\"version\": 1, \"entries\": [{{\"kind\": \"argv_prefix\", \"scope\": {}, \"tool\": \"bash\", \"argv\": [\"cargo\", \"test\"]}}, {{\"kind\": \"future\", \"scope\": \"s\", \"tool\": \"t\"}}]}}", py_string(&scope(&ws)));
        std::fs::write(&file, cli).unwrap();
        assert_eq!(check_in(&file, "bash", r#"{"command": "cargo test -p core"}"#, &ws), Some(ApprovalSource::RememberedPrefix));
        assert_eq!(check_in(&file, "bash", r#"{"command": "cargo build"}"#, &ws), None);
        assert_eq!(check_in(&file, "bash", r#"{"command": "cargo test; rm x"}"#, &ws), None, "not literal");
        assert_eq!(check_in(&file, "bash", r#"{"command": "cargo test"}"#, &dir), None, "another workspace");

        let rule = suggestion("mcp__x__search", r#"{"q":1}"#, &ws).unwrap();
        remember_in(&file, &rule).unwrap();
        remember_in(&file, &rule).unwrap();
        assert_eq!(check_in(&file, "mcp__x__search", r#"{"q":1}"#, &ws), Some(ApprovalSource::RememberedExact));
        assert_eq!(check_in(&file, "mcp__x__search", r#"{"q": 1}"#, &ws), None, "exact means byte for byte");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["entries"].as_array().unwrap().len(), 3, "kept both old entries, added one once");
        assert_eq!(saved["entries"][1]["kind"], "future");

        std::fs::write(&file, "{\"version\": 2, \"entries\": []}").unwrap();
        assert_eq!(check_in(&file, "mcp__x__search", r#"{"q":1}"#, &ws), None, "an unknown format allows nothing");
        assert!(remember_in(&file, &rule).is_err(), "and is never overwritten");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod interop {
    use super::*;

    /// With GLASS_TEST_INTEROP=<folder>: rules the real CLI saved in cli.json for
    /// <folder>/ws match in Glass, and a rule Glass saves in glass.json is there.
    #[test]
    fn matches_rules_the_cli_saved() {
        let Some(dir) = std::env::var_os("GLASS_TEST_INTEROP").map(PathBuf::from) else { return };
        let ws = dir.join("ws");
        let cli = dir.join("cli.json");
        assert_eq!(check_in(&cli, "bash", r#"{"command": "python3 -m unittest -v"}"#, &ws), Some(ApprovalSource::RememberedPrefix));
        assert_eq!(check_in(&cli, "bash", r#"{"command": "python3 -m unittest -v test_stats"}"#, &ws), Some(ApprovalSource::RememberedPrefix));
        assert_eq!(check_in(&cli, "bash", r#"{"command": "python3 -m pip install x"}"#, &ws), None);
        assert_eq!(check_in(&cli, "mcp__x__search", r#"{"q":1}"#, &ws), Some(ApprovalSource::RememberedExact));
        remember_in(&dir.join("glass.json"), &suggestion("bash", r#"{"command": "npm run 'build all'"}"#, &ws).unwrap()).unwrap();
    }
}
