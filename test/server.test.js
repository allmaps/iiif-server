const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRegion,
  parseSize,
  selectPyramidLevel,
  buildOperationPlan,
  renderImage,
} = require('../server');

test('parseRegion full returns image bounds', () => {
  assert.deepEqual(parseRegion('full', 4000, 3000), { x: 0, y: 0, w: 4000, h: 3000 });
});

test('parseSize width-only preserves aspect ratio', () => {
  assert.deepEqual(parseSize('1024,', 4000, 2000), { w: 1024, h: 512 });
});

test('parseSize bounded fit using !w,h', () => {
  assert.deepEqual(parseSize('!800,800', 4000, 2000), { w: 800, h: 400 });
});

test('selectPyramidLevel chooses deeper page for strong downscale', () => {
  const record = { width: 40000, height: 30000, pages: 7 };
  const region = { x: 0, y: 0, w: 40000, h: 30000 };
  const size = { w: 1024, h: 768 };

  const selected = selectPyramidLevel(record, region, size);
  assert.equal(selected.page, 5);
  assert.equal(selected.scale, 32);
});

test('buildOperationPlan scales extract to selected page', () => {
  const record = { width: 4096, height: 4096, pages: 5 };
  const region = { x: 1024, y: 1024, w: 1024, h: 1024 };
  const size = { w: 256, h: 256 };

  const plan = buildOperationPlan(record, region, size);
  assert.equal(plan.page, 2);
  assert.deepEqual(plan.extract, { left: 256, top: 256, width: 256, height: 256 });
});

test('buildOperationPlan clamps region to page bounds', () => {
  const record = { width: 1000, height: 1000, pages: 4 };
  const region = { x: 990, y: 990, w: 50, h: 50 };
  const size = { w: 25, h: 25 };

  const plan = buildOperationPlan(record, region, size);
  assert.ok(plan.extract.left >= 0);
  assert.ok(plan.extract.top >= 0);
  assert.ok(plan.extract.width >= 1);
  assert.ok(plan.extract.height >= 1);
});

test('buildOperationPlan handles odd full dimensions without overflow', () => {
  const record = { width: 39125, height: 34708, pages: 9 };
  const region = { x: 0, y: 0, w: 39125, h: 34708 };
  const size = { w: 1024, h: 908 };

  const plan = buildOperationPlan(record, region, size);
  const pageWidth = Math.floor(record.width / (2 ** plan.page));
  const pageHeight = Math.floor(record.height / (2 ** plan.page));

  assert.ok(plan.extract.left + plan.extract.width <= pageWidth);
  assert.ok(plan.extract.top + plan.extract.height <= pageHeight);
});

test('renderImage falls back to base level when pyramid extraction fails', async () => {
  const calls = [];
  const sharpMock = (file, options) => {
    calls.push(options);
    const state = { options };
    const chain = {
      extract() { return chain; },
      resize() { return chain; },
      rotate() { return chain; },
      grayscale() { return chain; },
      png() { state.fmt = 'png'; return chain; },
      jpeg() { state.fmt = 'jpg'; return chain; },
      async toBuffer() {
        if (state.options.page !== undefined) {
          throw new Error('extract_area: bad extract area');
        }
        return Buffer.from('ok');
      },
    };
    return chain;
  };

  const record = { file: 'x.tif', width: 4000, height: 3000, pages: 6 };
  const region = { x: 0, y: 0, w: 4000, h: 3000 };
  const size = { w: 1024, h: 768 };
  const out = await renderImage(record, region, size, 0, 'default', 'jpg', sharpMock);

  assert.equal(out.contentType, 'image/jpeg');
  assert.equal(out.data.toString(), 'ok');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].page !== undefined);
  assert.equal(calls[1].page, undefined);
});
