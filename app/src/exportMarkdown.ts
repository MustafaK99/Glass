// A session as Markdown, to keep or share. Built from what the screen shows.

import { relative, type AgentState } from "./agent";
import { toolLabel, toolSummary } from "./Transcript";

const fence = (text: string, language = "") => {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${language}\n${text.replace(/\n$/, "")}\n${ticks}`;
};

export function toMarkdown(agent: AgentState): string {
  const { meta } = agent;
  const out = [
    `# ${meta.title}`,
    "",
    `${meta.project} · ${meta.branch || "no git"} · ${meta.model} (${meta.api}) · reasoning ${meta.effort} · ${meta.mode}`,
    "",
    "_Exported from Glass, an unofficial desktop app for Mirror._",
    "",
  ];
  for (const item of agent.items) {
    switch (item.kind) {
      case "user":
        out.push("## You", "", item.text, "");
        break;
      case "reasoning":
        out.push("<details><summary>reasoning</summary>", "", item.text, "", "</details>", "");
        break;
      case "text":
        out.push(item.text, "");
        break;
      case "tool": {
        const label = `**${toolLabel(item.name)}** · \`${toolSummary(item, meta.workspace)}\``;
        const tail = item.approval === "rejected" ? " · rejected" : item.result && !item.result.success ? " · failed" : item.result?.exitCode != null ? ` · exit ${item.result.exitCode}` : "";
        out.push(`${label}${tail}`, "");
        const shown = item.result?.display && (item.name === "edit" || item.name === "write") ? item.result.display : item.result?.content;
        if (shown && item.approval !== "rejected") out.push(fence(shown.slice(0, 20_000), item.name === "edit" || item.name === "write" ? "diff" : ""), "");
        break;
      }
      case "notice":
        out.push(`> ${item.text}`, ...(item.lines.length ? ["", fence(item.lines.join("\n"))] : []), "");
        break;
      case "summary": {
        const files = item.files.map((file) => `${relative(file.path, meta.workspace)} +${file.add} -${file.del}`).join(", ");
        out.push(`_${item.outcome === "stopped" ? "stopped" : "done"}${item.seconds ? ` in ${item.seconds}s` : ""}${item.tokens ? ` · ${item.tokens} tokens` : ""}${files ? ` · ${files}` : ""}_`, "");
        break;
      }
      case "draft":
        break;
    }
  }
  return out.join("\n");
}
