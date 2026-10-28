/**
 * One JSON format for the base index, the PR overlay and the merged result.
 *
 * Node ids are stable across branches: "<file path>#<Class>.<member>" for class
 * members, "<file path>#<name>" for top-level declarations and "<file path>"
 * for the file itself (imports and other top-level code).
 */

export const SCHEMA_VERSION = 1;

export type IndexKind = 'base' | 'overlay' | 'merged';

export type NodeKind =
  | 'file'
  | 'class'
  | 'method'
  | 'constructor'
  | 'function'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum';

export type ChangeStatus = 'added' | 'modified' | 'removed';

/** A diff line. `o` is the line number on the old side, `n` on the new side. */
export interface DiffLine {
  t: '+' | '-' | ' ';
  text: string;
  o?: number;
  n?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface Change {
  status: ChangeStatus;
  /** Only the hunk lines that fall inside this node. */
  hunks: Hunk[];
  signatureChanged?: boolean;
  previousSignature?: string;
  /** Line range on the base side, for modified and removed nodes. */
  previousRange?: [number, number];
  /** Id on the base side when the file was renamed. */
  previousId?: string;
}

/** An entry point: an HTTP route, message pattern, GraphQL operation, schedule or event handler. */
export interface Route {
  type: 'http' | 'message' | 'graphql' | 'schedule' | 'event';
  /** HTTP verb, or the decorator name for other types. */
  verb: string;
  /** Path relative to the controller (http), or the pattern/name. */
  path: string;
  /** Controller prefix joined with the path (http only; excludes the global prefix). */
  fullPath?: string;
}

export interface Injection {
  /** Constructor parameter name. */
  param: string;
  kind: 'class' | 'token' | 'repository' | 'decorator';
  /** Class id, string token (quoted), or external name. */
  token: string;
  /** Node id the injection resolves to, when known. Filled in at finalize time for string tokens. */
  target?: string;
  /** Name of the decorator that set the token, e.g. Inject or InjectRepository. */
  decorator?: string;
  forwardRef?: boolean;
  optional?: boolean;
}

export interface SymbolNode {
  id: string;
  kind: NodeKind;
  name: string;
  file: string;
  /** Module id (directory of the owning *.module.ts, or an implicit folder group). */
  module: string;
  /** 1-based inclusive line range, decorators included. */
  range: [number, number];
  /** Id of the containing class, for members. */
  parent?: string;
  exported?: boolean;
  /** Normalized parameter list and return type; used to detect signature changes. */
  signature?: string;
  /** Hash of the node's source text. */
  hash: string;
  decorators?: string[];
  route?: Route;
  injects?: Injection[];
  /** Outgoing references: ids of nodes this node refers to (exact, via the type checker). */
  uses: string[];
  /** The subset of `uses` that only occur in type positions (annotations, generics, implements). */
  typeUses?: string[];
  /** Incoming references: ids of nodes that refer to this one. Derived from `uses`. */
  references: string[];
  /** Set when the node lives in a test file. */
  test?: boolean;
  change?: Change;
}

export interface ModuleImport {
  /** Name as written, e.g. UsersModule or TypeOrmModule. */
  name: string;
  /** Node id of the module class when it is in this codebase. */
  classId?: string;
  /** Module id, derived from classId. */
  module?: string;
  external: boolean;
  /** forRoot / forRootAsync / register / forFeature ... */
  dynamic?: string;
  forwardRef?: boolean;
}

export interface Provider {
  /** Class id, quoted string token, or external name. */
  token: string;
  /** How the provider is defined. */
  via: 'class' | 'useClass' | 'useValue' | 'useFactory' | 'useExisting' | 'unknown';
  /** Node id the provider resolves to (class, factory function, ...). */
  target?: string;
  /** Factory dependencies (`inject: [...]`). */
  inject?: string[];
}

export interface ModuleInfo {
  id: string;
  name: string;
  /** False for implicit folder groups (e.g. src/common) that have no *.module.ts. */
  declared: boolean;
  file?: string;
  classId?: string;
  global?: boolean;
  imports: ModuleImport[];
  providers: Provider[];
  /** Controller class ids. */
  controllers: string[];
  /** Exported class ids, module ids or tokens. */
  exports: string[];
  change?: { status: ChangeStatus };
}

export interface FileImport {
  spec: string;
  /** Resolved project-relative path (path aliases and index files resolved). */
  resolved?: string;
  names: string[];
  typeOnly?: boolean;
}

export interface FileInfo {
  path: string;
  module: string;
  test: boolean;
  hash: string;
  imports: FileImport[];
  change?: {
    status: ChangeStatus | 'renamed';
    oldPath?: string;
    additions: number;
    deletions: number;
    hunks: Hunk[];
  };
}

export interface PrInfo {
  baseRef?: string;
  baseCommit?: string;
  headCommit?: string;
  /** Every path the diff touches, after the change (old path for deletions). */
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: { from: string; to: string }[];
  /** Symbols that existed on the base side and are gone, with their old range and hunks. */
  deletedSymbols: SymbolNode[];
  /** Base id -> new id, for symbols in renamed files. */
  renamedSymbols: Record<string, string>;
  /** Changed files the indexer skipped (not TypeScript, or outside the project). */
  unindexedFiles: { path: string; oldPath?: string; status: string; additions: number; deletions: number; hunks: Hunk[] }[];
}

export interface DanglingReference {
  from: string;
  to: string;
  file: string;
  /** Likely new name, when an added symbol with the same parent looks like a rename. */
  maybeRenamedTo?: string;
}

export interface SignatureChange {
  id: string;
  before?: string;
  after?: string;
  /** Callers outside the PR: places the reviewer should check. */
  callersOutsidePr: string[];
  /** Callers the PR also touched. */
  callersInPr: string[];
}

export interface ModuleEdge {
  from: string;
  to: string;
  via: 'module-import' | 'file-import';
  forwardRef?: boolean;
}

export interface AffectedRoute {
  routeId: string;
  route: Route;
  /** The changed symbol the chain starts from. */
  changed: string;
  /** changed -> ... -> routeId */
  chain: string[];
}

export interface TestReach {
  id: string;
  /** Test files whose code reaches this symbol through references. */
  testFiles: string[];
}

export interface Checks {
  danglingReferences: DanglingReference[];
  signatureChanges: SignatureChange[];
  newModuleDependencies: ModuleEdge[];
  removedModuleDependencies: ModuleEdge[];
  /** Module cycles in the merged graph that do not exist on the base side. */
  newCycles: string[][];
  /** All module cycles in the merged graph. */
  cycles: string[][];
  affectedRoutes: AffectedRoute[];
  tests: TestReach[];
  untested: string[];
  summary: {
    filesChanged: number;
    additions: number;
    deletions: number;
    symbols: Record<ChangeStatus, number>;
    changedModules: string[];
    affectedModules: string[];
  };
}

export interface Index {
  schemaVersion: number;
  kind: IndexKind;
  tool: { name: string; version: string };
  generatedAt: string;
  /** Absolute path the index was built from (informational). */
  root: string;
  commit?: string;
  /** Value passed to app.setGlobalPrefix, if found. */
  globalPrefix?: string;
  modules: ModuleInfo[];
  files: FileInfo[];
  nodes: SymbolNode[];
  pr?: PrInfo;
  checks?: Checks;
}
