import type { DiffLine, Hunk } from './schema.js';

export interface DiffFile {
  /** Path after the change (the old path for deleted files). */
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

function stripPrefix(p: string): string {
  return unquote(p).replace(/^[ab]\//, '');
}

export function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let h: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      o = +m[1];
      n = +m[3];
      h = {
        header: line,
        oldStart: o,
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: n,
        newLines: m[4] === undefined ? 1 : +m[4],
        lines: [],
      };
      hunks.push(h);
      continue;
    }
    if (!h || line.startsWith('\\')) continue;
    const t = line[0];
    if (t === '+') h.lines.push({ t: '+', text: line.slice(1), n: n++ });
    else if (t === '-') h.lines.push({ t: '-', text: line.slice(1), o: o++ });
    else if (t === ' ' || line === '') h.lines.push({ t: ' ', text: line.slice(1), o: o++, n: n++ });
  }
  // A trailing empty string from the final newline is not a context line.
  for (const hk of hunks) {
    const expected = hk.oldLines + hk.newLines;
    let counted = hk.lines.reduce((s, l) => s + (l.t === ' ' ? 2 : 1), 0);
    while (counted > expected && hk.lines.length && hk.lines[hk.lines.length - 1].t === ' ') {
      hk.lines.pop();
      counted -= 2;
    }
  }
  return hunks;
}

/** Parse `git diff` output (or a GitHub .diff) into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = text.replace(/\r\n/g, '\n').split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue;
    const lines = chunk.split('\n');
    const head = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(lines[0]);
    let oldPath = head ? stripPrefix(head[1]) : undefined;
    let path = head ? stripPrefix(head[2]) : undefined;
    let status: DiffFile['status'] = 'modified';
    let binary = false;
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      if (l.startsWith('new file mode')) status = 'added';
      else if (l.startsWith('deleted file mode')) status = 'removed';
      else if (l.startsWith('rename from ')) {
        oldPath = unquote(l.slice(12));
        status = 'renamed';
      } else if (l.startsWith('rename to ')) path = unquote(l.slice(10));
      else if (l.startsWith('--- ') && l !== '--- /dev/null') oldPath = stripPrefix(l.slice(4));
      else if (l.startsWith('+++ ') && l !== '+++ /dev/null') path = stripPrefix(l.slice(4));
      else if (l.startsWith('Binary files') || l === 'GIT binary patch') binary = true;
    }
    if (status === 'removed') path = oldPath;
    if (!path) continue;
    const hunks = parseHunks(lines.slice(i));
    let additions = 0;
    let deletions = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.t === '+') additions++;
        else if (l.t === '-') deletions++;
      }
    files.push({
      path,
      oldPath: status === 'added' ? undefined : oldPath,
      status,
      binary,
      hunks,
      additions,
      deletions,
    });
  }
  return files;
}

/**
 * Rebuild the base-side text of a file from its current text and the diff.
 * Returns null when the diff does not apply to `newText` (stale diff).
 */
export function reverseApply(newText: string, hunks: Hunk[]): string | null {
  const cur = newText.split('\n');
  const out: string[] = [];
  let pos = 0; // 0-based index into cur
  for (const h of hunks) {
    const start = h.newLines === 0 ? h.newStart : h.newStart - 1;
    if (start < pos || start > cur.length) return null;
    while (pos < start) out.push(cur[pos++]);
    for (const l of h.lines) {
      if (l.t === '-') {
        out.push(l.text);
        continue;
      }
      if (cur[pos] !== l.text) return null;
      if (l.t === ' ') out.push(l.text);
      pos++;
    }
  }
  while (pos < cur.length) out.push(cur[pos++]);
  return out.join('\n');
}

/** Base-side text of a deleted file, taken from the diff (git includes every line). */
export function deletedText(hunks: Hunk[]): string {
  return hunks.flatMap((h) => h.lines.filter((l) => l.t !== '+').map((l) => l.text)).join('\n') + '\n';
}

/**
 * The parts of `hunks` that fall inside a node: new-side lines within `range`
 * and removed lines within `oldRange`. Hunks with no +/- lines left are dropped.
 */
export function sliceHunks(
  hunks: Hunk[],
  range: [number, number] | undefined,
  oldRange: [number, number] | undefined,
): Hunk[] {
  const inNew = (n?: number) => range != null && n != null && n >= range[0] && n <= range[1];
  const inOld = (o?: number) => oldRange != null && o != null && o >= oldRange[0] && o <= oldRange[1];
  const out: Hunk[] = [];
  for (const h of hunks) {
    const lines: DiffLine[] = h.lines.filter((l) =>
      l.t === '+' ? inNew(l.n) : l.t === '-' ? inOld(l.o) : inNew(l.n) || (!range && inOld(l.o)),
    );
    if (!lines.some((l) => l.t !== ' ')) continue;
    const first = lines[0];
    const oldStart = lines.find((l) => l.o != null)?.o ?? first.o ?? h.oldStart;
    const newStart = lines.find((l) => l.n != null)?.n ?? first.n ?? h.newStart;
    const oldLines = lines.filter((l) => l.t !== '+').length;
    const newLines = lines.filter((l) => l.t !== '-').length;
    out.push({
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }
  return out;
}
