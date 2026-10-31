const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'static');
const dest = path.join(__dirname, '..', 'dist', 'static');

fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
}
console.log('copied static → dist/static');
