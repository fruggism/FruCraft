/*
 * A zip built by hand, for testing the reader in web/js/pack/zip.js.
 *
 * Node has no zip writer, and the point here is to exercise our reader
 * against both storage methods — stored and deflated — without depending on
 * a real Minecraft jar being installed. The CRC field is left at zero: the
 * reader does not check it, and nothing else ever opens these bytes.
 */

import zlib from 'node:zlib';

export function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const compress = deflated.length < data.length;
    const body = compress ? deflated : data;
    const method = compress ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

/** A Buffer as the byte source ZipReader.open() expects. */
export const bufferSource = (buffer) => ({
  size: buffer.length,
  async slice(start, end) { return new Uint8Array(buffer.subarray(start, end)); },
});
