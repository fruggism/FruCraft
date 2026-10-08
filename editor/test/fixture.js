/*
 * A small synthetic save for the Cantiere tests: a 1.20.1 world with one
 * region, a few chunks that carry the awkward things a real chunk has
 * (heightmaps, light, a block entity, tags of every type, keys we don't know),
 * and a level.dat with game rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TAG, TByte, TFloat, TDouble, TShort, TLong, TList, TIntArray } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';
import { packIndices, heightmapBits } from '../core/chunk.js';
import { RegionData, writeRegionFile } from '../core/region.js';

export const DATA_VERSION = 3465;
export const CHUNKS = [[0, 0], [1, 0], [0, 1], [1, 1]];

const pal = (...names) => new TList(TAG.Compound, names.map((n) => (typeof n === 'string' ? { Name: n } : n)));

function section(sy, palette, indices) {
  const bs = { palette: pal(...palette) };
  if (palette.length > 1) bs.data = packIndices(indices, Math.max(4, Math.ceil(Math.log2(palette.length))), true);
  return {
    Y: new TByte(sy),
    block_states: bs,
    biomes: { palette: new TList(TAG.String, ['minecraft:plains']) },
    SkyLight: new Int8Array(2048).fill(-1),
    BlockLight: new Int8Array(2048),
  };
}

export function makeChunk(cx, cz) {
  const stone = new Uint16Array(4096);
  const top = new Uint16Array(4096); // palette: stone, grass_block, chest, air
  for (let i = 0; i < 4096; i++) {
    const ly = i >> 8;
    top[i] = ly < 7 ? 0 : ly === 7 ? 1 : 3;
  }
  top[(8 << 8) | (5 << 4) | 5] = 2; // chest at local (5, y40, 5)
  const hm = packIndices(new Uint16Array(256).fill(105), heightmapBits(384), true);
  return {
    DataVersion: DATA_VERSION,
    xPos: cx, zPos: cz, yPos: -4,
    Status: 'minecraft:full',
    LastUpdate: 1000n,
    InhabitedTime: 12345n,
    isLightOn: new TByte(1),
    sections: new TList(TAG.Compound, [
      section(0, ['minecraft:stone'], stone),
      section(1, ['minecraft:stone'], stone),
      section(2, ['minecraft:stone', 'minecraft:grass_block', 'minecraft:chest', 'minecraft:air'], top),
      section(3, ['minecraft:air'], stone),
    ]),
    block_entities: new TList(TAG.Compound, cx === 0 && cz === 0
      ? [{ id: 'minecraft:chest', x: 5, y: 40, z: 5, keepPacked: new TByte(0), Items: new TList(TAG.End, []) }]
      : []),
    block_ticks: new TList(TAG.End, []),
    fluid_ticks: new TList(TAG.End, []),
    Heightmaps: {
      MOTION_BLOCKING: hm, MOTION_BLOCKING_NO_LEAVES: hm, OCEAN_FLOOR: hm, WORLD_SURFACE: hm,
    },
    structures: { starts: {}, References: {} },
    PostProcessing: new TList(TAG.List, []),
    // Things a mod or a future version might add: all must come back identical.
    mod_data: {
      f: new TFloat(1.5), d: new TDouble(2.25), s: new TShort(-300), l: new TLong(1n << 40n),
      bytes: new Int8Array([1, -2, 3]), ints: new TIntArray([7, 8, 9]),
      nested: new TList(TAG.Compound, [{ a: new TByte(1) }, { a: new TByte(2) }]),
      empty: new TList(TAG.End, []),
      listOfLists: new TList(TAG.List, [new TList(TAG.Int, [1, 2]), new TList(TAG.Int, [])]),
    },
  };
}

/** Build <savesDir>/<name> with level.dat and region/r.0.0.mca. Returns the world dir. */
export function makeWorld(savesDir, name = 'Prova') {
  const dir = path.join(savesDir, name);
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  const region = new RegionData(0, 0);
  for (const [cx, cz] of CHUNKS) region.setChunk(cx, cz, makeChunk(cx, cz), '', 1700000000);
  writeRegionFile(path.join(dir, 'region', 'r.0.0.mca'), region);
  const level = {
    Data: {
      LevelName: name,
      DataVersion: DATA_VERSION,
      version: 19133,
      SpawnX: 8, SpawnY: 41, SpawnZ: 8, SpawnAngle: new TFloat(0),
      Time: new TLong(5000n), DayTime: new TLong(6000n),
      raining: new TByte(0), rainTime: 0, thundering: new TByte(0), thunderTime: 0,
      GameRules: { doDaylightCycle: 'true', randomTickSpeed: '3', keepInventory: 'false' },
      Version: { Name: '1.20.1', Id: DATA_VERSION, Snapshot: new TByte(0) },
    },
  };
  fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(Buffer.from(writeNbt(level, ''))));
  fs.mkdirSync(path.join(dir, 'playerdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playerdata', 'x.dat'), 'dati del giocatore');
  return dir;
}
