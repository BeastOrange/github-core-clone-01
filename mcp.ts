// Model Context Protocol over streamable HTTP (JSON-RPC 2.0). Speaks the
// modern 2026-07-28 revision through `server/discover`, and the legacy
// handshake (`initialize` + `notifications/initialized`) for older clients.
// The tools act on the same store as REST and GraphQL.

import { VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { issueView, pullView, repoView, tryMerge } from './rest.ts';

export const SERVER_NAME = 'forge';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

function numArg(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

function resolveRepo(store: Store, owner: string | null, repo: string | null): Repo | null {
  if (!owner || !repo || owner !== VIEWER.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; value: unknown; error?: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, value: null, error: `Unknown tool: ${name}` };
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { ok: false, value: toolError(`Missing required argument: ${req}`) };
    }
  }
  const owner = strArg(args, 'owner');
  const repoName = strArg(args, 'repo');
  switch (name) {
    case 'create_repo': {
      const repoArg = strArg(args, 'name');
      if (!repoArg) return { ok: false, value: toolError('Missing required argument: name') };
      if (store.getRepo(VIEWER.login, repoArg)) return { ok: false, value: toolError(`Repository ${repoArg} already exists`) };
      const repo = store.createRepo(VIEWER.login, repoArg, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, owner, repoName);
      const title = strArg(args, 'title');
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      if (!title) return { ok: false, value: toolError('Missing required argument: title') };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = { id: store.nextGlobalId(), number, title, body: strArg(args, 'body') ?? '', state: 'open', labels: [], comments: [], seq: store.nextSeq() };
      repo.issues.set(number, issue);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      const state = strArg(args, 'state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return { ok: true, value: list.map((i) => issueView(repo, i)) };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, owner, repoName);
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      if (!title || !head || !base) return { ok: false, value: toolError('Missing required argument for create_pull_request') };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { ok: false, value: toolError('head or base branch does not exist') };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr: PullRequest = {
        id: store.nextGlobalId(), number, title, body: strArg(args, 'body') ?? '',
        state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
        headRef: head, baseRef: base, headSha, baseSha, seq: store.nextSeq(),
      };
      repo.pulls.set(number, pr);
      return { ok: true, value: pullView(repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, owner, repoName);
      const number = numArg(args, 'pull_number');
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      if (number === null) return { ok: false, value: toolError('Missing required argument: pull_number') };
      const pr = repo.pulls.get(number);
      if (!pr) return { ok: false, value: toolError('Pull request not found') };
      if (pr.state !== 'open') return { ok: false, value: toolError('Pull request is not open') };
      const outcome = tryMerge(store, repo, pr);
      if (outcome.status !== 200) return { ok: false, value: toolError(outcome.message) };
      return { ok: true, value: { sha: outcome.sha, merged: true, message: outcome.message, pull_request: pullView(repo, pr) } };
    }
    case 'get_issue': {
      const repo = resolveRepo(store, owner, repoName);
      const number = numArg(args, 'issue_number');
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      if (number === null) return { ok: false, value: toolError('Missing required argument: issue_number') };
      const issue = repo.issues.get(number);
      if (!issue) return { ok: false, value: toolError('Issue not found') };
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return { ok: false, value: toolError('Repository not found') };
      const state = strArg(args, 'state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return { ok: true, value: list.map((p) => pullView(repo, p)) };
    }
    default:
      return { ok: false, value: null, error: `Unknown tool: ${name}` };
  }
}

export interface McpResult { status: number; body: unknown; }

/**
 * Handle one POST /mcp body. `raw` is the request text: a JSON parse failure
 * is a -32700 parse error (HTTP 400 on the modern transport). A parsed body
 * must be a JSON-RPC 2.0 request object (notifications carry no id and get
 * no JSON-RPC response; the transport answers 202 with an empty body).
 */
export function handleMcp(store: Store, raw: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in req;
  const id = hasId ? req.id ?? null : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const result = (value: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string, status = 200): McpResult => ({ status, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return result({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    return result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return error(-32601, `Method not found: tools/call ${name}`);
    const outcome = callTool(store, name, args);
    if (outcome.error) return error(-32601, outcome.error);
    if (!outcome.ok) return result(outcome.value);
    return result(toolResult(outcome.value));
  }
  return error(-32601, `Method not found: ${method}`);
}
