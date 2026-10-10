// Comments on diff lines, sent to the agent as one message.

export interface ReviewComment {
  id: string;
  path: string;
  /** The line in the new file, or in the old one for a removed line. */
  line: number;
  side: "new" | "old";
  code: string;
  body: string;
}

/** The message the agent receives: each comment with its file, line and code quoted. */
export function reviewMessage(comments: ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const parts = sorted.map((comment) => {
    const where = `${comment.path}, line ${comment.line}${comment.side === "old" ? " (a removed line)" : ""}`;
    return `${where}:\n> ${comment.code.trim() || "(blank line)"}\n${comment.body.trim()}`;
  });
  return `Review comments on your changes. Please address each one.\n\n${parts.join("\n\n")}`;
}
