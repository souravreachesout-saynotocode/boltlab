/** The four things worth remembering from a coding session. */
export const OBSERVATION_TYPES = ['discovery', 'change', 'decision', 'issue'] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** What the extractor produces, before it is given an id and a timestamp. */
export interface ObservationInput {
  type: ObservationType;
  /** One sentence, written so it reads on its own weeks later. */
  title: string;
  /** Two or three sentences of prose: what happened and why it mattered. */
  narrative: string;
  /** Short standalone statements — the "facts" side of the viewer toggle. */
  facts: string[];
  /** Subsystem, package or feature area the observation belongs to. */
  scope?: string;
  /** Repo-relative paths the observation touches. */
  files?: string[];
  /** Extra search terms that do not appear verbatim in the text. */
  keywords?: string[];
}

/** A stored observation, as the API and viewer see it. */
export interface Observation extends ObservationInput {
  id: number;
  sessionId: string;
  /** The session's per-project number, for the viewer's session dividers. */
  sessionSeq: number;
  /** Per-store counter — the `#764` in the viewer. */
  seq: number;
  project: string;
  agent: string;
  createdAt: string;
  scope: string;
  files: string[];
  keywords: string[];
}

export interface SessionRecord {
  id: string;
  /** Per-project counter — the `Session #95` header in the viewer. */
  seq: number;
  project: string;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  transcriptPath: string | null;
  observationCount: number;
}

/** The JSON Claude Code writes to a hook's stdin. */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: string;
  /** PreCompact: manual | auto */
  trigger?: string;
  /** SessionEnd: clear | logout | prompt_input_exit | other */
  reason?: string;
  /** UserPromptSubmit */
  prompt?: string;
}
