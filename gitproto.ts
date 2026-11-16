// Git smart HTTP: pkt-line framing, packfile read/write, upload-pack v2
// and v0, receive-pack v0. The suite's client speaks protocol v2 for fetch
// and ls-refs and v0 for receive-pack, and pushes plain (undelted) packs;
// the pack reader still resolves OFS/REF deltas so a deltified pack from
// any client is accepted too.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type GitObjectType, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; trailing raw bytes (a pack) are returned separately. */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

export function pktLinesText(packets: Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- packfile

const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas). */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift; shift += 8; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const hdr = readVarint(pack, off);
    off = hdr.next;
    const typeCode = (hdr.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOff, typeCode, size: hdr.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off];
      let value = byte & 0x7f;
      off += 1;
      while (byte & 0x80) { byte = pack[off++]; value = ((value + 1) * 128) + (byte & 0x7f); }
      entry.baseOffset = entryOff - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== hdr.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- refs

export interface RefInfo { oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean; }

export function listRefs(store: Store, repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  refs.push({ oid: tip ?? ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: tip === undefined });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: RefInfo = { oid, name };
    const obj = store.getObject(oid);
    if (obj?.type === 'tag') entry.peeled = store.peel(oid);
    refs.push(entry);
  }
  return refs;
}

const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow thin-pack ofs-delta', 'object-format=sha1', 'agent=forge/1.0'];

/** The v2 capability advertisement body. */
export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 ref advertisement body for a service, with the `# service=` preamble. */
export function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/' + repo.defaultBranch + ' agent=forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/' + repo.defaultBranch + ' agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(store, repo).filter((r) => r.name !== 'HEAD');
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip === undefined && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = `${tip ?? ZERO_OID} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

export interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** New shallow boundary commits (depth cut). */
  shallow: string[];
  /** Old shallow boundaries that are now complete. */
  unshallow: string[];
  /** Haves the server holds (for ACK lines). */
  acks: string[];
}

/**
 * Work out what a fetch sends. `wants` are the wanted oids, `haves` the
 * commits the client holds, `shallow` its current shallow boundary, and
 * `depth` the requested depth (commits from the wants: 1 = the wants only).
 * A shallow have's parents are NOT held, so a deepen walks past it.
 */
export function planFetch(store: Store, wants: string[], haves: string[], shallow: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallow);
  // held commits: walk from each have, stopping at shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  while (heldQueue.length) {
    const cur = heldQueue.pop()!;
    if (held.has(cur)) continue;
    const peeled = store.peel(cur);
    held.add(cur);
    if (cur !== peeled) held.add(peeled);
    if (shallowSet.has(cur) || shallowSet.has(peeled)) continue;
    const obj = store.getObject(peeled);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) heldQueue.push(p);
  }
  // The objects the client actually holds: each held commit plus its tree,
  // following a parent only when that parent is itself held. A shallow held
  // commit's parents are NOT held, so `reachable` (which walks all parents)
  // would over-claim and make the send set subtract objects the client
  // still needs.
  const objectClosure = (commits: Set<string>): Set<string> => {
    const out = new Set<string>();
    const addTree = (treeOid: string): void => {
      if (out.has(treeOid)) return;
      const obj = store.getObject(treeOid);
      if (!obj || obj.type !== 'tree') return;
      out.add(treeOid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') addTree(entry.oid);
        else if (entry.mode !== '160000') out.add(entry.oid);
      }
    };
    for (const oid of commits) {
      out.add(oid);
      const obj = store.getObject(oid);
      if (obj?.type !== 'commit') continue;
      addTree(parseCommit(obj.data).tree);
      for (const p of parseCommit(obj.data).parents) if (commits.has(p)) out.add(p);
    }
    return out;
  };
  const heldObjects = objectClosure(held);
  const addTreeTo = (out: Set<string>, treeOid: string): void => {
    if (out.has(treeOid)) return;
    const obj = store.getObject(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTreeTo(out, entry.oid);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  };
  // included commits: walk from wants, honouring depth and the held set.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; dist: number }[] = wants.map((oid) => ({ oid: store.peel(oid), dist: 0 }));
  const seenWalk = new Set<string>();
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (seenWalk.has(oid)) continue;
    seenWalk.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') {
      // A wanted tag object itself is sent; its target commit joins the walk.
      if (obj?.type === 'tag') {
        included.add(oid);
        queue.push({ oid: store.peel(oid), dist });
      }
      continue;
    }
    const isHeld = held.has(oid);
    if (!isHeld) {
      included.add(oid);
      if (depth !== null && dist >= depth - 1) { boundary.add(oid); continue; }
    } else if (!shallowSet.has(oid)) {
      continue; // held with full history: do not walk past it
    }
    // Held but shallow, or not held: walk the parents (depth permitting).
    if (depth !== null && dist >= depth - 1) { if (!isHeld) boundary.add(oid); continue; }
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, dist: dist + 1 });
  }
  // Objects to send: the closure of the included commits and wanted tags,
  // minus everything the client already holds. The closure must NOT walk
  // past a boundary commit's parents: a plain `reachable` would send the
  // whole history, which is exactly what a shallow fetch must not do.
  const wantedTags = wants.filter((oid) => store.getObject(oid)?.type === 'tag');
  const sendOids = objectClosure(included);
  for (const oid of wantedTags) {
    sendOids.add(oid);
    const obj = store.getObject(oid);
    if (obj?.type === 'tag') {
      const target = parseTag(obj.data);
      if (target.type === 'tree') addTreeTo(sendOids, target.object);
      else if (target.type === 'blob') sendOids.add(target.object);
    }
  }
  for (const oid of heldObjects) sendOids.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of sendOids) {
    const obj = store.getObject(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic pack order: commits first (parents before children is not
  // required), then trees, tags, blobs — sorted by oid inside each type.
  const typeOrder: Record<GitObjectType, number> = { commit: 0, tree: 1, tag: 2, blob: 3 };
  objects.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
  const unshallow = [...shallowSet].filter((oid) => {
    const obj = store.getObject(store.peel(oid));
    if (!obj || obj.type !== 'commit') return false;
    return parseCommit(obj.data).parents.every((p) => held.has(p) || included.has(p));
  }).sort();
  const unshallowSet = new Set(unshallow);
  // With no deepen, the old shallow boundary stays shallow (git re-reports
  // it on every fetch); with a deepen, the new boundary replaces it.
  const shallowOut = depth === null
    ? [...shallowSet].filter((oid) => !unshallowSet.has(oid)).sort()
    : [...boundary].sort();
  const acks = haves.filter((oid) => store.getObject(oid) !== undefined || store.getObject(store.peel(oid)) !== undefined);
  return { objects, shallow: shallowOut, unshallow, acks };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (chunks fit the pkt-line cap). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}
