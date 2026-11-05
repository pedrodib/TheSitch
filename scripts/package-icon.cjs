// Package the generated PNG sizes into the macOS ICNS container, without changing pixels.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'build');
const sizes = { icp4: '16x16', icp5: '32x32', icp6: '32x32@2x', ic07: '128x128', ic08: '256x256', ic09: '512x512', ic10: '512x512@2x', ic11: '16x16@2x', ic12: '32x32@2x', ic13: '128x128@2x', ic14: '256x256@2x' };
const chunks = Object.entries(sizes).map(([type, size]) => {
  const png = fs.readFileSync(path.join(root, 'icon.iconset', `icon_${size}.png`));
  const header = Buffer.alloc(8); header.write(type, 0, 'ascii'); header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8); header.write('icns', 0, 'ascii'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
fs.writeFileSync(path.join(root, 'icon.icns'), Buffer.concat([header, ...chunks]));
