const fs = require('fs');
const https = require('https');
const zlib = require('zlib');

// PlantUML text encoding (uses custom base64)
function encode64(data) {
  let r = '';
  for (let i = 0; i < data.length; i += 3) {
    if (i + 2 === data.length) {
      r += append3bytes(data[i], data[i + 1], 0);
    } else if (i + 1 === data.length) {
      r += append3bytes(data[i], 0, 0);
    } else {
      r += append3bytes(data[i], data[i + 1], data[i + 2]);
    }
  }
  return r;
}

function encode6bit(b) {
  if (b < 10) return String.fromCharCode(48 + b);
  b -= 10;
  if (b < 26) return String.fromCharCode(65 + b);
  b -= 26;
  if (b < 26) return String.fromCharCode(97 + b);
  b -= 26;
  if (b === 0) return '-';
  if (b === 1) return '_';
  return '?';
}

function append3bytes(b1, b2, b3) {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return (
    encode6bit(c1 & 0x3f) + encode6bit(c2 & 0x3f) + encode6bit(c3 & 0x3f) + encode6bit(c4 & 0x3f)
  );
}

const pumlSource = fs.readFileSync('pipeline-diagram.puml', 'utf-8');
const deflated = zlib.deflateRawSync(Buffer.from(pumlSource, 'utf-8'));
const encoded = encode64(deflated);

const format = process.argv[2] || 'svg';
const url = `https://www.plantuml.com/plantuml/${format}/${encoded}`;
console.log('Fetching from PlantUML server...');
console.log('URL length:', url.length);

https
  .get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error('HTTP error:', res.statusCode);
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.error(body);
        process.exit(1);
      });
      return;
    }
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const data = Buffer.concat(chunks);
      const ext = format === 'png' ? 'png' : 'svg';
      const outFile = `pipeline-diagram.${ext}`;
      fs.writeFileSync(outFile, data);
      console.log(`Saved ${outFile} (${data.length} bytes)`);
    });
  })
  .on('error', (e) => {
    console.error('Request failed:', e.message);
    process.exit(1);
  });
