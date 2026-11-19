/* Small, DOM-independent helpers for the multi-file batch result list.
 *
 * Kept in a UMD module so the cancel/copy/export wiring can be unit-tested with
 * a minimal DOM stub instead of relying on a browser-only test environment.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BatchUI = api.BatchUI;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function actionsMarkup() {
    return '<div class="batch-actions">'
      + '<button class="button button-quiet button-small" type="button" data-cancel-upload>Cancel all</button>'
      + '<button class="button button-quiet button-small" type="button" data-batch-copy>Copy all links</button>'
      + '<button class="button button-quiet button-small" type="button" data-batch-csv>Export CSV</button>'
      + '</div>';
  }

  function completed(items) {
    return (items || []).filter(item => item && item.status === 'done' && item.url);
  }

  function batchLinks(items) {
    return completed(items).map(item => item.url);
  }

  function batchCsv(items) {
    const rows = completed(items);
    if (!rows.length) return null;
    return ['name,url,size', ...rows.map(item =>
      `"${String(item.label || '').replace(/"/g, '""')}","${item.url}",${Number(item.total) || 0}`
    )].join('\n');
  }

  // Wire every action present in `root`. Missing buttons are simply skipped so
  // the same helper works while a batch is still running or already finished.
  function wire(root, handlers = {}) {
    if (!root || typeof root.querySelector !== 'function') return;
    const bind = (selector, handler) => {
      const node = root.querySelector(selector);
      if (node && typeof node.addEventListener === 'function' && typeof handler === 'function') {
        node.addEventListener('click', handler);
      }
    };
    bind('[data-cancel-upload]', handlers.onCancel);
    bind('[data-batch-copy]', handlers.onCopy);
    bind('[data-batch-csv]', handlers.onCsv);
  }

  return { BatchUI: { actionsMarkup, completed, batchLinks, batchCsv, wire } };
});
