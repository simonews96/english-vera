/**
 * Splits text into utterance-sized chunks so that no single utterance runs long enough to
 * hit Chrome's cutoff on network voices (~14 s). Every chunk is a verbatim substring of the
 * input at `offset`, so engine `charIndex` values map back as `offset + charIndex`.
 */

export interface TextChunk {
  readonly text: string;
  /** Index of `text` in the original string. */
  readonly offset: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 180;

const SENTENCE_TERMINATORS = new Set([".", "!", "?", ";", ":"]);
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "»"]);

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** A half-open span [start, end) of the source text. */
interface Span {
  readonly start: number;
  readonly end: number;
}

function trimmed(text: string, span: Span): Span | null {
  let start = span.start;
  let end = span.end;
  while (start < end && isSpace(text[start])) start += 1;
  while (end > start && isSpace(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

/**
 * A dot followed by whitespace and then a lowercase letter is most likely an abbreviation
 * or an ellipsis ("e.g. today", "wait... what"), not the end of a sentence.
 */
function continuesSentence(text: string, afterTerminator: number, end: number): boolean {
  let k = afterTerminator;
  while (k < end && isSpace(text[k]) && text[k] !== "\n" && text[k] !== "\r") k += 1;
  const next = text[k];
  return next !== undefined && next !== next.toUpperCase() && next === next.toLowerCase();
}

/** Splits at sentence terminators followed by whitespace (or end) and at line breaks. */
function splitSentences(text: string, span: Span): Span[] {
  const out: Span[] = [];
  let start = span.start;
  let i = span.start;
  while (i < span.end) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      out.push({ start, end: i });
      start = i + 1;
      i += 1;
      continue;
    }
    if (ch !== undefined && SENTENCE_TERMINATORS.has(ch)) {
      let j = i + 1;
      while (j < span.end) {
        const next = text[j];
        if (next === undefined || !(SENTENCE_TERMINATORS.has(next) || CLOSERS.has(next))) break;
        j += 1;
      }
      const onlyDots = /^\.+$/.test(text.slice(i, j));
      if (j >= span.end || (isSpace(text[j]) && !(onlyDots && continuesSentence(text, j, span.end)))) {
        out.push({ start, end: j });
        start = j;
        i = j;
        continue;
      }
    }
    i += 1;
  }
  out.push({ start, end: span.end });
  return out;
}

/** Splits after every comma that is followed by whitespace. */
function splitCommas(text: string, span: Span): Span[] {
  const out: Span[] = [];
  let start = span.start;
  for (let i = span.start; i < span.end; i += 1) {
    if (text[i] === "," && (i + 1 >= span.end || isSpace(text[i + 1]))) {
      out.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  out.push({ start, end: span.end });
  return out;
}

/** Splits at whitespace runs. */
function splitWords(text: string, span: Span): Span[] {
  const out: Span[] = [];
  let start = span.start;
  for (let i = span.start; i < span.end; i += 1) {
    if (isSpace(text[i])) {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  out.push({ start, end: span.end });
  return out;
}

/** Hard cut, for a single token longer than the limit (URLs, long numbers). */
function hardCut(span: Span, maxChars: number): Span[] {
  const out: Span[] = [];
  for (let start = span.start; start < span.end; start += maxChars) {
    out.push({ start, end: Math.min(span.end, start + maxChars) });
  }
  return out;
}

/** Greedily merges adjacent spans while the merged (trimmed) span fits in `maxChars`. */
function pack(text: string, spans: readonly Span[], maxChars: number): Span[] {
  const out: Span[] = [];
  let current: Span | null = null;
  for (const raw of spans) {
    const span = trimmed(text, raw);
    if (!span) continue;
    if (current) {
      const merged: Span = { start: current.start, end: span.end };
      if (merged.end - merged.start <= maxChars) {
        current = merged;
        continue;
      }
      out.push(current);
    }
    current = span;
  }
  if (current) out.push(current);
  return out;
}

function fits(span: Span, maxChars: number): boolean {
  return span.end - span.start <= maxChars;
}

function refine(
  text: string,
  spans: readonly Span[],
  maxChars: number,
  splitter: (text: string, span: Span) => Span[],
): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (fits(span, maxChars)) {
      out.push(span);
      continue;
    }
    out.push(...pack(text, splitter(text, span), maxChars));
  }
  return out;
}

/**
 * Splits `text` into chunks of at most `maxChars` characters: first on sentence boundaries
 * (. ! ? ; : and line breaks), then on commas, then on spaces, then by hard cutting.
 * Chunks are trimmed, never empty, and each one is a verbatim substring of `text`.
 */
export function chunkWithOffsets(text: string, maxChars = DEFAULT_MAX_CHUNK_CHARS): TextChunk[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const whole: Span = { start: 0, end: text.length };
  let spans = splitSentences(text, whole)
    .map((span) => trimmed(text, span))
    .filter((span): span is Span => span !== null);
  spans = refine(text, spans, limit, splitCommas);
  spans = refine(text, spans, limit, splitWords);
  spans = refine(text, spans, limit, (_, span) => hardCut(span, limit));
  return spans.map((span) => ({ text: text.slice(span.start, span.end), offset: span.start }));
}

/** Same as `chunkWithOffsets`, text only. */
export function chunkText(text: string, maxChars = DEFAULT_MAX_CHUNK_CHARS): string[] {
  return chunkWithOffsets(text, maxChars).map((chunk) => chunk.text);
}
