// Inline src/ into one self-contained index.html (works from file:// and any static host).
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
const parts = { STYLE: read('style.css'), SYNTH: read('synth.js'), ENGINE: read('engine.js'), SCENES: read('scenes.js'), MAIN: read('main.js') };
for (const [k, v] of Object.entries(parts)) if (/<\/script/i.test(v)) throw new Error(`${k} contains a closing script tag`);
let html = read('template.html');
for (const [k, v] of Object.entries(parts)) html = html.replace(`/*${k}*/`, () => v.trim());
fs.writeFileSync(new URL('./index.html', import.meta.url), html);
console.log(`index.html  ${(html.length / 1024).toFixed(1)} KB`);
