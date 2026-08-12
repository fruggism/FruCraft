/*
 * NBT writer, used only to build the synthetic world saves the test suite
 * runs against. The app itself never writes NBT, so this lives with the
 * fixtures rather than in the shared core.
 */

import zlib from 'node:zlib';

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};

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

export {
  TAG, build, gzip, deflate,
  TLong, TFloat, TDouble, TByte, TShort, TIntArray, TLongArray, TList,
};
