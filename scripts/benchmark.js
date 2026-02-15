#!/usr/bin/env node

const { performance } = require('node:perf_hooks');

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

async function bench(url, iterations) {
  const times = [];

  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const elapsed = performance.now() - start;

    if (!res.ok) {
      throw new Error(`Request failed (${res.status}): ${url}`);
    }

    times.push(elapsed);
    console.log(`${i + 1}/${iterations}: ${elapsed.toFixed(1)} ms, ${(buf.byteLength / 1024).toFixed(1)} KiB`);
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((acc, x) => acc + x, 0) / times.length;

  return {
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    avg,
  };
}

async function main() {
  const base = process.argv[2] || 'http://127.0.0.1:8000';
  const id = process.argv[3] || 'KZL_W_X_020.pyr.tif';
  const iterations = Number(process.argv[4] || '10');

  const full1024 = `${base}/${id}/full/1024,/0/default.jpg`;
  const tile = `${base}/${id}/0,0,1024,1024/256,/0/default.jpg`;

  console.log(`Benchmarking ${iterations} iterations per endpoint`);

  console.log('\nFull image downscale (1024,):');
  const fullStats = await bench(full1024, iterations);

  console.log('\nTile-ish region (0,0,1024,1024 -> 256,):');
  const tileStats = await bench(tile, iterations);

  console.log('\nSummary');
  console.log(`full  p50=${fullStats.p50.toFixed(1)}ms p95=${fullStats.p95.toFixed(1)}ms avg=${fullStats.avg.toFixed(1)}ms`);
  console.log(`tile  p50=${tileStats.p50.toFixed(1)}ms p95=${tileStats.p95.toFixed(1)}ms avg=${tileStats.avg.toFixed(1)}ms`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
