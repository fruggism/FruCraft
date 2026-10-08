/*
 * NBT writer, the counterpart of nbt.js.
 *
 * Pure and dependency-free like the reader, so it runs in Node and in the
 * browser alike; compressing the result is the caller's job.
 *
 * What it accepts:
 *   - a tree parsed with { typed: true }, which round-trips byte for byte
 *     (same tag types, same list element types, same key order);
 *   - a hand-built tree, where JS values are mapped like this:
 *       number -> Int, bigint -> Long, string -> String, plain object -> Compound,
 *       Array -> List (element type taken from the first item; empty -> End),
 *       Int8Array -> ByteArray, Int32Array -> IntArray, BigInt64Array -> LongArray,
 *     and the T* wrappers from nbt.js say anything else (Byte, Short, Float, ...).
 */

import {
  TAG, TLong, TFloat, TDouble, TByte, TShort, TIntArray, TLongArray, TList,
} from './nbt.js';

export {
  TAG, TLong, TFloat, TDouble, TByte, TShort, TIntArray, TLongArray, TList,
};

const utf8 = new TextEncoder();

class Writer {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  ubyte(v) { this.ensure(1); this.view.setUint8(this.len, v); this.len += 1; }
  byte(v) { this.ensure(1); this.view.setInt8(this.len, v); this.len += 1; }
  short(v) { this.ensure(2); this.view.setInt16(this.len, v); this.len += 2; }
  int(v) { this.ensure(4); this.view.setInt32(this.len, v); this.len += 4; }
  long(v) { this.ensure(8); this.view.setBigInt64(this.len, BigInt.asIntN(64, BigInt(v))); this.len += 8; }
  float(v) { this.ensure(4); this.view.setFloat32(this.len, v); this.len += 4; }
  double(v) { this.ensure(8); this.view.setFloat64(this.len, v); this.len += 8; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  string(s) {
    const sb = utf8.encode(s);
    if (sb.length > 0xffff) throw new Error('Stringa NBT troppo lunga');
    this.ensure(2 + sb.length);
    this.view.setUint16(this.len, sb.length);
    this.len += 2;
    this.bytes(sb);
  }
  result() { return this.buf.slice(0, this.len); }
}

/** The tag type a JS value will be written as. */
function typeOf(val) {
  if (val instanceof TByte) return TAG.Byte;
  if (val instanceof TShort) return TAG.Short;
  if (val instanceof TLong || typeof val === 'bigint') return TAG.Long;
  if (val instanceof TFloat) return TAG.Float;
  if (val instanceof TDouble) return TAG.Double;
  if (val instanceof TIntArray || val instanceof Int32Array) return TAG.IntArray;
  if (val instanceof TLongArray || val instanceof BigInt64Array) return TAG.LongArray;
  if (val instanceof Int8Array) return TAG.ByteArray;
  if (val instanceof TList || Array.isArray(val)) return TAG.List;
  if (typeof val === 'string') return TAG.String;
  if (typeof val === 'number') return TAG.Int;
  if (typeof val === 'object' && val !== null) return TAG.Compound;
  throw new Error(`Impossibile dedurre il tipo NBT di: ${String(val)}`);
}

const unwrap = (val) => (val !== null && typeof val === 'object' && 'v' in val && !(val instanceof TList) ? val.v : val);

function writePayload(w, type, val) {
  switch (type) {
    case TAG.Byte: w.byte(unwrap(val)); return;
    case TAG.Short: w.short(unwrap(val)); return;
    case TAG.Int: w.int(val); return;
    case TAG.Long: w.long(unwrap(val)); return;
    case TAG.Float: w.float(unwrap(val)); return;
    case TAG.Double: w.double(unwrap(val)); return;
    case TAG.String: w.string(val); return;
    case TAG.ByteArray:
      w.int(val.length);
      w.ensure(val.length);
      for (let i = 0; i < val.length; i++) w.byte(val[i]);
      return;
    case TAG.IntArray: {
      const arr = unwrap(val);
      w.int(arr.length);
      for (let i = 0; i < arr.length; i++) w.int(arr[i]);
      return;
    }
    case TAG.LongArray: {
      const arr = unwrap(val);
      w.int(arr.length);
      for (let i = 0; i < arr.length; i++) w.long(arr[i]);
      return;
    }
    case TAG.List: {
      let itemType;
      let items;
      if (val instanceof TList) { itemType = val.itemType; items = val.items; }
      else { items = val; itemType = items.length ? typeOf(items[0]) : TAG.End; }
      w.ubyte(itemType);
      w.int(items.length);
      for (const item of items) writePayload(w, itemType, item);
      return;
    }
    case TAG.Compound:
      for (const key of Object.keys(val)) {
        const v = val[key];
        const t = typeOf(v);
        w.ubyte(t);
        w.string(key);
        writePayload(w, t, v);
      }
      w.ubyte(TAG.End);
      return;
    default:
      throw new Error(`Tipo NBT non scrivibile: ${type}`);
  }
}

/** Serialize a root compound to uncompressed NBT bytes (Uint8Array). */
export function writeNbt(rootObj, name = '') {
  const w = new Writer();
  w.ubyte(TAG.Compound);
  w.string(name);
  writePayload(w, TAG.Compound, rootObj);
  return w.result();
}
