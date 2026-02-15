#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

let sharpInstance;
function getSharp() {
  if (!sharpInstance) sharpInstance = require("sharp");
  return sharpInstance;
}

const SUPPORTED = [".tif", ".tiff", ".ptif"];

function parseArgs(argv) {
  const opts = {
    containersDir: "containers",
    host: "127.0.0.1",
    port: 8000,
    tlsKey: null,
    tlsCert: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--containers-dir") {
      opts.containersDir = argv[++i];
    } else if (arg === "--host") {
      opts.host = argv[++i];
    } else if (arg === "--port") {
      opts.port = Number(argv[++i]);
    } else if (arg === "--tls-key") {
      opts.tlsKey = argv[++i];
    } else if (arg === "--tls-cert") {
      opts.tlsCert = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node server.js [--containers-dir containers] [--host 127.0.0.1] [--port 8000] [--tls-key certs/dev.key --tls-cert certs/dev.crt]",
      );
      process.exit(0);
    }
  }

  if ((opts.tlsKey && !opts.tlsCert) || (!opts.tlsKey && opts.tlsCert)) {
    throw new Error("Provide both --tls-key and --tls-cert to enable HTTPS");
  }

  return opts;
}

function err(res, status, msg) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(msg);
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Access-Control-Allow-Origin": "*",
  });
  res.end();
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function parseRegion(raw, imgW, imgH) {
  if (raw === "full") {
    return { x: 0, y: 0, w: imgW, h: imgH };
  }

  const m = raw.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  if (!m) throw new Error("Invalid region");

  const x = Number(m[1]);
  const y = Number(m[2]);
  let w = Number(m[3]);
  let h = Number(m[4]);

  if (w <= 0 || h <= 0) throw new Error("Invalid region dimensions");
  if (x >= imgW || y >= imgH) throw new Error("Region out of bounds");

  w = Math.min(w, imgW - x);
  h = Math.min(h, imgH - y);

  return { x, y, w, h };
}

function parseSize(raw, regW, regH) {
  if (raw === "full") return { w: regW, h: regH };

  if (raw.startsWith("pct:")) {
    const pct = Number(raw.slice(4));
    if (!(pct > 0)) throw new Error("Invalid size pct");
    return {
      w: Math.max(1, Math.round((regW * pct) / 100)),
      h: Math.max(1, Math.round((regH * pct) / 100)),
    };
  }

  if (raw.startsWith("!")) {
    const m = raw.slice(1).match(/^(\d+),(\d+)$/);
    if (!m) throw new Error("Invalid size");

    const maxW = Number(m[1]);
    const maxH = Number(m[2]);
    if (!(maxW > 0 && maxH > 0)) throw new Error("Invalid size");

    const scale = Math.min(maxW / regW, maxH / regH);
    return {
      w: Math.max(1, Math.round(regW * scale)),
      h: Math.max(1, Math.round(regH * scale)),
    };
  }

  const m = raw.match(/^(\d*),(\d*)$/);
  if (!m) throw new Error("Invalid size");

  const wRaw = m[1];
  const hRaw = m[2];

  if (wRaw && hRaw) {
    return { w: Number(wRaw), h: Number(hRaw) };
  }

  if (wRaw) {
    const w = Number(wRaw);
    return { w, h: Math.max(1, Math.round(regH * (w / regW))) };
  }

  if (hRaw) {
    const h = Number(hRaw);
    return { w: Math.max(1, Math.round(regW * (h / regH))), h };
  }

  throw new Error("Invalid size");
}

function parseRotation(raw) {
  const rotation = Number(raw);
  if (Number.isNaN(rotation) || rotation < 0) {
    throw new Error("Invalid rotation");
  }
  return rotation;
}

function selectPyramidLevel(record, region, size) {
  const pages = Math.max(1, record.pages || 1);
  if (pages === 1) return { page: 0, scale: 1 };

  const shrinkX = region.w / size.w;
  const shrinkY = region.h / size.h;
  const shrink = Math.max(1, Math.min(shrinkX, shrinkY));
  const targetLevel = Math.floor(Math.log2(shrink));
  const page = Math.max(0, Math.min(pages - 1, targetLevel));
  const scale = 2 ** page;

  return { page, scale };
}

function buildOperationPlan(record, region, size) {
  const selected = selectPyramidLevel(record, region, size);

  // Sharp pyramid pages typically shrink by repeated /2 with floor rounding.
  const pageWidth = Math.max(1, Math.floor(record.width / selected.scale));
  const pageHeight = Math.max(1, Math.floor(record.height / selected.scale));

  const left = Math.max(
    0,
    Math.min(pageWidth - 1, Math.floor(region.x / selected.scale)),
  );
  const top = Math.max(
    0,
    Math.min(pageHeight - 1, Math.floor(region.y / selected.scale)),
  );
  const right = Math.max(
    left + 1,
    Math.min(pageWidth, Math.ceil((region.x + region.w) / selected.scale)),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(pageHeight, Math.ceil((region.y + region.h) / selected.scale)),
  );

  const width = right - left;
  const height = bottom - top;

  return {
    page: selected.page,
    extract: { left, top, width, height },
  };
}

async function renderImage(
  record,
  region,
  size,
  rotation,
  quality,
  fmt,
  sharpFactory = getSharp(),
) {
  const render = async (usePyramidPage) => {
    const inputOptions = {
      limitInputPixels: false,
      sequentialRead: true,
    };

    let extractRegion = region;
    const isFullRegion =
      region.x === 0 &&
      region.y === 0 &&
      region.w === record.width &&
      region.h === record.height;
    if (usePyramidPage) {
      const plan = buildOperationPlan(record, region, size);
      inputOptions.page = plan.page;
      if (!isFullRegion) {
        extractRegion = plan.extract;
      }
    }

    let pipeline = sharpFactory(record.file, inputOptions);
    const isFull =
      extractRegion.left === undefined &&
      extractRegion.x === 0 &&
      extractRegion.y === 0 &&
      extractRegion.w === record.width &&
      extractRegion.h === record.height;

    if (!isFull) {
      if (extractRegion.left !== undefined) {
        pipeline = pipeline.extract(extractRegion);
      } else {
        pipeline = pipeline.extract({
          left: extractRegion.x,
          top: extractRegion.y,
          width: extractRegion.w,
          height: extractRegion.h,
        });
      }
    }

    pipeline = pipeline.resize(size.w, size.h, {
      fit: "fill",
      fastShrinkOnLoad: true,
    });

    if (rotation !== 0) pipeline = pipeline.rotate(rotation);
    if (quality === "gray") pipeline = pipeline.grayscale();

    if (fmt === "png") {
      return {
        data: await pipeline.png().toBuffer(),
        contentType: "image/png",
      };
    }

    return {
      data: await pipeline.jpeg({ quality: 90 }).toBuffer(),
      contentType: "image/jpeg",
    };
  };

  try {
    return await render(true);
  } catch (e) {
    // Some pyramid TIFFs expose levels that can still fail extract math by 1px.
    // Fallback keeps requests reliable, at the cost of slower rendering.
    return render(false);
  }
}

async function loadCatalog(containersDir, sharpFactory = getSharp()) {
  const catalog = new Map();
  const entries = await fs.readdir(containersDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = path.join(containersDir, entry.name);
    const lower = entry.name.toLowerCase();
    if (!SUPPORTED.some((ext) => lower.endsWith(ext))) continue;

    const metadata = await sharpFactory(fullPath, {
      limitInputPixels: false,
    }).metadata();
    if (!metadata.width || !metadata.height) continue;

    const record = {
      file: fullPath,
      width: metadata.width,
      height: metadata.height,
      pages: metadata.pages || 1,
    };

    const stem = path.parse(entry.name).name;
    if (!catalog.has(stem)) catalog.set(stem, record);
  }

  return catalog;
}

function infoJson(baseUrl, imageId, width, height) {
  const tileSize = 1024;
  const maxDim = Math.max(width, height);
  const levels = Math.max(0, Math.ceil(Math.log2(maxDim / tileSize)));
  const scaleFactors = [];
  for (let i = 0; i <= levels; i += 1) {
    scaleFactors.push(2 ** i);
  }

  return {
    "@context": "http://iiif.io/api/image/2/context.json",
    "@id": `${baseUrl}/${imageId}`,
    protocol: "http://iiif.io/api/image",
    width,
    height,
    profile: [
      "http://iiif.io/api/image/2/level1.json",
      {
        formats: ["jpg", "png"],
        qualities: ["default", "color", "gray"],
        supports: [
          "regionByPx",
          "sizeByW",
          "sizeByH",
          "sizeByPct",
          "sizeByWh",
          "rotationBy90s",
        ],
      },
    ],
    tiles: [{ width: tileSize, scaleFactors }],
  };
}

function createRequestHandler(opts, catalog, sharpFactory = getSharp()) {
  return async (req, res) => {
    try {
      const pathname = decodeURIComponent((req.url || "/").split("?", 1)[0]);
      const parts = pathname.split("/").filter(Boolean);

      if (parts.length === 0) {
        sendJson(res, 200, {
          service: "iiif-image-level1",
          identifiers: [...catalog.keys()].sort(),
        });
        return;
      }

      const imageId = parts[0];
      const record = catalog.get(imageId);
      if (!record) {
        err(res, 404, "Unknown identifier");
        return;
      }

      if (parts.length === 1) {
        redirect(res, `/${imageId}/info.json`);
        return;
      }

      if (parts.length === 2 && parts[1] === "info.json") {
        const host = req.headers.host || `${opts.host}:${opts.port}`;
        const scheme = opts.tlsKey ? "https" : "http";
        sendJson(
          res,
          200,
          infoJson(`${scheme}://${host}`, imageId, record.width, record.height),
        );
        return;
      }

      if (parts.length !== 5) {
        err(res, 404, "Invalid IIIF path");
        return;
      }

      const [regionRaw, sizeRaw, rotationRaw, qualityFmtRaw] = parts.slice(1);
      const qualityFmtParts = qualityFmtRaw.split(".");
      if (qualityFmtParts.length < 2) {
        err(res, 400, "Invalid quality/format");
        return;
      }

      const fmt = qualityFmtParts.pop().toLowerCase();
      const quality = qualityFmtParts.join(".");

      if (!["default", "color", "gray"].includes(quality)) {
        err(res, 400, "Unsupported quality");
        return;
      }

      if (!["jpg", "jpeg", "png"].includes(fmt)) {
        err(res, 400, "Unsupported format");
        return;
      }

      const region = parseRegion(regionRaw, record.width, record.height);
      const size = parseSize(sizeRaw, region.w, region.h);
      const rotation = parseRotation(rotationRaw);

      const rendered = await renderImage(
        record,
        region,
        size,
        rotation,
        quality,
        fmt,
        sharpFactory,
      );

      res.writeHead(200, {
        "Content-Type": rendered.contentType,
        "Content-Length": rendered.data.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(rendered.data);
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.startsWith("Invalid") ||
          e.message.startsWith("Unsupported") ||
          e.message.includes("out of bounds"))
      ) {
        err(res, 400, e.message);
        return;
      }

      err(res, 500, "Image processing failed");
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const catalog = await loadCatalog(opts.containersDir);

  const requestHandler = createRequestHandler(opts, catalog);

  let server;
  let scheme = "http";
  if (opts.tlsKey && opts.tlsCert) {
    const [key, cert] = await Promise.all([
      fs.readFile(opts.tlsKey),
      fs.readFile(opts.tlsCert),
    ]);
    server = https.createServer({ key, cert }, requestHandler);
    scheme = "https";
  } else {
    server = http.createServer(requestHandler);
  }

  server.listen(opts.port, opts.host, () => {
    console.log(`Serving IIIF on ${scheme}://${opts.host}:${opts.port}`);
    console.log(`Containers dir: ${opts.containersDir}`);
    console.log(`Identifiers: ${[...catalog.keys()].sort().join(", ")}`);
  });
}

module.exports = {
  parseArgs,
  parseRegion,
  parseSize,
  parseRotation,
  selectPyramidLevel,
  buildOperationPlan,
  createRequestHandler,
  renderImage,
  loadCatalog,
  infoJson,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
