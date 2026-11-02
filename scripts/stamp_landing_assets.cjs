const fs = require('fs');
const path = require('path');
const V = JSON.parse(fs.readFileSync('package.json','utf8')).version;
const countries = JSON.parse(fs.readFileSync('landing/data/countries.json','utf8')).countries;
const bootMap = {};
for (const [c, e] of Object.entries(countries)) bootMap[c] = { name: e.name, calling: e.calling, locale: e.locale };
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])); }
for (const f of walk('landing')) {
  if (!/\.(html|css)$/.test(f)) continue;
  let t = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    t = t.replace(/(href|src)="(\/assets\/(?:css|js)\/[^"?]+\.(?:css|js))\?v=[0-9.]+/g, '$1="$2?v=' + V);
    if (f.endsWith('index.html')) t = t.replace(/var m=\{.*\};/, 'var m=' + JSON.stringify(bootMap) + ';');
  } else if (f.endsWith('styles.css')) {
    t = t.replace(/\/assets\/fonts\/([A-Za-z0-9-]+\.woff2)(\?v=[0-9.]+)?/g, '/assets/fonts/$1?v=' + V);
  }
  fs.writeFileSync(f, t);
}
console.log('Landing assets stamped to v' + V);
