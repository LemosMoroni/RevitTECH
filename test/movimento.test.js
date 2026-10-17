// Testes do detector de passagem (câmera na boca da lixeira) — rode com: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { DetectorMovimento, decidirPassagem } = require('../public/movimento.js');

const LADO = 64;
const QUADRO_MS = 33; // ~30 fps

// Quadro escuro (interior da lixeira) com um objeto claro opcional (coordenadas da grade 64×64)
function quadro(obj, fundo = 40) {
  const q = new Uint8Array(LADO * LADO).fill(fundo);
  if (obj) {
    for (let y = Math.max(0, obj.y); y < Math.min(LADO, obj.y + obj.h); y++)
      for (let x = Math.max(0, obj.x); x < Math.min(LADO, obj.x + obj.w); x++) q[y * LADO + x] = 200;
  }
  return q;
}

function rodar(sequencia) {
  const m = new DetectorMovimento();
  const eventos = [];
  let t = 0;
  for (const obj of [null, null, null, ...sequencia, ...Array(15).fill(null)]) {
    const r = m.processar(typeof obj === 'number' ? quadro(null, obj) : quadro(obj), t);
    if (r.finalizado) eventos.push(r.finalizado);
    t += QUADRO_MS;
  }
  return eventos;
}

// Garrafa (10×24) caindo pela boca: atravessa a imagem em ~8 quadros (~0,27 s)
const queda = Array.from({ length: 9 }, (_, i) => ({ x: 27, y: -24 + i * 11, w: 10, h: 24 }));
// Fraude: entra pela parte de cima, para no meio e volta
const fraude = [...Array.from({ length: 6 }, (_, i) => ({ x: 27, y: -20 + i * 6, w: 10, h: 24 })),
  ...Array(5).fill({ x: 27, y: 10, w: 10, h: 24 }),
  ...Array.from({ length: 6 }, (_, i) => ({ x: 27, y: 10 - i * 6, w: 10, h: 24 }))];

test('queda rápida gera exatamente uma passagem, com trajetória descendo', () => {
  const evs = rodar(queda);
  assert.equal(evs.length, 1);
  const p = evs[0].pontos;
  assert.ok(p[p.length - 1].cy - p[0].cy > 0.3, 'centro do movimento deve descer');
  assert.ok(evs[0].fim - evs[0].inicio < 500, 'passagem curta');
});

test('duas quedas separadas geram duas passagens', () => {
  assert.equal(rodar([...queda, ...Array(10).fill(null), ...queda]).length, 2);
});

test('ruído de um único quadro não gera passagem', () => {
  assert.equal(rodar([{ x: 5, y: 5, w: 12, h: 12 }]).length, 0);
});

test('mudança de luz na imagem toda não gera passagem', () => {
  assert.equal(rodar([120, 120, 120, 120, 120]).length, 0);
});

test('fantasma: objeto presente no 1º quadro some do fundo em menos de 1,5 s', () => {
  const m = new DetectorMovimento();
  let t = 0;
  m.processar(quadro({ x: 27, y: 20, w: 10, h: 24 }), t); // fundo inicial com uma garrafa
  let ultimo;
  for (let i = 0; i < 45; i++) { t += QUADRO_MS; ultimo = m.processar(quadro(null), t); }
  assert.ok(ultimo.fracao < 0.005, `fantasma ainda presente: ${ultimo.fracao}`);
  assert.equal(m.evento, null);
  // e uma queda depois disso é detectada normalmente
  const evs = [];
  for (const obj of [...queda, ...Array(15).fill(null)]) { t += QUADRO_MS; const r = m.processar(quadro(obj), t); if (r.finalizado) evs.push(r.finalizado); }
  assert.equal(evs.length, 1);
});

test('fraude com pausa de 300 ms continua sendo uma única passagem (não é absorvida)', () => {
  const evs = rodar(fraude);
  assert.equal(evs.length, 1);
  const p = evs[0].pontos;
  assert.ok(p[p.length - 1].cy < 0.35, 'termina perto do topo');
});

const det = (t, cy, cls = 'bottle', score = 0.8) => ({ t, class: cls, score, bbox: [0.4, cy - 0.15, 0.15, 0.3] });
const pontos = (cys) => cys.map((cy, i) => ({ t: i * 33, cx: 0.5, cy }));

test('garrafa caindo é contada', () => {
  const ev = { pontos: pontos([0.1, 0.3, 0.6, 0.9]), dets: [det(33, 0.3), det(66, 0.6)] };
  const r = decidirPassagem(ev, ['bottle']);
  assert.equal(r.decisao, 'contado');
  assert.equal(r.quantidade, 1);
});

test('uma única detecção basta quando o movimento mostra a queda', () => {
  const ev = { pontos: pontos([0.1, 0.4, 0.8, 0.95]), dets: [det(33, 0.4, 'bottle', 0.62)] };
  assert.equal(decidirPassagem(ev, ['bottle']).decisao, 'contado');
});

test('garrafa que entra e volta (fraude) é retirada', () => {
  const ev = { pontos: pontos([0.1, 0.3, 0.45, 0.45, 0.3, 0.1]), dets: [det(66, 0.45), det(99, 0.45)] };
  assert.equal(decidirPassagem(ev, ['bottle']).decisao, 'retirado');
});

test('fraude: IA vê o item descendo, mas o movimento mostra que ele saiu por cima', () => {
  // detecções só na entrada e na pausa (a volta borrada não é detectada)
  const ev = { pontos: pontos([0.1, 0.3, 0.45, 0.45, 0.45, 0.3, 0.15, 0.05]), dets: [det(33, 0.15, 'bottle', 0.5), det(99, 0.45, 'bottle', 0.55)] };
  assert.equal(decidirPassagem(ev, ['bottle']).decisao, 'retirado');
});

test('sem a exigência de descida, a mesma passagem conta', () => {
  const ev = { pontos: pontos([0.1, 0.45, 0.1]), dets: [det(33, 0.45)] };
  assert.equal(decidirPassagem(ev, ['bottle'], { exigirDescida: false }).decisao, 'contado');
});

test('material diferente é rejeitado', () => {
  const ev = { pontos: pontos([0.1, 0.9]), dets: [det(33, 0.5, 'cell phone', 0.9)] };
  const r = decidirPassagem(ev, ['bottle']);
  assert.equal(r.decisao, 'material');
  assert.equal(r.classe, 'cell phone');
});

test('outro material dominando a votação vence uma confusão isolada', () => {
  const ev = { pontos: pontos([0.1, 0.9]), dets: [det(33, 0.3, 'cell phone', 0.9), det(66, 0.5, 'cell phone', 0.85), det(99, 0.7, 'bottle', 0.5)] };
  assert.equal(decidirPassagem(ev, ['bottle']).decisao, 'material');
});

test('movimento sem objeto reconhecido (ex.: só a mão) não conta', () => {
  const ev = { pontos: pontos([0.1, 0.5]), dets: [{ t: 33, class: 'person', score: 0.9, bbox: [0, 0, 1, 1] }] };
  assert.equal(decidirPassagem(ev, ['bottle']).decisao, 'nao-reconhecido');
});

test('duas garrafas no mesmo quadro contam 2', () => {
  const ev = { pontos: pontos([0.1, 0.9]), dets: [det(33, 0.3), { ...det(33, 0.35), bbox: [0.1, 0.2, 0.15, 0.3] }, det(66, 0.6)] };
  assert.equal(decidirPassagem(ev, ['bottle']).quantidade, 2);
});

test('lata aceita copo ou garrafa', () => {
  const ev = { pontos: pontos([0.1, 0.9]), dets: [det(33, 0.4, 'cup', 0.7)] };
  assert.equal(decidirPassagem(ev, ['cup', 'bottle']).decisao, 'contado');
});
