import sharp from 'sharp';
const svg = (size, pad) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="${pad ? 0 : 22}" fill="#F4F7FE"/><g transform="translate(${pad ? 24 : 16} ${pad ? 33 : 29}) scale(${pad ? 0.74 : 0.97})" fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 25L17 37L39 9" stroke="#246BFD"/><path d="M23 27L35 39L61 9" stroke="#13B9B0"/></g></svg>`);
for (const [name, size, pad] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, false]]) await sharp(svg(size, pad)).png().toFile(`public/${name}`);
console.log('icons written');
