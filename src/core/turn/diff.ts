/**
 * Word-level diff between what the learner said (`heard`) and the corrected sentence
 * (`correct`), computed by the app and never by the model (docs/PIANO.md §1.3). It drives the
 * "wrong word becomes the right one" animation: at most two changes, otherwise the whole line
 * is replaced.
 */

export type Change =
  | { op: "replace"; index: number; from: string; to: string }
  | { op: "insert"; index: number; to: string }
  | { op: "delete"; index: number; from: string };

/**
 * `index` is a position in `words` (the corrected tokens): for `replace` and `insert` it is the
 * token itself; for `delete` it is the corrected token before which the removed word sat
 * (`words.length` when it was at the end).
 */
export type CorrectionDiff = { kind: "changes"; changes: Change[]; words: string[] } | { kind: "whole" };

export const MAX_CHANGES = 2;

const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

export function tokenize(sentence: string): string[] {
  return sentence.split(/\s+/).filter((token) => token.length > 0);
}

/** Comparison key of a token: case-insensitive, without leading/trailing punctuation. */
export function wordKey(token: string): string {
  const stripped = token.replace(EDGE_PUNCTUATION, "");
  return (stripped.length > 0 ? stripped : token).toLowerCase();
}

/** LCS length table for two sequences compared with `equals`. */
function lcsTable<T>(a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean): number[][] {
  const table: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    table.push(new Array<number>(b.length + 1).fill(0));
  }
  for (let i = 1; i <= a.length; i += 1) {
    const row = table[i];
    const previous = table[i - 1];
    const x = a[i - 1];
    if (row === undefined || previous === undefined || x === undefined) {
      continue;
    }
    for (let j = 1; j <= b.length; j += 1) {
      const y = b[j - 1];
      if (y !== undefined && equals(x, y)) {
        row[j] = (previous[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(previous[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }
  return table;
}

type Step = { op: "keep" } | { op: "del"; from: string } | { op: "ins"; to: string };

/** Walks the LCS table back into an edit script over the two token lists, in reading order. */
function alignment(heard: readonly string[], correct: readonly string[]): Step[] {
  const table = lcsTable(heard, correct, (x, y) => wordKey(x) === wordKey(y));
  const steps: Step[] = [];
  let i = heard.length;
  let j = correct.length;
  while (i > 0 || j > 0) {
    const h = heard[i - 1];
    const c = correct[j - 1];
    if (i > 0 && j > 0 && h !== undefined && c !== undefined && wordKey(h) === wordKey(c)) {
      steps.push({ op: "keep" });
      i -= 1;
      j -= 1;
    } else if (
      j > 0 &&
      c !== undefined &&
      (i === 0 || (table[i]?.[j - 1] ?? 0) >= (table[i - 1]?.[j] ?? 0))
    ) {
      steps.push({ op: "ins", to: c });
      j -= 1;
    } else if (h !== undefined) {
      steps.push({ op: "del", from: h });
      i -= 1;
    } else {
      break;
    }
  }
  return steps.reverse();
}

/** Turns each run of deletions/insertions into replacements first, then leftovers. */
function changesFromSteps(steps: readonly Step[]): Change[] {
  const changes: Change[] = [];
  let index = 0;
  let deletions: string[] = [];
  let insertions: string[] = [];

  function flush(): void {
    const paired = Math.min(deletions.length, insertions.length);
    for (let k = 0; k < paired; k += 1) {
      const from = deletions[k];
      const to = insertions[k];
      if (from !== undefined && to !== undefined) {
        changes.push({ op: "replace", index: index + k, from, to });
      }
    }
    for (let k = paired; k < insertions.length; k += 1) {
      const to = insertions[k];
      if (to !== undefined) {
        changes.push({ op: "insert", index: index + k, to });
      }
    }
    for (let k = paired; k < deletions.length; k += 1) {
      const from = deletions[k];
      if (from !== undefined) {
        changes.push({ op: "delete", index: index + insertions.length, from });
      }
    }
    index += insertions.length;
    deletions = [];
    insertions = [];
  }

  for (const step of steps) {
    if (step.op === "keep") {
      flush();
      index += 1;
    } else if (step.op === "del") {
      deletions.push(step.from);
    } else {
      insertions.push(step.to);
    }
  }
  flush();
  return changes;
}

/**
 * Diff of the learner's sentence against the corrected one. Returns `whole` when either side is
 * blank or more than `MAX_CHANGES` edits would be needed.
 */
export function diffCorrection(heard: string, correct: string): CorrectionDiff {
  const heardWords = tokenize(heard);
  const words = tokenize(correct);
  if (heardWords.length === 0 || words.length === 0) {
    return { kind: "whole" };
  }
  const changes = changesFromSteps(alignment(heardWords, words));
  if (changes.length > MAX_CHANGES) {
    return { kind: "whole" };
  }
  return { kind: "changes", changes, words };
}

function letters(word: string): string[] {
  return [...word.toLowerCase()].filter((ch) => /\p{L}/u.test(ch));
}

/**
 * Whether two words share enough letters (LCS over letters divided by the longer length) for a
 * letter-by-letter morph to read well; otherwise the UI swaps the whole word.
 */
export function sharesLetters(a: string, b: string, threshold = 0.4): boolean {
  const la = letters(a);
  const lb = letters(b);
  const longest = Math.max(la.length, lb.length);
  if (longest === 0) {
    return false;
  }
  const table = lcsTable(la, lb, (x, y) => x === y);
  const common = table[la.length]?.[lb.length] ?? 0;
  return common / longest >= threshold;
}
