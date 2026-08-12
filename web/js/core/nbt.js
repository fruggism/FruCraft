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

function readPayload(r, type) {
  switch (type) {
    case TAG.Byte: return r.byte();
    case TAG.Short: return r.short();
    case TAG.Int: return r.int();
    case TAG.Long: return r.long();
    case TAG.Float: return r.float();
    case TAG.Double: return r.double();
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
      for (let i = 0; i < len; i++) out[i] = readPayload(r, itemType);
      return out;
    }
    case TAG.Compound: {
      const obj = {};
      for (;;) {
        const t = r.ubyte();
        if (t === TAG.End) break;
        obj[r.string()] = readPayload(r, t);
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
export function parseRaw(bytes) {
  const r = new Reader(bytes);
  const rootType = r.ubyte();
  if (rootType === TAG.End) return { name: '', value: {} };
  const name = r.string();
  return { name, value: readPayload(r, rootType) };
}

/** Parse NBT bytes, decompressing first when they are gzip/zlib. */
export async function parse(bytes) {
  return parseRaw(await decompress(bytes));
}
