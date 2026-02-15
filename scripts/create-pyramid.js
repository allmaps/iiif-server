#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

function usage() {
  console.log(`Create a pyramidal image container.

Usage:
  node scripts/create-pyramid.js <input-image> [output-dir] [format]

Args:
  input-image   Path to source image
  output-dir    Output directory (default: ./containers)
  format        tif | pmtiles (default: tif)
`);
}

async function main() {
  const [, , inputImage, outputDir = 'containers', format = 'tif'] = process.argv;

  if (!inputImage || inputImage === '-h' || inputImage === '--help') {
    usage();
    process.exit(inputImage ? 0 : 1);
  }

  try {
    await fs.access(inputImage);
  } catch {
    throw new Error(`Input file not found: ${inputImage}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const parsed = path.parse(inputImage);
  const outBase = path.join(outputDir, parsed.name);

  if (format === 'pmtiles') {
    throw new Error('PMTiles output is not supported by sharp directly. Use format "tif".');
  }

  if (format !== 'tif') {
    throw new Error(`Unsupported format: ${format}. Use "tif" or "pmtiles".`);
  }

  const outFile = `${outBase}.tif`;

  await sharp(inputImage, { limitInputPixels: false })
    .tiff({
      compression: 'jpeg',
      quality: 80,
      tile: true,
      tileWidth: 1024,
      tileHeight: 1024,
      pyramid: true,
      bigtiff: true,
    })
    .toFile(outFile);

  console.log(`Done: ${outFile}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
