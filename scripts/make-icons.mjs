import { chromium } from 'playwright';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" fill="#16131a"/>
<g transform="translate(256 256) scale(${pad}) translate(-256 -256)">
<circle cx="256" cy="256" r="150" fill="#f0a05a"/>
<circle cx="316" cy="216" r="130" fill="#16131a"/>
<circle cx="350" cy="330" r="22" fill="#9c8cf0"/><circle cx="395" cy="270" r="14" fill="#6cc4b0"/>
</g></svg>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 512, height: 512 } });
for (const [name, scale, size] of [['icon-512', 1.15, 512], ['icon-512-maskable', 0.85, 512], ['icon-192', 1.15, 192]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg(scale)}`);
  await p.screenshot({ path: `app/icons/${name}.png` });
}
await b.close();
