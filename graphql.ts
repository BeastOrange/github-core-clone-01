// GitHub GraphQL v4, minimal but exact for the documents gh and
// github-mcp-server send: a small recursive-descent parser for queries,
// mutations, variables, inline input objects, enums and inline fragments,
// plus an executor over the store. Unknown fields are reported as GraphQL
// errors (HTTP 200), never as HTTP errors.

import { globalId, parseGlobalId, VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { mergeableState, tryMerge } from './rest.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null; name: string; args: { name: string; value: ValueNode }[]; selection: SelectionNode[];
}
type SelectionNode = FieldNode | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation'; name: string | null;
  variables: { name: string; value: ValueNode | null }[];
  selection: SelectionNode[];
}

interface Token { kind: 'name' | 'string' | 'int' | 'float' | 'punct'; value: string; }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j])) j += 1; }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$():=@[]{}.|'.includes(ch)) {
      if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek()) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const kw = this.expectName();
      if (kw !== 'query' && kw !== 'mutation') throw new Error(`unsupported operation ${kw}`);
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.expectName();
      const variables: Operation['variables'] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectPunct('$');
          const vname = this.expectName();
          this.expectPunct(':');
          this.skipType();
          let def: ValueNode | null = null;
          if (this.acceptPunct('=')) def = this.parseValue();
          variables.push({ name: vname, value: def });
        }
      }
      ops.push({ type: kw, name, variables, selection: this.parseSelectionSet() });
    }
    return ops;
  }

  private skipType(): void {
    if (this.acceptPunct('[')) { this.skipType(); this.expectPunct(']'); }
    else this.expectName();
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '...') {
        this.next();
        this.expectName(); // 'on'
        const type = this.expectName();
        out.push({ kind: 'fragment', type, selection: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.acceptPunct(':')) { alias = first; name = this.expectName(); }
      const args: FieldNode['args'] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const aname = this.expectName();
          this.expectPunct(':');
          args.push({ name: aname, value: this.parseValue() });
        }
      }
      const selection = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
      out.push({ alias, name, args, selection });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------- schema

const QUERY_FIELDS = new Set(['viewer', 'repository', 'node', '__type']);
const USER_FIELDS = new Set(['login', 'id', 'name', 'email']);
const REPO_FIELDS = new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']);
const ISSUE_FIELDS = new Set(['id', 'number', 'title', 'state', 'body', 'url']);
const PR_FIELDS = new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']);
const REF_FIELDS = new Set(['name']);
const CONN_FIELDS = new Set(['nodes', 'pageInfo', 'totalCount']);
const PAGE_INFO_FIELDS = new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']);
const FILE_FIELDS = new Set(['path']);
const TYPE_FIELDS = new Set(['name', 'kind', 'fields', 'enumValues']);
const FIELD_FIELDS = new Set(['name']);
const ENUM_FIELDS = new Set(['name']);
const MUTATION_FIELDS = new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);

const TYPE_FIELD_NAMES: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PACKAGE', 'LABEL'];

// ---------------------------------------------------------------- executor

interface GqlCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, ctx: GqlCtx): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: GqlCtx): unknown {
  const a = field.args.find((x) => x.name === name);
  return a ? resolveValue(a.value, ctx) : undefined;
}

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}
function repoId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}
function prId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`);
}

function issueNode(repo: Repo, issue: Issue, sel: SelectionNode[], ctx: GqlCtx): Record<string, unknown> {
  return selectFields('Issue', {
    id: issueId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body ?? '',
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  }, sel, ctx);
}

function prNode(repo: Repo, pr: PullRequest, sel: SelectionNode[], ctx: GqlCtx): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: prId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: mergeableState(ctx.store, repo, pr),
  };
  return selectFields('PullRequest', base, sel, ctx, (field) => {
    if (field.name === 'files') {
      const first = argValue(field, 'first', ctx);
      const baseCommit = ctx.store.mergeBase(pr.headSha, pr.baseSha);
      const baseFlat = baseCommit ? ctx.store.treeFlat(baseCommit) : new Map<string, string>();
      const headFlat = ctx.store.treeFlat(pr.headSha);
      const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort().filter((p) => baseFlat.get(p) !== headFlat.get(p));
      const limit = typeof first === 'number' ? first : paths.length;
      const page = paths.slice(0, limit);
      const out: Record<string, unknown> = {};
      for (const sel of field.selection) {
        if (sel.kind === 'fragment') continue;
        if (sel.name === 'nodes') out.nodes = page.map((p) => selectFields('PullRequestChangedFile', { path: p }, sel.selection, ctx));
        else if (sel.name === 'pageInfo') out.pageInfo = selectFields('PageInfo', { hasNextPage: paths.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null }, sel.selection, ctx);
      }
      return out;
    }
    return undefined;
  });
}

function repoNode(repo: Repo, sel: SelectionNode[], ctx: GqlCtx): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: repoId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  return selectFields('Repository', base, sel, ctx, (field) => {
    if (field.name === 'owner') return selectFields('User', { login: repo.owner }, field.selection, ctx);
    if (field.name === 'defaultBranchRef') {
      if (base.defaultBranchRef === null) return null;
      return selectFields('Ref', { name: repo.defaultBranch }, field.selection, ctx);
    }
    if (field.name === 'issue') {
      const number = argValue(field, 'number', ctx);
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      if (!issue) return null;
      return issueNode(repo, issue, field.selection, ctx);
    }
    if (field.name === 'issues') return issuesConnection(repo, field, ctx);
    if (field.name === 'pullRequests') {
      const first = argValue(field, 'first', ctx);
      let list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      if (typeof first === 'number') list = list.slice(0, first);
      const out: Record<string, unknown> = {};
      for (const sel of field.selection) {
        if (sel.kind === 'fragment') continue;
        if (sel.name === 'nodes') out.nodes = list.map((pr) => prNode(repo, pr, sel.selection, ctx));
        else if (sel.name === 'pageInfo') out.pageInfo = selectFields('PageInfo', { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }, sel.selection, ctx);
      }
      return out;
    }
    if (field.name === 'pullRequest') {
      const number = argValue(field, 'number', ctx);
      const pr = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      if (!pr) return null;
      return prNode(repo, pr, field.selection, ctx);
    }
    return undefined;
  });
}

function issuesConnection(repo: Repo, field: FieldNode, ctx: GqlCtx): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = argValue(field, 'states', ctx);
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = argValue(field, 'orderBy', ctx);
  let dir = 'asc';
  if (orderBy && typeof orderBy === 'object') {
    const d = (orderBy as Record<string, unknown>).direction;
    if (d === 'DESC') dir = 'desc';
  }
  list.sort((a, b) => (dir === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  const after = argValue(field, 'after', ctx);
  if (typeof after === 'string' && after !== '') {
    try {
      const seq = Number(Buffer.from(after, 'base64url').toString('utf8'));
      if (Number.isFinite(seq)) list = list.filter((i) => (dir === 'desc' ? i.seq < seq : i.seq > seq));
    } catch { /* ignore a bad cursor */ }
  }
  const first = argValue(field, 'first', ctx);
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNext = list.length > page.length;
  const endCursor = page.length ? Buffer.from(String(page[page.length - 1].seq), 'utf8').toString('base64url') : null;
  const out: Record<string, unknown> = {};
  for (const sel of field.selection) {
    if (sel.kind === 'fragment') continue;
    if (sel.name === 'nodes') out.nodes = page.map((issue) => issueNode(repo, issue, sel.selection, ctx));
    else if (sel.name === 'pageInfo') {
      out.pageInfo = selectFields('PageInfo', { hasNextPage: hasNext, hasPreviousPage: false, endCursor, startCursor: page.length ? Buffer.from(String(page[0].seq), 'utf8').toString('base64url') : null }, sel.selection, ctx);
    }
  }
  return out;
}

/** Pick the requested fields out of `values`, validating names against `typeName`. */
function selectFields(
  typeName: string,
  values: Record<string, unknown>,
  sel: SelectionNode[],
  ctx: GqlCtx,
  custom?: (field: FieldNode) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = allowedFields(typeName);
  for (const node of sel) {
    if (node.kind === 'fragment') {
      if (node.type === typeName) Object.assign(out, selectFields(typeName, values, node.selection, ctx, custom));
      continue;
    }
    const field = node;
    if (field.name.startsWith('__')) continue;
    if (allowed && !allowed.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    if (custom) {
      const v = custom(field);
      if (v !== undefined) { out[field.alias ?? field.name] = v; continue; }
    }
    const value = values[field.name];
    if (value !== undefined && field.selection.length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Nested object selection (e.g. owner { login }): resolve generically.
      const nestedType = field.name === 'owner' ? 'User' : field.name === 'defaultBranchRef' ? 'Ref' : typeName;
      out[field.alias ?? field.name] = selectFields(nestedType, value as Record<string, unknown>, field.selection, ctx);
    } else {
      out[field.alias ?? field.name] = value ?? null;
    }
  }
  return out;
}

function allowedFields(typeName: string): Set<string> | null {
  switch (typeName) {
    case 'Query': return QUERY_FIELDS;
    case 'Mutation': return MUTATION_FIELDS;
    case 'User': return USER_FIELDS;
    case 'Repository': return REPO_FIELDS;
    case 'Issue': return ISSUE_FIELDS;
    case 'PullRequest': return PR_FIELDS;
    case 'Ref': return REF_FIELDS;
    case 'IssueConnection': case 'PullRequestConnection': return CONN_FIELDS;
    case 'PageInfo': return PAGE_INFO_FIELDS;
    case 'PullRequestChangedFile': return FILE_FIELDS;
    case '__Type': return TYPE_FIELDS;
    case '__Field': return FIELD_FIELDS;
    case '__EnumValue': return ENUM_FIELDS;
    default: return null;
  }
}

function typeIntrospection(name: string, sel: SelectionNode[], ctx: GqlCtx): Record<string, unknown> | null {
  const fields = TYPE_FIELD_NAMES[name];
  const values: Record<string, unknown> = { name, kind: fields === undefined && name === 'SearchType' ? 'ENUM' : 'OBJECT' };
  if (fields !== undefined) {
    values.fields = fields.map((f) => ({ name: f }));
  }
  if (name === 'SearchType') {
    values.enumValues = SEARCH_TYPE_VALUES.map((v) => ({ name: v }));
  }
  const out: Record<string, unknown> = {};
  for (const node of sel) {
    if (node.kind === 'fragment') continue;
    if (node.name === 'fields') {
      const list = (values.fields as { name: string }[] | undefined) ?? [];
      out[node.alias ?? node.name] = list.map((f) => selectFields('__Field', f, node.selection, ctx));
    } else if (node.name === 'enumValues') {
      const list = (values.enumValues as { name: string }[] | undefined) ?? [];
      out[node.alias ?? node.name] = list.map((f) => selectFields('__EnumValue', f, node.selection, ctx));
    } else if (node.name === 'name' || node.name === 'kind') {
      out[node.alias ?? node.name] = values[node.name] ?? null;
    }
  }
  return out;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: GqlCtx = { store, variables, errors: [] };
  // Apply variable defaults.
  for (const v of op.variables) {
    if (!(v.name in variables) && v.value !== null) ctx.variables[v.name] = resolveValue(v.value, ctx);
  }
  const data: Record<string, unknown> = {};
  const isMutation = op.type === 'mutation';
  for (const node of op.selection) {
    if (node.kind === 'fragment') continue;
    const field = node;
    if (field.name === '__type') {
      const name = argValue(field, 'name', ctx);
      const type = typeof name === 'string' ? typeIntrospection(name, field.selection, ctx) : null;
      data[field.alias ?? field.name] = type;
      continue;
    }
    if (!isMutation) {
      if (field.name === 'viewer') {
        data[field.alias ?? field.name] = selectFields('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, field.selection, ctx);
      } else if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx);
        const name = argValue(field, 'name', ctx);
        const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
        data[field.alias ?? field.name] = repo && owner === VIEWER.login ? repoNode(repo, field.selection, ctx) : null;
      } else if (field.name === 'node') {
        const id = argValue(field, 'id', ctx);
        data[field.alias ?? field.name] = resolveNode(store, id, field.selection, ctx);
      } else {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        data[field.alias ?? field.name] = null;
      }
    } else {
      data[field.alias ?? field.name] = executeMutation(store, field, ctx);
    }
  }
  return { data, errors: ctx.errors };
}

function resolveNode(store: Store, id: unknown, sel: SelectionNode[], ctx: GqlCtx): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const [owner, name] = parsed.key.split('/');
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    return repoNode(repo, sel, ctx);
  }
  if (parsed.kind === 'Issue') {
    const [repoPart, num] = parsed.key.split('#');
    const [owner, name] = repoPart.split('/');
    const repo = store.getRepo(owner, name);
    const issue = repo?.issues.get(Number(num));
    if (!repo || !issue) return null;
    return issueNode(repo, issue, sel, ctx);
  }
  return null;
}

function executeMutation(store: Store, field: FieldNode, ctx: GqlCtx): unknown {
  const input = argValue(field, 'input', ctx);
  if (!input || typeof input !== 'object') {
    ctx.errors.push({ message: `Field "${field.name}" argument "input" of type is required.` });
    return null;
  }
  const inp = input as Record<string, unknown>;
  const pick = (sel: SelectionNode[], obj: Record<string, unknown>, typeName: string): Record<string, unknown> =>
    selectFields(typeName, obj, sel, ctx);

  if (field.name === 'createIssue') {
    const repo = repoByGlobalId(store, inp.repositoryId);
    if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); return null; }
    const title = typeof inp.title === 'string' ? inp.title : '';
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = { id: store.nextGlobalId(), number, title, body: typeof inp.body === 'string' ? inp.body : '', state: 'open', labels: [], comments: [], seq: store.nextSeq() };
    repo.issues.set(number, issue);
    return pick(field.selection, { issue: pickFieldIssue(repo, issue, field, ctx) }, 'CreateIssuePayload');
  }
  if (field.name === 'closeIssue') {
    const found = issueByGlobalId(store, inp.issueId);
    if (!found) { ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' }); return null; }
    found.issue.state = 'closed';
    return pick(field.selection, { issue: pickFieldIssue(found.repo, found.issue, field, ctx) }, 'CloseIssuePayload');
  }
  if (field.name === 'createPullRequest') {
    const repo = repoByGlobalId(store, inp.repositoryId);
    if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); return null; }
    const head = typeof inp.headRefName === 'string' ? inp.headRefName : '';
    const base = typeof inp.baseRefName === 'string' ? inp.baseRefName : repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) { ctx.errors.push({ message: 'head or base branch does not exist.' }); return null; }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: PullRequest = {
      id: store.nextGlobalId(), number, title: typeof inp.title === 'string' ? inp.title : '',
      body: typeof inp.body === 'string' ? inp.body : '', state: 'open', merged: false, merged_at: null,
      merge_commit_sha: null, headRef: head, baseRef: base, headSha, baseSha, seq: store.nextSeq(),
    };
    repo.pulls.set(number, pr);
    return pick(field.selection, { pullRequest: prNode(repo, pr, subSelection(field, 'pullRequest'), ctx) }, 'CreatePullRequestPayload');
  }
  if (field.name === 'mergePullRequest') {
    const found = prByGlobalId(store, inp.pullRequestId);
    if (!found) { ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' }); return null; }
    if (found.pr.state !== 'open') { ctx.errors.push({ message: 'Pull request is not open.' }); return null; }
    const outcome = tryMerge(store, found.repo, found.pr);
    if (outcome.status !== 200) { ctx.errors.push({ message: outcome.message }); return null; }
    return pick(field.selection, { pullRequest: prNode(found.repo, found.pr, subSelection(field, 'pullRequest'), ctx) }, 'MergePullRequestPayload');
  }
  if (field.name === 'addComment') {
    const found = issueByGlobalId(store, inp.subjectId);
    if (!found) { ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' }); return null; }
    const comment = { id: store.nextGlobalId(), body: typeof inp.body === 'string' ? inp.body : '' };
    found.issue.comments.push(comment);
    const node = { id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`), body: comment.body };
    return pick(field.selection, { commentEdge: { node: pickFieldComment(node, field, ctx) } }, 'AddCommentPayload');
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function subSelection(field: FieldNode, name: string): SelectionNode[] {
  const child = field.selection.find((s): s is FieldNode => s.kind !== 'fragment' && s.name === name);
  return child ? child.selection : [];
}

function pickFieldIssue(repo: Repo, issue: Issue, field: FieldNode, ctx: GqlCtx): Record<string, unknown> {
  return issueNode(repo, issue, subSelection(field, 'issue'), ctx);
}

function pickFieldComment(node: { id: string; body: string }, field: FieldNode, ctx: GqlCtx): Record<string, unknown> {
  const nodeSel = subSelection(field, 'commentEdge');
  const inner = nodeSel.find((s): s is FieldNode => s.kind !== 'fragment' && s.name === 'node');
  return selectFields('IssueComment', node, inner ? inner.selection : [], ctx);
}

function repoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  return store.getRepo(owner, name) ?? null;
}

function issueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [repoPart, num] = parsed.key.split('#');
  const [owner, name] = repoPart.split('/');
  const repo = store.getRepo(owner, name);
  const issue = repo?.issues.get(Number(num));
  return repo && issue ? { repo, issue } : null;
}

function prByGlobalId(store: Store, id: unknown): { repo: Repo; pr: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoPart, num] = parsed.key.split('#');
  const [owner, name] = repoPart.split('/');
  const repo = store.getRepo(owner, name);
  const pr = repo?.pulls.get(Number(num));
  return repo && pr ? { repo, pr } : null;
}

export interface GraphQLResult { status: number; body: unknown; }

/** Execute one GraphQL HTTP body (a single operation object or a batch array). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const out = body.map((entry) => runOne(store, entry));
    return { status: 200, body: out };
  }
  return { status: 200, body: runOne(store, body) };
}

function runOne(store: Store, entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || typeof (entry as { query?: unknown }).query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string.' }] };
  }
  const query = (entry as { query: string }).query;
  const variables = ((entry as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'Empty query.' }] };
  const op = ops[0];
  const { data, errors } = executeOperation(store, op, { ...variables });
  const out: Record<string, unknown> = { data };
  if (errors.length) out.errors = errors;
  return out;
}
