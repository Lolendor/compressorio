# Compressor — in-browser image compressor

### → [Try it live](https://lolendor.github.io/compressorio/)

A standalone web app that replicates compressor.io entirely in the browser.
Drop PNG/JPG/WebP/GIF/SVG, get byte-for-byte identical output (for JPG and
GIF — literally to the byte), with **no backend** and **no upload anywhere**.

## Deploy on GitHub Pages (1 minute)

1. Create a new GitHub repo (any name, public or private).
2. Drop **all the files in this folder** into the repo root and push.
3. Go to **Settings → Pages**.
4. Either:
   - **Branch deploy**: Source = `Deploy from a branch`, branch = `main`,
     folder = `/ (root)`. Click Save.
   - **Actions deploy** (more reliable, see `.github/workflows/pages.yml`):
     Source = `GitHub Actions`. The workflow auto-triggers on push.
5. Wait ~30 seconds and visit `https://<your-user>.github.io/<repo-name>/`.

No build step, no Node.js, no server config.

## Three compression modes

- **LOSSY** (default) — compressor.io's own settings. JPG q=70, WebP q=70,
  GIF `-O3 --lossy=80`, PNG palette quantization (Wu+FS).
- **LOSSLESS** — guaranteed no quality loss. If a file would grow rather
  than shrink (typical for already-compressed JPGs/WebPs), the **original
  bytes are kept** instead — so you'll never end up with a bigger file.
    - PNG: re-encoded via Canvas as pure-lossless PNG.
    - JPG: q=100, no chroma subsampling.
    - WebP: `lossless: 1`.
    - GIF: only frame differencing (`-O3`).
    - SVG: always lossless.
- **CUSTOM** — show all sliders and tune by hand. No smart fallback here:
  whatever your sliders produce, that's what you get.

## Files

| File | Size | What it is |
|---|---:|---|
| `index.html` | ~9 KB | UI markup. |
| `style.css` | ~19 KB | Styles. |
| `app.js` | ~60 KB | App logic + worker pool. |
| `codec-core.js` | ~19 KB | Shared compression core (main + worker). |
| `worker.js` | ~4 KB | Web Worker for parallel raster compression. |
| `codecs/png/wasm_exec.js` | ~17 KB | TinyGo runtime glue. |
| `codecs/png/compressor.wasm` | ~420 KB | TinyGo PNG compressor (Wu + Floyd-Steinberg). |
| `codecs/jpeg/mozjpeg_*` | ~490 KB | mozjpeg encode + decode (WASM). |
| `codecs/webp/webp_*` | ~490 KB | libwebp encode + decode (WASM). |
| `codecs/gif/gifsicle.min.js` | ~340 KB | gifsicle (inline WASM). |
| `codecs/svg/svgo.browser.js` | ~890 KB | SVGO 3 (pure JS). |
| `.nojekyll` | 0 B | Don't filter underscored files. |
| `.github/workflows/pages.yml` | — | Auto-deploy workflow. |

Total: ~2.6 MB raw, ~1.0 MB gzip. Works fully offline after first paint.

The PNG compressor is built with **TinyGo** (not the standard Go
toolchain), which shrinks the wasm from ~2.7 MB down to ~420 KB
(~160 KB gzipped) for byte-identical output.

## Local preview

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Algorithm matching with compressor.io

| Format | What we use | Match |
|---|---|---|
| PNG  | Wu's color quantizer + Floyd-Steinberg | Identical to pngquant |
| JPG  | mozjpeg `-quality 70 -progressive` | **BYTE-EXACT** |
| WebP | libwebp `cwebp -q 70` | Within ~1% |
| GIF  | gifsicle `-O3 --lossy=80` | **BYTE-EXACT** |
| SVG  | SVGO 3 `preset-default + multipass` | Within ~5 bytes |

## Credits

- mozjpeg, libwebp WASM: [@jsquash/jpeg](https://github.com/jamsinclair/jSquash), [@jsquash/webp](https://github.com/jamsinclair/jSquash).
- gifsicle WASM: [renzhezhilu/gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser).
- SVGO 3: [svg/svgo](https://github.com/svg/svgo).
- pngquant algorithm reimplemented in Go, compiled to wasm with TinyGo.

UI design heavily inspired by [compressor.io](https://compressor.io/).

## License

Licensed under the **GNU General Public License v3.0 (or later)** —
see [LICENSE](LICENSE). You're free to use, modify and redistribute,
provided that derivatives stay open-source under the same license and
keep the original author attribution. Bundled codecs retain their own
licenses (BSD / MIT / GPL); see the LICENSE file for the full list.
