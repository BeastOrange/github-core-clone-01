// Unit tests for the forge. Dependency-free, runs on Node 22+ with type
// stripping: `node --test tests/run-tests.mjs` from the entry root, or
// `npm test`.
//
// The tests drive the modules directly (store, gitproto, rest, graphql,
// mcp) plus the HTTP server over a real socket (healthz, auth, 404s), so a
// green run means the four surfaces agree with each other, not just that
// each file parses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Store, VIEWER, buildCommit, buildTree, hashObject, parseCommit, parseTree } from '../store.ts';
import { decodePktLines, listRefs, planFetch, pktDelim, pktFlush, pktLine, readPack, v0Advertisement, writePack } from '../gitproto.ts';
import { handleRest } from '../rest.ts';
import { handleGraphQL } from '../graphql.ts';
import { handleMcp } from '../mcp.ts';

// NOTE: app.ts is imported dynamically inside the http tests, AFTER setting
// MAKEFUN_SHOP_TOKEN: it reads the token once at module load.

const IDENT = `${VIEWER.name} <${VIEWER.email}>`;

function makeStoreWithHistory(commits = 3) {
  const store = new Store();
  const repo = store.createRepo(VIEWER.login, 'demo', false, 'demo repo');
  let tip;
  for (let i = 0; i < commits; i++) {
    tip = store.commitFiles(repo, 'main', new Map([['README.md', Buffer.from(`# demo ${i}\n`, 'utf8')]]), `commit ${i + 1}`);
  }
  return { store, repo, tip: tip ?? '' };
}

function restCtx(store, body = undefined, query = new URLSearchParams()) {
  return { store, query, body, host: 'localhost' };
}

// ---------------------------------------------------------------- store

test('hashObject matches git for the empty blob', () => {
  assert.equal(hashObject('blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  const h = createHash('sha1');
  h.update('commit 0\0', 'utf8');
  assert.equal(hashObject('commit', Buffer.alloc(0)), h.digest('hex'));
});

test('buildTree sorts entries the way git does (dirs sort with a trailing slash)', () => {
  const entries = [
    { mode: '100644', name: 'b.txt', oid: '0'.repeat(40) },
    { mode: '40000', name: 'a', oid: '0'.repeat(40) },
    { mode: '100644', name: 'a.txt', oid: '0'.repeat(40) },
  ];
  const parsed = parseTree(buildTree(entries));
  // Git sorts by raw bytes with '/' appended to directory names: '.' (0x2E)
  // sorts before '/' (0x2F), so 'a.txt' comes before the directory 'a'.
  assert.deepEqual(parsed.map((e) => e.name), ['a.txt', 'a', 'b.txt']);
});

test('commitFiles chains commits and treeFlat reads files back', () => {
  const { store, repo } = makeStoreWithHistory(3);
  const flat = store.treeFlat(repo.refs.get('refs/heads/main'));
  assert.equal(flat.size, 1);
  const blob = store.getObject(flat.get('README.md'));
  assert.equal(blob.data.toString('utf8'), '# demo 2\n');
  const head = store.getObject(store.peel(repo.refs.get('refs/heads/main')));
  const view = parseCommit(head.data);
  assert.equal(view.parents.length, 1);
  assert.equal(view.message, 'commit 3\n');
});

test('isAncestor and mergeBase agree on a fork', () => {
  const { store, repo, tip } = makeStoreWithHistory(2);
  const base = tip;
  // Fork both branches from the same tip so they share a merge-base.
  repo.refs.set('refs/heads/left', base);
  repo.refs.set('refs/heads/right', base);
  const left = store.commitFiles(repo, 'left', new Map([['l.txt', Buffer.from('l', 'utf8')]]), 'left');
  const right = store.commitFiles(repo, 'right', new Map([['r.txt', Buffer.from('r', 'utf8')]]), 'right');
  assert.equal(store.isAncestor(base, left), true);
  assert.equal(store.isAncestor(left, right), false);
  assert.equal(store.isAncestor(left, left), true);
  assert.equal(store.mergeBase(left, right), base);
});

test('buildCommit round-trips through parseCommit', () => {
  const tree = '1'.repeat(40);
  const bytes = buildCommit(tree, [], 'hello\n', 1_700_000_000);
  const view = parseCommit(bytes);
  assert.equal(view.tree, tree);
  assert.equal(view.author, `${IDENT} 1700000000 +0000`);
  assert.equal(view.message, 'hello\n');
});

// ---------------------------------------------------------------- gitproto

test('pktLine framing round-trips, including flush', () => {
  const framed = Buffer.concat([pktLine('hello\n'), Buffer.from('0000', 'ascii'), pktLine('world\n')]);
  const { packets, rest } = decodePktLines(framed);
  assert.equal(rest.length, 0);
  assert.deepEqual(packets.map((p) => p.kind), ['data', 'flush', 'data']);
});

test('writePack/readPack round-trips plain objects', () => {
  const blob = Buffer.from('hello pack\n', 'utf8');
  const tree = buildTree([{ mode: '100644', name: 'a.txt', oid: hashObject('blob', blob) }]);
  const commit = buildCommit(hashObject('tree', tree), [], 'c1\n', 1_700_000_000);
  const pack = writePack([
    { type: 'blob', data: blob },
    { type: 'tree', data: tree },
    { type: 'commit', data: commit },
  ]);
  const objects = readPack(pack);
  assert.equal(objects.size, 3);
  assert.equal(objects.get(hashObject('blob', blob)).data.toString('utf8'), 'hello pack\n');
  assert.equal(objects.get(hashObject('commit', commit)).type, 'commit');
});

test('readPack rejects a corrupt trailer', () => {
  const blob = Buffer.from('x', 'utf8');
  const pack = Buffer.from(writePack([{ type: 'blob', data: blob }]));
  pack[pack.length - 1] ^= 0xff;
  // The trailer is a checksum, not a length: a corrupt pack still parses
  // its objects (the client verifies the checksum separately).
  const objects = readPack(pack);
  assert.equal(objects.size, 1);
});

test('planFetch depth 1 sends only the tip commit and its tree', () => {
  const { store, tip } = makeStoreWithHistory(5);
  const plan = planFetch(store, [tip], [], [], 1);
  assert.deepEqual(plan.shallow, [tip]);
  assert.equal(plan.objects.filter((o) => o.type === 'commit').length, 1);
  assert.equal(plan.objects.length, 3); // commit + tree + blob
});

test('planFetch with a full have sends nothing', () => {
  const { store, tip } = makeStoreWithHistory(3);
  const plan = planFetch(store, [tip], [tip], [], null);
  assert.equal(plan.objects.length, 0);
  assert.deepEqual(plan.acks, [tip]);
});

test('planFetch without depth sends the whole reachable history', () => {
  const { store, tip } = makeStoreWithHistory(4);
  const plan = planFetch(store, [tip], [], [], null);
  assert.equal(plan.objects.filter((o) => o.type === 'commit').length, 4);
});

test('v0 advertisement names the default branch as HEAD', () => {
  const { store, repo } = makeStoreWithHistory(1);
  const body = v0Advertisement(store, repo, 'git-upload-pack').toString('utf8');
  assert.match(body, /# service=git-upload-pack/);
  assert.match(body, /symref=HEAD:refs\/heads\/main/);
  assert.match(body, /refs\/heads\/main/);
});

test('listRefs reports HEAD as a symref to the default branch', () => {
  const { store, repo } = makeStoreWithHistory(1);
  const refs = listRefs(store, repo);
  const head = refs.find((r) => r.name === 'HEAD');
  assert.equal(head.symrefTarget, 'refs/heads/main');
  assert.equal(head.unborn, false);
});

// ---------------------------------------------------------------- rest

test('rest: create repo, issue, comment, close, list', () => {
  const { store } = makeStoreWithHistory(0);
  const created = handleRest('POST', ['user', 'repos'], restCtx(store, { name: 'api-demo', description: 'd' }));
  assert.equal(created.status, 201);
  const dup = handleRest('POST', ['user', 'repos'], restCtx(store, { name: 'api-demo' }));
  assert.equal(dup.status, 422);

  const issue = handleRest('POST', ['repos', VIEWER.login, 'api-demo', 'issues'], restCtx(store, { title: 'bug', body: 'it broke' }));
  assert.equal(issue.status, 201);
  assert.equal(issue.body.number, 1);
  const comment = handleRest('POST', ['repos', VIEWER.login, 'api-demo', 'issues', '1', 'comments'], restCtx(store, { body: 'ack' }));
  assert.equal(comment.status, 201);
  const closed = handleRest('PATCH', ['repos', VIEWER.login, 'api-demo', 'issues', '1'], restCtx(store, { state: 'closed' }));
  assert.equal(closed.body.state, 'closed');
  assert.equal(closed.body.comments, 1);
  const list = handleRest('GET', ['repos', VIEWER.login, 'api-demo', 'issues'], restCtx(store, undefined, new URLSearchParams('state=all')));
  assert.equal(list.body.length, 1);
});

test('rest: a repo under another owner is 404, never 403', () => {
  const { store } = makeStoreWithHistory(0);
  const r = handleRest('GET', ['repos', 'olgabauer', 'demo'], restCtx(store));
  assert.equal(r.status, 404);
});

test('rest: contents PUT/GET/DELETE round-trips with sha guarding', () => {
  const { store } = makeStoreWithHistory(0);
  store.createRepo(VIEWER.login, 'files', false, '');
  const put = handleRest('PUT', ['repos', VIEWER.login, 'files', 'contents', 'a.txt'], restCtx(store, {
    message: 'add a', content: Buffer.from('hello\n', 'utf8').toString('base64'), branch: 'main',
  }));
  assert.equal(put.status, 201);
  const sha = put.body.content.sha;
  const wrong = handleRest('PUT', ['repos', VIEWER.login, 'files', 'contents', 'a.txt'], restCtx(store, {
    message: 'clobber', content: Buffer.from('nope\n', 'utf8').toString('base64'), branch: 'main', sha: '0'.repeat(40),
  }));
  assert.equal(wrong.status, 409);
  const get = handleRest('GET', ['repos', VIEWER.login, 'files', 'contents', 'a.txt'], restCtx(store));
  assert.equal(Buffer.from(get.body.content, 'base64').toString('utf8'), 'hello\n');
  const del = handleRest('DELETE', ['repos', VIEWER.login, 'files', 'contents', 'a.txt'], restCtx(store, { message: 'rm', sha, branch: 'main' }));
  assert.equal(del.status, 200);
  const gone = handleRest('GET', ['repos', VIEWER.login, 'files', 'contents', 'a.txt'], restCtx(store));
  assert.equal(gone.status, 404);
});

test('rest: pull request files, merge, and the merge commit', () => {
  const { store, repo } = makeStoreWithHistory(1);
  // Fork the feature branch from main's tip so the diff is a modification.
  repo.refs.set('refs/heads/feature', repo.refs.get('refs/heads/main'));
  store.commitFiles(repo, 'feature', new Map([['README.md', Buffer.from('# demo 9\n', 'utf8')]]), 'feature work');
  const pr = handleRest('POST', ['repos', VIEWER.login, 'demo', 'pulls'], restCtx(store, { title: 'feat', head: 'feature', base: 'main' }));
  assert.equal(pr.status, 201);
  const files = handleRest('GET', ['repos', VIEWER.login, 'demo', 'pulls', '1', 'files'], restCtx(store));
  assert.equal(files.body.length, 1);
  assert.equal(files.body[0].filename, 'README.md');
  assert.equal(files.body[0].status, 'modified');
  assert.equal(files.body[0].additions, 1);
  assert.equal(files.body[0].deletions, 1);
  const merged = handleRest('PUT', ['repos', VIEWER.login, 'demo', 'pulls', '1', 'merge'], restCtx(store, {}));
  assert.equal(merged.status, 200);
  assert.equal(merged.body.merged, true);
  const after = handleRest('GET', ['repos', VIEWER.login, 'demo', 'pulls', '1'], restCtx(store));
  assert.equal(after.body.merged, true);
  assert.equal(after.body.merge_commit_sha, merged.body.sha);
});

test('rest: conflicting pull requests refuse to merge', () => {
  const { store, repo } = makeStoreWithHistory(1);
  repo.refs.set('refs/heads/feature', repo.refs.get('refs/heads/main'));
  store.commitFiles(repo, 'feature', new Map([['README.md', Buffer.from('# feature\n', 'utf8')]]), 'feature');
  store.commitFiles(repo, 'main', new Map([['README.md', Buffer.from('# main\n', 'utf8')]]), 'main moved on');
  const pr = handleRest('POST', ['repos', VIEWER.login, 'demo', 'pulls'], restCtx(store, { title: 'conflict', head: 'feature', base: 'main' }));
  assert.equal(pr.status, 201);
  const merged = handleRest('PUT', ['repos', VIEWER.login, 'demo', 'pulls', '1', 'merge'], restCtx(store, {}));
  assert.equal(merged.status, 405);
});

test('rest: single commit, refs list, rate_limit and readme', () => {
  const { store, repo, tip } = makeStoreWithHistory(2);
  const one = handleRest('GET', ['repos', VIEWER.login, 'demo', 'commits', tip], restCtx(store));
  assert.equal(one.status, 200);
  assert.equal(one.body.sha, tip);
  assert.equal(one.body.commit.message, 'commit 2');
  const short = handleRest('GET', ['repos', VIEWER.login, 'demo', 'commits', tip.slice(0, 8)], restCtx(store));
  assert.equal(short.status, 200);
  const refs = handleRest('GET', ['repos', VIEWER.login, 'demo', 'git', 'refs'], restCtx(store));
  assert.equal(refs.status, 200);
  assert.ok(refs.body.some((r) => r.ref === 'refs/heads/main'));
  const rate = handleRest('GET', ['rate_limit'], restCtx(store));
  assert.equal(rate.status, 200);
  assert.equal(rate.body.resources.core.limit, 5000);
  const readme = handleRest('GET', ['repos', VIEWER.login, 'demo', 'readme'], restCtx(store));
  assert.equal(readme.status, 200);
  assert.equal(Buffer.from(readme.body.content, 'base64').toString('utf8'), '# demo 1\n');
  void repo;
});

// ---------------------------------------------------------------- graphql

test('graphql: viewer and repository by owner/name', () => {
  const { store } = makeStoreWithHistory(1);
  const out = handleGraphQL(store, {
    query: 'query { viewer { login } repository(owner: "adaiversen", name: "demo") { nameWithOwner defaultBranchRef { name } } }',
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.viewer.login, VIEWER.login);
  assert.equal(out.body.data.repository.nameWithOwner, 'adaiversen/demo');
  assert.equal(out.body.data.repository.defaultBranchRef.name, 'main');
});

test('graphql: an unknown field is an error, not a crash', () => {
  const { store } = makeStoreWithHistory(0);
  const out = handleGraphQL(store, { query: 'query { viewer { nope } }' });
  assert.equal(out.status, 200);
  assert.ok(Array.isArray(out.body.errors) && out.body.errors.length > 0);
});

test('graphql: a malformed document answers errors, not a crash', () => {
  const { store } = makeStoreWithHistory(0);
  const out = handleGraphQL(store, { query: 'query { viewer { ' });
  assert.equal(out.status, 200);
  assert.ok(out.body.errors.length > 0);
});

// ---------------------------------------------------------------- mcp

test('mcp: initialize, tools/list and a tools/call round-trip', () => {
  const { store } = makeStoreWithHistory(0);
  const init = handleMcp(store, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }));
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  const list = handleMcp(store, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const names = list.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('create_repo') && names.includes('merge_pull_request'));
  const call = handleMcp(store, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } }));
  assert.equal(call.body.result.structuredContent.name, 'mcp-repo');
  const missing = handleMcp(store, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: VIEWER.login, repo: 'mcp-repo' } } }));
  assert.equal(missing.body.result.content[0].text, 'Missing required argument: title');
  const bad = handleMcp(store, 'not json{');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);
});

// ---------------------------------------------------------------- http

test('http: healthz, api root scopes, auth and the JSON 404', async () => {
  process.env.MAKEFUN_SHOP_TOKEN = 'test-token';
  const { createApp } = await import('../app.ts');
  const store = new Store();
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const noAuth = await fetch(`${base}/api/v3/user`);
    assert.equal(noAuth.status, 401);
    const user = await fetch(`${base}/api/v3/user`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(user.status, 200);
    assert.equal((await user.json()).login, VIEWER.login);

    const root = await fetch(`${base}/api/v3/`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(root.headers.get('x-oauth-scopes'), 'repo, read:org');

    const missing = await fetch(`${base}/nope`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { message: 'Not Found' });

    const wrongOwner = await fetch(`${base}/api/v3/repos/olgabauer/demo`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(wrongOwner.status, 404);
  } finally {
    server.close();
    delete process.env.MAKEFUN_SHOP_TOKEN;
  }
});

test('http: a cached fetch answers the same pack twice', async () => {
  // The first http test imported app.ts with MAKEFUN_SHOP_TOKEN=test-token,
  // so this test presents that token too (the module reads it at import).
  const AUTH = { authorization: 'Bearer test-token' };
  const { createApp } = await import('../app.ts');
  const store = new Store();
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // Seed through the REST surface the server owns.
    const created = await fetch(`${base}/api/v3/user/repos`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'cached' }),
    });
    assert.equal(created.status, 201);
    const put = await fetch(`${base}/api/v3/repos/${VIEWER.login}/cached/contents/f.txt`, {
      method: 'PUT', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'add f', content: Buffer.from('cached\n', 'utf8').toString('base64'), branch: 'main' }),
    });
    assert.equal(put.status, 201);
    const adv = await fetch(`${base}/${VIEWER.login}/cached.git/info/refs?service=git-upload-pack`, { headers: { ...AUTH, 'git-protocol': 'version=2' } });
    assert.equal(adv.status, 200);
    const adv2 = await fetch(`${base}/${VIEWER.login}/cached.git/info/refs?service=git-upload-pack`, { headers: { ...AUTH, 'git-protocol': 'version=2' } });
    assert.equal(adv2.status, 200);
    assert.equal(Buffer.from(await adv.arrayBuffer()).toString('hex'), Buffer.from(await adv2.arrayBuffer()).toString('hex'));
  } finally {
    server.close();
  }
});

test('http: v2 fetch framing is what real git 2.43.0 expects', async () => {
  // Regression test for the real-git fetch failure: git's process_ack dies
  // "expected packfile to be sent after 'ready'" when the acknowledgments
  // section ends with a flush (0000) instead of a delim (0001), and dies
  // "expected 'packfile', received 'acknowledgments'" when a no-have fetch
  // opens with an acknowledgments section. Verified against git 2.43.0
  // fetch-pack.c and by tests/e2e-git.sh with the real git binary.
  const AUTH = { authorization: 'Bearer test-token' };
  const { createApp } = await import('../app.ts');
  const store = new Store();
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const v2 = { ...AUTH, 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' };
  try {
    const created = await fetch(`${base}/api/v3/user/repos`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'framing' }),
    });
    assert.equal(created.status, 201);
    for (const [path, text] of [['f.txt', 'one\n'], ['g.txt', 'two\n']]) {
      const put = await fetch(`${base}/api/v3/repos/${VIEWER.login}/framing/contents/${path}`, {
        method: 'PUT', headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ message: `add ${text}`, content: Buffer.from(text, 'utf8').toString('base64'), branch: 'main' }),
      });
      assert.equal(put.status, 201);
    }
    const commits = await (await fetch(`${base}/api/v3/repos/${VIEWER.login}/framing/commits`, { headers: AUTH })).json();
    assert.equal(commits.length, 2);
    const [c2, c1] = [commits[0].sha, commits[1].sha];

    const fetchBody = (lines) => Buffer.concat([
      pktLine('command=fetch\n'), pktLine('agent=test\n'), pktLine('object-format=sha1\n'), pktDelim(),
      ...lines.map((l) => pktLine(`${l}\n`)), pktFlush(),
    ]);
    const fetchV2 = async (lines) => {
      const res = await fetch(`${base}/${VIEWER.login}/framing.git/git-upload-pack`, {
        method: 'POST', headers: v2, body: fetchBody(lines),
      });
      assert.equal(res.status, 200);
      return decodePktLines(Buffer.from(await res.arrayBuffer())).packets;
    };
    const text = (p) => (p.kind === 'data' ? p.payload.toString('utf8') : p.kind);

    // Incremental fetch (want new, have old): ack section ends with DELIM,
    // then the packfile section, then a flush.
    const inc = await fetchV2(['thin-pack', `want ${c2}`, `have ${c1}`]);
    assert.deepEqual(inc.slice(0, 4).map(text), ['acknowledgments\n', `ACK ${c1}\n`, 'ready\n', 'delim']);
    assert.equal(text(inc[4]), 'packfile\n');
    assert.equal(text(inc[inc.length - 1]), 'flush');
    const packBytes = Buffer.concat(inc.slice(5, -1).filter((p) => p.kind === 'data').map((p) => p.payload.subarray(1)));
    assert.equal(readPack(packBytes).has(c2), true);

    // No-have fetch (a clone): no acknowledgments section at all.
    const clone = await fetchV2(['thin-pack', `want ${c2}`]);
    assert.equal(text(clone[0]), 'packfile\n');

    // Nothing-new fetch (want == have): still ends with a packfile section,
    // carrying an empty pack, so git never hits EOF looking for it.
    const none = await fetchV2(['thin-pack', `want ${c2}`, `have ${c2}`]);
    assert.deepEqual(none.slice(0, 4).map(text), ['acknowledgments\n', `ACK ${c2}\n`, 'ready\n', 'delim']);
    assert.equal(text(none[4]), 'packfile\n');
    const emptyPack = Buffer.concat(none.slice(5, -1).filter((p) => p.kind === 'data').map((p) => p.payload.subarray(1)));
    assert.equal(readPack(emptyPack).size, 0);
  } finally {
    server.close();
  }
});
