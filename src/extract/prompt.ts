import type { Transcript } from '../transcript.js';

export interface PromptContext {
  project: string;
  cwd?: string | null;
  maxObservations: number;
  digest: string;
  transcript: Pick<Transcript, 'openingPrompt' | 'files'>;
}

/**
 * The extraction prompt. It asks for compression, not summary: each observation
 * has to survive on its own in a future session with none of this context around.
 */
export function buildExtractionPrompt(context: PromptContext): string {
  const files = context.transcript.files.slice(0, 40);
  return `You are the memory extractor for a coding assistant. You are reading the transcript of one Claude Code session and writing down what a future session would need to know.

Project: ${context.project}
Working directory: ${context.cwd ?? 'unknown'}
Session goal (first user message): ${context.transcript.openingPrompt ?? 'unknown'}
Files touched: ${files.length > 0 ? files.join(', ') : 'none recorded'}

Return ONLY a JSON array — no prose, no code fence — of at most ${context.maxObservations} observations, ordered most to least useful. Each element:

{
  "type": "discovery" | "change" | "decision" | "issue",
  "title": "one sentence, under 100 characters, states the finding itself",
  "narrative": "two or three sentences of context: what happened and why it matters later",
  "facts": ["2-5 short standalone statements, each checkable against the code"],
  "scope": "subsystem, package or feature area, lowercase-hyphenated",
  "files": ["repo-relative paths this observation concerns"],
  "keywords": ["extra search terms a future session might use"]
}

Type meanings:
- discovery: how something in this codebase actually works, learned by reading or running it.
- change: something that was modified, added or removed, and the shape of the change.
- decision: a choice made and the reason, especially where another option was rejected.
- issue: a bug, failure, limitation or piece of unfinished work that is still open.

Rules:
- Write titles that read on their own: "Auth middleware rejects tokens issued before a password change", not "Fixed the bug".
- No pronouns referring to this conversation ("we", "the user", "as discussed"). A future reader has no access to it.
- Facts must come from the transcript. Never infer, never fill gaps, never restate the instructions above.
- Skip routine mechanics: file reads that found nothing, greps, formatting passes, chit-chat.
- Prefer fewer, denser observations. An empty array is the correct answer for a session that established nothing durable.

Transcript follows.

<transcript>
${context.digest}
</transcript>`;
}
