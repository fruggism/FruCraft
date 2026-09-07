/*
 * Reading a .jar (or a resource pack .zip) without unpacking it.
 *
 * A jar is a zip, and a zip is readable back-to-front: the directory of what
 * is inside sits at the end of the file. So instead of loading forty megabytes
 * to get four hundred small PNGs, we read the last few kilobytes, look up the
 * entries we want and fetch only those bytes.
 *
 * Decompression is the platform's own DecompressionStream('deflate-raw') —
 * the same reason nbt.js needs no inflate library, and the reason this file
 * has no dependencies either.
 *
 * The source is anything that can answer "give me bytes from x to y": a File
 * in the browser, a file descriptor in the tests.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const utf8 = new TextDecoder('utf-8');

/** A File (or Blob) as a byte source. */
export const blobSource = (file) => ({
  size: file.size,
  async slice(start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  },
});

async function inflateRaw(bytes) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = stream.readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export class ZipReader {
  constructor(source, entries) {
    this.source = source;
    this.entries = entries;
  }

  /**
   * Read the end-of-central-directory record, then the directory itself.
   * The comment at the very end has no length field of its own, so the
   * record is found by scanning backwards for its signature — which is what
   * every zip reader does.
   */
  static async open(source) {
    const tailLength = Math.min(source.size, EOCD_MIN + MAX_COMMENT);
    const tail = await source.slice(source.size - tailLength, source.size);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tailView.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Non sembra un file .jar o .zip');

    const count = tailView.getUint16(eocd + 10, true);
    const dirSize = tailView.getUint32(eocd + 12, true);
    const dirOffset = tailView.getUint32(eocd + 16, true);
    if (dirOffset === 0xffffffff || count === 0xffff) {
      throw new Error('Archivio in formato ZIP64: non supportato');
    }

    const dir = await source.slice(dirOffset, dirOffset + dirSize);
    const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries = new Map();
    let at = 0;
    while (at + 46 <= dir.length && view.getUint32(at, true) === CD_SIG) {
      const method = view.getUint16(at + 10, true);
      const compressed = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const offset = view.getUint32(at + 42, true);
      const name = utf8.decode(dir.subarray(at + 46, at + 46 + nameLength));
      if (!name.endsWith('/')) entries.set(name, { method, compressed, size, offset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipReader(source, entries);
  }

  has(name) { return this.entries.has(name); }

  /** Entry names under a prefix — used to enumerate the block textures. */
  *names(prefix = '') {
    for (const name of this.entries.keys()) {
      if (name.startsWith(prefix)) yield name;
    }
  }

  /** @returns {Promise<Uint8Array|null>} */
  async read(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    // The local header repeats the name and may carry a different extra
    // field, so its length has to be read rather than assumed.
    const head = await this.source.slice(entry.offset, entry.offset + 30);
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (headView.getUint32(0, true) !== LOCAL_SIG) return null;
    const start = entry.offset + 30
      + headView.getUint16(26, true) + headView.getUint16(28, true);
    const raw = await this.source.slice(start, start + entry.compressed);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error(`Compressione zip non supportata: ${entry.method}`);
    return inflateRaw(raw);
  }

  async readJSON(name) {
    const bytes = await this.read(name);
    if (!bytes) return null;
    try {
      return JSON.parse(utf8.decode(bytes));
    } catch {
      return null;
    }
  }
}
