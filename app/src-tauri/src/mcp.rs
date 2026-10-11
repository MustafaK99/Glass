//! MCP servers, the simple case: Mirror's own config in `~/.mirror/mcp/*.json`,
//! servers that run as a local command, or a URL with a bearer token from the
//! environment. OAuth servers are listed as needing sign-in; that is after v1.
//!
//! Glass hosts the tools the way Mirror's client does: it connects to each
//! server, declares the tools to the worker at launch as `mcp__<server>__<tool>`,
//! and runs each `host_tool_call` the worker sends. The worker asks for approval
//! first in manual mode, as for its own tools.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{Mutex, OnceCell};

const DEFAULT_TIMEOUT: f64 = 300.0;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Mirror's config folder for MCP servers.
pub fn config_dir() -> PathBuf {
    match std::env::var("MIRROR_MCP_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir.replacen('~', &std::env::var("HOME").unwrap_or_default(), 1)),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mirror").join("mcp"),
    }
}

/// The model-facing name, as Mirror's client makes it.
pub fn tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect()
}

#[derive(Serialize, Clone, Debug)]
pub struct ServerInfo {
    pub name: String,
    /// "command" or "url".
    pub kind: String,
    /// connected, failed, needs sign-in.
    pub status: String,
    pub detail: Option<String>,
    pub tools: Vec<String>,
}

struct Tool {
    server: String,
    remote: String,
    timeout: f64,
}

struct Connected {
    // Kept alive for the life of the app; dropping it closes the server.
    service: RunningService<RoleClient, ()>,
}

#[derive(Default)]
struct State {
    servers: Vec<ServerInfo>,
    definitions: Vec<Value>,
    tools: HashMap<String, Tool>,
    clients: HashMap<String, Arc<Connected>>,
}

/// Every configured server, connected once, shared by all agents.
#[derive(Default)]
pub struct Hub {
    ready: OnceCell<()>,
    state: Mutex<State>,
}

fn text_of(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

/// A string, or the value of the environment variable a config names.
fn env_value(name: &str) -> Result<String, String> {
    crate::secrets::lookup(name).ok_or_else(|| format!("{name} is not set in Settings or your environment"))
}

impl Hub {
    /// Connect to every server the first time it is needed. Later calls return at once.
    pub async fn ensure(&self) {
        self.ready
            .get_or_init(|| async {
                let state = connect_all().await;
                *self.state.lock().await = state;
            })
            .await;
    }

    pub async fn servers(&self) -> Vec<ServerInfo> {
        self.ensure().await;
        self.state.lock().await.servers.clone()
    }

    /// The `host_tools` entries for a worker's launch config.
    pub async fn definitions(&self) -> Vec<Value> {
        self.ensure().await;
        self.state.lock().await.definitions.clone()
    }

    /// Run one tool call from the worker. Returns the content and whether it succeeded.
    pub async fn call(&self, name: &str, arguments: &str) -> (String, bool) {
        let (client, remote, timeout) = {
            let state = self.state.lock().await;
            let Some(tool) = state.tools.get(name) else {
                return (format!("unknown host tool {name}"), false);
            };
            let Some(client) = state.clients.get(&tool.server).cloned() else {
                return (format!("MCP server {} is not connected", tool.server), false);
            };
            (client, tool.remote.clone(), tool.timeout)
        };
        let arguments: Map<String, Value> = match serde_json::from_str::<Value>(if arguments.trim().is_empty() { "{}" } else { arguments }) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return ("Tool arguments must be a JSON object".to_string(), false),
            Err(error) => return (format!("Invalid tool arguments: {error}"), false),
        };
        let mut params = CallToolRequestParams::new(remote);
        params.arguments = Some(arguments);
        match tokio::time::timeout(Duration::from_secs_f64(timeout), client.service.call_tool(params)).await {
            Err(_) => (format!("Tool call timed out after {timeout} seconds"), false),
            Ok(Err(error)) => (error.to_string(), false),
            Ok(Ok(result)) => {
                // Read the result as JSON, so this code does not track the SDK's types.
                let value = serde_json::to_value(&result).unwrap_or(Value::Null);
                let failed = value["isError"].as_bool().unwrap_or(false);
                let content = if !value["structuredContent"].is_null() {
                    value["structuredContent"].to_string()
                } else {
                    value["content"]
                        .as_array()
                        .map(|blocks| {
                            blocks
                                .iter()
                                .map(|block| if block["type"] == "text" { block["text"].as_str().unwrap_or_default().to_string() } else { block.to_string() })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default()
                };
                (content, !failed)
            }
        }
    }
}

async fn connect_all() -> State {
    tokio::task::spawn_blocking(crate::settings::wait_for_login_env).await.ok();
    let mut state = State::default();
    let Ok(entries) = std::fs::read_dir(config_dir()) else { return state };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "json")).collect();
    paths.sort();
    let mut pending = Vec::new();
    for path in paths {
        let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
            continue;
        }
        let config: Value = match std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()) {
            Some(value @ Value::Object(_)) => value,
            _ => {
                state.servers.push(ServerInfo { name, kind: "unknown".into(), status: "failed".into(), detail: Some(format!("{} is not a JSON object", path.display())), tools: vec![] });
                continue;
            }
        };
        pending.push(tokio::spawn(async move {
            let result = tokio::time::timeout(CONNECT_TIMEOUT, open(&name, &config)).await;
            (name, config, result)
        }));
    }
    for task in pending {
        let Ok((name, config, result)) = task.await else { continue };
        let kind = if config.get("url").is_some() { "url" } else { "command" }.to_string();
        let timeout = config["toolTimeoutSeconds"].as_f64().filter(|seconds| *seconds > 0.0).unwrap_or(DEFAULT_TIMEOUT);
        match result {
            Err(_) => state.servers.push(ServerInfo { name, kind, status: "failed".into(), detail: Some("did not answer within 20 seconds".into()), tools: vec![] }),
            Ok(Err(Opened::NeedsSignIn)) => state.servers.push(ServerInfo {
                name: name.clone(),
                kind,
                status: "needs sign-in".into(),
                detail: Some(format!("Glass cannot sign in yet. Its tools are not offered to agents.")),
                tools: vec![],
            }),
            Ok(Err(Opened::Failed(error))) => state.servers.push(ServerInfo { name, kind, status: "failed".into(), detail: Some(error), tools: vec![] }),
            Ok(Ok((service, tools))) => {
                let enabled: Option<Vec<String>> = config["enabledTools"].as_array().map(|names| names.iter().filter_map(|name| name.as_str().map(str::to_string)).collect());
                let mut names = Vec::new();
                for tool in tools {
                    let remote = text_of(&tool["name"]).unwrap_or_default().to_string();
                    if remote.is_empty() || enabled.as_ref().is_some_and(|list| !list.contains(&remote)) {
                        continue;
                    }
                    let local = tool_name(&name, &remote);
                    let description = match text_of(&tool["description"]) {
                        Some(text) => format!("[{name} MCP] {text}"),
                        None => format!("MCP tool {remote} from server {name}."),
                    };
                    state.definitions.push(json!({
                        "name": local,
                        "description": description,
                        "parameters": tool["inputSchema"],
                        "needs_approval": true,
                        "timeout_seconds": timeout,
                    }));
                    state.tools.insert(local, Tool { server: name.clone(), remote: remote.clone(), timeout });
                    names.push(remote);
                }
                state.clients.insert(name.clone(), Arc::new(Connected { service }));
                state.servers.push(ServerInfo { name, kind, status: "connected".into(), detail: None, tools: names });
            }
        }
    }
    state.servers.sort_by(|a, b| a.name.cmp(&b.name));
    state
}

enum Opened {
    NeedsSignIn,
    Failed(String),
}

async fn open(name: &str, config: &Value) -> Result<(RunningService<RoleClient, ()>, Vec<Value>), Opened> {
    let fail = |error: String| Opened::Failed(error);
    let service = match (config.get("url").and_then(Value::as_str), config.get("command").and_then(Value::as_str)) {
        (Some(_), Some(_)) | (None, None) => return Err(fail("needs exactly one of url or command".into())),
        (Some(url), None) => {
            let mut transport = StreamableHttpClientTransportConfig::with_uri(url.to_string());
            match config["auth"]["type"].as_str() {
                None => {}
                Some("bearer") => {
                    let variable = config["auth"]["tokenEnvVar"].as_str().ok_or_else(|| fail("bearer auth needs tokenEnvVar".into()))?;
                    transport = transport.auth_header(env_value(variable).map_err(fail)?);
                }
                Some("oauth") => return Err(Opened::NeedsSignIn),
                Some(other) => return Err(fail(format!("unknown auth type {other}"))),
            }
            ().serve(StreamableHttpClientTransport::from_config(transport)).await.map_err(|error| fail(error.to_string()))?
        }
        (None, Some(command)) => {
            let mut process = tokio::process::Command::new(command);
            if let Some(args) = config["args"].as_array() {
                process.args(args.iter().filter_map(Value::as_str));
            }
            // Like Mirror: env maps a variable for the server to one in Glass's environment.
            if let Some(env) = config["env"].as_object() {
                for (target, source) in env {
                    let source = source.as_str().ok_or_else(|| fail("env must map strings to strings".into()))?;
                    process.env(target, env_value(source).map_err(fail)?);
                }
            }
            process.stderr(std::process::Stdio::null());
            let transport = TokioChildProcess::new(process).map_err(|error| fail(format!("could not start {command}: {error}")))?;
            ().serve(transport).await.map_err(|error| fail(error.to_string()))?
        }
    };
    let tools = service.list_all_tools().await.map_err(|error| fail(format!("{name}: {error}")))?;
    let tools = tools.into_iter().filter_map(|tool| serde_json::to_value(tool).ok()).collect();
    Ok((service, tools))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_mirrors_client() {
        assert_eq!(tool_name("linear", "create_issue"), "mcp__linear__create_issue");
        assert_eq!(tool_name("my.server", "do it"), "mcp__my_server__do_it");
    }

    #[tokio::test]
    async fn connects_to_a_command_server_and_calls_a_tool() {
        let dir = std::env::temp_dir().join(format!("glass-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dev/fake_mcp.py");
        std::fs::write(dir.join("fake.json"), json!({ "command": "python3", "args": [script] }).to_string()).unwrap();
        std::fs::write(dir.join("broken.json"), json!({ "command": "/nonexistent/server" }).to_string()).unwrap();
        std::fs::write(dir.join("cloud.json"), json!({ "url": "https://example.invalid/mcp", "auth": { "type": "oauth" } }).to_string()).unwrap();
        std::env::set_var("MIRROR_MCP_DIR", &dir);

        let hub = Hub::default();
        let servers = hub.servers().await;
        let status: Vec<_> = servers.iter().map(|server| (server.name.as_str(), server.status.as_str())).collect();
        assert_eq!(status, [("broken", "failed"), ("cloud", "needs sign-in"), ("fake", "connected")]);
        let names: Vec<_> = hub.definitions().await.iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["mcp__fake__search", "mcp__fake__add"]);
        assert_eq!(hub.call("mcp__fake__add", r#"{"a": 2, "b": 3}"#).await, ("5".to_string(), true));
        assert_eq!(hub.call("mcp__fake__nope", "{}").await.1, false);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
