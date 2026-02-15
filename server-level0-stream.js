#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { PassThrough } = require("node:stream");

let sharpInstance;
function getSharp() {
  if (!sharpInstance) sharpInstance = require("sharp");
  return sharpInstance;
}

const TYPE_SIZES = new Map([
  [1, 1], // BYTE
  [2, 1], // ASCII
  [3, 2], // SHORT
  [4, 4], // LONG
  [5, 8], // RATIONAL
  [7, 1], // UNDEFINED
  [16, 8], // LONG8
  [18, 8], // IFD8
]);

function parseArgs(argv) {
  const opts = {
    containersDir: "containers",
    host: "127.0.0.1",
    port: 9000,
    tlsKey: null,
    tlsCert: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--containers-dir") opts.containersDir = argv[++i];
    else if (arg === "--host") opts.host = argv[++i];
    else if (arg === "--port") opts.port = Number(argv[++i]);
    else if (arg === "--tls-key") opts.tlsKey = argv[++i];
    else if (arg === "--tls-cert") opts.tlsCert = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node server-level0-stream.js [--containers-dir containers] [--host 127.0.0.1] [--port 9000] [--tls-key certs/dev.key --tls-cert certs/dev.crt]",
      );
      process.exit(0);
    }
  }

  if ((opts.tlsKey && !opts.tlsCert) || (!opts.tlsKey && opts.tlsCert)) {
    throw new Error("Provide both --tls-key and --tls-cert to enable HTTPS");
  }

  return opts;
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  if (body !== undefined) res.end(body);
  else res.end();
}

function redirect(res, location) {
  send(res, 302, { Location: location });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
    },
    body,
  );
}

function fail(res, status, msg) {
  send(res, status, { "Content-Type": "text/plain; charset=utf-8" }, msg);
}

function readU16(buf, off, le) {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}

function readU32(buf, off, le) {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}

function readU64(buf, off, le) {
  const v = le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Offset/value exceeds JS safe integer");
  return Number(v);
}

async function readExactly(fd, position, length) {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fd.read(
      out,
      done,
      length - done,
      position + done,
    );
    if (!bytesRead) throw new Error("Unexpected EOF");
    done += bytesRead;
  }
  return out;
}

async function parseIfd(fd, offset, le, bigTiff) {
  const countSize = bigTiff ? 8 : 2;
  const entrySize = bigTiff ? 20 : 12;
  const valueSize = bigTiff ? 8 : 4;

  const countBuf = await readExactly(fd, offset, countSize);
  const count = bigTiff ? readU64(countBuf, 0, le) : readU16(countBuf, 0, le);

  const entriesBuf = await readExactly(
    fd,
    offset + countSize,
    count * entrySize,
  );
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    const base = i * entrySize;
    const tag = readU16(entriesBuf, base, le);
    const type = readU16(entriesBuf, base + 2, le);
    const valueCount = bigTiff
      ? readU64(entriesBuf, base + 4, le)
      : readU32(entriesBuf, base + 4, le);
    const valueOffset = bigTiff
      ? readU64(entriesBuf, base + 12, le)
      : readU32(entriesBuf, base + 8, le);
    const inlineBytes = bigTiff
      ? entriesBuf.subarray(base + 12, base + 20)
      : entriesBuf.subarray(base + 8, base + 12);

    entries.set(tag, {
      tag,
      type,
      valueCount,
      valueOffset,
      inlineBytes,
      valueSize,
    });
  }

  const nextBuf = await readExactly(
    fd,
    offset + countSize + count * entrySize,
    valueSize,
  );
  const nextOffset = bigTiff
    ? readU64(nextBuf, 0, le)
    : readU32(nextBuf, 0, le);

  return { entries, nextOffset };
}

function decodeNumericValues(raw, type, count, le) {
  const out = [];
  let off = 0;
  for (let i = 0; i < count; i += 1) {
    if (type === 3) {
      out.push(readU16(raw, off, le));
      off += 2;
    } else if (type === 4) {
      out.push(readU32(raw, off, le));
      off += 4;
    } else if (type === 16 || type === 18) {
      out.push(readU64(raw, off, le));
      off += 8;
    } else if (type === 1 || type === 7) {
      out.push(raw[off]);
      off += 1;
    } else {
      throw new Error(`Unsupported TIFF field type ${type}`);
    }
  }
  return out;
}

async function readField(fd, entry, le) {
  const typeSize = TYPE_SIZES.get(entry.type);
  if (!typeSize) throw new Error(`Unsupported TIFF type ${entry.type}`);
  const byteLen = entry.valueCount * typeSize;
  if (byteLen <= entry.valueSize) {
    return entry.inlineBytes.subarray(0, byteLen);
  }
  return readExactly(fd, entry.valueOffset, byteLen);
}

async function readNumericField(fd, entries, tag, le, required = true) {
  const entry = entries.get(tag);
  if (!entry) {
    if (required) throw new Error(`Missing TIFF tag ${tag}`);
    return null;
  }
  const raw = await readField(fd, entry, le);
  return decodeNumericValues(raw, entry.type, entry.valueCount, le);
}

async function parseTiffPyramid(filePath) {
  const fd = await fsp.open(filePath, "r");
  try {
    const header = await readExactly(fd, 0, 16);
    const byteOrder = header.toString("ascii", 0, 2);
    const le = byteOrder === "II";
    if (!le && byteOrder !== "MM") throw new Error("Unsupported byte order");

    const magic = readU16(header, 2, le);
    const bigTiff = magic === 43;
    if (!bigTiff && magic !== 42) throw new Error("Not a TIFF/BigTIFF file");

    let firstIfd;
    if (bigTiff) {
      const offsetSize = readU16(header, 4, le);
      if (offsetSize !== 8) throw new Error("Unsupported BigTIFF offset size");
      firstIfd = readU64(header, 8, le);
    } else {
      firstIfd = readU32(header, 4, le);
    }

    const queue = [firstIfd];
    const visited = new Set();
    const pageIfds = [];

    while (queue.length > 0) {
      const off = queue.shift();
      if (!off || visited.has(off)) continue;
      visited.add(off);

      const ifd = await parseIfd(fd, off, le, bigTiff);
      const entries = ifd.entries;

      const widthArr = await readNumericField(fd, entries, 256, le, false);
      const heightArr = await readNumericField(fd, entries, 257, le, false);
      const tileWidthArr = await readNumericField(fd, entries, 322, le, false);
      const tileHeightArr = await readNumericField(fd, entries, 323, le, false);
      const compressionArr = await readNumericField(
        fd,
        entries,
        259,
        le,
        false,
      );

      if (
        widthArr &&
        heightArr &&
        tileWidthArr &&
        tileHeightArr &&
        compressionArr
      ) {
        const tileOffsets = await readNumericField(fd, entries, 324, le, true);
        const tileByteCounts = await readNumericField(
          fd,
          entries,
          325,
          le,
          true,
        );

        let jpegTables = null;
        if (entries.has(347)) {
          jpegTables = await readField(fd, entries.get(347), le);
        }

        pageIfds.push({
          width: widthArr[0],
          height: heightArr[0],
          tileWidth: tileWidthArr[0],
          tileHeight: tileHeightArr[0],
          compression: compressionArr[0],
          tileOffsets,
          tileByteCounts,
          jpegTables,
        });
      }

      const subIfds = await readNumericField(fd, entries, 330, le, false);
      if (subIfds) queue.push(...subIfds);
      if (ifd.nextOffset) queue.push(ifd.nextOffset);
    }

    if (!pageIfds.length) throw new Error("No tiled pages found in TIFF");

    pageIfds.sort((a, b) => b.width - a.width);
    const fullWidth = pageIfds[0].width;
    const fullHeight = pageIfds[0].height;

    const pages = pageIfds.map((p, idx) => {
      const tilesAcross = Math.ceil(p.width / p.tileWidth);
      const tilesDown = Math.ceil(p.height / p.tileHeight);
      return {
        ...p,
        level: idx,
        scale: 2 ** idx,
        tilesAcross,
        tilesDown,
      };
    });

    return {
      filePath,
      width: fullWidth,
      height: fullHeight,
      pages,
    };
  } finally {
    await fd.close();
  }
}

function parseRegion(raw, imageWidth, imageHeight) {
  if (raw === "full") {
    return {
      x: 0,
      y: 0,
      w: imageWidth,
      h: imageHeight,
      isFull: true,
    };
  }

  const m = raw.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  if (!m)
    throw new Error("Only region=full or pixel region x,y,w,h is supported");

  const x = Number(m[1]);
  const y = Number(m[2]);
  const w = Number(m[3]);
  const h = Number(m[4]);

  if (w <= 0 || h <= 0) throw new Error("Invalid region dimensions");
  if (x >= imageWidth || y >= imageHeight)
    throw new Error("Region out of bounds");

  return {
    x,
    y,
    w: Math.min(w, imageWidth - x),
    h: Math.min(h, imageHeight - y),
    isFull: false,
  };
}

function parseSize(raw, regionW, regionH) {
  if (raw === "full") return { w: regionW, h: regionH };

  let m = raw.match(/^(\d+),(\d+)$/);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };

  m = raw.match(/^(\d+),$/);
  if (m) {
    const w = Number(m[1]);
    if (w <= 0) throw new Error("Invalid size");
    return { w, h: Math.max(1, Math.round(regionH * (w / regionW))) };
  }

  m = raw.match(/^,(\d+)$/);
  if (m) {
    const h = Number(m[1]);
    if (h <= 0) throw new Error("Invalid size");
    return { w: Math.max(1, Math.round(regionW * (h / regionH))), h };
  }

  throw new Error("Only full, w,h, w, or ,h size forms are supported");
}

function parseSizeMode(raw) {
  if (raw === "full") return "full";
  if (/^\d+,\d+$/.test(raw)) return "exact";
  if (/^\d+,$/.test(raw)) return "w";
  if (/^,\d+$/.test(raw)) return "h";
  return "unknown";
}

function sizeMatches(expectedW, expectedH, size, sizeMode) {
  if (sizeMode === "w") return size.w === expectedW;
  if (sizeMode === "h") return size.h === expectedH;
  return size.w === expectedW && size.h === expectedH;
}

function findJpegTileMatch(source, region, size, sizeMode = "exact") {
  if (region.isFull) {
    for (const page of source.pages) {
      if (!sizeMatches(page.width, page.height, size, sizeMode)) continue;
      if (page.compression !== 7) continue; // JPEG
      if (page.tilesAcross !== 1 || page.tilesDown !== 1) continue;
      if (!page.tileOffsets.length || !page.tileByteCounts.length) continue;

      return {
        page,
        tileIndex: 0,
        offset: page.tileOffsets[0],
        byteCount: page.tileByteCounts[0],
        outWidth: page.width,
        outHeight: page.height,
      };
    }
    return null;
  }

  for (const page of source.pages) {
    const s = page.scale;
    const scaledTileW = page.tileWidth * s;
    const scaledTileH = page.tileHeight * s;

    if (region.x % scaledTileW || region.y % scaledTileH) continue;

    // IIIF Image 3.0 implementation note algorithm for edge tiles.
    const expectedRegionW = Math.min(scaledTileW, source.width - region.x);
    const expectedRegionH = Math.min(scaledTileH, source.height - region.y);
    if (region.w !== expectedRegionW || region.h !== expectedRegionH) continue;

    let expectedSizeW = page.tileWidth;
    if (region.x + scaledTileW > source.width) {
      expectedSizeW = Math.ceil((source.width - region.x) / s);
    }

    let expectedSizeH = page.tileHeight;
    if (region.y + scaledTileH > source.height) {
      expectedSizeH = Math.ceil((source.height - region.y) / s);
    }

    if (!sizeMatches(expectedSizeW, expectedSizeH, size, sizeMode)) continue;

    const tileX = region.x / scaledTileW;
    const tileY = region.y / scaledTileH;
    const tileIndex = tileY * page.tilesAcross + tileX;

    if (tileIndex < 0 || tileIndex >= page.tileOffsets.length) continue;
    if (page.compression !== 7) continue; // JPEG

    return {
      page,
      tileIndex,
      offset: page.tileOffsets[tileIndex],
      byteCount: page.tileByteCounts[tileIndex],
      outWidth: expectedSizeW,
      outHeight: expectedSizeH,
    };
  }

  return null;
}

function hasMarker(buf, marker, atStart) {
  if (buf.length < 2) return false;
  if (atStart) return buf[0] === marker[0] && buf[1] === marker[1];
  return buf[buf.length - 2] === marker[0] && buf[buf.length - 1] === marker[1];
}

function buildJpegParts(tileFirst2, tileLast2, jpegTables) {
  const SOI = [0xff, 0xd8];
  const EOI = [0xff, 0xd9];

  const tileHasSoi = hasMarker(tileFirst2, SOI, true);
  const tileHasEoi = hasMarker(tileLast2, EOI, true);

  if (!jpegTables || jpegTables.length < 2) {
    return {
      prefix: Buffer.alloc(0),
      skipStart: 0,
      skipEnd: 0,
      suffix: Buffer.alloc(0),
    };
  }

  const tablesHasSoi = hasMarker(jpegTables.subarray(0, 2), SOI, true);
  const tablesHasEoi = hasMarker(
    jpegTables.subarray(jpegTables.length - 2),
    EOI,
    true,
  );

  let prefix = jpegTables;
  if (tablesHasEoi) prefix = prefix.subarray(0, prefix.length - 2);

  return {
    prefix,
    skipStart: tileHasSoi ? 2 : 0,
    skipEnd: tileHasEoi ? 2 : 0,
    suffix: Buffer.from(EOI),
    tablesHasSoi,
  };
}

async function streamJpegTile(res, source, match) {
  const fd = await fsp.open(source.filePath, "r");
  try {
    const tileFirst2 = await readExactly(
      fd,
      match.offset,
      Math.min(2, match.byteCount),
    );
    const tileLast2 =
      match.byteCount >= 2
        ? await readExactly(fd, match.offset + match.byteCount - 2, 2)
        : Buffer.alloc(0);

    const parts = buildJpegParts(tileFirst2, tileLast2, match.page.jpegTables);

    const tileStart = match.offset + parts.skipStart;
    const tileLength = Math.max(
      0,
      match.byteCount - parts.skipStart - parts.skipEnd,
    );
    const contentLength =
      parts.prefix.length + tileLength + parts.suffix.length;

    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "image/jpeg",
      "Content-Length": contentLength,
      "Cache-Control": "public, max-age=31536000, immutable",
    });

    const out = new PassThrough();
    out.pipe(res);

    if (parts.prefix.length) out.write(parts.prefix);

    const tileStream = fs.createReadStream(source.filePath, {
      start: tileStart,
      end: tileStart + tileLength - 1,
    });

    tileStream.on("error", () => {
      out.destroy();
    });

    tileStream.on("end", () => {
      if (parts.suffix.length) out.write(parts.suffix);
      out.end();
    });

    tileStream.pipe(out, { end: false });
  } finally {
    await fd.close();
  }
}

async function readJpegTileBuffer(source, match) {
  const fd = await fsp.open(source.filePath, "r");
  try {
    const tileFirst2 = await readExactly(
      fd,
      match.offset,
      Math.min(2, match.byteCount),
    );
    const tileLast2 =
      match.byteCount >= 2
        ? await readExactly(fd, match.offset + match.byteCount - 2, 2)
        : Buffer.alloc(0);

    const parts = buildJpegParts(tileFirst2, tileLast2, match.page.jpegTables);
    const tileStart = match.offset + parts.skipStart;
    const tileLength = Math.max(
      0,
      match.byteCount - parts.skipStart - parts.skipEnd,
    );
    const tileData =
      tileLength > 0
        ? await readExactly(fd, tileStart, tileLength)
        : Buffer.alloc(0);
    return Buffer.concat([parts.prefix, tileData, parts.suffix]);
  } finally {
    await fd.close();
  }
}

function needsEdgeTranscode(match) {
  return (
    match.outWidth !== match.page.tileWidth ||
    match.outHeight !== match.page.tileHeight
  );
}

function edgeCropRect(match) {
  return {
    left: 0,
    top: 0,
    width: match.outWidth,
    height: match.outHeight,
  };
}

async function sendTranscodedEdgeTile(res, source, match) {
  const sharp = getSharp();
  const rawTile = await readJpegTileBuffer(source, match);
  const crop = edgeCropRect(match);

  let pipeline = sharp(rawTile, { limitInputPixels: false }).extract(crop);

  // Keep this for safety if future callers request a different output size.
  if (crop.width !== match.outWidth || crop.height !== match.outHeight) {
    pipeline = pipeline.resize(match.outWidth, match.outHeight, {
      fit: "fill",
    });
  }

  const data = await pipeline.jpeg({ quality: 90 }).toBuffer();

  send(
    res,
    200,
    {
      "Content-Type": "image/jpeg",
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
    data,
  );
}

async function loadSources(containersDir) {
  const entries = await fsp.readdir(containersDir, { withFileTypes: true });
  const map = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (
      !(
        lower.endsWith(".tif") ||
        lower.endsWith(".tiff") ||
        lower.endsWith(".ptif")
      )
    )
      continue;

    const filePath = path.join(containersDir, entry.name);
    const source = await parseTiffPyramid(filePath);

    const stem = path.parse(entry.name).name;
    if (!map.has(stem)) map.set(stem, source);
  }

  return map;
}

function buildSizes(source) {
  const seen = new Set();
  const sizes = [];
  for (const page of source.pages) {
    // For this passthrough server, full-image responses are only possible
    // when the selected pyramid page is encoded as a single native tile.
    if (
      page.tilesAcross !== 1 ||
      page.tilesDown !== 1 ||
      page.compression !== 7
    )
      continue;

    const key = `${page.width}x${page.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push({ width: page.width, height: page.height });
  }
  sizes.sort((a, b) => b.width - a.width);
  return sizes;
}

function infoJsonV2(idUrl, source) {
  const scaleFactors = source.pages.map((p) => p.scale);
  const tile = source.pages[0];
  const sizes = buildSizes(source);

  return {
    "@context": "http://iiif.io/api/image/2/context.json",
    "@id": idUrl,
    protocol: "http://iiif.io/api/image",
    width: source.width,
    height: source.height,
    profile: [
      "http://iiif.io/api/image/2/level0.json",
      {
        formats: ["jpg"],
        qualities: ["default"],
      },
    ],
    sizes,
    tiles: [
      {
        width: tile.tileWidth,
        height: tile.tileHeight,
        scaleFactors,
      },
    ],
  };
}

function infoJsonV3(idUrl, source) {
  const scaleFactors = source.pages.map((p) => p.scale);
  const tile = source.pages[0];
  const sizes = buildSizes(source);

  return {
    "@context": "http://iiif.io/api/image/3/context.json",
    id: idUrl,
    type: "ImageService3",
    protocol: "http://iiif.io/api/image",
    profile: "level0",
    width: source.width,
    height: source.height,
    sizes,
    tiles: [
      {
        width: tile.tileWidth,
        height: tile.tileHeight,
        scaleFactors,
      },
    ],
  };
}

function parseIiifRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "iiif" && (parts[1] === "2" || parts[1] === "3")) {
    return {
      version: Number(parts[1]),
      parts: parts.slice(2),
      prefix: `/iiif/${parts[1]}`,
    };
  }
  return {
    version: null,
    parts,
    prefix: "",
  };
}

function createHandler(opts, sources) {
  return async (req, res) => {
    try {
      const pathname = decodeURIComponent((req.url || "/").split("?", 1)[0]);
      const parsed = parseIiifRoute(pathname);
      const parts = parsed.parts;

      if (pathname === "/" || pathname === "/iiif" || pathname === "/iiif/") {
        sendJson(res, 200, {
          service: "iiif-image-level0-stream",
          routes: {
            v2: "/iiif/2/{identifier}/...",
            v3: "/iiif/3/{identifier}/...",
          },
          identifiers: [...sources.keys()].sort(),
        });
        return;
      }

      if (!parsed.prefix) {
        fail(res, 404, "Use /iiif/2 or /iiif/3 route prefix");
        return;
      }

      if (parts.length === 0) {
        fail(res, 404, "Missing identifier");
        return;
      }

      const id = parts[0];
      const source = sources.get(id);
      if (!source) {
        fail(res, 404, "Unknown identifier");
        return;
      }

      if (parts.length === 1) {
        const target = `${parsed.prefix}/${id}/info.json`;
        redirect(res, target);
        return;
      }

      if (parts.length === 2 && parts[1] === "info.json") {
        const host = req.headers.host || `${opts.host}:${opts.port}`;
        const scheme = opts.tlsKey ? "https" : "http";
        const basePath = `${parsed.prefix}/${id}`;
        const idUrl = `${scheme}://${host}${basePath}`;
        if (parsed.version === 3) {
          sendJson(res, 200, infoJsonV3(idUrl, source));
        } else {
          sendJson(res, 200, infoJsonV2(idUrl, source));
        }
        return;
      }

      if (parts.length !== 5) {
        fail(res, 404, "Invalid IIIF path");
        return;
      }

      const [regionRaw, sizeRaw, rotationRaw, qualityFormat] = parts.slice(1);
      if (rotationRaw !== "0") {
        fail(res, 400, "Only rotation 0 is supported");
        return;
      }
      if (qualityFormat !== "default.jpg" && qualityFormat !== "default.jpeg") {
        fail(res, 400, "Only default.jpg is supported");
        return;
      }

      const region = parseRegion(regionRaw, source.width, source.height);
      const size = parseSize(sizeRaw, region.w, region.h);
      const sizeMode = parseSizeMode(sizeRaw);

      const match = findJpegTileMatch(source, region, size, sizeMode);
      if (!match) {
        if (region.isFull) {
          fail(
            res,
            400,
            "Unsupported full size for passthrough. Use one of info.json sizes that map to a single native tile.",
          );
        } else {
          fail(
            res,
            400,
            "Request not tile-aligned for passthrough. Use x,y,w,h with matching output w,h for a native tile level.",
          );
        }
        return;
      }

      if (needsEdgeTranscode(match)) {
        await sendTranscodedEdgeTile(res, source, match);
      } else {
        await streamJpegTile(res, source, match);
      }
    } catch (e) {
      fail(res, 500, e instanceof Error ? e.message : "Internal error");
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const sources = await loadSources(opts.containersDir);

  const handler = createHandler(opts, sources);

  let server;
  let scheme = "http";
  if (opts.tlsKey && opts.tlsCert) {
    const [key, cert] = await Promise.all([
      fsp.readFile(opts.tlsKey),
      fsp.readFile(opts.tlsCert),
    ]);
    server = https.createServer({ key, cert }, handler);
    scheme = "https";
  } else {
    server = http.createServer(handler);
  }

  server.listen(opts.port, opts.host, () => {
    console.log(
      `Serving IIIF Level 0 passthrough on ${scheme}://${opts.host}:${opts.port}`,
    );
    console.log(`Containers dir: ${opts.containersDir}`);
    console.log(`Identifiers: ${[...sources.keys()].sort().join(", ")}`);
  });
}

module.exports = {
  parseRegion,
  parseSize,
  parseSizeMode,
  parseIiifRoute,
  findJpegTileMatch,
  buildJpegParts,
  needsEdgeTranscode,
  edgeCropRect,
  buildSizes,
  infoJsonV2,
  infoJsonV3,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
