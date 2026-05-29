// ============================================================
//  worker.js — compression worker (module type)
//
//  Loads its own copies of the mozjpeg / libwebp / TinyGo-PNG codecs
//  and runs PNG / JPG / WebP compression + conversion off the main
//  thread. SVG and GIF stay on the main thread (DOM / library reasons)
//  and never reach this worker.
//
//  Protocol (main → worker):
//    { type: 'init' }
//    { type: 'job', id, op, bytes, sourceType, target, opts }
//      op: 'compress' | 'convert'
//  Protocol (worker → main):
//    { type: 'ready' }
//    { type: 'progress', id, value }
//    { type: 'done', id, data, stats, outType }   (data transferred)
//    { type: 'error', id, message }
// ============================================================

import * as core from './codec-core.js';
import mozjpegEnc from './codecs/jpeg/mozjpeg_enc.js';
import mozjpegDec from './codecs/jpeg/mozjpeg_dec.js';
import webpEnc from './codecs/webp/webp_enc.js';
import webpDec from './codecs/webp/webp_dec.js';

let ready = false;
let pngReady = false;

// ---- TinyGo PNG codec -------------------------------------------------
// wasm_exec.js is an IIFE that assigns globalThis.Go. In a module worker
// there is no importScripts(), so we fetch the source and evaluate it
// in the global scope via an indirect Function call.
async function loadTinyGoPng() {
  const src = await (await fetch('./wasm_exec.js')).text();
  (0, eval)(src); // defines globalThis.Go
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiateStreaming(
    fetch('compressor.wasm'), go.importObject);
  // go.run blocks (the Go side does `select {}`), so don't await it.
  go.run(instance);
  // The Go main sets globalThis.compressPNG and calls compressorOnReady.
  // Poll briefly until compressPNG appears.
  for (let i = 0; i < 200 && typeof globalThis.compressPNG !== 'function'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (typeof globalThis.compressPNG !== 'function') {
    throw new Error('TinyGo PNG codec failed to initialise');
  }
  pngReady = true;
}

async function init() {
  if (ready) return;
  const [mjEnc, mjDec, wpEnc, wpDec] = await Promise.all([
    mozjpegEnc({ locateFile: f => 'codecs/jpeg/' + f }),
    mozjpegDec({ locateFile: f => 'codecs/jpeg/' + f }),
    webpEnc({ locateFile: f => 'codecs/webp/' + f }),
    webpDec({ locateFile: f => 'codecs/webp/' + f }),
  ]);
  core.setCodecs({ mjEnc, mjDec, wpEnc, wpDec });
  // PNG codec loads in parallel; mark codecs that don't need it ready now.
  await loadTinyGoPng();
  core.setCodecs({ pngCompress: globalThis.compressPNG });
  ready = true;
  self.postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try { await init(); }
    catch (err) { self.postMessage({ type: 'error', id: 'init', message: String(err && err.message || err) }); }
    return;
  }
  if (msg.type === 'job') {
    const { id, op, bytes, sourceType, target, opts } = msg;
    const onProgress = v => self.postMessage({ type: 'progress', id, value: v });
    try {
      if (!ready) await init();
      let res, outType;
      if (op === 'convert') {
        res = await core.convertTo(target, bytes, sourceType, opts, onProgress);
        outType = target;
      } else {
        // compress in place (same format)
        if (sourceType === 'jpg')       res = await core.compressJpg(bytes, opts, onProgress);
        else if (sourceType === 'webp') res = await core.compressWebp(bytes, opts, onProgress);
        else                            res = await core.compressPng(bytes, opts, onProgress);
        outType = sourceType;
      }
      const out = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
      self.postMessage(
        { type: 'done', id, data: out, stats: res.stats || {}, outType },
        [out.buffer]
      );
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
    }
  }
};
