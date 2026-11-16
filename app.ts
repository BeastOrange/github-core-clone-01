// The forge's HTTP server: one process, four surfaces. Routing is by path:
//   GET  /healthz                     the env's boot probe (no auth)
//   POST /mcp                          Model Context Protocol (JSON-RPC 2.0)
//   POST /api/graphql                  GraphQL v4
//   /api/v3/...                        GitHub REST v3
//   /{owner}/{repo}.git/...            git smart HTTP
// Everything else is a JSON 404. Every API call carries
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a request without it is 401,
// and a repository belongs to the login the token names, so the same name
// under another owner is 404, never 403.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { decodePktLines, listRefs, planFetch, pktDelim, pktFlush, pktLine, pktLinesText, readPack, sidebandPack, v0Advertisement, v2Advertisement, writePack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Ctx } from './rest.ts';
import { Store, VIEWER, ZERO_OID } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local runs): accept any
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function requestId(): string { return randomUUID(); }

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...extra };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------- git

function gitRepo(store: Store, owner: string, repo: string): ReturnType<Store['getRepo']> {
  if (owner !== VIEWER.login) return undefined;
  return store.getRepo(owner, repo);
}

function handleInfoRefs(store: Store, res: ServerResponse, owner: string, repoName: string, service: string, isV2: boolean): void {
  const repo = gitRepo(store, owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  if (service === 'git-upload-pack') {
    if (isV2) sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    else sendBuffer(res, 200, v0Advertisement(store, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

function handleUploadPack(store: Store, res: ServerResponse, owner: string, repoName: string, body: Buffer, isV2: boolean): void {
  const repo = gitRepo(store, owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const { packets } = decodePktLines(body);
  const lines = pktLinesText(packets);
  if (isV2) {
    const command = lines[0]?.trim() ?? '';
    if (command === 'command=ls-refs') {
      let peel = false;
      let symrefs = false;
      let unborn = false;
      const prefixes: string[] = [];
      let afterDelim = false;
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === '') continue;
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text === 'unborn') unborn = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
        void afterDelim;
      }
      const parts: Buffer[] = [];
      const refs = listRefs(store, repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        if (ref.unborn) {
          if (unborn) parts.push(pktLine(`unborn ${ref.name} symref-target:${ref.symrefTarget ?? ''}\n`));
          continue;
        }
        let line = `${ref.oid} ${ref.name}`;
        if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
        if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
        parts.push(pktLine(`${line}\n`));
      }
      parts.push(pktFlush());
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      let afterDelim = false;
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === '') continue;
        if (text === 'delim') { afterDelim = true; continue; }
        void afterDelim;
        if (text.startsWith('want ')) wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      }
      const plan = planFetch(store, wants, haves, shallow, depth);
      const parts: Buffer[] = [];
      parts.push(pktLine('acknowledgments\n'));
      if (plan.acks.length) {
        for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktFlush());
      if (depth !== null || shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
        parts.push(pktFlush());
      }
      if (plan.objects.length) {
        parts.push(pktLine('packfile\n'));
        parts.push(sidebandPack(writePack(plan.objects)));
        parts.push(pktFlush());
      }
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  // v0 fetch: want lines, flush, have lines, done, flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  if (wants.length === 0) { sendJson(res, 400, { message: 'Bad request' }); return; }
  const plan = planFetch(store, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length) for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(store: Store, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = gitRepo(store, owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const { packets, rest } = decodePktLines(body);
  interface Command { oldOid: string; newOid: string; ref: string; }
  const commands: Command[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const report: string[] = [];
  if (commands.length === 0) { sendJson(res, 400, { message: 'Bad request' }); return; }
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => store.getObject(oid));
      for (const [oid, obj] of objects) {
        const actual = store.putObject(obj.type, obj.data);
        if (actual !== oid) throw new Error(`pack object ${oid} recomputes to ${actual}`);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : String(e);
    }
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let verdict: { ok: boolean; reason: string } | null = null;
    if (!unpackOk) {
      verdict = { ok: false, reason: 'unpack failed' };
    } else if (cmd.newOid === ZERO_OID) {
      if (current === undefined) verdict = { ok: false, reason: 'remote ref does not exist' };
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) verdict = { ok: false, reason: 'old value mismatch' };
      else { repo.refs.delete(cmd.ref); verdict = { ok: true, reason: '' }; }
    } else {
      const obj = store.getObject(cmd.newOid);
      if (!obj) verdict = { ok: false, reason: 'unresolvable' };
      else if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) verdict = { ok: false, reason: 'old value mismatch' };
        else { repo.refs.set(cmd.ref, cmd.newOid); verdict = { ok: true, reason: '' }; }
      } else if (cmd.oldOid !== current) {
        verdict = { ok: false, reason: 'old value mismatch' };
      } else if (cmd.newOid === current) {
        verdict = { ok: true, reason: '' };
      } else if (!store.isAncestor(store.peel(current), store.peel(cmd.newOid))) {
        verdict = { ok: false, reason: 'non-fast-forward' };
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        verdict = { ok: true, reason: '' };
      }
    }
    report.push(verdict.ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${verdict.reason}\n`);
  }
  const stream: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const line of report) stream.push(pktLine(line));
  stream.push(pktFlush());
  const banded = Buffer.concat(stream.map((pkt) => pktLine(Buffer.concat([Buffer.from([1]), pkt]))));
  sendBuffer(res, 200, Buffer.concat([banded, pktFlush()]), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- server

export function createApp(store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(store, req, res);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' });
        else res.destroy();
      }
    })();
  });
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const query = url.searchParams;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP (any method other than POST/DELETE is a 404).
  if (path === '/mcp') {
    if (method === 'DELETE') { sendJson(res, 200, {}); return; }
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const raw = await readBody(req);
    const out = handleMcp(store, raw.toString('utf8'));
    if (out.body === null) { res.writeHead(out.status, { 'x-github-request-id': requestId() }); res.end(); return; }
    sendJson(res, out.status, out.body);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] }); return; }
    const out = handleGraphQL(store, parsed.value);
    sendJson(res, out.status, out.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const raw = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON body' }); return; }
    const segments = path === '/api/v3' || path === '/api/v3/'
      ? []
      : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
    const ctx: Ctx = { store, query, body: parsed.value, host: req.headers.host ?? 'localhost' };
    const reply = handleRest(method, segments, ctx);
    if (reply === null) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3];
    if (method === 'GET' && suffix === 'info/refs') {
      handleInfoRefs(store, res, owner, repoName, query.get('service') ?? '', req.headers['git-protocol'] === 'version=2');
      return;
    }
    if (method === 'POST' && suffix === 'git-upload-pack') {
      const raw = await readBody(req);
      handleUploadPack(store, res, owner, repoName, raw, req.headers['git-protocol'] === 'version=2');
      return;
    }
    if (method === 'POST' && suffix === 'git-receive-pack') {
      const raw = await readBody(req);
      handleReceivePack(store, res, owner, repoName, raw);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
