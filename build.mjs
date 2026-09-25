// Inline src/ into one self-contained index.html (works from file:// and any static host).
// `node build.mjs --fragment <out>` also writes a body-only variant for hosts that supply their own document shell.
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
const parts = { STYLE: read('style.css'), SYNTH: read('synth.js'), ENGINE: read('engine.js'), SCENES: read('scenes.js'), MAIN: read('main.js') };
for (const [k, v] of Object.entries(parts)) if (/<\/script/i.test(v)) throw new Error(`${k} contains a closing script tag`);
const fill = (tpl) => { for (const [k, v] of Object.entries(parts)) tpl = tpl.replace(`/*${k}*/`, () => v.trim()); return tpl; };
const html = fill(read('template.html'));
fs.writeFileSync(new URL('./index.html', import.meta.url), html);
console.log(`index.html  ${(html.length / 1024).toFixed(1)} KB`);
const i = process.argv.indexOf('--fragment');
if (i > 0) {
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'))
    .replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '').replace(/<link rel="icon"[^>]*>\s*/, '');
  const title = (head.match(/<title>.*?<\/title>/) || [''])[0];
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  const frag = title + '\n' + head.replace(title, '').trim() + '\n' + body.trim() + '\n';
  fs.writeFileSync(process.argv[i + 1], frag);
  console.log(`${process.argv[i + 1]}  ${(frag.length / 1024).toFixed(1)} KB`);
}
