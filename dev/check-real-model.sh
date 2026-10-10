#!/usr/bin/env bash
# Run Glass's live-agent code against a real model, the same task as the recording:
# fix the failing test in tmp/stats-demo, approving every request. Then try a short
# prompt at each reasoning effort, to see which ones the provider accepts.
#
#   OPENAI_API_KEY=... dev/check-real-model.sh openai-responses gpt-5-nano
#   ANTHROPIC_API_KEY=... dev/check-real-model.sh anthropic-messages claude-haiku-4-5-20251001
#
# Prints a pass or fail line per check. Keys are read from the environment only.
set -u
api="${1:-openai-responses}"
model="${2:-gpt-5-nano}"
root="$(cd "$(dirname "$0")/.." && pwd)"
demo="$root/tmp/stats-demo"
out="$(mktemp -d)"
cd "$root" || exit 1

# A fresh copy of the two-file project the recording used.
rm -rf "$demo" && mkdir -p "$demo"
printf 'def average(nums):\n    return sum(nums) / (len(nums) + 1)\n' > "$demo/stats.py"
printf 'import unittest\nfrom stats import average\n\nclass TestAverage(unittest.TestCase):\n    def test_average(self):\n        self.assertEqual(average([2, 4, 6]), 4)\n\nif __name__ == "__main__":\n    unittest.main()\n' > "$demo/test_stats.py"
git -C "$demo" init -q && git -C "$demo" add . && git -C "$demo" -c user.name=check -c user.email=check@localhost commit -qm init

echo "Building..."
cargo build -q -p glass-app --example live_smoke || exit 1
run() { GLASS_API="$api" GLASS_MODEL="$model" GLASS_EFFORT="$1" ./target/debug/examples/live_smoke "$demo" "$2" > "$3" 2>&1; }
pass() { printf '  pass  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; }

echo "Fix the failing test with $model ($api)..."
start=$(date +%s)
run medium "Run the tests with python3 -m unittest, find and fix the bug, then run the tests again to confirm they pass." "$out/fix.jsonl"
echo "  took $(( $(date +%s) - start ))s · full event log: $out/fix.jsonl"
events() { grep '^{' "$1" | jq -r '.type' 2>/dev/null; }
events "$out/fix.jsonl" | grep -q '^turn_completed$' && pass "turn completed" || { fail "turn did not complete"; grep -E '"log"|turn_interrupted|turn_error|closed' "$out/fix.jsonl" | tail -5; }
events "$out/fix.jsonl" | grep -q '^text$' && pass "text streamed" || fail "no streamed text"
events "$out/fix.jsonl" | grep -q '^reasoning$' && pass "reasoning streamed" || echo "  note  no reasoning shown (some models do not share it)"
events "$out/fix.jsonl" | grep -q '^approval_requested$' && pass "asked for approval" || fail "never asked for approval"
grep '^{' "$out/fix.jsonl" | jq -e 'select(.type=="message" and .role=="tool" and .display != null and (.display|startswith("---")))' >/dev/null && pass "edit came with a diff" || echo "  note  no edit diff (the model may have used write or bash)"
(cd "$demo" && python3 test_stats.py >/dev/null 2>&1) && pass "the test now passes" || fail "the test still fails"

echo "Reasoning efforts..."
for effort in low medium high xhigh max; do
  run "$effort" "Reply with the single word: ok" "$out/effort-$effort.jsonl"
  if events "$out/effort-$effort.jsonl" | grep -q '^turn_completed$'; then pass "$effort"; else fail "$effort"; grep '"log"' "$out/effort-$effort.jsonl" | jq -r .text 2>/dev/null | tail -2 | sed 's/^/        /'; fi
done
echo "Logs kept in $out"
