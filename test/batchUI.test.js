'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchUI } = require('../public/batch-ui');

function button() {
  return {
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    click() { (this.handlers.click || (() => {}))(); },
  };
}

function rootWith(selectors) {
  return {
    querySelector(selector) { return selectors[selector] || null; },
  };
}

test('batch actions markup exposes cancel, copy and export controls', () => {
  const html = BatchUI.actionsMarkup();
  for (const selector of ['data-cancel-upload', 'data-batch-copy', 'data-batch-csv']) {
    assert.ok(html.includes(selector), `missing ${selector}`);
  }
  assert.match(html, /type="button"/);
});

test('copy helpers only include completed files with links', () => {
  const items = [
    { label: 'a.txt', status: 'done', url: 'https://example.test/a', total: 10 },
    { label: 'b.txt', status: 'failed', url: null, total: 20 },
    { label: 'c.txt', status: 'done', url: 'https://example.test/c', total: 30 },
    { label: 'd.txt', status: 'done', total: 40 },
  ];
  assert.deepEqual(BatchUI.batchLinks(items), [
    'https://example.test/a', 'https://example.test/c',
  ]);
  const csv = BatchUI.batchCsv(items);
  assert.match(csv, /^name,url,size/);
  assert.match(csv, /"a.txt","https:\/\/example.test\/a",10/);
  assert.equal(BatchUI.batchCsv([items[1]]), null);
});

test('CSV quoting escapes names that contain quotes', () => {
  const csv = BatchUI.batchCsv([
    { label: 'a "quoted" name.bin', status: 'done', url: 'https://example.test/x', total: 5 },
  ]);
  assert.match(csv, /"a ""quoted"" name.bin"/);
});

test('wire binds every visible batch control and tolerates missing ones', () => {
  const cancel = button();
  const copy = button();
  const csv = button();
  const calls = [];
  BatchUI.wire(rootWith({
    '[data-cancel-upload]': cancel,
    '[data-batch-copy]': copy,
    '[data-batch-csv]': csv,
  }), {
    onCancel: () => calls.push('cancel'),
    onCopy: () => calls.push('copy'),
    onCsv: () => calls.push('csv'),
  });
  cancel.click(); copy.click(); csv.click();
  assert.deepEqual(calls, ['cancel', 'copy', 'csv']);

  assert.doesNotThrow(() => BatchUI.wire(rootWith({}), { onCancel: () => {} }));
  assert.doesNotThrow(() => BatchUI.wire(null, {}));
});
