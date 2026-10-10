// Assistant text and reasoning as formatted HTML: markdown, with code coloured.

import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { highlightBlock } from "./highlight";

const ALIASES: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", rs: "rust", yml: "yaml", toml: "ini", html: "xml" };

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const name = (lang ?? "").trim().split(/\s/)[0].toLowerCase();
      const language = ALIASES[name] ?? (name || null);
      const label = name ? `<span class="code-lang">${name.replace(/[^\w+#.-]/g, "")}</span>` : "";
      return `<pre class="code hl">${label}<button type="button" class="copy-btn" data-copy="code">copy</button><code>${highlightBlock(text.replace(/\n$/, ""), language)}</code></pre>`;
    },
  },
});

/** Markdown to safe HTML. Streaming text renders fine half-finished. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
