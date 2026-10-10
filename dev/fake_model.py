"""A scripted OpenAI-compatible endpoint, for testing the client without a model key.

Each POST to /v1/chat/completions gets the next scripted reply, streamed as SSE.
Request bodies are saved so the worker's tool schemas can be inspected.

Usage: fake_model.py PORT SCRIPT.json LOG_DIR [WORKSPACE]
"$WORKSPACE" in the script is replaced with the WORKSPACE argument.
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, script_path, log_dir = int(sys.argv[1]), sys.argv[2], sys.argv[3]
os.makedirs(log_dir, exist_ok=True)
workspace = sys.argv[4] if len(sys.argv) > 4 else "."
script = json.loads(open(script_path).read().replace("$WORKSPACE", workspace))
state = {"n": 0}

def chunks(step):
    base = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": int(time.time()), "model": "fake"}
    def c(delta, finish=None):
        return {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    yield c({"role": "assistant", "content": ""})
    for piece in step.get("reasoning", []):
        yield c({"reasoning_content": piece})
    for piece in step.get("text", []):
        yield c({"content": piece})
    for i, call in enumerate(step.get("tools", [])):
        args = json.dumps(call["arguments"])
        yield c({"tool_calls": [{"index": i, "id": f"call_{state['n']}_{i}", "type": "function", "function": {"name": call["name"], "arguments": ""}}]})
        half = len(args) // 2
        for part in (args[:half], args[half:]):
            yield c({"tool_calls": [{"index": i, "function": {"arguments": part}}]})
    yield c({}, "tool_calls" if step.get("tools") else "stop")
    yield {**base, "choices": [], "usage": {"prompt_tokens": 1200, "completion_tokens": 40, "total_tokens": 1240}}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fake", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        open(f"{log_dir}/request-{state['n']}.json", "wb").write(raw)
        step = script[min(state["n"], len(script) - 1)]; state["n"] += 1
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        for chunk in chunks(step):
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush(); time.sleep(0.02)
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
