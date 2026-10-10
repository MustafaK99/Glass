"""A tiny stdio MCP server for testing Glass's MCP support with no account or key.

Tools: `search` returns canned results for a query; `add` adds two numbers.
Configure it as ~/.mirror/mcp/fake.json (or under $MIRROR_MCP_DIR):

  {"command": "python3", "args": ["/path/to/Glass/dev/fake_mcp.py"]}
"""
import json, sys

TOOLS = [
    {
        "name": "search",
        "description": "Search the web (canned results, for testing).",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "add",
        "description": "Add two numbers.",
        "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]},
    },
]

def reply(id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": id}
    message["error" if error else "result"] = error or result
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    method, id, params = request.get("method"), request.get("id"), request.get("params") or {}
    if id is None:
        continue  # notifications
    if method == "initialize":
        reply(id, {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "0.1"}})
    elif method == "tools/list":
        reply(id, {"tools": TOOLS})
    elif method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name == "search":
            text = f"Results for {args.get('query', '')!r}:\n1. Python statistics docs: statistics.mean(data)\n2. Stack Overflow: average of a list in Python"
            reply(id, {"content": [{"type": "text", "text": text}], "isError": False})
        elif name == "add":
            reply(id, {"content": [{"type": "text", "text": str(args.get("a", 0) + args.get("b", 0))}], "isError": False})
        else:
            reply(id, {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True})
    elif method == "ping":
        reply(id, {})
    else:
        reply(id, error={"code": -32601, "message": f"unknown method {method}"})
