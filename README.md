# IIIF Server

We really like level 0 static tiles. See the example in [this repository](https://github.com/amsterdamtimemachine/berckenrode-iiif). They are very fast (no server-side processing is needed) and sufficient for 99% of the use cases (most image operations can be done client-side anyways...).

The downside? Lots of images in lots of folders! Which are slow to copy to servers or commit to a  git repository. What if you could combine all those tiles in a single format? Guess what: this already exists, a [Tiled Pyramidal TIFF](https://iipimage.sourceforge.io/documentation/images). But aren't TIFFs large? No, they support compression such as JPEG or WebP.

This repository contains a script to generate pyramidal TIFFs using [Sharp](https://sharp.pixelplumbing.com/). Then it has two servers that create a IIIF Image API that efficiently reads from this source file. The most interesting is the "Level 0 Byte-Streaming Server" which offers a `level0` compliant API. It extracts the relevant tiles from the TIFF without reading the entire file. Only for the edge tiles (with a deviating width and/or height) it decodes and encodes the image.

Next steps:
- Run the level0 server as a web worker
- Test different options for hosting the image pyramids
- Add support for the IIIF Presentation API and use metadata from the source files
- Experiment with WebP

## Implementation

Node.js + sharp implementation with two separate components:

- `scripts/create-pyramid.js`: creates a pyramidal TIFF container.
- `server.js`: serves a minimal IIIF Image API Level 1 endpoint.
- `server-level0-stream.js`: serves a strict Level 0-style JPEG tile passthrough endpoint (no decode/encode).

## Install

```bash
npm install
```

## 1) Build a container

```bash
npm run create:pyramid -- images/KZL_W_X_020.tif containers tif
```

This creates:

- `containers/KZL_W_X_020.tif`

`pmtiles` is accepted as an argument but currently not implemented with sharp directly.

## 2) Start the IIIF server

```bash
npm start -- --containers-dir containers --host 127.0.0.1 --port 8000
```

### HTTPS (local)

Generate a local self-signed cert:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout certs/dev.key \
  -out certs/dev.crt \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Start HTTPS:

```bash
npm start -- --containers-dir containers --host 127.0.0.1 --port 8443 --tls-key certs/dev.key --tls-cert certs/dev.crt
```

Then use:

```bash
https://localhost:8443/KZL_W_X_020/info.json
```

## 3) Test endpoints

Use the image filename as identifier:

```bash
curl http://127.0.0.1:8000/KZL_W_X_020/info.json
```

`/{identifier}` now redirects to `/{identifier}/info.json`.

Versioned routes are also supported:

- v2: `/iiif/2/{identifier}/...`
- v3: `/iiif/3/{identifier}/...`

Example region request:

```bash
curl -o tile.jpg "http://127.0.0.1:8000/KZL_W_X_020/0,0,1024,1024/512,/0/default.jpg"
```

## Tests

```bash
npm test
```

## Benchmark performance

With the server running:

```bash
npm run bench -- http://127.0.0.1:8000 KZL_W_X_020 10
```

This measures repeated latency for:

- `full/1024,/0/default.jpg`
- `0,0,1024,1024/256,/0/default.jpg`

Performance optimization added in `server.js`:

- For downscaled requests, the server now selects an appropriate TIFF pyramid page (`page` option in sharp) instead of always decoding from full resolution.
- It then extracts and resizes from that lower-resolution page, which reduces decode and I/O cost for requests like `full/1024,`.

## Optional: Level 0 Byte-Streaming Server

Start:

```bash
npm run start:level0 -- --containers-dir containers --host 127.0.0.1 --port 9000
```

This server does not decode or re-encode images. It reads and streams native JPEG tile bytes directly from a tiled pyramidal TIFF.

Supported routes:

- v2: `/iiif/2/{identifier}/...`
- v3: `/iiif/3/{identifier}/...`

Supported request shape:

- `{route}/{x},{y},{w},{h}/{size}/0/default.jpg`

Supported size forms:

- `{W},{H}`
- `{W},`
- `,{H}`
- `full`

Strict limitations:

- region must be numeric (`x,y,w,h`), not `full` or `pct:`
- output must match a native JPEG tile size at a native pyramid level
- rotation must be `0`
- request must align exactly to tile boundaries

If those conditions are not met, it returns `400`.

`region=full` note:

- `full/{W},{H}/0/default.jpg` is supported only when `{W},{H}` maps to a pyramid level that is stored as a single native JPEG tile. Multi-tile full-image requests still require decode/encode and are not supported by this passthrough server.

Both v2 and v3 `info.json` include:

- `tiles` with native tile dimensions and scale factors
- `sizes` listing only passthrough-safe full-image sizes (single native JPEG tile levels)

Edge-tile behavior:

- Right and bottom edge tiles are supported using remaining-pixel sizes from the IIIF implementation notes (partial tile region and reduced output size at that level).
- If an edge request needs output dimensions smaller than the native encoded tile (for example `199,`), the server transcodes that tile to match requested dimensions.

_Made using GPT-5.3-Codex, inspired by this [blog post](https://www.discretecosine.com/loading-jpeg-compressed-pyramidal-tiff-files-in-the-browser/)._
