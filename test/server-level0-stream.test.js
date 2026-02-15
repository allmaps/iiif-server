const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRegion,
  parseSize,
  parseIiifRoute,
  findJpegTileMatch,
  parseSizeMode,
  buildJpegParts,
  needsEdgeTranscode,
  edgeCropRect,
  buildSizes,
  infoJsonV2,
  infoJsonV3,
} = require('../server-level0-stream');

test('parseRegion requires numeric region', () => {
  assert.deepEqual(parseRegion('full', 100, 100), { x: 0, y: 0, w: 100, h: 100, isFull: true });
  assert.deepEqual(parseRegion('0,0,256,256', 1000, 1000), { x: 0, y: 0, w: 256, h: 256, isFull: false });
});

test('parseSize supports full, w,h, w, and ,h', () => {
  assert.deepEqual(parseSize('full', 300, 200), { w: 300, h: 200 });
  assert.deepEqual(parseSize('256,256', 300, 200), { w: 256, h: 256 });
  assert.deepEqual(parseSize('150,', 300, 200), { w: 150, h: 100 });
  assert.deepEqual(parseSize(',150', 300, 200), { w: 225, h: 150 });
  assert.throws(() => parseSize('max', 300, 200), /Only full/);
});

test('parseSizeMode detects constrained-dimension size forms', () => {
  assert.equal(parseSizeMode('full'), 'full');
  assert.equal(parseSizeMode('200,150'), 'exact');
  assert.equal(parseSizeMode('200,'), 'w');
  assert.equal(parseSizeMode(',150'), 'h');
});

test('parseIiifRoute supports /iiif/2 and /iiif/3 prefixes', () => {
  assert.deepEqual(parseIiifRoute('/iiif/2/id/info.json'), {
    version: 2,
    parts: ['id', 'info.json'],
    prefix: '/iiif/2',
  });
  assert.deepEqual(parseIiifRoute('/iiif/3/id/info.json'), {
    version: 3,
    parts: ['id', 'info.json'],
    prefix: '/iiif/3',
  });
  assert.deepEqual(parseIiifRoute('/id/info.json'), {
    version: null,
    parts: ['id', 'info.json'],
    prefix: '',
  });
});

test('findJpegTileMatch returns matching tile for aligned request', () => {
  const source = {
    width: 1024,
    height: 1024,
    pages: [
      {
        scale: 1,
        width: 1024,
        height: 1024,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 4,
        tileOffsets: new Array(16).fill(1000).map((v, i) => v + i * 10),
        tileByteCounts: new Array(16).fill(10),
        compression: 7,
      },
    ],
  };

  const match = findJpegTileMatch(source, { x: 256, y: 512, w: 256, h: 256, isFull: false }, { w: 256, h: 256 });
  assert.ok(match);
  assert.equal(match.tileIndex, 9);
});

test('findJpegTileMatch rejects non-native sizing', () => {
  const source = {
    width: 1024,
    height: 1024,
    pages: [
      {
        scale: 1,
        width: 1024,
        height: 1024,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 4,
        tileOffsets: new Array(16).fill(1000),
        tileByteCounts: new Array(16).fill(10),
        compression: 7,
      },
    ],
  };

  const match = findJpegTileMatch(source, { x: 0, y: 0, w: 256, h: 256, isFull: false }, { w: 200, h: 200 });
  assert.equal(match, null);
});

test('findJpegTileMatch accepts right-edge partial tile at scale 1', () => {
  const source = {
    width: 1000,
    height: 1000,
    pages: [
      {
        scale: 1,
        width: 1000,
        height: 1000,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 4,
        tileOffsets: new Array(16).fill(1000),
        tileByteCounts: new Array(16).fill(10),
        compression: 7,
      },
    ],
  };

  const match = findJpegTileMatch(source, { x: 768, y: 0, w: 232, h: 256, isFull: false }, { w: 232, h: 256 });
  assert.ok(match);
  assert.equal(match.outWidth, 232);
  assert.equal(match.outHeight, 256);
});

test('findJpegTileMatch accepts bottom-edge partial tile at scale 2', () => {
  const source = {
    width: 1000,
    height: 1000,
    pages: [
      {
        scale: 1,
        width: 1000,
        height: 1000,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 4,
        tileOffsets: new Array(16).fill(1000),
        tileByteCounts: new Array(16).fill(10),
        compression: 7,
      },
      {
        scale: 2,
        width: 500,
        height: 500,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 2,
        tileOffsets: new Array(4).fill(2000),
        tileByteCounts: new Array(4).fill(10),
        compression: 7,
      },
    ],
  };

  // For s=2, bottom tile starts at y=512 and has region h=488, output h=244.
  const match = findJpegTileMatch(source, { x: 0, y: 512, w: 512, h: 488, isFull: false }, { w: 256, h: 244 });
  assert.ok(match);
  assert.equal(match.page.scale, 2);
  assert.equal(match.outWidth, 256);
  assert.equal(match.outHeight, 244);
});

test('findJpegTileMatch supports full region only for single-tile page size', () => {
  const source = {
    width: 1024,
    height: 1024,
    pages: [
      {
        scale: 1,
        width: 1024,
        height: 1024,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 4,
        tilesDown: 4,
        tileOffsets: new Array(16).fill(1000),
        tileByteCounts: new Array(16).fill(10),
        compression: 7,
      },
      {
        scale: 8,
        width: 128,
        height: 128,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 1,
        tilesDown: 1,
        tileOffsets: [2000],
        tileByteCounts: [20],
        compression: 7,
      },
    ],
  };

  const ok = findJpegTileMatch(source, { x: 0, y: 0, w: 1024, h: 1024, isFull: true }, { w: 128, h: 128 });
  assert.ok(ok);
  assert.equal(ok.tileIndex, 0);

  const reject = findJpegTileMatch(source, { x: 0, y: 0, w: 1024, h: 1024, isFull: true }, { w: 1024, h: 1024 });
  assert.equal(reject, null);
});

test('findJpegTileMatch accepts width-only form for canonical tile height', () => {
  const source = {
    width: 39125,
    height: 34708,
    pages: [
      {
        scale: 32,
        width: 1222,
        height: 1084,
        tileWidth: 256,
        tileHeight: 256,
        tilesAcross: 5,
        tilesDown: 5,
        tileOffsets: new Array(25).fill(1000),
        tileByteCounts: new Array(25).fill(10),
        compression: 7,
      },
    ],
  };

  const region = { x: 32768, y: 0, w: 6357, h: 8192, isFull: false };
  const sizeFromW = { w: 199, h: 1026 }; // parseSize('199,', 6357, 8192)

  const match = findJpegTileMatch(source, region, sizeFromW, 'w');
  assert.ok(match);
  assert.equal(match.outWidth, 199);
  assert.equal(match.outHeight, 256);
});

test('needsEdgeTranscode detects edge-sized output mismatch', () => {
  const base = {
    outWidth: 256,
    outHeight: 256,
    page: { tileWidth: 256, tileHeight: 256 },
  };
  assert.equal(needsEdgeTranscode(base), false);
  assert.equal(needsEdgeTranscode({ ...base, outWidth: 199 }), true);
  assert.equal(needsEdgeTranscode({ ...base, outHeight: 148 }), true);
});

test('edgeCropRect crops padded right/bottom pixels', () => {
  const rect = edgeCropRect({
    outWidth: 199,
    outHeight: 148,
    page: { tileWidth: 256, tileHeight: 256 },
  });
  assert.deepEqual(rect, { left: 0, top: 0, width: 199, height: 148 });
});

test('buildJpegParts strips duplicate markers when tables exist', () => {
  const jpegTables = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const parts = buildJpegParts(Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xd9]), jpegTables);

  assert.equal(parts.prefix[0], 0xff);
  assert.equal(parts.prefix[1], 0xd8);
  assert.equal(parts.skipStart, 2);
  assert.equal(parts.skipEnd, 2);
  assert.deepEqual([...parts.suffix], [0xff, 0xd9]);
});

test('buildSizes and versioned info.json include sizes', () => {
  const source = {
    width: 1024,
    height: 768,
    pages: [
      { width: 1024, height: 768, tileWidth: 256, tileHeight: 256, scale: 1, tilesAcross: 4, tilesDown: 3, compression: 7 },
      { width: 512, height: 384, tileWidth: 256, tileHeight: 256, scale: 2, tilesAcross: 2, tilesDown: 2, compression: 7 },
      { width: 256, height: 192, tileWidth: 256, tileHeight: 256, scale: 4, tilesAcross: 1, tilesDown: 1, compression: 7 },
    ],
  };

  const sizes = buildSizes(source);
  assert.deepEqual(sizes, [{ width: 256, height: 192 }]);

  const v2 = infoJsonV2('http://x/iiif/2/id', source);
  assert.equal(v2['@context'], 'http://iiif.io/api/image/2/context.json');
  assert.deepEqual(v2.sizes, sizes);
  assert.equal(v2['@id'], 'http://x/iiif/2/id');

  const v3 = infoJsonV3('http://x/iiif/3/id', source);
  assert.equal(v3['@context'], 'http://iiif.io/api/image/3/context.json');
  assert.deepEqual(v3.sizes, sizes);
  assert.equal(v3.id, 'http://x/iiif/3/id');
});
