// GitHub REST v3: repositories, branches, commits, contents, issues,
// labels, comments and pull requests, over the in-memory store. Every
// reply is JSON; every error carries a string `message`.

import { buildCommit, hashObject, parseCommit, parseTree, VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface Ctx {
  store: Store;
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface Reply { status: number; body: unknown; headers?: Record<string, string>; }

const ok = (body: unknown, status = 200, headers?: Record<string, string>): Reply => ({ status, body, headers });
const err = (status: number, message: string): Reply => ({ status, body: { message } });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bodyString(b: unknown, field: string, fallback = ''): string {
  if (!isRecord(b)) return fallback;
  const v = b[field];
  return typeof v === 'string' ? v : fallback;
}

function nowIso(): string { return new Date().toISOString(); }

// ---------------------------------------------------------------- views

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate, description: repo.description, fork: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch, has_issues: true, has_projects: false, has_wiki: false,
    created_at: nowIso(), updated_at: nowIso(), pushed_at: nowIso(),
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body ?? '',
    state: issue.state, locked: false,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: nowIso(), updated_at: nowIso(), closed_at: issue.state === 'closed' ? nowIso() : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id, number: pr.number, title: pr.title, body: pr.body ?? '',
    state: pr.state, locked: false, draft: false,
    merged: pr.merged, merged_at: pr.merged_at, merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.state === 'open',
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: nowIso(), updated_at: nowIso(), closed_at: pr.state === 'closed' ? nowIso() : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ---------------------------------------------------------------- helpers

function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], ctx: Ctx, basePath: string): { items: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `http://${ctx.host}${basePath}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `http://${ctx.host}${basePath}?per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { items: slice, headers };
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Line diff counts for two small texts (LCS; falls back to a multiset diff when large). */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  if (a.length * b.length > 40000) {
    const counts = new Map<string, number>();
    for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
    let add = 0;
    for (const l of b) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else add += 1;
    }
    let del = 0;
    for (const c of counts.values()) del += c;
    return { additions: add, deletions: del };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let add = 0;
  let del = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { del += 1; i += 1; }
    else { add += 1; j += 1; }
  }
  del += a.length - i;
  add += b.length - j;
  return { additions: add, deletions: del };
}

// ---------------------------------------------------------------- merge

export interface MergeOutcome { status: number; sha?: string; message: string; }

export function tryMerge(store: Store, repo: Repo, pr: PullRequest): MergeOutcome {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return { status: 405, message: 'Merge conflict: missing branch tip' };
  const base = store.mergeBase(headTip, baseTip);
  const baseFlat = base ? store.treeFlat(base) : new Map<string, string>();
  const headFlat = store.treeFlat(headTip);
  const tipFlat = store.treeFlat(baseTip);
  const merged = new Map(tipFlat);
  let conflict = false;
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    if (h !== b) {
      if (t !== b && t !== h) { conflict = true; break; }
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    }
  }
  if (conflict) return { status: 405, message: 'Merge conflict' };
  const tree = store.buildTreeFromFlat(merged);
  const ts = Math.floor(Date.now() / 1000);
  const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
  const sha = store.putObject('commit', buildCommit(tree, [baseTip], message, ts));
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = nowIso();
  pr.merge_commit_sha = sha;
  return { status: 200, sha, message: 'Pull request successfully merged' };
}

/** MERGEABLE / CONFLICTING / UNKNOWN for an open pull request. */
export function mergeableState(store: Store, repo: Repo, pr: PullRequest): string {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = store.mergeBase(headTip, baseTip);
  const baseFlat = base ? store.treeFlat(base) : new Map<string, string>();
  const headFlat = store.treeFlat(headTip);
  const tipFlat = store.treeFlat(baseTip);
  for (const path of new Set([...baseFlat.keys(), ...headFlat.keys()])) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    if (h !== b && t !== b && t !== h) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------- contents

function refTip(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = store.getObject(ref);
    if (obj?.type === 'commit') return ref;
    if (obj?.type === 'tag') return store.peel(ref);
  }
  return undefined;
}

// ---------------------------------------------------------------- handlers

export function handleRest(method: string, segments: string[], ctx: Ctx): Reply | null {
  const [a, b, c, d, e, f] = segments;
  // GET /api/v3/  (segments empty) and GET /api/v3/meta
  if (segments.length === 0) {
    if (method === 'GET') return ok({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, 200, { 'x-oauth-scopes': 'repo, read:org' });
    return null;
  }
  if (segments.length === 1 && a === 'meta') {
    if (method === 'GET') return ok({ installed_version: '1.0.0', github_services_sha: 'forge' });
    return null;
  }
  if (segments.length === 1 && a === 'user' && method === 'GET') {
    return ok({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, type: 'User', email: VIEWER.email });
  }
  if (a === 'user' && b === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listViewerRepos().map(repoView);
      const { items, headers } = paginate(repos, ctx, '/api/v3/user/repos');
      return ok(items, 200, headers);
    }
    if (method === 'POST') {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      const name = bodyString(ctx.body, 'name');
      if (!name) return err(422, 'Repository name is required');
      if (ctx.store.getRepo(VIEWER.login, name)) return err(422, `Repository ${name} already exists`);
      const repo = ctx.store.createRepo(VIEWER.login, name, ctx.body.private === true, bodyString(ctx.body, 'description'));
      return ok(repoView(repo), 201);
    }
    return null;
  }
  if (a !== 'repos' || !b || !c) return null;
  const owner = decodeURIComponent(b);
  const repoName = decodeURIComponent(c);
  const repo = resolveRepo(ctx, owner, repoName);
  if (!repo) return err(404, 'Not Found');
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoView(repo));
    if (method === 'PATCH') {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
      if (typeof ctx.body.default_branch === 'string' && repo.refs.has(`refs/heads/${ctx.body.default_branch}`)) repo.defaultBranch = ctx.body.default_branch;
      return ok(repoView(repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return null;
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const out = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) }, protected: false }));
      return ok(out);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Branch not found');
      return ok({ name: branch, commit: { sha }, protected: false });
    }
    return null;
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = ctx.query.get('sha');
    const tip = refTip(ctx.store, repo, ref);
    const out: Record<string, unknown>[] = [];
    if (tip) {
      const seen = new Set<string>();
      const queue = [ctx.store.peel(tip)];
      while (queue.length) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const obj = ctx.store.getObject(cur);
        if (!obj || obj.type !== 'commit') continue;
        const v = parseCommit(obj.data);
        out.push({
          sha: cur,
          commit: {
            // The raw commit object ends its message with "\n"; the API
            // reports the message without that trailing newline.
            message: v.message.replace(/\n+$/, ''),
            author: { name: v.author, date: nowIso() },
            committer: { name: v.committer, date: nowIso() },
          },
          author: { login: VIEWER.login },
          parents: v.parents.map((p) => ({ sha: p })),
        });
        for (const p of v.parents) queue.push(p);
      }
    }
    return ok(out);
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      const ref = bodyString(ctx.body, 'ref');
      const sha = bodyString(ctx.body, 'sha');
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      const obj = ctx.store.getObject(sha);
      if (!obj) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: obj.type }, url: '' }, 201);
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest[3]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Reference not found');
      return ok({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return null;
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      const contentB64 = bodyString(ctx.body, 'content');
      const message = bodyString(ctx.body, 'message', 'Update file');
      const branch = bodyString(ctx.body, 'branch') || repo.defaultBranch;
      const sha = bodyString(ctx.body, 'sha');
      if (contentB64 === '') return err(422, 'content is required');
      let bytes: Buffer;
      try { bytes = Buffer.from(contentB64, 'base64'); } catch { return err(422, 'content is not valid base64'); }
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const current = tip ? ctx.store.blobAt(tip, path) : null;
      if (current) {
        if (!sha || sha.toLowerCase() !== current.toLowerCase()) return err(409, 'sha does not match the current blob');
      } else if (sha) {
        return err(422, 'sha given for a file that does not exist');
      }
      const files = new Map([[path, bytes]]);
      const commitSha = ctx.store.commitFiles(repo, branch, files, message);
      const blobSha = hashObject('blob', bytes);
      return ok({ content: { name: path.split('/').pop(), path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' }, commit: { sha: commitSha, message } }, current ? 200 : 201);
    }
    if (method === 'GET') {
      const ref = ctx.query.get('ref');
      const tip = refTip(ctx.store, repo, ref);
      if (!tip) return err(404, 'Not Found');
      const flat = ctx.store.treeFlat(tip);
      if (flat.has(path)) {
        const oid = flat.get(path)!;
        const obj = ctx.store.getObject(oid)!;
        return ok({ type: 'file', encoding: 'base64', size: obj.data.length, name: path.split('/').pop(), path, content: obj.data.toString('base64'), sha: oid });
      }
      // Directory listing: entries directly under `path` (or the root when path is '').
      const prefix = path === '' ? '' : `${path}/`;
      const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
      for (const [p, oid] of flat) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const seg = restPath.split('/')[0];
        if (restPath.includes('/')) {
          if (!entries.has(seg)) {
            // The sub-tree's oid: rebuild is wasteful; use the tree object id
            // by walking from the tip tree.
            entries.set(seg, { type: 'dir', name: seg, path: prefix + seg, sha: dirTreeOid(ctx.store, tip, prefix + seg) ?? '0'.repeat(40), size: 0 });
          }
        } else {
          const obj = ctx.store.getObject(oid)!;
          entries.set(seg, { type: 'file', name: seg, path: p, sha: oid, size: obj.data.length });
        }
      }
      if (entries.size === 0) return err(404, 'Not Found');
      return ok([...entries.values()].sort((x, y) => (x.name < y.name ? -1 : 1)));
    }
    if (method === 'DELETE') {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      const sha = bodyString(ctx.body, 'sha');
      const message = bodyString(ctx.body, 'message', 'Delete file');
      const branch = bodyString(ctx.body, 'branch') || repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const current = tip ? ctx.store.blobAt(tip, path) : null;
      if (!current) return err(404, 'Not Found');
      if (sha && sha.toLowerCase() !== current.toLowerCase()) return err(409, 'sha does not match the current blob');
      const commitSha = ctx.store.commitFiles(repo, branch, new Map(), message, [path]);
      return ok({ commit: { sha: commitSha, message } });
    }
    return null;
  }

  if (rest[0] === 'labels') {
    if (method === 'POST') {
      if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
      const name = bodyString(ctx.body, 'name');
      if (!name) return err(422, 'Label name is required');
      const color = bodyString(ctx.body, 'color', 'ededed');
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      return ok({ name, color: repo.labels.get(name)!.color, description: '' }, 201);
    }
    if (method === 'GET') return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
    return null;
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
        const title = bodyString(ctx.body, 'title');
        if (!title) return err(422, 'Title is required');
        const labels: string[] = Array.isArray(ctx.body.labels) ? ctx.body.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const l of labels) if (!repo.labels.has(l)) return err(422, `Label '${l}' does not exist`);
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const issue: Issue = { id: ctx.store.nextGlobalId(), number, title, body: bodyString(ctx.body, 'body'), state: 'open', labels, comments: [], seq: ctx.store.nextSeq() };
        repo.issues.set(number, issue);
        return ok(issueView(repo, issue), 201);
      }
      if (method === 'GET') {
        let list = [...repo.issues.values()];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((x, y) => (direction === 'asc' ? x.seq - y.seq : y.seq - x.seq));
        const { items, headers } = paginate(list.map((i) => issueView(repo, i)), ctx, `/api/v3/repos/${owner}/${repoName}/issues`);
        return ok(items, 200, headers);
      }
      return null;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return null;
    const issue = repo.issues.get(num);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(issueView(repo, issue));
      if (method === 'PATCH') {
        if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
        if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
        if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
        if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
        return ok(issueView(repo, issue));
      }
      return null;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'POST') {
        if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
        const comment = { id: ctx.store.nextGlobalId(), body: bodyString(ctx.body, 'body') };
        issue.comments.push(comment);
        return ok({ id: comment.id, body: comment.body, user: { login: VIEWER.login } }, 201);
      }
      if (method === 'GET') return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login } })));
      return null;
    }
    return null;
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!isRecord(ctx.body)) return err(400, 'Invalid request body');
        const head = bodyString(ctx.body, 'head');
        const base = bodyString(ctx.body, 'base', repo.defaultBranch);
        const title = bodyString(ctx.body, 'title');
        if (!head || !title) return err(422, 'head and title are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) return err(422, 'A pull request already exists for this head branch');
        }
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const pr: PullRequest = {
          id: ctx.store.nextGlobalId(), number, title, body: bodyString(ctx.body, 'body'),
          state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
          headRef: head, baseRef: base, headSha, baseSha, seq: ctx.store.nextSeq(),
        };
        repo.pulls.set(number, pr);
        return ok(pullView(repo, pr), 201);
      }
      if (method === 'GET') {
        let list = [...repo.pulls.values()];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((x, y) => y.seq - x.seq);
        const { items, headers } = paginate(list.map((p) => pullView(repo, p)), ctx, `/api/v3/repos/${owner}/${repoName}/pulls`);
        return ok(items, 200, headers);
      }
      return null;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return null;
    const pr = repo.pulls.get(num);
    if (rest.length === 2) {
      if (!pr) return err(404, 'Not Found');
      if (method === 'GET') return ok(pullView(repo, pr));
      return null;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pr) return err(404, 'Not Found');
      const base = ctx.store.mergeBase(pr.headSha, pr.baseSha);
      const baseFlat = base ? ctx.store.treeFlat(base) : new Map<string, string>();
      const headFlat = ctx.store.treeFlat(pr.headSha);
      const out: Record<string, unknown>[] = [];
      for (const path of [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort()) {
        const b = baseFlat.get(path);
        const h = headFlat.get(path);
        if (b === h) continue;
        const oldText = b ? ctx.store.getObject(b)?.data.toString('utf8') ?? '' : '';
        const newText = h ? ctx.store.getObject(h)?.data.toString('utf8') ?? '' : '';
        const { additions, deletions } = diffCounts(oldText, newText);
        out.push({
          filename: path,
          status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
          additions, deletions, changes: additions + deletions,
          sha: h ?? b ?? '',
        });
      }
      return ok(out);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pr) return err(404, 'Not Found');
      if (pr.state !== 'open') return err(405, 'Pull request is not open');
      const outcome = tryMerge(ctx.store, repo, pr);
      if (outcome.status !== 200) return err(outcome.status, outcome.message);
      return ok({ sha: outcome.sha, merged: true, message: outcome.message });
    }
    return null;
  }

  return null;
}

/** The tree oid of a directory inside a commit's tree, for directory listings. */
function dirTreeOid(store: Store, commitOid: string, dirPath: string): string | null {
  const commit = store.getObject(store.peel(commitOid));
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  for (const seg of dirPath.split('/')) {
    const tree = store.getObject(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}
