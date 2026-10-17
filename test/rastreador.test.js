// Testes do rastreador simulando quadros de vídeo a ~10 fps (rode com: npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rastreador, iou } = require('../public/rastreador.js');

const ZONA = { x: 0, y: 0, w: 1000, h: 800 };
const QUADRO_MS = 100;

// Executa uma sequência de quadros; cada quadro é uma lista de detecções.
// Depois roda quadros vazios suficientes para as trilhas expirarem.
function simular(quadros, { alvo = ['bottle'], opts = {} } = {}) {
  const r = new Rastreador(opts);
  const finalizados = [];
  let t = 0;
  for (const dets of [...quadros, ...Array(10).fill([])]) {
    finalizados.push(...r.atualizar(dets, ZONA, t, alvo).finalizados);
    t += QUADRO_MS;
  }
  return finalizados.map((f) => f.decisao);
}

const garrafa = (x, y, score = 0.8, cls = 'bottle') => ({ bbox: [x, y, 80, 200], class: cls, score });

// Garrafa entrando pelo topo e descendo dy px por quadro
const descendo = (n, { x = 400, y0 = 100, dy = 40, cls, score } = {}) =>
  Array.from({ length: n }, (_, i) => [garrafa(x, y0 + i * dy, score, cls)]);

test('iou básico', () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(iou([0, 0, 10, 10], [20, 20, 10, 10]), 0);
});

test('garrafa que desce para dentro da lixeira conta 1', () => {
  assert.deepEqual(simular(descendo(10)), ['contado']);
});

test('garrafa mostrada e retirada (sem descer) não conta', () => {
  const parada = Array.from({ length: 15 }, () => [garrafa(400, 250)]);
  assert.deepEqual(simular(parada), ['retirado']);
});

test('sem a exigência de descida, item parado que some conta', () => {
  const parada = Array.from({ length: 15 }, () => [garrafa(400, 250)]);
  assert.deepEqual(simular(parada, { opts: { exigirDescida: false } }), ['contado']);
});

test('falhas momentâneas da detecção não duplicam a contagem', () => {
  const q = descendo(12);
  q[4] = [];
  q[5] = [];
  q[8] = [];
  assert.deepEqual(simular(q), ['contado']);
});

test('queda rápida sem sobreposição entre quadros continua sendo 1 objeto', () => {
  assert.deepEqual(simular(descendo(4, { y0: 0, dy: 210 })), ['contado']);
});

test('duas garrafas ao mesmo tempo contam 2', () => {
  const q = Array.from({ length: 10 }, (_, i) => [garrafa(150, 100 + i * 40), garrafa(700, 120 + i * 40)]);
  assert.deepEqual(simular(q), ['contado', 'contado']);
});

test('duas garrafas em sequência contam 2', () => {
  const q = [...descendo(8), [], [], [], [], [], [], [], [], ...descendo(8, { x: 300 })];
  assert.deepEqual(simular(q), ['contado', 'contado']);
});

test('material diferente do declarado não conta', () => {
  assert.deepEqual(simular(descendo(10, { cls: 'cell phone' })), ['material']);
});

test('detecção de um único quadro é descartada como ruído', () => {
  assert.deepEqual(simular([[garrafa(400, 300)]]), ['ruido']);
});

test('sem sessão ativa nada é finalizado', () => {
  assert.deepEqual(simular(descendo(10), { alvo: null }), []);
});

test('classe oscilando garrafa/copo vence a maioria ponderada', () => {
  const q = descendo(10).map((dets, i) => (i % 3 === 2 ? [{ ...dets[0], class: 'cup', score: 0.55 }] : dets));
  assert.deepEqual(simular(q), ['contado']);
  assert.deepEqual(simular(q, { alvo: ['cup'] }), ['material']);
});

test('histerese: trilha iniciada com confiança alta se mantém com confiança média', () => {
  const q = descendo(10).map((dets, i) => (i === 0 ? dets : [{ ...dets[0], score: 0.35 }]));
  assert.deepEqual(simular(q), ['contado']);
});

test('objeto que só aparece com confiança baixa não inicia trilha', () => {
  assert.deepEqual(simular(descendo(10, { score: 0.35 })), []);
});

test('pessoa é ignorada', () => {
  assert.deepEqual(simular(descendo(10, { cls: 'person' })), []);
});
