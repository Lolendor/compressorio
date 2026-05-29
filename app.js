// ============================================================
//  Codec loading
// ============================================================
const $ = id => document.getElementById(id);

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}

// Module readiness
let goReady = false, mozjpegReady = false, webpReady = false, gifsicleReady = false, svgoReady = false;
let mjEnc = null, mjDec = null, wpEnc = null, wpDec = null;
let svgoOptimize = null, gifsicleMod = null;

function setGlobalStatus(msg) {
  // Helper for showing loading status under drop zone (only before first file)
  const els = document.querySelectorAll('.drop .drop-sub');
  if (els[0]) els[0].textContent = msg;
}

window.compressorOnReady = () => { goReady = true; checkReady(); };
function checkReady() {
  if (goReady && mozjpegReady && webpReady && gifsicleReady && svgoReady) {
    setGlobalStatus('compress jpg, png, gif, svg, webp. Multiple files OK. Max 50 MB each.');
  }
}
setGlobalStatus('Loading WASM codecs…');

const go = new Go();
WebAssembly.instantiateStreaming(fetch('compressor.wasm'), go.importObject)
  .then(({instance}) => go.run(instance))
  .catch(err => setGlobalStatus('Failed to load Go-WASM: ' + err.message));

import mozjpegEnc from './codecs/jpeg/mozjpeg_enc.js';
import mozjpegDec from './codecs/jpeg/mozjpeg_dec.js';
Promise.all([
  mozjpegEnc({ locateFile: f => 'codecs/jpeg/' + f }),
  mozjpegDec({ locateFile: f => 'codecs/jpeg/' + f }),
]).then(([e, d]) => { mjEnc = e; mjDec = d; mozjpegReady = true; checkReady(); })
  .catch(err => setGlobalStatus('mozjpeg load failed: ' + err.message));

import webpEnc from './codecs/webp/webp_enc.js';
import webpDec from './codecs/webp/webp_dec.js';
Promise.all([
  webpEnc({ locateFile: f => 'codecs/webp/' + f }),
  webpDec({ locateFile: f => 'codecs/webp/' + f }),
]).then(([e, d]) => { wpEnc = e; wpDec = d; webpReady = true; checkReady(); })
  .catch(err => setGlobalStatus('libwebp load failed: ' + err.message));

import { optimize as svgOptimize } from './codecs/svg/svgo.browser.js';
svgoOptimize = svgOptimize;
svgoReady = true;
checkReady();

import gifsicleBrowser from './codecs/gif/gifsicle.min.js?v=3';
gifsicleMod = gifsicleBrowser;
gifsicleReady = true;
checkReady();

// ============================================================
//  Worker pool for parallel raster compression (PNG/JPG/WebP)
//
//  Each worker is a real OS thread, so N workers compress N images
//  truly in parallel and the UI thread stays responsive. SVG and GIF
//  are NOT routed here — SVG rasterisation needs createImageBitmap on
//  an <svg> source (DOM-only) and gifsicle/svgo run fine on main.
// ============================================================
const POOL_SIZE = Math.max(1, Math.min(
  (navigator.hardwareConcurrency || 4) - 1, // leave one core for the UI
  6                                          // diminishing returns past ~6
));
const pool = [];          // [{ worker, busy }]
let jobSeq = 0;
const jobCallbacks = new Map(); // id → { resolve, reject, onProgress }
let poolInitStarted = false;

function ensurePool() {
  if (poolInitStarted) return;
  poolInitStarted = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    let worker;
    try {
      worker = new Worker('./worker.js', { type: 'module' });
    } catch (e) {
      console.warn('Worker spawn failed, falling back to main thread:', e);
      break;
    }
    const slot = { worker, busy: false };
    worker.onmessage = (e) => handleWorkerMessage(slot, e.data);
    worker.onerror = (e) => console.error('worker error:', e.message || e);
    worker.postMessage({ type: 'init' });
    pool.push(slot);
  }
}

function handleWorkerMessage(slot, msg) {
  if (msg.type === 'ready') return;
  const cb = jobCallbacks.get(msg.id);
  if (!cb) return;
  if (msg.type === 'progress') {
    cb.onProgress && cb.onProgress(msg.value);
  } else if (msg.type === 'done') {
    jobCallbacks.delete(msg.id);
    slot.busy = false;
    cb.resolve({ data: msg.data, stats: msg.stats, outType: msg.outType });
    pumpQueue();
  } else if (msg.type === 'error') {
    jobCallbacks.delete(msg.id);
    slot.busy = false;
    cb.reject(new Error(msg.message));
    pumpQueue();
  }
}

// Pending jobs waiting for a free worker.
const poolQueue = []; // [{ op, bytes, sourceType, target, opts, onProgress, resolve, reject }]

function runInWorker(op, bytes, sourceType, target, opts, onProgress) {
  ensurePool();
  // No workers available at all → signal caller to use the main thread.
  if (!pool.length) return null;
  return new Promise((resolve, reject) => {
    poolQueue.push({ op, bytes, sourceType, target, opts, onProgress, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  for (const slot of pool) {
    if (slot.busy) continue;
    const job = poolQueue.shift();
    if (!job) break;
    slot.busy = true;
    const id = ++jobSeq;
    jobCallbacks.set(id, { resolve: job.resolve, reject: job.reject, onProgress: job.onProgress });
    // Copy the input buffer (no transfer) so the caller keeps its own
    // bytes for the smart-fallback size check / re-download.
    slot.worker.postMessage({
      type: 'job', id, op: job.op,
      bytes: job.bytes, sourceType: job.sourceType, target: job.target, opts: job.opts,
    });
  }
}

// Warm up the pool right away so the first compression isn't delayed by
// codec loading inside the workers.
ensurePool();

// ============================================================
//  Mode (LOSSY / LOSSLESS / CUSTOM)
// ============================================================
let mode = 'lossy';
function bindRange(rangeId, valId, fmt) {
  const r = $(rangeId), v = $(valId);
  const sync = () => v.textContent = fmt(r.value);
  r.addEventListener('input', sync);
  sync();
}
bindRange('colors', 'vColors', x => x);
bindRange('dither', 'vDither', x => Number(x).toFixed(2));
bindRange('quality', 'vQuality', x => x);
bindRange('lossy',   'vLossy',   x => x);
bindRange('speed',   'vSpeed',   x => x);

function applyMode(m) {
  mode = m;
  [...$('ctypeTabs').querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('controls').hidden = (m !== 'custom');
  const lossless = (m === 'lossless');
  $('quality').value = lossless ? 95 : 70;
  $('lossy').value   = lossless ? 0  : 80;
  $('colors').value  = 256;
  $('dither').value  = 1;
  $('speed').value   = 3;
  ['quality','lossy','colors','dither','speed'].forEach(id => $(id).dispatchEvent(new Event('input', { bubbles: true })));
}
$('ctypeTabs').addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON' && e.target.dataset.mode) applyMode(e.target.dataset.mode);
});
applyMode('lossy');

// ============================================================
//  Output format (default 'original' = keep input format)
// ============================================================
let outputFormat = 'original';
const outputFormatEl = $('outputFormat');
outputFormatEl.addEventListener('change', () => {
  outputFormat = outputFormatEl.value;
  outputFormatEl.classList.toggle('active-convert', outputFormat !== 'original');
});

// ============================================================
//  Output scale (resize factor before encoding)
//  1.0 = keep source size. Anything else triggers a canvas-based
//  bilinear resample inside decodeToRGBA → encodeRGBATo.
// ============================================================
let outputScale = 1;
const outputScaleEl = $('outputScale');
outputScaleEl.addEventListener('change', () => {
  outputScale = parseFloat(outputScaleEl.value) || 1;
  outputScaleEl.classList.toggle('active-convert', outputScale !== 1);
});

// ============================================================
//  Format detection + per-format compress (same as before)
// ============================================================
function detectType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return 'png';
}

function readOpts() {
  return {
    maxColors: parseInt($('colors').value, 10),
    dither:    parseFloat($('dither').value),
    speed:     parseInt($('speed').value, 10),
    quality:   parseInt($('quality').value, 10),
    lossy:     parseInt($('lossy').value, 10),
    lossless:  (mode === 'lossless'),
    scale:     outputScale,
  };
}

async function compressPng(bytes, opts, onProgress) {
  if (opts.lossless) {
    // Lossless: re-encode via canvas → PNG. Canvas's PNG output is
    // always lossless. If the original was already an optimized PNG
    // this might actually grow the file — that's the price for "no
    // quality loss". Most photos shrink anyway because canvas uses
    // strong zlib + filters.
    onProgress(0.1);
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    onProgress(0.4);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    onProgress(0.7);
    const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    onProgress(0.95);
    const out = new Uint8Array(await pngBlob.arrayBuffer());
    onProgress(1.0);
    return { data: out, stats: { width: img.naturalWidth, height: img.naturalHeight } };
  }
  const phaseBase = { quantize: 0, dither: 0.5, encode: 0.85 };
  const phaseWeight = { quantize: 0.5, dither: 0.35, encode: 0.15 };
  const cb = (stage, frac) => onProgress((phaseBase[stage] ?? 0) + (phaseWeight[stage] ?? 0) * frac);
  await new Promise(r => setTimeout(r, 10));
  const result = window.compressPNG(bytes, opts, cb);
  if (result.error) throw new Error(result.error);
  return { data: result.data, stats: result.stats };
}
// ---- JPEG metadata helpers ----

// Extract all APP1 (EXIF) and APP2 (ICC_PROFILE) segments from a JPEG.
// Returns an array of raw segment bytes (including the FFE1/FFE2 marker and
// length bytes) suitable for direct re-insertion into another JPEG.
function extractJpegMetadata(bytes) {
  const segments = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return segments;
  let pos = 2;
  while (pos < bytes.length - 1) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    // skip 0xff fill bytes
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0x00 || marker === 0xd9) continue;
    // restart markers - no length
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    // start of scan - stop scanning meta
    if (marker === 0xda || marker === 0xc0 || marker === 0xc1 || marker === 0xc2) break;
    const segLen = (bytes[pos] << 8) | bytes[pos+1];
    // Only keep APP2 (ICC profile). compressor.io discards EXIF (APP1)
    // and Photoshop IRB (APP13) — we mirror that behaviour for byte-exact
    // parity and to maximise compression.
    if (marker === 0xe2) {
      // Slice the FULL chunk: FF + marker + length(2) + data
      const start = pos - 2;
      const end = pos + segLen;
      segments.push(bytes.slice(start, end));
    }
    pos += segLen;
  }
  return segments;
}

// Inject the given metadata segments immediately after the JFIF (APP0)
// chunk in a freshly encoded JPEG. If no JFIF is present, inject right
// after SOI.
function injectJpegMetadata(jpgBytes, segments) {
  if (!segments.length) return jpgBytes;
  if (jpgBytes[0] !== 0xff || jpgBytes[1] !== 0xd8) return jpgBytes;
  let insertAt = 2; // right after SOI by default
  // If APP0 (JFIF) is the first segment, insert *after* it.
  if (jpgBytes[2] === 0xff && jpgBytes[3] === 0xe0) {
    const app0Len = (jpgBytes[4] << 8) | jpgBytes[5];
    insertAt = 4 + app0Len;
  }
  const totalExtra = segments.reduce((s, seg) => s + seg.byteLength, 0);
  const out = new Uint8Array(jpgBytes.byteLength + totalExtra);
  out.set(jpgBytes.subarray(0, insertAt), 0);
  let p = insertAt;
  for (const seg of segments) {
    out.set(seg, p);
    p += seg.byteLength;
  }
  out.set(jpgBytes.subarray(insertAt), p);
  return out;
}

// ---- Raw ICC profile extraction (works across source formats) ----
//
// Returns just the ICC profile *payload* (i.e. the .icc bytes themselves,
// without any container-specific framing). This is what we need to embed
// into a different output format. Returns null if no profile present.
function extractIccProfile(bytes, type) {
  if (type === 'jpg') return extractIccFromJpeg(bytes);
  if (type === 'png') return extractIccFromPng(bytes);
  if (type === 'webp') return extractIccFromWebp(bytes);
  return null;
}

// JPEG ICC profiles can span multiple APP2 segments. Each starts with the
// signature "ICC_PROFILE\0" followed by chunk-index + chunk-count bytes.
// We reassemble all chunks in order into a single Uint8Array.
function extractIccFromJpeg(bytes) {
  const SIG = [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0x00]; // "ICC_PROFILE\0"
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  const chunks = []; // [{ idx, data }]
  let total = 0;
  while (pos < bytes.length - 1) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0x00 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0xda || marker === 0xc0 || marker === 0xc1 || marker === 0xc2) break;
    const segLen = (bytes[pos] << 8) | bytes[pos+1];
    if (marker === 0xe2 && segLen > 16) {
      // Check signature
      let match = true;
      for (let i = 0; i < SIG.length; i++) {
        if (bytes[pos + 2 + i] !== SIG[i]) { match = false; break; }
      }
      if (match) {
        const idx = bytes[pos + 2 + SIG.length];
        const cnt = bytes[pos + 2 + SIG.length + 1];
        const dataStart = pos + 2 + SIG.length + 2;
        const dataEnd = pos + segLen;
        chunks.push({ idx, total: cnt, data: bytes.slice(dataStart, dataEnd) });
        total += dataEnd - dataStart;
      }
    }
    pos += segLen;
  }
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.idx - b.idx);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c.data, o); o += c.data.length; }
  return out;
}

// PNG ICC read is not currently needed (we route PNG sources through the
// browser canvas which already color-manages to sRGB before we touch the
// pixels). Stubbed for completeness.
function extractIccFromPng(_bytes) { return null; }

// WebP: look for ICCP chunk inside the RIFF container.
function extractIccFromWebp(bytes) {
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49) return null;
  let pos = 12; // skip RIFF header + 'WEBP'
  while (pos + 8 <= bytes.length) {
    const t = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    const len = bytes[pos+4] | (bytes[pos+5]<<8) | (bytes[pos+6]<<16) | (bytes[pos+7]<<24);
    if (t === 'ICCP') {
      return bytes.slice(pos + 8, pos + 8 + len);
    }
    // Chunks are padded to even byte boundaries.
    pos += 8 + len + (len & 1);
  }
  return null;
}

// Async deflate via the native CompressionStream API (Safari 16.4+,
// all evergreens). We use it to wrap the raw ICC payload for PNG iCCP
// chunks. No external pako dependency required.
async function deflateAsync(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- ICC profile injection into WebP / PNG ----

// Insert an ICCP chunk into a WebP RIFF container. Per the WebP spec, when
// ICCP is present, the VP8X (extended) header must be present and its
// "has ICC profile" flag set. If the encoder produced a simple VP8/VP8L
// file, we upgrade it to VP8X first.
function injectIccIntoWebp(webpBytes, icc) {
  if (!icc || !icc.length) return webpBytes;
  if (webpBytes[0] !== 0x52 || webpBytes[1] !== 0x49) return webpBytes; // not RIFF
  // Read 'WEBP' magic.
  if (String.fromCharCode(webpBytes[8], webpBytes[9], webpBytes[10], webpBytes[11]) !== 'WEBP') return webpBytes;

  const chunks = []; // [{type, data}]
  let pos = 12;
  while (pos + 8 <= webpBytes.length) {
    const t = String.fromCharCode(webpBytes[pos], webpBytes[pos+1], webpBytes[pos+2], webpBytes[pos+3]);
    const len = webpBytes[pos+4] | (webpBytes[pos+5]<<8) | (webpBytes[pos+6]<<16) | (webpBytes[pos+7]<<24);
    chunks.push({ type: t, data: webpBytes.slice(pos + 8, pos + 8 + len) });
    pos += 8 + len + (len & 1);
  }
  if (!chunks.length) return webpBytes;

  // Find image dimensions + alpha info from the first VP8/VP8L/VP8X chunk.
  let width = 0, height = 0, hasAlpha = 0, hasAnim = 0;
  const first = chunks[0];
  if (first.type === 'VP8X') {
    width  = 1 + (first.data[4] | (first.data[5] << 8) | (first.data[6] << 16));
    height = 1 + (first.data[7] | (first.data[8] << 8) | (first.data[9] << 16));
    hasAlpha = (first.data[0] >> 4) & 1;
    hasAnim  = (first.data[0] >> 1) & 1;
  } else if (first.type === 'VP8 ') {
    // VP8 (lossy) keyframe layout:
    //   bytes 0..2  : frame tag
    //   bytes 3..5  : start code 0x9d 0x01 0x2a
    //   bytes 6..7  : 14-bit width  (+ 2-bit horizontal scale)
    //   bytes 8..9  : 14-bit height (+ 2-bit vertical scale)
    const d = first.data;
    width  = (d[6] | (d[7] << 8)) & 0x3fff;
    height = (d[8] | (d[9] << 8)) & 0x3fff;
  } else if (first.type === 'VP8L') {
    // VP8L: 1 byte signature (0x2f) then 14-bit (w-1) + 14-bit (h-1) + alpha
    const d = first.data;
    width  = 1 + (((d[1]) | (d[2] << 8)) & 0x3fff);
    height = 1 + (((d[2] >> 6) | (d[3] << 2) | (d[4] << 10)) & 0x3fff);
    hasAlpha = (d[4] >> 4) & 1;
  } else {
    // Unknown layout — bail and return the original.
    return webpBytes;
  }
  if (!width || !height) return webpBytes;

  // Build new VP8X chunk (10 bytes payload).
  const vp8x = new Uint8Array(10);
  // Flags: ICC profile = bit 5 (0x20). Preserve alpha/anim flags.
  vp8x[0] = 0x20 | (hasAlpha ? 0x10 : 0) | (hasAnim ? 0x02 : 0);
  vp8x[1] = 0; vp8x[2] = 0; vp8x[3] = 0;
  const w1 = width - 1, h1 = height - 1;
  vp8x[4] = w1 & 0xff; vp8x[5] = (w1 >> 8) & 0xff; vp8x[6] = (w1 >> 16) & 0xff;
  vp8x[7] = h1 & 0xff; vp8x[8] = (h1 >> 8) & 0xff; vp8x[9] = (h1 >> 16) & 0xff;

  // Reorder/replace: VP8X first, then ICCP, then any pre-existing chunks
  // (skipping any old VP8X / ICCP).
  const outChunks = [
    { type: 'VP8X', data: vp8x },
    { type: 'ICCP', data: icc },
  ];
  for (const c of chunks) {
    if (c.type === 'VP8X' || c.type === 'ICCP') continue;
    outChunks.push(c);
  }

  // Serialize.
  let bodyLen = 4; // 'WEBP' magic
  for (const c of outChunks) bodyLen += 8 + c.data.length + (c.data.length & 1);
  const out = new Uint8Array(8 + bodyLen);
  // RIFF header
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // 'RIFF'
  out[4] = bodyLen & 0xff; out[5] = (bodyLen >> 8) & 0xff;
  out[6] = (bodyLen >> 16) & 0xff; out[7] = (bodyLen >>> 24) & 0xff;
  // 'WEBP'
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50;
  let o = 12;
  for (const c of outChunks) {
    out[o++] = c.type.charCodeAt(0);
    out[o++] = c.type.charCodeAt(1);
    out[o++] = c.type.charCodeAt(2);
    out[o++] = c.type.charCodeAt(3);
    const l = c.data.length;
    out[o++] = l & 0xff; out[o++] = (l >> 8) & 0xff;
    out[o++] = (l >> 16) & 0xff; out[o++] = (l >>> 24) & 0xff;
    out.set(c.data, o); o += l;
    if (l & 1) out[o++] = 0; // pad
  }
  return out;
}

// Build a PNG iCCP chunk and insert it right after the IHDR chunk.
async function injectIccIntoPng(pngBytes, icc) {
  if (!icc || !icc.length) return pngBytes;
  if (pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50) return pngBytes;
  // Find IHDR end (first chunk after the 8-byte signature).
  let pos = 8;
  const ihdrLen = (pngBytes[pos]<<24) | (pngBytes[pos+1]<<16) | (pngBytes[pos+2]<<8) | pngBytes[pos+3];
  if (String.fromCharCode(pngBytes[pos+4], pngBytes[pos+5], pngBytes[pos+6], pngBytes[pos+7]) !== 'IHDR') {
    return pngBytes;
  }
  const ihdrEnd = pos + 12 + ihdrLen; // length(4) + type(4) + data + crc(4)

  // Strip any existing iCCP / sRGB / gAMA chunks (they would conflict).
  const filtered = [];
  filtered.push(pngBytes.subarray(0, ihdrEnd));
  let p = ihdrEnd;
  while (p + 12 <= pngBytes.length) {
    const len = (pngBytes[p]<<24) | (pngBytes[p+1]<<16) | (pngBytes[p+2]<<8) | pngBytes[p+3];
    const t = String.fromCharCode(pngBytes[p+4], pngBytes[p+5], pngBytes[p+6], pngBytes[p+7]);
    const chunkEnd = p + 12 + len;
    if (t !== 'iCCP' && t !== 'sRGB' && t !== 'gAMA') {
      filtered.push(pngBytes.subarray(p, chunkEnd));
    }
    p = chunkEnd;
  }

  // Build the iCCP chunk: name "icc" + null + compression(0) + deflate(icc).
  const compressed = await deflateAsync(icc);
  const nameBytes = [0x69, 0x63, 0x63, 0x00]; // "icc\0"
  const dataLen = nameBytes.length + 1 + compressed.length; // +1 for compression method
  const chunk = new Uint8Array(12 + dataLen);
  // length
  chunk[0] = (dataLen >>> 24) & 0xff; chunk[1] = (dataLen >>> 16) & 0xff;
  chunk[2] = (dataLen >>> 8) & 0xff;  chunk[3] = dataLen & 0xff;
  // type 'iCCP'
  chunk[4] = 0x69; chunk[5] = 0x43; chunk[6] = 0x43; chunk[7] = 0x50;
  // data
  let q = 8;
  chunk.set(nameBytes, q); q += nameBytes.length;
  chunk[q++] = 0; // compression method = deflate
  chunk.set(compressed, q); q += compressed.length;
  // CRC over type + data
  const crc = crc32Range(chunk, 4, q);
  chunk[q++] = (crc >>> 24) & 0xff; chunk[q++] = (crc >>> 16) & 0xff;
  chunk[q++] = (crc >>> 8) & 0xff;  chunk[q++] = crc & 0xff;

  // Splice: header+IHDR, then iCCP, then the rest.
  const head = filtered[0];
  const tailParts = filtered.slice(1);
  const total = head.length + chunk.length + tailParts.reduce((s, x) => s + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  out.set(head, o); o += head.length;
  out.set(chunk, o); o += chunk.length;
  for (const part of tailParts) { out.set(part, o); o += part.length; }
  return out;
}

// CRC-32 helper for PNG iCCP chunk. Computes CRC over bytes[start..end).
function crc32Range(bytes, start, end) {
  if (!crc32Range._table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    crc32Range._table = t;
  }
  const T = crc32Range._table;
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function compressJpg(bytes, opts, onProgress) {
  onProgress(0.3); await new Promise(r => setTimeout(r, 10));
  // Grab ICC profile + EXIF so we can re-insert them after encoding
  // (compressor.io behaves the same way — it keeps the ICC).
  const meta = extractJpegMetadata(bytes);
  const decoded = mjDec.decode(bytes, {});
  onProgress(0.6); await new Promise(r => setTimeout(r, 10));
  const q = opts.quality;
  const encoded = mjEnc.encode(decoded.data, decoded.width, decoded.height, {
    // True JPEG lossless does not exist in mozjpeg — we approximate with
    // q=100 + no chroma subsampling (4:4:4) + arithmetic coding.
    quality: opts.lossless ? 100 : q,
    baseline: false,
    arithmetic: false,
    progressive: true,
    optimize_coding: true, smoothing: 0, color_space: 3, quant_table: 3,
    trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false, trellis_loops: 1,
    auto_subsample: opts.lossless ? false : true,
    chroma_subsample: opts.lossless ? 1 : 2,
    separate_chroma_quality: false,
    chroma_quality: opts.lossless ? 100 : q,
  });
  // Re-attach the original ICC profile / EXIF so the browser keeps the
  // intended color gamut (Display P3, Adobe RGB, etc.) — without this
  // step a P3 source rendered as sRGB and reds looked washed out.
  const withMeta = injectJpegMetadata(new Uint8Array(encoded), meta);
  onProgress(1.0);
  return { data: withMeta, stats: { width: decoded.width, height: decoded.height } };
}
async function compressWebp(bytes, opts, onProgress) {
  onProgress(0.2); await new Promise(r => setTimeout(r, 10));
  const decoded = wpDec.decode(bytes);
  onProgress(0.5); await new Promise(r => setTimeout(r, 10));
  const q = opts.quality;
  const encoded = wpEnc.encode(decoded.data, decoded.width, decoded.height, {
    quality: opts.lossless ? 100 : q,
    target_size: 0, target_PSNR: 0,
    method: opts.lossless ? 6 : 4,
    sns_strength: 50,
    filter_strength: 60, filter_sharpness: 0, filter_type: 1, partitions: 0,
    segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
    partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100,
    lossless: opts.lossless ? 1 : 0,
    exact: opts.lossless ? 1 : 0,
    image_hint: 0, emulate_jpeg_size: 0,
    thread_level: 0, low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
  });
  onProgress(1.0);
  return { data: new Uint8Array(encoded), stats: { width: decoded.width, height: decoded.height } };
}
async function compressGif(bytes, opts, onProgress) {
  onProgress(0.1); await new Promise(r => setTimeout(r, 10));
  const lossy = opts.lossy;
  const cmd = '-O3' + (lossy > 0 ? (' --lossy=' + lossy) : '') + ' input.gif -o /out/output.gif';
  const inputBlob = new Blob([bytes], { type: 'image/gif' });
  onProgress(0.3);
  const files = await gifsicleMod.run({
    input:   [{ file: inputBlob, name: 'input.gif' }],
    command: [cmd],
  });
  if (!files || !files.length) throw new Error('gifsicle returned no output');
  onProgress(0.9);
  const out = await files[0].arrayBuffer();
  onProgress(1.0);
  return { data: new Uint8Array(out), stats: {} };
}
async function compressSvg(bytes, opts, onProgress) {
  onProgress(0.2); await new Promise(r => setTimeout(r, 10));
  const text = new TextDecoder('utf-8').decode(bytes);
  const result = svgoOptimize(text, { multipass: true });
  const out = new TextEncoder().encode(result.data);
  onProgress(1.0);
  return { data: out, stats: {} };
}

// ============================================================
//  Cross-format conversion (decode → re-encode to target)
// ============================================================

// Decode any supported source into raw RGBA pixels, optionally
// resized by `scale` (1 = original size). For SVG the scale is
// applied at rasterisation time (vector → crisp pixels). For raster
// formats we do a bilinear resample on a 2D canvas.
// Returns { data: Uint8ClampedArray, width, height }.
async function decodeToRGBA(bytes, type, scale = 1) {
  // mozjpeg / libwebp expose native decoders that give us RGBA directly.
  if (type === 'jpg') {
    const d = mjDec.decode(bytes, {});
    return resampleRGBA(new Uint8ClampedArray(d.data), d.width, d.height, scale);
  }
  if (type === 'webp') {
    const d = wpDec.decode(bytes);
    return resampleRGBA(new Uint8ClampedArray(d.data), d.width, d.height, scale);
  }
  // PNG / GIF (first frame) / SVG → use the browser's image decoder.
  let mime;
  if (type === 'png') mime = 'image/png';
  else if (type === 'gif') mime = 'image/gif';
  else if (type === 'svg') mime = 'image/svg+xml';
  else mime = 'image/png';

  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode failed for ' + type));
      i.src = url;
    });
    let w = img.naturalWidth, h = img.naturalHeight;
    // SVG without intrinsic size — fall back to a reasonable default
    // so users get something instead of a 0×0 canvas error.
    if (!w || !h) { w = 1024; h = 1024; }
    // Apply scale by drawing the source image directly onto a
    // scaled-down/up canvas. For SVG this re-rasterises the vector at
    // the target resolution (no upscale blur). For raster sources it
    // produces a bilinear resample in one step.
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, dw, dh);
    const imgData = ctx.getImageData(0, 0, dw, dh);
    return { data: imgData.data, width: dw, height: dh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Resample an RGBA buffer to a new size using the browser's 2D
// canvas bilinear/bicubic engine. No-op when scale === 1.
function resampleRGBA(data, w, h, scale) {
  if (scale === 1) return { data, width: w, height: h };
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  // Draw the source pixels onto a same-size canvas, then onto the
  // destination-sized canvas. Two-stage avoids ImageData's lack of
  // built-in scaling.
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const dst = document.createElement('canvas');
  dst.width = dw; dst.height = dh;
  const dctx = dst.getContext('2d');
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, dw, dh);
  const out = dctx.getImageData(0, 0, dw, dh);
  return { data: out.data, width: dw, height: dh };
}

// Encode RGBA pixels into the target format.
async function encodeRGBATo(target, rgba, width, height, opts) {
  if (target === 'jpg') {
    const encoded = mjEnc.encode(rgba, width, height, {
      quality: opts.lossless ? 100 : opts.quality,
      baseline: false, arithmetic: false, progressive: true,
      optimize_coding: true, smoothing: 0, color_space: 3, quant_table: 3,
      trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false, trellis_loops: 1,
      auto_subsample: !opts.lossless, chroma_subsample: opts.lossless ? 1 : 2,
      separate_chroma_quality: false,
      chroma_quality: opts.lossless ? 100 : opts.quality,
    });
    return new Uint8Array(encoded);
  }
  if (target === 'webp') {
    const encoded = wpEnc.encode(rgba, width, height, {
      quality: opts.lossless ? 100 : opts.quality,
      target_size: 0, target_PSNR: 0,
      method: opts.lossless ? 6 : 4, sns_strength: 50,
      filter_strength: 60, filter_sharpness: 0, filter_type: 1, partitions: 0,
      segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
      partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100,
      lossless: opts.lossless ? 1 : 0, exact: opts.lossless ? 1 : 0,
      image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0,
      near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
    });
    return new Uint8Array(encoded);
  }
  if (target === 'png') {
    // Canvas → PNG (always lossless). For LOSSY mode on PNG output we
    // could optionally run pngquant on top via window.compressPNG, but
    // that re-introduces palette quantization across all sources, which
    // surprises users converting photos to PNG. Keep canvas PNG simple.
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imgData, 0, 0);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('PNG encode failed');

    let out = new Uint8Array(await blob.arrayBuffer());
    // For LOSSY mode also run pngquant for a real size win.
    if (!opts.lossless && window.compressPNG) {
      try {
        const q = window.compressPNG(out, opts, () => {});
        if (!q.error && q.data && q.data.byteLength < out.byteLength) {
          out = q.data;
        }
      } catch (_) { /* fall back to canvas PNG */ }
    }
    return out;
  }
  throw new Error('Unsupported target format: ' + target);
}

// Convert a source file to a different output format. Preserves the
// embedded ICC color profile across the transcode — without this, a
// Display-P3 / Adobe-RGB JPG decoded by mozjpeg yields raw RGB samples
// that the browser then displays as sRGB, so wide-gamut reds shift
// cooler. We extract the source ICC and re-embed it in the target.
async function convertTo(target, bytes, sourceType, opts, onProgress) {
  onProgress(0.05); await new Promise(r => setTimeout(r, 10));
  // Only JPG and WebP source paths give us raw, non-color-managed samples
  // (mozjpeg/libwebp decoders ignore the embedded profile). PNG/GIF/SVG
  // go through the browser canvas which already applies the source ICC
  // and gives us sRGB pixels, so re-embedding would double-apply.
  const icc = (sourceType === 'jpg' || sourceType === 'webp')
              ? extractIccProfile(bytes, sourceType)
              : null;
  // For SVG the rasterisation size should be set BEFORE drawing so we
  // get crisp vector strokes at the target resolution instead of a
  // blurry upscale of the default-sized bitmap. Pass scale into
  // decodeToRGBA; it bakes the scale into the canvas dimensions for
  // SVG and into a post-decode resample for everything else.
  let { data, width, height } = await decodeToRGBA(bytes, sourceType, opts.scale || 1);
  onProgress(0.5); await new Promise(r => setTimeout(r, 10));
  let out = await encodeRGBATo(target, data, width, height, opts);
  onProgress(0.85);

  // Re-attach ICC profile to the new container. Each target format
  // stores it differently:
  //   JPG  → APP2 segment (handled below via injectJpegMetadata).
  //   WebP → ICCP RIFF chunk + VP8X header upgrade.
  //   PNG  → iCCP chunk (deflate-compressed profile).
  if (icc && icc.length) {
    try {
      if (target === 'webp') {
        out = injectIccIntoWebp(out, icc);
      } else if (target === 'png') {
        out = await injectIccIntoPng(out, icc);
      } else if (target === 'jpg') {
        // Wrap the raw ICC into a (possibly multi-segment) APP2 chunk
        // and inject via the existing JPEG path.
        const seg = buildJpegIccApp2(icc);
        out = injectJpegMetadata(out, seg);
      }
    } catch (e) {
      console.warn('ICC re-embedding failed for ' + target + ':', e);
    }
  }
  onProgress(1.0);
  return { data: out, stats: { width, height } };
}

// Wrap a raw ICC profile blob into one or more JPEG APP2 segments
// (signature "ICC_PROFILE\0" + chunk index + chunk count + payload).
// Each segment must fit in 65533 bytes total (2-byte length covers
// itself, so payload max ≈ 65519 incl. 14-byte header).
function buildJpegIccApp2(icc) {
  const SIG = [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0x00];
  const MAX_PAYLOAD = 65519; // 65535 - 2 (length) - 14 (sig+idx+cnt)
  const chunks = [];
  for (let p = 0; p < icc.length; p += MAX_PAYLOAD) {
    chunks.push(icc.slice(p, Math.min(p + MAX_PAYLOAD, icc.length)));
  }
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = chunks[i];
    const segLen = 2 + SIG.length + 2 + payload.length; // length field includes itself
    const seg = new Uint8Array(4 + SIG.length + 2 + payload.length); // FF E2 + length + sig + idx + cnt + payload
    seg[0] = 0xff; seg[1] = 0xe2;
    seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
    seg.set(SIG, 4);
    seg[4 + SIG.length] = i + 1;       // chunk index (1-based per spec)
    seg[4 + SIG.length + 1] = chunks.length;
    seg.set(payload, 4 + SIG.length + 2);
    segments.push(seg);
  }
  return segments;
}

// ============================================================
//  File queue with parallel workers
// ============================================================
const items = [];      // [{ id, file, type, bytes, status, progress, outBytes, outType, error }]
let nextId = 0;
// processOne is now lightweight (reads the file, hands the bytes to the
// worker pool, awaits the result), so we let many run concurrently and
// let the pool itself throttle actual CPU work to POOL_SIZE threads.
const MAX_PARALLEL = 64;
let activeWorkers = 0;
let allCodecsReadyForRun = () => goReady && mozjpegReady && webpReady && gifsicleReady && svgoReady;

const fileRows = $('fileRows');

function addFiles(fileList) {
  for (const f of fileList) {
    if (!f) continue;
    items.push({
      id: ++nextId,
      file: f,
      type: null,
      bytes: null,
      status: 'queued',  // queued | working | done | error
      progress: 0,
      outBytes: null,
      outType: null,
      error: null,
    });
  }
  $('filelistWrap').hidden = items.length === 0;
  $('dropWrap').hidden = false; // keep drop visible
  renderAll();
  startWorkers();
}

function renderAll() {
  // Replace tbody content fully (cheap because lists are short).
  fileRows.innerHTML = '';
  for (const it of items) fileRows.appendChild(renderRow(it));
  updateSummary();
}

function renderRow(it) {
  const tr = document.createElement('tr');
  tr.dataset.id = it.id;
  if (it.status === 'error') tr.classList.add('row-error');

  // Name + format badge + (compare button if done)
  const tdName = document.createElement('td');
  tdName.className = 'col-name';
  tdName.title = it.file.name;
  tdName.textContent = it.file.name;
  if (it.type) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    // Show "jpg → webp" when transcoded so the conversion is visible.
    badge.textContent = (it.outType && it.outType !== it.type)
      ? `${it.type} → ${it.outType}`
      : it.type;
    tdName.appendChild(badge);
  }
  tr.appendChild(tdName);

  // Before size
  const tdBefore = document.createElement('td');
  tdBefore.className = 'col-before';
  tdBefore.textContent = formatBytes(it.file.size);
  tr.appendChild(tdBefore);

  // Status / progress
  const tdStatus = document.createElement('td');
  tdStatus.className = 'col-status';
  if (it.status === 'queued') {
    tdStatus.innerHTML = '<span class="row-status-queued">Queued</span>';
  } else if (it.status === 'working') {
    const pct = (it.progress * 100).toFixed(0);
    tdStatus.innerHTML = `<div class="row-progress"><div class="bar"><div style="width:${pct}%"></div></div><div class="label">${pct}%</div></div>`;
  } else if (it.status === 'done') {
    const ratio = it.outBytes ? (it.outBytes.byteLength / it.file.size) : 1;
    const savedNum = (1 - ratio) * 100;
    if (savedNum >= 0) {
      tdStatus.innerHTML = `<span class="row-status-done">Saved ${savedNum.toFixed(0)}%</span>`;
    } else {
      tdStatus.innerHTML = `<span class="row-status-grown">Grown ${(-savedNum).toFixed(0)}%</span>`;
    }
  } else if (it.status === 'error') {
    tdStatus.innerHTML = `<span class="row-status-error">${it.error || 'Error'}</span>`;
  }
  tr.appendChild(tdStatus);

  // After size
  const tdAfter = document.createElement('td');
  tdAfter.className = 'col-after';
  if (it.status === 'done') {
    const ratio = it.outBytes.byteLength / it.file.size;
    const savedPct = (1 - ratio) * 100;
    const badge = savedPct >= 0
      ? `<span class="saved">−${savedPct.toFixed(1)}%</span>`
      : `<span class="grown">+${(-savedPct).toFixed(1)}%</span>`;
    tdAfter.innerHTML = `<span class="size">${formatBytes(it.outBytes.byteLength)}</span>${badge}`;
  } else {
    tdAfter.textContent = '—';
  }
  tr.appendChild(tdAfter);

  // Actions
  const tdAction = document.createElement('td');
  tdAction.className = 'col-action';
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const cmpBtn = document.createElement('button');
  cmpBtn.className = 'btn-row';
  cmpBtn.textContent = 'Compare';
  cmpBtn.disabled = (it.status !== 'done');
  cmpBtn.addEventListener('click', () => openCompare(it));
  actions.appendChild(cmpBtn);

  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn-row primary';
  dlBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 1 v10 M3 7 l5 5 l5 -5 M2 14 h12"/></svg> Download';
  dlBtn.disabled = (it.status !== 'done');
  dlBtn.addEventListener('click', () => downloadOne(it));
  actions.appendChild(dlBtn);

  tdAction.appendChild(actions);
  tr.appendChild(tdAction);

  return tr;
}

function updateSummary() {
  const total = items.length;
  const done  = items.filter(it => it.status === 'done').length;
  const error = items.filter(it => it.status === 'error').length;
  const totalIn  = items.reduce((s, it) => s + it.file.size, 0);
  const totalOut = items.reduce((s, it) => s + (it.outBytes ? it.outBytes.byteLength : it.file.size), 0);
  const savedPct = totalIn > 0 ? ((1 - totalOut/totalIn) * 100).toFixed(1) : '0';
  let txt = `${total} file${total === 1 ? '' : 's'}`;
  if (done > 0) txt += ` · ${done} done · saved <span class="saved-total">${savedPct}%</span> (${formatBytes(totalIn - totalOut)})`;
  if (error > 0) txt += ` · ${error} error`;
  $('fileSummary').innerHTML = txt;
  $('downloadAll').disabled = done === 0;
  $('downloadZip').disabled = done === 0;
}

async function startWorkers() {
  while (activeWorkers < MAX_PARALLEL) {
    const it = items.find(x => x.status === 'queued');
    if (!it) break;
    if (!allCodecsReadyForRun()) {
      // Codecs not ready yet — retry shortly.
      setTimeout(startWorkers, 300);
      return;
    }
    activeWorkers++;
    it.status = 'working';
    renderRow_inplace(it);
    processOne(it).finally(() => {
      activeWorkers--;
      startWorkers();
    });
  }
}

function renderRow_inplace(it) {
  // Replace just the row for this item.
  const oldRow = fileRows.querySelector('tr[data-id="' + it.id + '"]');
  const newRow = renderRow(it);
  if (oldRow) oldRow.replaceWith(newRow);
  else fileRows.appendChild(newRow);
  updateSummary();
}

async function processOne(it) {
  try {
    const buf = new Uint8Array(await it.file.arrayBuffer());
    it.bytes = buf;
    it.type = detectType(buf);
    renderRow_inplace(it);

    const opts = readOpts();
    const onProgress = p => {
      it.progress = p;
      renderRow_inplace(it);
    };

    // Decide whether to transcode to a different output format.
    // GIF is kept as-is even when a target is selected — converting it
    // would drop every frame after the first. SVG → raster is allowed
    // because the user explicitly opted in by changing the format
    // dropdown; we rasterize at the SVG's intrinsic size (or 1024×1024
    // fallback if it has none) in decodeToRGBA.
    const targetFmt = (outputFormat !== 'original'
                       && it.type !== 'gif')
                      ? outputFormat : null;

    // A non-1× scale requires going through the decode→resize→encode
    // path even when input and output formats match — the per-format
    // compressXxx functions don't resize. SVG→SVG and GIF→GIF cannot
    // be rescaled meaningfully (vector / animation) so we ignore scale
    // there.
    const sameFmt = it.outType === it.type;
    const needsRescale = opts.scale !== 1
                         && it.type !== 'gif'
                         && !(it.type === 'svg' && (!targetFmt || targetFmt === 'svg'));

    // Can this job run in a worker? Workers handle raster pipelines
    // only. SVG sources need DOM-based rasterisation, GIF needs
    // gifsicle on the main thread, and SVG→SVG / GIF stay on main.
    const isConvert = !!(targetFmt && targetFmt !== it.type) || needsRescale;
    const workerTarget = isConvert ? (targetFmt || it.type) : it.type;
    const rasterIn  = (it.type === 'jpg' || it.type === 'webp' || it.type === 'png');
    const rasterOut = (workerTarget === 'jpg' || workerTarget === 'webp' || workerTarget === 'png');
    const canUseWorker = rasterIn && rasterOut && it.type !== 'gif' && it.type !== 'svg';

    let res;
    if (canUseWorker) {
      const op = isConvert ? 'convert' : 'compress';
      const wres = await runInWorker(op, buf, it.type, workerTarget, opts, onProgress);
      if (wres) {
        res = { data: wres.data, stats: wres.stats };
        it.outType = wres.outType;
      } else {
        // Pool unavailable → run on main thread instead.
        res = await runOnMain();
      }
    } else {
      res = await runOnMain();
    }

    async function runOnMain() {
      let r;
      if (targetFmt && targetFmt !== it.type) {
        r = await convertTo(targetFmt, buf, it.type, opts, onProgress);
        it.outType = targetFmt;
      } else if (needsRescale) {
        r = await convertTo(it.type, buf, it.type, opts, onProgress);
        it.outType = it.type;
      } else {
        if (it.type === 'jpg')      r = await compressJpg(buf, opts, onProgress);
        else if (it.type === 'webp')r = await compressWebp(buf, opts, onProgress);
        else if (it.type === 'gif') r = await compressGif(buf, opts, onProgress);
        else if (it.type === 'svg') r = await compressSvg(buf, opts, onProgress);
        else                        r = await compressPng(buf, opts, onProgress);
        it.outType = it.type;
      }
      return r;
    }

    let outBytes = res.data;
    // Smart fallback: if compression made the file LARGER (typical for
    // LOSSLESS mode on already-compressed JPGs/WebPs), keep the original
    // bytes instead. The user still gets a "done" state, just with 0%
    // saved. Skip the fallback in CUSTOM mode so power users can see
    // what their settings actually produce. Also skip when the user
    // explicitly asked for a transcode or a non-1× resize — those
    // requests are about producing a *different* file, not a smaller
    // one, and silently swapping in the original would defeat the point.
    if (mode !== 'custom' && !targetFmt && !needsRescale && outBytes.byteLength > buf.byteLength) {
      outBytes = buf;
    }
    it.outBytes = outBytes;
    it.status   = 'done';
    it.progress = 1;
  } catch (e) {
    console.error('compress error:', e);
    it.status = 'error';
    it.error  = (e && e.message) ? e.message : String(e);
  }
  renderRow_inplace(it);
}

// ============================================================
//  Download / clear / compare
// ============================================================
function mimeFor(type) {
  return ({ jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml' })[type] || 'application/octet-stream';
}
// When format is unchanged → "<name>.min.<ext>".
// When converted → "<name>.<ext>" (no .min — clearer that the format changed).
function suffixFor(it) {
  const sourceType = it.type;
  const out = it.outType;
  const ext = ({ jpg: 'jpg', webp: 'webp', png: 'png', gif: 'gif', svg: 'svg' })[out] || 'bin';
  return (out === sourceType ? '.min.' : '.') + ext;
}

function downloadOne(it) {
  if (!it.outBytes) return;
  const blob = new Blob([it.outBytes], { type: mimeFor(it.outType) });
  const base = it.file.name.replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + suffixFor(it);
  a.click();
}

$('downloadAll').addEventListener('click', () => {
  items.forEach(it => { if (it.status === 'done') downloadOne(it); });
});

$('downloadZip').addEventListener('click', async () => {
  const btn = $('downloadZip');
  const originalText = btn.textContent;
  const done = items.filter(it => it.status === 'done' && it.outBytes);
  if (!done.length) return;
  btn.disabled = true;
  btn.textContent = 'Zipping…';
  try {
    // Build per-file entries with the same name the single Download
    // button would produce. Deduplicate collisions ("a.png" twice →
    // "a.png", "a (2).png") so the zip never overwrites itself.
    const seen = new Map();
    const entries = done.map(it => {
      const base = it.file.name.replace(/\.[^.]+$/, '');
      let name = base + suffixFor(it);
      const count = (seen.get(name) || 0) + 1;
      seen.set(name, count);
      if (count > 1) {
        const dot = name.lastIndexOf('.');
        name = (dot > 0 ? name.slice(0, dot) + ' (' + count + ')' + name.slice(dot)
                        : name + ' (' + count + ')');
      }
      return { name, data: it.outBytes };
    });
    const zipBytes = buildStoreZip(entries);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'compressor-' + new Date().toISOString().slice(0, 10) + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    console.error('zip failed:', e);
    alert('Failed to build zip: ' + (e && e.message ? e.message : e));
  } finally {
    btn.textContent = originalText;
    btn.disabled = items.filter(it => it.status === 'done').length === 0;
  }
});

// =============================================================
//  Minimal STORE-only ZIP encoder (ZIP 2.0, no compression).
//  Our inputs are already-compressed media (JPG/PNG/WebP/GIF) so
//  DEFLATE would save 1–2% at best while adding a ~30 KB pako
//  dependency. STORE keeps the bundle dependency-free.
//
//  Spec: PKWARE APPNOTE 6.3.4. We only implement what real
//  unzippers actually need:
//    - Local File Header (per entry)
//    - File data (uncompressed)
//    - Central Directory entry (per entry)
//    - End of Central Directory record
//
//  Files are stored UTF-8 (general purpose bit 11 set) so non-ASCII
//  filenames open correctly on macOS / Linux / Windows 10+.
// =============================================================
function buildStoreZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const size = data.byteLength >>> 0;

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfhV = new DataView(lfh.buffer);
    lfhV.setUint32(0,  0x04034b50, true); // signature
    lfhV.setUint16(4,  20, true);         // version needed
    lfhV.setUint16(6,  0x0800, true);     // flags: bit 11 = UTF-8 filename
    lfhV.setUint16(8,  0, true);          // method: 0 = STORE
    lfhV.setUint16(10, 0, true);          // mod time
    lfhV.setUint16(12, 0x21, true);       // mod date (1980-01-01)
    lfhV.setUint32(14, crc, true);
    lfhV.setUint32(18, size, true);       // compressed size
    lfhV.setUint32(22, size, true);       // uncompressed size
    lfhV.setUint16(26, nameBytes.length, true);
    lfhV.setUint16(28, 0, true);          // extra length
    lfh.set(nameBytes, 30);

    parts.push(lfh, data);

    // Central directory file header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdhV = new DataView(cdh.buffer);
    cdhV.setUint32(0,  0x02014b50, true); // signature
    cdhV.setUint16(4,  20, true);         // version made by
    cdhV.setUint16(6,  20, true);         // version needed
    cdhV.setUint16(8,  0x0800, true);     // flags
    cdhV.setUint16(10, 0, true);          // method
    cdhV.setUint16(12, 0, true);          // mod time
    cdhV.setUint16(14, 0x21, true);       // mod date
    cdhV.setUint32(16, crc, true);
    cdhV.setUint32(20, size, true);       // compressed size
    cdhV.setUint32(24, size, true);       // uncompressed size
    cdhV.setUint16(28, nameBytes.length, true);
    cdhV.setUint16(30, 0, true);          // extra length
    cdhV.setUint16(32, 0, true);          // comment length
    cdhV.setUint16(34, 0, true);          // disk number
    cdhV.setUint16(36, 0, true);          // internal attrs
    cdhV.setUint32(38, 0, true);          // external attrs
    cdhV.setUint32(42, offset, true);     // LFH offset
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.byteLength + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.byteLength; }

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdV = new DataView(eocd.buffer);
  eocdV.setUint32(0,  0x06054b50, true); // signature
  eocdV.setUint16(4,  0, true);          // disk #
  eocdV.setUint16(6,  0, true);          // disk w/ CD
  eocdV.setUint16(8,  entries.length, true);
  eocdV.setUint16(10, entries.length, true);
  eocdV.setUint32(12, centralSize, true);
  eocdV.setUint32(16, centralStart, true);
  eocdV.setUint16(20, 0, true);          // .zip comment length
  parts.push(eocd);

  // Concatenate.
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.byteLength; }
  return out;
}

// Standard IEEE 802.3 CRC-32 with reflected polynomial 0xEDB88320,
// cached lookup table. ~25 MB/s in V8 — fine for tens of MB of input.
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
$('clearAll').addEventListener('click', () => {
  items.length = 0;
  renderAll();
  $('filelistWrap').hidden = true;
});
$('addMore').addEventListener('click', () => $('file').click());

// Compare modal
function openCompare(it) {
  if (!it.outBytes) return;
  const cmpBg  = $('cmpBg');
  const cmpTop = $('cmpTop');
  const cmpBox = $('compare');

  // Reset any size hints from a previous compare so raster images can
  // pick up their natural dimensions again.
  cmpBg.removeAttribute('width');  cmpBg.removeAttribute('height');
  cmpTop.removeAttribute('width'); cmpTop.removeAttribute('height');
  cmpBg.style.width = ''; cmpBg.style.height = '';
  cmpBox.style.width = ''; cmpBox.style.height = '';
  cmpBox.classList.remove('compare-svg');

  // Original on the LEFT (cmpTop with clip-path), compressed on the RIGHT (cmpBg).
  cmpBg.src  = URL.createObjectURL(new Blob([it.outBytes], { type: mimeFor(it.outType) }));
  cmpTop.src = URL.createObjectURL(it.file);

  // SVGs have no reliable intrinsic size for an <img> tag (a viewBox
  // alone collapses to 300×150 in most browsers, sometimes 0). Force a
  // concrete pixel size on the *container* so both layers fill it.
  // 800px on the long edge keeps the modal usable on phones.
  const eitherSideIsSvg = (it.outType === 'svg' || it.type === 'svg');
  if (eitherSideIsSvg) {
    cmpBox.classList.add('compare-svg');
    // Try to read the original SVG's aspect ratio so the box doesn't
    // letterbox a portrait/landscape vector into a square.
    (async () => {
      try {
        const text = await it.file.text();
        const { w, h } = svgDisplayBox(text);
        cmpBox.style.width  = w + 'px';
        cmpBox.style.height = h + 'px';
        cmpBg.style.width   = w + 'px';
        cmpBg.style.height  = h + 'px';
      } catch (_) {
        cmpBox.style.width = '800px';
        cmpBox.style.height = '800px';
      }
    })();
  }

  $('compareTitle').textContent = 'Compare: ' + it.file.name;
  $('compareModal').classList.add('open');
  // Reset slider to middle.
  setCompareAt(0.5);
}

// Compute the display box (in CSS pixels) for an SVG so the compare
// modal shows it at a useful size regardless of the SVG's own width
// attribute (which is often missing). 800px long edge, with aspect
// ratio preserved from viewBox / width-height when available.
function svgDisplayBox(text) {
  const TARGET = 800;
  const wAttr = text.match(/\bwidth\s*=\s*["']?([\d.]+)/);
  const hAttr = text.match(/\bheight\s*=\s*["']?([\d.]+)/);
  let ratio = 1;
  if (wAttr && hAttr && +wAttr[1] > 0 && +hAttr[1] > 0) {
    ratio = +wAttr[1] / +hAttr[1];
  } else {
    const vb = text.match(/\bviewBox\s*=\s*["']([\d.\s,-]+)["']/);
    if (vb) {
      const parts = vb[1].split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        ratio = parts[2] / parts[3];
      }
    }
  }
  if (ratio >= 1) return { w: TARGET,            h: Math.round(TARGET / ratio) };
  return                  { w: Math.round(TARGET * ratio), h: TARGET };
}
function setCompareAt(frac) {
  const top = $('cmpTop'), sl = $('cmpSlider');
  top.style.clipPath = `inset(0 ${(1-frac)*100}% 0 0)`;
  sl.style.left = (frac*100) + '%';
}
$('compareClose').addEventListener('click', () => $('compareModal').classList.remove('open'));
$('compareModal').addEventListener('click', e => {
  if (e.target === $('compareModal')) $('compareModal').classList.remove('open');
});
// Drag the slider.
let dragging = false;
$('compare').addEventListener('pointerdown', e => {
  dragging = true;
  e.currentTarget.setPointerCapture(e.pointerId);
  updateCompareFromEvent(e);
});
$('compare').addEventListener('pointermove', e => { if (dragging) updateCompareFromEvent(e); });
$('compare').addEventListener('pointerup', e => { dragging = false; });
function updateCompareFromEvent(e) {
  const rect = $('compare').getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  setCompareAt(x / rect.width);
}

// ============================================================
//  File input + drag-and-drop
// ============================================================
$('file').addEventListener('change', e => {
  if (e.target.files && e.target.files.length) {
    addFiles(e.target.files);
    e.target.value = '';
  }
});

const drop = $('drop');
['dragenter','dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
  }
});
