const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function uint32BE(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t   = Buffer.from(type, 'ascii');
  const crc = uint32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([uint32BE(data.length), t, data, crc]);
}

function makePng(size, bg, fg) {
  const SIG  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: RGB truecolour

  const cx = size / 2, cy = size / 2;
  const stride = 1 + size * 3;  // filter byte + 3 channels per pixel
  const raw  = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;  // PNG filter: None
    for (let x = 0; x < size; x++) {
      const dist  = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      const outer = size * 0.44;
      const inner = size * 0.30;
      const color = (dist <= outer && dist >= inner) ? fg : bg;
      const p = y * stride + 1 + x * 3;
      raw[p] = color[0]; raw[p + 1] = color[1]; raw[p + 2] = color[2];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const BG = [6, 10, 16];        // #060a10  deep-space background
const FG = [99, 180, 255];     // #63b4ff  ice-blue ring ("O")

const OUT = path.join(__dirname, 'pwa');
fs.writeFileSync(path.join(OUT, 'icon-192.png'), makePng(192, BG, FG));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), makePng(512, BG, FG));
console.log('icon-192.png', fs.statSync(path.join(OUT, 'icon-192.png')).size, 'bytes');
console.log('icon-512.png', fs.statSync(path.join(OUT, 'icon-512.png')).size, 'bytes');
