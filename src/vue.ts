import { ts } from 'ts-morph';
import { hash } from './symbols.js';

export const isVueFile = (p: string) => p.endsWith('.vue');

interface Block {
  tag: string;
  attrs: string;
  /** Content offsets, between the open and close tag. */
  start: number;
  end: number;
}

/** Top-level <template>, <script> and <style> blocks of a single-file component. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  const open = /<!--[\s\S]*?-->|<([A-Za-z][\w-]*)(\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    const start = m.index + m[0].length;
    if (m[0].endsWith('/>')) continue;
    let end = -1;
    if (tag === 'template') {
      // <template> nests (slots, v-if groups): find the matching close tag.
      const t = /<template(\s[^>]*)?>|<\/template\s*>/gi;
      t.lastIndex = start;
      let depth = 1;
      let x: RegExpExecArray | null;
      while ((x = t.exec(text))) {
        if (x[0][1] !== '/') {
          if (!x[0].endsWith('/>')) depth++;
        } else if (--depth === 0) {
          end = x.index;
          break;
        }
      }
    } else {
      end = text.toLowerCase().indexOf(`</${tag}`, start);
    }
    if (end < 0) break;
    out.push({ tag, attrs: m[2] ?? '', start, end });
    open.lastIndex = text.indexOf('>', end) + 1 || text.length;
  }
  return out;
}

const PLAIN_ATTR = /^(?:v-(?:if|else-if|show|for|model|html|text|bind|on)(?::[\w.-]+)?|[:@][\w.:-]+|v-bind|v-on)$/;

/** Identifiers a template refers to: component tags and names in bindings, events and interpolations. */
function templateNames(tpl: string): string[] {
  const names = new Set<string>();
  const words = (expr: string) => {
    const code = expr.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ' ');
    for (const w of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) names.add(w[0]);
  };
  for (const t of tpl.matchAll(/<([A-Za-z][\w.-]*)([^>]*)>/g)) {
    const tag = t[1];
    if (/[A-Z]/.test(tag[0])) names.add(tag.split('.')[0]);
    else if (tag.includes('-')) names.add(tag.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase()));
    for (const a of t[2].matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (!PLAIN_ATTR.test(a[1])) continue;
      const value = a[2] ?? a[3] ?? '';
      words(a[1] === 'v-for' ? value.replace(/^[\s\S]*?\s(?:in|of)\s/, '') : value);
    }
  }
  for (const i of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) words(i[1]);
  return [...names].filter((n) => !isReservedWord(n));
}

const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
/** Words that cannot be an identifier in a module (`if`, `new`, `let`, ...). */
function isReservedWord(word: string): boolean {
  scanner.setText(word);
  const k = scanner.scan();
  return (
    (k >= ts.SyntaxKind.FirstReservedWord && k <= ts.SyntaxKind.LastReservedWord) ||
    (k >= ts.SyntaxKind.FirstFutureReservedWord && k <= ts.SyntaxKind.LastFutureReservedWord)
  );
}

export interface VueScript {
  /** File name suffix for the TypeScript view: `.ts`, or `.tsx` for JSX. */
  ext: '.ts' | '.tsx';
  code: string;
}

/**
 * A TypeScript view of a .vue file: the <script> blocks stay at their exact offsets
 * and everything else is blanked, so line numbers match the original file. One
 * statement on the last line refers to every name the template uses (so the file
 * gets a reference to each component and function it renders or calls) and carries
 * a hash of the template and styles (so changing them changes the file). A script
 * setup component also gets a default export, so `import X from './X.vue'` resolves.
 */
export function vueToTs(text: string): VueScript {
  const bs = blocks(text);
  const chars = text.replace(/[^\n]/g, ' ').split('');
  let ext: VueScript['ext'] = '.ts';
  let script = '';
  let other = '';
  let tplNames: string[] = [];
  for (const b of bs) {
    const content = text.slice(b.start, b.end);
    if (b.tag === 'script') {
      for (let i = b.start; i < b.end; i++) chars[i] = text[i];
      if (/\blang\s*=\s*["']?[jt]sx\b/.test(b.attrs)) ext = '.tsx';
      script += content;
    } else {
      other += `<${b.tag}${b.attrs}>${content}`;
      if (b.tag === 'template') tplNames = templateNames(content);
    }
  }
  const tail = [`void [${[JSON.stringify(hash(other)), ...tplNames].join(', ')}];`];
  if (!/^\s*export\s+default\b/m.test(script)) tail.push('export default {};');
  return { ext, code: chars.join('') + tail.join(' ') };
}

/** Parse a file without a type checker; .vue files are parsed as their TypeScript view. */
export function parseSource(path: string, text: string): ts.SourceFile {
  if (!isVueFile(path)) return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const v = vueToTs(text);
  return ts.createSourceFile(path + v.ext, v.code, ts.ScriptTarget.Latest, true, v.ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
