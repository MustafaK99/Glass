//! Can Glass write to Mirror's memory through the worker, with no model? Launch a
//! worker with a memory folder, call save_memory directly, and read the store.

use std::sync::Arc;

use glass_app::live::{Emit, Live, Settings};
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let memory = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: memory_smoke <memory-dir> <workspace>"))?;
    let workspace = std::env::args().nth(2).ok_or_else(|| anyhow::anyhow!("usage: memory_smoke <memory-dir> <workspace>"))?;
    std::env::set_var("GLASS_TEST_MEMORY_DIR", &memory);
    let settings = Settings::from_env(std::fs::canonicalize(workspace)?, "low".into(), true);
    let emit: Emit = Arc::new(|_event: Value| {});
    let live = Live::start(&settings, None, emit, None).await?;
    let saved = live.session.call_tool("save_memory", &json!({ "action": "remember", "kind": "preference", "content": "Prefer small commits." })).await?;
    println!("save: {saved:?}");
    let found = live.session.call_tool("search_memory", &json!({ "query": "commits" })).await?;
    println!("search: {found:?}");
    let replaced = live.session.call_tool("save_memory", &json!({ "action": "remember", "kind": "preference", "content": "Prefer small, focused commits.", "replaces": std::env::var("REPLACE_ID").unwrap_or_default() })).await?;
    println!("replace: {replaced:?}");
    let forgot = live.session.call_tool("save_memory", &json!({ "action": "forget", "key": "use-four-spaces-in-python-files" })).await?;
    println!("forget: {forgot:?}");
    live.stop().await;
    Ok(())
}
