// Baixa as bibliotecas e o modelo COCO-SSD para public/vendor, permitindo rodar a demo sem internet.
// Uso: npm run offline
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', 'public', 'vendor');
const MODELO_URL = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssd_mobilenet_v2';
const LIBS = {
  'tf.min.js': 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  'coco-ssd.min.js': 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
  'jsQR.min.js': 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
};

async function baixar(url, destino) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ao baixar ${url}`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  console.log('  ✓', path.relative(process.cwd(), destino));
}

(async () => {
  console.log('Baixando bibliotecas…');
  for (const [nome, url] of Object.entries(LIBS)) await baixar(url, path.join(VENDOR, nome));

  console.log('Baixando modelo COCO-SSD (mobilenet_v2, ~65 MB)…');
  const dirModelo = path.join(VENDOR, 'ssd_mobilenet_v2');
  await baixar(`${MODELO_URL}/model.json`, path.join(dirModelo, 'model.json'));
  const manifesto = JSON.parse(fs.readFileSync(path.join(dirModelo, 'model.json'), 'utf8'));
  for (const arquivo of manifesto.weightsManifest.flatMap((m) => m.paths)) {
    await baixar(`${MODELO_URL}/${arquivo}`, path.join(dirModelo, arquivo));
  }
  console.log('\nPronto! A estação da lixeira agora funciona offline.');
})().catch((e) => {
  console.error('\nFalha:', e.message);
  process.exit(1);
});
