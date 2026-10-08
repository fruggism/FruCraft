/*
 * NBT writer for the synthetic world saves the test suite runs against.
 * The writer itself is part of the shared core (web/js/core/nbtWrite.js);
 * this file only adds the Node-side conveniences the fixtures were built on.
 */

import zlib from 'node:zlib';
import { writeNbt } from '../web/js/core/nbtWrite.js';

export {
  TAG, TLong, TFloat, TDouble, TByte, TShort, TIntArray, TLongArray, TList,
} from '../web/js/core/nbtWrite.js';

const build = (name, rootObj) => Buffer.from(writeNbt(rootObj, name));
const gzip = (buf) => zlib.gzipSync(buf);
const deflate = (buf) => zlib.deflateSync(buf);

export { build, gzip, deflate };
