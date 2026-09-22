import { existsSync, readFileSync } from 'node:fs';

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: string;
}

export interface ToolCall {
  name: string;
  summary: string;
  file?: string;
}

export interface Transcript {
  path: string;
  turns: TranscriptTurn[];
  toolCalls: ToolCall[];
  files: string[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** First real user message — the closest thing a session has to a topic. */
  openingPrompt: string | null;
}

interface RawEntry {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  summary?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

const FILE_KEYS = ['file_path', 'notebook_path', 'path'];
const TOOL_HINT_KEYS = ['command', 'pattern', 'query', 'prompt', 'description', 'url'];

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function describeToolInput(input: Record<string, unknown>): { summary: string; file?: string } {
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value) {
      const extra = TOOL_HINT_KEYS.map((hint) => input[hint]).find(
        (hint): hint is string => typeof hint === 'string' && hint.length > 0,
      );
      return { summary: extra ? `${value} — ${clip(extra, 120)}` : value, file: value };
    }
  }
  for (const key of TOOL_HINT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value) return { summary: clip(value, 200) };
  }
  return { summary: clip(JSON.stringify(input), 160) };
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string };
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
  }
  return parts.join('\n');
}

/** Parses a Claude Code transcript (JSONL) into turns, tool calls and touched files. */
export function parseTranscript(path: string): Transcript {
  const transcript: Transcript = {
    path,
    turns: [],
    toolCalls: [],
    files: [],
    firstTimestamp: null,
    lastTimestamp: null,
    openingPrompt: null,
  };
  if (!existsSync(path)) return transcript;

  const seenFiles = new Set<string>();
  const lines = readFileSync(path, 'utf8').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed) as RawEntry;
    } catch {
      continue; // A half-written final line is normal while a session is live.
    }
    if (entry.isMeta) continue;

    if (entry.timestamp) {
      transcript.firstTimestamp ??= entry.timestamp;
      transcript.lastTimestamp = entry.timestamp;
    }

    if (entry.type === 'summary' && typeof entry.summary === 'string') {
      transcript.turns.push({ role: 'system', text: entry.summary, timestamp: entry.timestamp });
      continue;
    }

    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: string; name?: string; input?: unknown };
        if (typed.type !== 'tool_use' || typeof typed.name !== 'string') continue;
        const input = (typed.input ?? {}) as Record<string, unknown>;
        const { summary, file } = describeToolInput(input);
        transcript.toolCalls.push(file ? { name: typed.name, summary, file } : { name: typed.name, summary });
        if (file && !seenFiles.has(file)) {
          seenFiles.add(file);
          transcript.files.push(file);
        }
      }
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const text = textFromContent(content).trim();
    if (!text) continue;
    // Tool results and local command chatter are replayed as user turns; they add
    // bulk without adding meaning.
    if (entry.type === 'user' && /^<(command-name|local-command|bash-input)/.test(text)) continue;

    const turn: TranscriptTurn = { role: entry.type, text, timestamp: entry.timestamp };
    transcript.turns.push(turn);
    if (entry.type === 'user' && !transcript.openingPrompt && !text.startsWith('<')) {
      transcript.openingPrompt = clip(text, 300);
    }
  }

  return transcript;
}

/**
 * Flattens a transcript into the text handed to the extractor. When it does not
 * fit the budget the middle is dropped: the opening states the goal and the tail
 * holds the outcome, which is where the durable facts live.
 */
export function buildDigest(transcript: Transcript, charBudget: number): string {
  const lines: string[] = [];

  for (const turn of transcript.turns) {
    const label = turn.role === 'user' ? 'USER' : turn.role === 'assistant' ? 'CLAUDE' : 'NOTE';
    lines.push(`[${label}] ${clip(turn.text, 1_500)}`);
  }

  if (transcript.toolCalls.length > 0) {
    lines.push('');
    lines.push('[TOOL CALLS]');
    for (const call of transcript.toolCalls.slice(-120)) {
      lines.push(`- ${call.name}: ${clip(call.summary, 160)}`);
    }
  }

  const body = lines.join('\n');
  if (body.length <= charBudget) return body;

  const head = Math.floor(charBudget * 0.25);
  const tail = charBudget - head;
  return `${body.slice(0, head)}\n\n…[${body.length - charBudget} characters of the middle omitted]…\n\n${body.slice(-tail)}`;
}
