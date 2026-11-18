// Generate the tiny app icon without an image dependency.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const size = 128;
const scanlines = [];
for (let y = 0; y < size; y++) {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    const inSquare = x >= 8 && x < 120 && y >= 8 && y < 120;
    const inCircle = (x - 64) ** 2 + (y - 64) ** 2 < 30 ** 2;
    const rgba = !inSquare ? [0, 0, 0, 0] : inCircle ? [255, 255, 255, 255] : [87, 68, 223, 255];
    row.set(rgba, 1 + x * 4);
  }
  scanlines.push(row);
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, bytes, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
header[8] = 8; header[9] = 6;
mkdirSync('src-tauri/icons', { recursive: true });
writeFileSync('src-tauri/icons/icon.png', Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(scanlines))), chunk('IEND', Buffer.alloc(0))
]));
