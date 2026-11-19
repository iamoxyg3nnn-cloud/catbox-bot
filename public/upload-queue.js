/* Bounded-concurrency upload queue for multi-file batches.
 *
 * Each item is uploaded by a caller-supplied `uploader(file, { signal, onProgress })`
 * function. The queue never has more than `concurrency` uploads in flight, so a
 * 100-file batch opens a handful of short-lived connections instead of 100 long
 * ones. That keeps us inside Cloudflare's per-connection read timeout and the
 * hub's per-IP throttle without changing the public API.
 *
 * The module is UMD so the same logic can be unit-tested under Node.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UploadQueue = api.UploadQueue;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  class UploadQueue {
    constructor({ concurrency = 5, retries = 2, uploader, onUpdate } = {}) {
      this.concurrency = Math.max(1, Number(concurrency) || 5);
      this.retries = Math.max(0, Number(retries) || 0);
      if (typeof uploader !== 'function') throw new TypeError('uploader must be a function');
      this.uploader = uploader;
      this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
      this.items = [];
      this.controllers = new Map();
      this.cancelled = false;
      this.running = false;
    }

    // items: [{ id, file, label }]. Returns the queue so calls can chain.
    add(files) {
      for (const file of Array.from(files || [])) {
        this.items.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          label: file.name || 'file',
          status: 'queued',
          sent: 0,
          total: Number(file.size) || 0,
          attempts: 0,
          url: null,
          error: null,
        });
      }
      this.emit();
      return this;
    }

    get stats() {
      const by = status => this.items.filter(i => i.status === status).length;
      const totalBytes = this.items.reduce((n, i) => n + i.total, 0);
      const sentBytes = this.items.reduce((n, i) => n + (i.sent || 0), 0);
      return {
        total: this.items.length,
        queued: by('queued'),
        uploading: by('uploading'),
        processing: by('processing'),
        done: by('done'),
        failed: by('failed'),
        cancelled: by('cancelled'),
        percent: totalBytes ? Math.round(sentBytes / totalBytes * 100) : 0,
      };
    }

    emit() { this.onUpdate(this.stats, this.items); }

    async run() {
      if (this.running) return;
      this.running = true;
      this.cancelled = false;
      let cursor = 0;
      const worker = async () => {
        while (!this.cancelled) {
          const index = cursor++;
          const item = this.items[index];
          if (!item) return;
          await this.process(item);
        }
      };
      const workers = Array.from({ length: Math.min(this.concurrency, this.items.length) }, worker);
      await Promise.all(workers);
      this.running = false;
      this.emit();
      return this.stats;
    }

    async process(item) {
      while (!this.cancelled && item.attempts <= this.retries) {
        item.attempts += 1;
        const controller = new AbortController();
        this.controllers.set(item.id, controller);
        item.status = 'uploading';
        item.error = null;
        this.emit();
        try {
          const url = await this.uploader(item.file, {
            signal: controller.signal,
            onProgress: (sent, total) => {
              item.sent = Math.min(Number(sent) || 0, item.total);
              if (Number(total) > 0) item.total = Number(total);
              this.emit();
            },
            onStatus: status => { item.status = status; this.emit(); },
          });
          item.url = url;
          item.status = 'done';
          item.sent = item.total;
          this.controllers.delete(item.id);
          this.emit();
          return;
        } catch (err) {
          this.controllers.delete(item.id);
          if (this.cancelled || (controller.signal && controller.signal.aborted)) {
            item.status = 'cancelled';
            this.emit();
            return;
          }
          item.error = err && err.message ? err.message : 'Upload failed.';
          if (item.attempts <= this.retries) {
            item.status = 'queued';
            item.sent = 0;
            this.emit();
            await wait(400 * 2 ** (item.attempts - 1));
            continue;
          }
          item.status = 'failed';
          this.emit();
          return;
        }
      }
    }

    cancel() {
      this.cancelled = true;
      for (const controller of this.controllers.values()) controller.abort();
      for (const item of this.items) {
        if (item.status === 'queued' || item.status === 'uploading' || item.status === 'processing') {
          item.status = 'cancelled';
        }
      }
      this.emit();
    }
  }

  return { UploadQueue };
});
