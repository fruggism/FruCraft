'use strict';
/*
 * Minimal NBT (Named Binary Tag) reader/writer for Minecraft Java Edition.
 * Supports both gzip and zlib compressed buffers (region-file chunk payloads
 * are zlib; some other files, e.g. level.dat, are gzip).
 *
 * Decoded shape: { name, value } where value is a plain JS tree:
 *   TAG_Byte/Short/Int/Float/Double -> number
 *   TAG_Long                        -> BigInt
 *   TAG_String                      -> string
 *   TAG_ByteArray                   -> Int8Array
 *   TAG_IntArray                    -> Int32Array
 *   TAG_LongArray                   -> BigInt64Array
 *   TAG_List                        -> Array (each element already unwrapped)
 *   TAG_Compound                    -> plain object { key: value, ... }
 * (Type information beyond this is not needed by this project, so it is not
 * preserved on decode. The writer below infers types from JS values / a
 * small set of wrapper classes for the ambiguous cases used by test fixtures.)
 */

const zlib = require('zlib');

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};

function isGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}
function isZlib(buf) {
  return buf.length > 2 && buf[0] === 0x78;
}

function decompress(buf) {
  if (isGzip(buf)) return zlib.gunzipSync(buf);
  if (isZlib(buf)) return zlib.inflateSync(buf);
  return buf; // uncompressed
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }
  byte() { const v = this.buf.readInt8(this.off); this.off += 1; return v; }
  ubyte() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  short() { const v = this.buf.readInt16BE(this.off); this.off += 2; return v; }
  int() { const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
  long() { const v = this.buf.readBigInt64BE(this.off); this.off += 8; return v; }
  float() { const v = this.buf.readFloatBE(this.off); this.off += 4; return v; }
  double() { const v = this.buf.readDoubleBE(this.off); this.off += 8; return v; }
  string() {
    const len = this.buf.readUInt16BE(this.off); this.off += 2;
    const s = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len;
    return s;
  }
  bytes(n) { const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
}

function readTagPayload(r, type) {
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
      for (let i = 0; i < len; i++) out[i] = readTagPayload(r, itemType);
      out.__listType = itemType;
      return out;
    }
    case TAG.Compound: {
      const obj = {};
      for (;;) {
        const t = r.ubyte();
        if (t === TAG.End) break;
        const name = r.string();
        obj[name] = readTagPayload(r, t);
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
      throw new Error(`Unsupported/unknown NBT tag type ${type} at offset ${r.off}`);
  }
}

function parse(buf) {
  const raw = decompress(buf);
  const r = new Reader(raw);
  const rootType = r.ubyte();
  if (rootType === TAG.End) return { name: '', value: {} };
  const name = r.string();
  const value = readTagPayload(r, rootType);
  return { name, value };
}

// ---------------------------------------------------------------------------
// Writer (used only by the synthetic test-world generator).
// ---------------------------------------------------------------------------

class Writer {
  constructor() { this.chunks = []; }
  push(buf) { this.chunks.push(buf); }
  byte(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.push(b); }
  ubyte(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this.push(b); }
  short(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.push(b); }
  int(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.push(b); }
  long(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.push(b); }
  float(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.push(b); }
  double(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.push(b); }
  string(s) {
    const sb = Buffer.from(s, 'utf8');
    const lb = Buffer.alloc(2); lb.writeUInt16BE(sb.length);
    this.push(lb); this.push(sb);
  }
  concat() { return Buffer.concat(this.chunks); }
}

// Explicit typed wrappers so the test-world generator can disambiguate
// numeric NBT types (JS only has one "number").
class TLong { constructor(v) { this.v = BigInt(v); } }
class TFloat { constructor(v) { this.v = v; } }
class TDouble { constructor(v) { this.v = v; } }
class TByte { constructor(v) { this.v = v; } }
class TShort { constructor(v) { this.v = v; } }
class TIntArray { constructor(v) { this.v = Int32Array.from(v); } }
class TLongArray { constructor(v) { this.v = BigInt64Array.from(v.map(BigInt)); } }
class TList { constructor(itemType, items) { this.itemType = itemType; this.items = items; } }

function inferTypeAndWrite(w, val) {
  if (val instanceof TLong) { w.ubyte(TAG.Long); w.long(val.v); return; }
  if (val instanceof TFloat) { w.ubyte(TAG.Float); w.float(val.v); return; }
  if (val instanceof TDouble) { w.ubyte(TAG.Double); w.double(val.v); return; }
  if (val instanceof TByte) { w.ubyte(TAG.Byte); w.byte(val.v); return; }
  if (val instanceof TShort) { w.ubyte(TAG.Short); w.short(val.v); return; }
  if (val instanceof TIntArray) {
    w.ubyte(TAG.IntArray); w.int(val.v.length);
    for (const x of val.v) w.int(x);
    return;
  }
  if (val instanceof TLongArray) {
    w.ubyte(TAG.LongArray); w.int(val.v.length);
    for (const x of val.v) w.long(x);
    return;
  }
  if (val instanceof TList) {
    w.ubyte(TAG.List);
    w.ubyte(val.itemType);
    w.int(val.items.length);
    for (const item of val.items) writePayloadOnly(w, val.itemType, item);
    return;
  }
  if (typeof val === 'string') { w.ubyte(TAG.String); w.string(val); return; }
  if (typeof val === 'number') { w.ubyte(TAG.Int); w.int(val | 0); return; }
  if (typeof val === 'object' && val !== null) {
    w.ubyte(TAG.Compound);
    writeCompoundBody(w, val);
    return;
  }
  throw new Error(`Cannot infer NBT type for value: ${val}`);
}

function writePayloadOnly(w, type, val) {
  switch (type) {
    case TAG.Byte: w.byte(val instanceof TByte ? val.v : val); return;
    case TAG.Short: w.short(val instanceof TShort ? val.v : val); return;
    case TAG.Int: w.int(val); return;
    case TAG.Long: w.long(val instanceof TLong ? val.v : val); return;
    case TAG.Float: w.float(val instanceof TFloat ? val.v : val); return;
    case TAG.Double: w.double(val instanceof TDouble ? val.v : val); return;
    case TAG.String: w.string(val); return;
    case TAG.Compound: writeCompoundBody(w, val); return;
    case TAG.List: {
      w.ubyte(val.itemType); w.int(val.items.length);
      for (const item of val.items) writePayloadOnly(w, val.itemType, item);
      return;
    }
    default: throw new Error(`writePayloadOnly: unsupported type ${type}`);
  }
}

function writeCompoundBody(w, obj) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const nameBuf = Buffer.from(key, 'utf8');
    // We need the tag type byte before the name; inferTypeAndWrite writes
    // [typeByte] directly, so emit name in between via a small trick:
    // write type first, then name, then payload.
    const tmp = new Writer();
    inferTypeAndWrite(tmp, val);
    const full = tmp.concat();
    w.push(full.subarray(0, 1)); // type byte
    w.string(key);
    w.push(full.subarray(1)); // payload
  }
  w.ubyte(TAG.End);
}

function build(name, rootObj) {
  const w = new Writer();
  w.ubyte(TAG.Compound);
  w.string(name);
  writeCompoundBody(w, rootObj);
  return w.concat();
}

function gzip(buf) { return zlib.gzipSync(buf); }
function deflate(buf) { return zlib.deflateSync(buf); }

module.exports = {
  TAG, parse, build, gzip, deflate,
  TLong, TFloat, TDouble, TByte, TShort, TIntArray, TLongArray, TList,
};
