import { basename } from 'node:path';
import type { Transcript } from '../transcript.js';
import type { ObservationInput } from '../types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function scopeFor(file: string): string {
  const parts = file.split('/').filter(Boolean);
  const index = parts.findIndex((part) => part === 'src' || part === 'lib' || part === 'app');
  const candidate = index >= 0 ? parts[index + 1] : parts[parts.length - 2];
  return (candidate ?? basename(file))
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Offline fallback. It records what a session touched — not what it learned —
 * so the timeline stays continuous when the extraction model is unavailable.
 * Observations it produces are deliberately plain; the model pass is the one
 * that writes anything worth reading.
 */
export function heuristicExtract(transcript: Transcript, max: number): ObservationInput[] {
  const observations: ObservationInput[] = [];

  const editedFiles = new Map<string, string[]>();
  const commands: string[] = [];

  for (const call of transcript.toolCalls) {
    if (EDIT_TOOLS.has(call.name) && call.file) {
      const entries = editedFiles.get(call.file) ?? [];
      entries.push(call.summary);
      editedFiles.set(call.file, entries);
    } else if (call.name === 'Bash') {
      commands.push(call.summary);
    }
  }

  if (transcript.openingPrompt) {
    observations.push({
      type: 'discovery',
      title: `Session worked on: ${transcript.openingPrompt.slice(0, 120)}`,
      narrative:
        'Recorded without model extraction, so this is the stated goal of the session rather than its outcome.',
      facts: [`Opening request: ${transcript.openingPrompt}`],
      scope: 'session',
      files: [],
      keywords: ['goal'],
    });
  }

  for (const [file, summaries] of editedFiles) {
    if (observations.length >= max) break;
    observations.push({
      type: 'change',
      title: `Modified ${file}`,
      narrative: `The session edited ${file} ${summaries.length} time${summaries.length === 1 ? '' : 's'}.`,
      facts: summaries.slice(0, 4),
      scope: scopeFor(file),
      files: [file],
      keywords: [basename(file)],
    });
  }

  if (commands.length > 0 && observations.length < max) {
    observations.push({
      type: 'change',
      title: `Ran ${commands.length} shell command${commands.length === 1 ? '' : 's'} during the session`,
      narrative: 'Commands executed while the session ran, newest last.',
      facts: commands.slice(-5),
      scope: 'shell',
      files: [],
      keywords: ['bash', 'commands'],
    });
  }

  return observations.slice(0, max);
}
