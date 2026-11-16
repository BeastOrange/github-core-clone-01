// The forge's whole state: one in-memory git object store plus the REST
// resources (repositories, issues, pull requests) that sit on top of it.
// Nothing here touches the disk or the network; the trial pod gives the
// entry a fresh process, so memory is the store and a restart is a reset.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const STRANGER_LOGIN = 'olgabauer';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export interface TreeEntry { mode: string; name: string; oid: string; }

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort(compareTreeNames)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. `ts` is unix seconds; the identity is the viewer. */
export function buildCommit(tree: string, parents: string[], message: string, ts: number, who?: string): Buffer {
  const ident = who ?? `${VIEWER.name} <${VIEWER.email}>`;
  const stamp = `${ts} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident} ${stamp}`, `committer ${ident} ${stamp}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: { id: number; body: string }[]; seq: number;
}

export interface PullRequest {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; seq: number;
}

export interface Repo {
  owner: string; name: string; description: string; isPrivate: boolean;
  defaultBranch: string; id: number; seq: number;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private seq = 0;

  nextSeq(): number { this.seq += 1; return this.seq; }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined { return this.objects.get(oid); }

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      owner, name, description, isPrivate, defaultBranch: 'main',
      id: this.nextRepoId, seq: this.nextSeq(),
      refs: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
  }

  nextGlobalId(): number { this.nextObjectId += 1; return this.nextObjectId; }

  /** Follow tag objects to the commit they point at. */
  peel(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  /** All objects reachable from `roots` (commits, trees, tags, blobs). */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...roots];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      }
    }
    return seen;
  }

  private parentsCache = new Map<string, string[]>();

  /** A commit's parents, memoized: objects are immutable once stored, so the cache never goes stale. */
  commitParents(oid: string): string[] {
    const hit = this.parentsCache.get(oid);
    if (hit) return hit;
    const obj = this.objects.get(oid);
    const parents = obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
    this.parentsCache.set(oid, parents);
    return parents;
  }

  /** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [this.peel(descendant)];
    while (queue.length) {
      const cur = queue.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.commitParents(cur)) queue.push(p);
    }
    return false;
  }

  /** The merge-base of two commits: the first common ancestor found walking both histories. */
  mergeBase(a: string, b: string): string | null {
    const ancA = new Set<string>();
    const qa = [this.peel(a)];
    while (qa.length) {
      const cur = qa.pop()!;
      if (ancA.has(cur)) continue;
      ancA.add(cur);
      for (const p of this.commitParents(cur)) qa.push(p);
    }
    const seen = new Set<string>();
    const qb = [this.peel(b)];
    while (qb.length) {
      const cur = qb.pop()!;
      if (ancA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.commitParents(cur)) qb.push(p);
    }
    return null;
  }

  /** The flat path -> blob-oid map of the tree at `commitOid` (following tags). */
  treeFlat(commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const commit = this.objects.get(this.peel(commitOid));
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else if (e.mode !== '160000') out.set(path, e.oid);
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build (and store) a tree object for `flat` (path -> blob oid). */
  buildTreeFromFlat(flat: Map<string, string>): string {
    interface Node { files: Map<string, string>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of [...flat.entries()].sort()) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
        node = node.dirs.get(segs[i])!;
      }
      node.files.set(segs[segs.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one file's blob oid out of a commit's tree, or null. */
  blobAt(commitOid: string, path: string): string | null {
    return this.treeFlat(commitOid).get(path) ?? null;
  }

  /** Commit `files` (path -> bytes) onto `branch` of `repo`, returning the new commit oid. */
  commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string, deletions: string[] = []): string {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const flat = tip ? this.treeFlat(tip) : new Map<string, string>();
    for (const [path, bytes] of files) flat.set(path, this.putObject('blob', bytes));
    for (const path of deletions) flat.delete(path);
    const tree = this.buildTreeFromFlat(flat);
    const ts = Math.floor(Date.now() / 1000);
    const commit = this.putObject('commit', buildCommit(tree, tip ? [tip] : [], message.endsWith('\n') ? message : `${message}\n`, ts));
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }
}

/** Opaque, stable Relay-style global id: base64url of `Kind:stable-key`. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
