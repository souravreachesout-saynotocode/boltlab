import type { Config } from '../config.js';
import type { ObservationInput } from '../types.js';
import { buildDigest, parseTranscript, type Transcript } from '../transcript.js';
import { buildExtractionPrompt } from './prompt.js';
import { extractJsonArray, normalizeObservations } from './parse.js';
import { heuristicExtract } from './heuristic.js';
import { runClaude } from './claude.js';

export interface ExtractionResult {
  observations: ObservationInput[];
  /** Which path produced them — reported by `boltmem extract` and the logs. */
  via: 'claude' | 'heuristic' | 'none';
  transcript: Transcript;
  warning?: string;
}

export interface ExtractOptions {
  config: Config;
  project: string;
  cwd?: string | null;
}

/** Runs the model pass over a transcript, falling back to the offline extractor. */
export async function extractFromTranscript(
  transcriptPath: string,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const { config } = options;
  const transcript = parseTranscript(transcriptPath);

  if (transcript.turns.length === 0 && transcript.toolCalls.length === 0) {
    return { observations: [], via: 'none', transcript, warning: 'transcript is empty or unreadable' };
  }

  const fallback = () => heuristicExtract(transcript, config.maxObservationsPerSession);

  if (config.extractor === 'heuristic') {
    return { observations: fallback(), via: 'heuristic', transcript };
  }

  const prompt = buildExtractionPrompt({
    project: options.project,
    cwd: options.cwd ?? null,
    maxObservations: config.maxObservationsPerSession,
    digest: buildDigest(transcript, config.digestCharBudget),
    transcript,
  });

  const run = await runClaude(prompt, {
    model: config.model,
    timeoutSec: config.extractTimeoutSec,
  });

  if (!run.ok) {
    if (config.extractor === 'claude') {
      return { observations: [], via: 'none', transcript, warning: run.error };
    }
    return { observations: fallback(), via: 'heuristic', transcript, warning: run.error };
  }

  const raw = extractJsonArray(run.text);
  if (!raw) {
    if (config.extractor === 'claude') {
      return {
        observations: [],
        via: 'none',
        transcript,
        warning: 'extractor returned no parseable JSON array',
      };
    }
    return {
      observations: fallback(),
      via: 'heuristic',
      transcript,
      warning: 'extractor returned no parseable JSON array',
    };
  }

  // An empty array is a valid answer: not every session leaves something behind.
  return {
    observations: normalizeObservations(raw, config.maxObservationsPerSession),
    via: 'claude',
    transcript,
  };
}

export { buildExtractionPrompt } from './prompt.js';
export { extractJsonArray, normalizeObservations } from './parse.js';
export { heuristicExtract } from './heuristic.js';
export { isChildProcess, CHILD_ENV_FLAG } from './claude.js';
