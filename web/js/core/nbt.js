/*
 * NBT (Named Binary Tag) reader for Minecraft Java Edition.
 *
 * Runs unchanged in the browser, in a Web Worker and in Node: decompression
 * uses the platform's own DecompressionStream rather than a bundled inflate,
 * so there is no dependency to ship and no wasm to load.
 *
 * Decoded shape — a plain JS tree:
 *   Byte/Short/Int/Float/Double -> number
 *   Long                        -> BigInt
 *   String                      -> string
 *   ByteArray                   -> Int8Array
 *   IntArray                    -> Int32Array
 *   LongArray                   -> BigInt64Array
 *   List                        -> Array
 *   Compound                    -> plain object
 */

export const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};

/*
 * Typed wrappers. The plain decode above is lossy for a writer: a Byte, a
 * Short, a Float and a Double all come back as a bare number, and an empty
 * List forgets its element type. A caller that has to write a tree back
 * (the editor) parses with { typed: true }, which wraps exactly those values,
 * and also uses these classes to say what it means when it builds new tags.
 */
export class TLong { constructor(v) { this.v = BigInt(v); } }
export class TFloat { constructor(v) { this.v = v; } }
export class TDouble { constructor(v) { this.v = v; } }
export class TByte { constructor(v) { this.v = v; } }
export class TShort { constructor(v) { this.v = v; } }
export class TIntArray { constructor(v) { this.v = Int32Array.from(v); } }
export class TLongArray { constructor(v) { this.v = BigInt64Array.from(v.map(BigInt)); } }
export class TList { constructor(itemType, items) { this.itemType = itemType; this.items = items; } }

const utf8 = new TextDecoder('utf-8');

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZlib = (b) => b.length > 2 && b[0] === 0x78;

/**
 * Decompress with the platform stream API.
 *
 * The writer/reader pair is used directly rather than Blob().stream() +
 * Response: for the thousands of small chunk payloads a map render decodes,
 * the Blob/Response plumbing costs about three times as much as the actual
 * inflating.
 */
export async function decompressBytes(bytes, format) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();

  const reader = ds.readable.getReader();
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
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Inflate/gunzip if needed, based on the magic bytes. */
export async function decompress(bytes) {
  if (isGzip(bytes)) return decompressBytes(bytes, 'gzip');
  if (isZlib(bytes)) return decompressBytes(bytes, 'deflate');
  return bytes;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.off = 0;
  }
  byte() { return this.view.getInt8(this.off++); }
  ubyte() { return this.view.getUint8(this.off++); }
  short() { const v = this.view.getInt16(this.off); this.off += 2; return v; }
  int() { const v = this.view.getInt32(this.off); this.off += 4; return v; }
  long() { const v = this.view.getBigInt64(this.off); this.off += 8; return v; }
  float() { const v = this.view.getFloat32(this.off); this.off += 4; return v; }
  double() { const v = this.view.getFloat64(this.off); this.off += 8; return v; }
  string() {
    const len = this.view.getUint16(this.off);
    this.off += 2;
    const s = utf8.decode(this.bytes.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }
}

function readPayload(r, type, typed) {
  switch (type) {
    case TAG.Byte: return typed ? new TByte(r.byte()) : r.byte();
    case TAG.Short: return typed ? new TShort(r.short()) : r.short();
    case TAG.Int: return r.int();
    case TAG.Long: return r.long();
    case TAG.Float: return typed ? new TFloat(r.float()) : r.float();
    case TAG.Double: return typed ? new TDouble(r.double()) : r.double();
    case TAG.ByteArray: {
      const len = r.int();
      const out = new Int8Array(len);
      for (let i = 0; i < len; i++) out[i] = r.byte();
      return out;
    }
    case TAG.String: return r.string();
    case TAG.List: {
      const itemType = r.ubyte();
      const len = r.int();
      const out = new Array(len);
      for (let i = 0; i < len; i++) out[i] = readPayload(r, itemType, typed);
      return typed ? new TList(itemType, out) : out;
    }
    case TAG.Compound: {
      const obj = {};
      for (;;) {
        const t = r.ubyte();
        if (t === TAG.End) break;
        obj[r.string()] = readPayload(r, t, typed);
      }
      return obj;
    }
    case TAG.IntArray: {
      const len = r.int();
      const out = new Int32Array(len);
      for (let i = 0; i < len; i++) out[i] = r.int();
      return out;
    }
    case TAG.LongArray: {
      const len = r.int();
      const out = new BigInt64Array(len);
      for (let i = 0; i < len; i++) out[i] = r.long();
      return out;
    }
    default:
      throw new Error(`Tag NBT sconosciuto: ${type} (offset ${r.off})`);
  }
}

/** Parse already-decompressed NBT bytes. */
export function parseRaw(bytes, options = {}) {
  const r = new Reader(bytes);
  const rootType = r.ubyte();
  if (rootType === TAG.End) return { name: '', value: {} };
  const name = r.string();
  return { name, value: readPayload(r, rootType, !!options.typed) };
}

/** Parse NBT bytes, decompressing first when they are gzip/zlib. */
export async function parse(bytes, options = {}) {
  return parseRaw(await decompress(bytes), options);
}
