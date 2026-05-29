// ============================================================
//  codec-core.js — shared compression core
//
//  Runs identically on the main thread and inside a Web Worker. All
//  canvas work uses OffscreenCanvas + createImageBitmap, which are
//  available in both contexts, so there is a single code path.
//
//  Codecs (mozjpeg / libwebp / TinyGo PNG) are injected via initCodecs()
//  rather than imported here, so the worker and the main thread can each
//  manage their own module instances.
// ============================================================

// Injected codec handles.
let mjEnc = null, mjDec = null, wpEnc = null, wpDec = null;
let pngCompress = null; // (bytes, opts, cb) => { data, stats, error }

export function setCodecs(c) {
  if (c.mjEnc) mjEnc = c.mjEnc;
  if (c.mjDec) mjDec = c.mjDec;
  if (c.wpEnc) wpEnc = c.wpEnc;
  if (c.wpDec) wpDec = c.wpDec;
  if (c.pngCompress) pngCompress = c.pngCompress;
}

// ---- OffscreenCanvas helpers (work in both window and worker) --------

function makeCanvas(w, h) {
  return new OffscreenCanvas(w, h);
}

async function decodeImageBitmap(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  // createImageBitmap honours the source ICC profile and color-manages
  // to the display space, mirroring the previous <img>+canvas behaviour.
  return await createImageBitmap(blob);
}

async function canvasToPngBytes(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ============================================================
//  JPEG metadata (ICC / EXIF) helpers — pure byte ops
// ============================================================

export function extractJpegMetadata(bytes) {
  const segments = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return segments;
  let pos = 2;
  while (pos < bytes.length - 1) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0x00 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0xda || marker === 0xc0 || marker === 0xc1 || marker === 0xc2) break;
    const segLen = (bytes[pos] << 8) | bytes[pos+1];
    if (marker === 0xe2) {
      const start = pos - 2;
      const end = pos + segLen;
      segments.push(bytes.slice(start, end));
    }
    pos += segLen;
  }
  return segments;
}

export function injectJpegMetadata(jpgBytes, segments) {
  if (!segments.length) return jpgBytes;
  if (jpgBytes[0] !== 0xff || jpgBytes[1] !== 0xd8) return jpgBytes;
  let insertAt = 2;
  if (jpgBytes[2] === 0xff && jpgBytes[3] === 0xe0) {
    const app0Len = (jpgBytes[4] << 8) | jpgBytes[5];
    insertAt = 4 + app0Len;
  }
  const totalExtra = segments.reduce((s, seg) => s + seg.byteLength, 0);
  const out = new Uint8Array(jpgBytes.byteLength + totalExtra);
  out.set(jpgBytes.subarray(0, insertAt), 0);
  let p = insertAt;
  for (const seg of segments) { out.set(seg, p); p += seg.byteLength; }
  out.set(jpgBytes.subarray(insertAt), p);
  return out;
}

export function extractIccProfile(bytes, type) {
  if (type === 'jpg') return extractIccFromJpeg(bytes);
  if (type === 'png') return extractIccFromPng(bytes);
  if (type === 'webp') return extractIccFromWebp(bytes);
  return null;
}

function extractIccFromJpeg(bytes) {
  const SIG = [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0x00];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  const chunks = [];
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

function extractIccFromPng(_bytes) { return null; }

function extractIccFromWebp(bytes) {
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49) return null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const t = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    const len = bytes[pos+4] | (bytes[pos+5]<<8) | (bytes[pos+6]<<16) | (bytes[pos+7]<<24);
    if (t === 'ICCP') return bytes.slice(pos + 8, pos + 8 + len);
    pos += 8 + len + (len & 1);
  }
  return null;
}

async function deflateAsync(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function injectIccIntoWebp(webpBytes, icc) {
  if (!icc || !icc.length) return webpBytes;
  if (webpBytes[0] !== 0x52 || webpBytes[1] !== 0x49) return webpBytes;
  if (String.fromCharCode(webpBytes[8], webpBytes[9], webpBytes[10], webpBytes[11]) !== 'WEBP') return webpBytes;

  const chunks = [];
  let pos = 12;
  while (pos + 8 <= webpBytes.length) {
    const t = String.fromCharCode(webpBytes[pos], webpBytes[pos+1], webpBytes[pos+2], webpBytes[pos+3]);
    const len = webpBytes[pos+4] | (webpBytes[pos+5]<<8) | (webpBytes[pos+6]<<16) | (webpBytes[pos+7]<<24);
    chunks.push({ type: t, data: webpBytes.slice(pos + 8, pos + 8 + len) });
    pos += 8 + len + (len & 1);
  }
  if (!chunks.length) return webpBytes;

  let width = 0, height = 0, hasAlpha = 0, hasAnim = 0;
  const first = chunks[0];
  if (first.type === 'VP8X') {
    width  = 1 + (first.data[4] | (first.data[5] << 8) | (first.data[6] << 16));
    height = 1 + (first.data[7] | (first.data[8] << 8) | (first.data[9] << 16));
    hasAlpha = (first.data[0] >> 4) & 1;
    hasAnim  = (first.data[0] >> 1) & 1;
  } else if (first.type === 'VP8 ') {
    const d = first.data;
    width  = (d[6] | (d[7] << 8)) & 0x3fff;
    height = (d[8] | (d[9] << 8)) & 0x3fff;
  } else if (first.type === 'VP8L') {
    const d = first.data;
    width  = 1 + (((d[1]) | (d[2] << 8)) & 0x3fff);
    height = 1 + (((d[2] >> 6) | (d[3] << 2) | (d[4] << 10)) & 0x3fff);
    hasAlpha = (d[4] >> 4) & 1;
  } else {
    return webpBytes;
  }
  if (!width || !height) return webpBytes;

  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x20 | (hasAlpha ? 0x10 : 0) | (hasAnim ? 0x02 : 0);
  vp8x[1] = 0; vp8x[2] = 0; vp8x[3] = 0;
  const w1 = width - 1, h1 = height - 1;
  vp8x[4] = w1 & 0xff; vp8x[5] = (w1 >> 8) & 0xff; vp8x[6] = (w1 >> 16) & 0xff;
  vp8x[7] = h1 & 0xff; vp8x[8] = (h1 >> 8) & 0xff; vp8x[9] = (h1 >> 16) & 0xff;

  const outChunks = [
    { type: 'VP8X', data: vp8x },
    { type: 'ICCP', data: icc },
  ];
  for (const c of chunks) {
    if (c.type === 'VP8X' || c.type === 'ICCP') continue;
    outChunks.push(c);
  }

  let bodyLen = 4;
  for (const c of outChunks) bodyLen += 8 + c.data.length + (c.data.length & 1);
  const out = new Uint8Array(8 + bodyLen);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;
  out[4] = bodyLen & 0xff; out[5] = (bodyLen >> 8) & 0xff;
  out[6] = (bodyLen >> 16) & 0xff; out[7] = (bodyLen >>> 24) & 0xff;
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
    if (l & 1) out[o++] = 0;
  }
  return out;
}

export async function injectIccIntoPng(pngBytes, icc) {
  if (!icc || !icc.length) return pngBytes;
  if (pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50) return pngBytes;
  let pos = 8;
  const ihdrLen = (pngBytes[pos]<<24) | (pngBytes[pos+1]<<16) | (pngBytes[pos+2]<<8) | pngBytes[pos+3];
  if (String.fromCharCode(pngBytes[pos+4], pngBytes[pos+5], pngBytes[pos+6], pngBytes[pos+7]) !== 'IHDR') {
    return pngBytes;
  }
  const ihdrEnd = pos + 12 + ihdrLen;

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

  const compressed = await deflateAsync(icc);
  const nameBytes = [0x69, 0x63, 0x63, 0x00];
  const dataLen = nameBytes.length + 1 + compressed.length;
  const chunk = new Uint8Array(12 + dataLen);
  chunk[0] = (dataLen >>> 24) & 0xff; chunk[1] = (dataLen >>> 16) & 0xff;
  chunk[2] = (dataLen >>> 8) & 0xff;  chunk[3] = dataLen & 0xff;
  chunk[4] = 0x69; chunk[5] = 0x43; chunk[6] = 0x43; chunk[7] = 0x50;
  let q = 8;
  chunk.set(nameBytes, q); q += nameBytes.length;
  chunk[q++] = 0;
  chunk.set(compressed, q); q += compressed.length;
  const crc = crc32Range(chunk, 4, q);
  chunk[q++] = (crc >>> 24) & 0xff; chunk[q++] = (crc >>> 16) & 0xff;
  chunk[q++] = (crc >>> 8) & 0xff;  chunk[q++] = crc & 0xff;

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

export function buildJpegIccApp2(icc) {
  const SIG = [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0x00];
  const MAX_PAYLOAD = 65519;
  const chunks = [];
  for (let p = 0; p < icc.length; p += MAX_PAYLOAD) {
    chunks.push(icc.slice(p, Math.min(p + MAX_PAYLOAD, icc.length)));
  }
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = chunks[i];
    const segLen = 2 + SIG.length + 2 + payload.length;
    const seg = new Uint8Array(4 + SIG.length + 2 + payload.length);
    seg[0] = 0xff; seg[1] = 0xe2;
    seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
    seg.set(SIG, 4);
    seg[4 + SIG.length] = i + 1;
    seg[4 + SIG.length + 1] = chunks.length;
    seg.set(payload, 4 + SIG.length + 2);
    segments.push(seg);
  }
  return segments;
}

// ============================================================
//  Per-format compression
// ============================================================

const noop = () => {};

export async function compressPng(bytes, opts, onProgress = noop) {
  if (opts.lossless) {
    onProgress(0.1);
    const bmp = await decodeImageBitmap(bytes, 'image/png');
    onProgress(0.4);
    const canvas = makeCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    onProgress(0.7);
    const out = await canvasToPngBytes(canvas);
    onProgress(1.0);
    return { data: out, stats: { width: canvas.width, height: canvas.height } };
  }
  const phaseBase = { quantize: 0, dither: 0.5, encode: 0.85 };
  const phaseWeight = { quantize: 0.5, dither: 0.35, encode: 0.15 };
  const cb = (stage, frac) => onProgress((phaseBase[stage] ?? 0) + (phaseWeight[stage] ?? 0) * frac);
  const result = pngCompress(bytes, opts, cb);
  if (result.error) throw new Error(result.error);
  return { data: result.data, stats: result.stats };
}

export async function compressJpg(bytes, opts, onProgress = noop) {
  onProgress(0.3);
  const meta = extractJpegMetadata(bytes);
  const decoded = mjDec.decode(bytes, {});
  onProgress(0.6);
  const q = opts.quality;
  const encoded = mjEnc.encode(decoded.data, decoded.width, decoded.height, {
    quality: opts.lossless ? 100 : q,
    baseline: false, arithmetic: false, progressive: true,
    optimize_coding: true, smoothing: 0, color_space: 3, quant_table: 3,
    trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false, trellis_loops: 1,
    auto_subsample: opts.lossless ? false : true,
    chroma_subsample: opts.lossless ? 1 : 2,
    separate_chroma_quality: false,
    chroma_quality: opts.lossless ? 100 : q,
  });
  const withMeta = injectJpegMetadata(new Uint8Array(encoded), meta);
  onProgress(1.0);
  return { data: withMeta, stats: { width: decoded.width, height: decoded.height } };
}

export async function compressWebp(bytes, opts, onProgress = noop) {
  onProgress(0.2);
  const decoded = wpDec.decode(bytes);
  onProgress(0.5);
  const q = opts.quality;
  const encoded = wpEnc.encode(decoded.data, decoded.width, decoded.height, {
    quality: opts.lossless ? 100 : q,
    target_size: 0, target_PSNR: 0,
    method: opts.lossless ? 6 : 4, sns_strength: 50,
    filter_strength: 60, filter_sharpness: 0, filter_type: 1, partitions: 0,
    segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
    partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100,
    lossless: opts.lossless ? 1 : 0, exact: opts.lossless ? 1 : 0,
    image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0,
    near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
  });
  onProgress(1.0);
  return { data: new Uint8Array(encoded), stats: { width: decoded.width, height: decoded.height } };
}

// ============================================================
//  Cross-format conversion (decode → resize → re-encode)
// ============================================================

export async function decodeToRGBA(bytes, type, scale = 1) {
  if (type === 'jpg') {
    const d = mjDec.decode(bytes, {});
    return resampleRGBA(new Uint8ClampedArray(d.data), d.width, d.height, scale);
  }
  if (type === 'webp') {
    const d = wpDec.decode(bytes);
    return resampleRGBA(new Uint8ClampedArray(d.data), d.width, d.height, scale);
  }
  let mime;
  if (type === 'png') mime = 'image/png';
  else if (type === 'gif') mime = 'image/gif';
  else if (type === 'svg') mime = 'image/svg+xml';
  else mime = 'image/png';

  const bmp = await decodeImageBitmap(bytes, mime);
  let w = bmp.width, h = bmp.height;
  if (!w || !h) { w = 1024; h = 1024; }
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const canvas = makeCanvas(dw, dh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, dw, dh);
  bmp.close && bmp.close();
  const imgData = ctx.getImageData(0, 0, dw, dh);
  return { data: imgData.data, width: dw, height: dh };
}

function resampleRGBA(data, w, h, scale) {
  if (scale === 1) return { data, width: w, height: h };
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const src = makeCanvas(w, h);
  src.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const dst = makeCanvas(dw, dh);
  const dctx = dst.getContext('2d');
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, dw, dh);
  const out = dctx.getImageData(0, 0, dw, dh);
  return { data: out.data, width: dw, height: dh };
}

export async function encodeRGBATo(target, rgba, width, height, opts) {
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
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imgData, 0, 0);
    let out = await canvasToPngBytes(canvas);
    if (!opts.lossless && pngCompress) {
      try {
        const q = pngCompress(out, opts, () => {});
        if (!q.error && q.data && q.data.byteLength < out.byteLength) out = q.data;
      } catch (_) { /* fall back to canvas PNG */ }
    }
    return out;
  }
  throw new Error('Unsupported target format: ' + target);
}

export async function convertTo(target, bytes, sourceType, opts, onProgress = noop) {
  onProgress(0.05);
  const icc = (sourceType === 'jpg' || sourceType === 'webp')
              ? extractIccProfile(bytes, sourceType)
              : null;
  let { data, width, height } = await decodeToRGBA(bytes, sourceType, opts.scale || 1);
  onProgress(0.5);
  let out = await encodeRGBATo(target, data, width, height, opts);
  onProgress(0.85);
  if (icc && icc.length) {
    try {
      if (target === 'webp')      out = injectIccIntoWebp(out, icc);
      else if (target === 'png')  out = await injectIccIntoPng(out, icc);
      else if (target === 'jpg')  out = injectJpegMetadata(out, buildJpegIccApp2(icc));
    } catch (e) {
      // Non-fatal: ship the file without the re-embedded profile.
    }
  }
  onProgress(1.0);
  return { data: out, stats: { width, height } };
}
