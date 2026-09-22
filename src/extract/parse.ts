import type { ObservationInput, ObservationType } from '../types.js';
import { OBSERVATION_TYPES } from '../types.js';

function asStringArray(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 1)}…` : item));
}

function toSlug(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Pulls the JSON array out of a model response. Models wrap arrays in fences or
 * add a line of preamble often enough that scanning for the outermost brackets is
 * worth it before giving up.
 */
export function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      // A single object, or {"observations": [...]}, are both common near-misses.
      if (parsed && typeof parsed === 'object') {
        const wrapped = (parsed as { observations?: unknown }).observations;
        if (Array.isArray(wrapped)) return wrapped;
        return [parsed];
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Validates and normalises raw extractor output; anything malformed is dropped. */
export function normalizeObservations(raw: unknown[], max: number): ObservationInput[] {
  const observations: ObservationInput[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (title.length < 8) continue;

    const rawType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    const type: ObservationType = (OBSERVATION_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ObservationType)
      : 'discovery';

    const narrative = typeof record.narrative === 'string' ? record.narrative.trim() : '';

    observations.push({
      type,
      title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
      narrative: narrative.length > 1_200 ? `${narrative.slice(0, 1_199)}…` : narrative,
      facts: asStringArray(record.facts, 8, 300),
      scope: toSlug(record.scope),
      files: asStringArray(record.files, 12, 200),
      keywords: asStringArray(record.keywords, 12, 40),
    });

    if (observations.length >= max) break;
  }

  return observations;
}
