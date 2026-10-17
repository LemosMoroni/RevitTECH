// Detecção de passagem para câmera na boca da lixeira.
//
// DetectorMovimento: diferença de quadros em baixa resolução (64×64), roda em todo quadro da câmera
// (30–60 fps). Delimita cada "passagem" (algo entrou na boca e saiu) e guarda a trajetória do movimento.
//
// decidirPassagem: com as detecções da IA feitas durante a passagem (ao vivo + quadros do buffer),
// decide se o item foi contado, retirado, se é outro material ou se não foi reconhecido.

const PADRAO_MOV = {
  lado: 64,             // grade de análise (lado × lado)
  limiarPixel: 28,      // diferença de cinza para considerar um pixel "em movimento"
  fracInicio: 0.012,    // fração de pixels em movimento para iniciar uma passagem
  fracFim: 0.005,       // abaixo disso a cena está "quieta"
  quadrosInicio: 2,     // quadros seguidos acima do limiar para iniciar (evita ruído)
  msFim: 140,           // tempo quieto para encerrar a passagem
  msMax: 5000,          // passagem mais longa que isso é encerrada à força
  aprendizado: 0.06,    // velocidade com que o fundo se adapta (pixels parados)
  aprendizadoMov: 0.004,// adaptação lenta onde há movimento
  msEstatico: 800,      // pixel diferente do fundo mas parado há esse tempo = fantasma/objeto parado
  aprendizadoEstatico: 0.35, // ... e é absorvido rápido no fundo
  fracGlobal: 0.65,     // mudança na imagem toda = luz/exposição mudou → reaprende o fundo
};

class DetectorMovimento {
  constructor(opts = {}) {
    this.o = { ...PADRAO_MOV, ...opts };
    this.reiniciar();
  }

  reiniciar() {
    this.fundo = null;
    this.evento = null;
    this.acima = 0;
    this.quietoDesde = 0;
    this.seq = this.seq || 0;
  }

  // cinza: Uint8Array (lado × lado) com a zona em tons de cinza
  processar(cinza, agora) {
    const { lado, limiarPixel } = this.o;
    const n = lado * lado;
    if (!this.fundo || this.fundo.length !== n) {
      this.fundo = Float32Array.from(cinza);
      this.anterior = Uint8Array.from(cinza);
      this.estaticoDesde = new Float64Array(n).fill(agora);
      this.mascara = new Uint8Array(n);
      return { fracao: 0, centro: null, caixa: null, iniciou: null, finalizado: null };
    }

    let cont = 0, sx = 0, sy = 0, x0 = lado, y0 = lado, x1 = -1, y1 = -1;
    for (let i = 0; i < n; i++) {
      // há quanto tempo este pixel não muda de um quadro para o outro
      if (Math.abs(cinza[i] - this.anterior[i]) > limiarPixel * 0.5) this.estaticoDesde[i] = agora;
      if (Math.abs(cinza[i] - this.fundo[i]) > limiarPixel) {
        this.mascara[i] = 1;
        cont++;
        const x = i % lado;
        const y = (i / lado) | 0;
        sx += x; sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      } else {
        this.mascara[i] = 0;
      }
    }
    const fracao = cont / n;

    // mudança global (exposição automática, alguém apagou a luz): reaprende sem gerar passagem
    if (fracao >= this.o.fracGlobal) {
      this.fundo.set(cinza);
      return { fracao, centro: null, caixa: null, iniciou: null, finalizado: null, global: true };
    }

    for (let i = 0; i < n; i++) {
      let a = this.o.aprendizado;
      if (this.mascara[i]) a = agora - this.estaticoDesde[i] >= this.o.msEstatico ? this.o.aprendizadoEstatico : this.o.aprendizadoMov;
      this.fundo[i] += (cinza[i] - this.fundo[i]) * a;
    }
    this.anterior.set(cinza);

    const centro = cont ? [(sx / cont + 0.5) / lado, (sy / cont + 0.5) / lado] : null;
    const caixa = cont ? [x0 / lado, y0 / lado, (x1 - x0 + 1) / lado, (y1 - y0 + 1) / lado] : null;
    let iniciou = null;
    let finalizado = null;

    if (!this.evento) {
      this.acima = fracao >= this.o.fracInicio ? this.acima + 1 : 0;
      if (this.acima >= this.o.quadrosInicio) {
        this.evento = { id: ++this.seq, inicio: agora, fim: null, pontos: [], maxFracao: 0, dets: [] };
        this.quietoDesde = 0;
        iniciou = this.evento;
      }
    }

    if (this.evento) {
      const ev = this.evento;
      if (fracao >= this.o.fracFim) {
        this.quietoDesde = 0;
        ev.pontos.push({ t: agora, cx: centro[0], cy: centro[1], fracao, caixa });
        if (fracao > ev.maxFracao) ev.maxFracao = fracao;
      } else if (!this.quietoDesde) {
        this.quietoDesde = agora;
      }
      const quieto = this.quietoDesde && agora - this.quietoDesde >= this.o.msFim;
      if (quieto || agora - ev.inicio > this.o.msMax) {
        ev.fim = this.quietoDesde || agora;
        finalizado = ev;
        this.evento = null;
        this.quietoDesde = 0;
        this.acima = 0;
      }
    }

    return { fracao, centro, caixa, iniciou, finalizado };
  }
}

const IGNORAR_PASSAGEM = new Set(['person', 'chair', 'couch', 'bed', 'dining table', 'tv', 'laptop', 'refrigerator', 'oven', 'toilet', 'bench']);
const normalizarClasse = (c) => (c === 'wine glass' ? 'cup' : c);

// ev.dets: [{ t, class, score, bbox: [x, y, w, h] normalizado 0..1 na zona }]
// ev.pontos: trajetória do movimento [{ t, cx, cy }] normalizada 0..1 na zona
function decidirPassagem(ev, alvo, opts = {}) {
  const conf = opts.confianca ?? 0.45;
  const exigirDescida = opts.exigirDescida ?? true;
  const dets = ev.dets
    .map((d) => ({ ...d, class: normalizarClasse(d.class) }))
    .filter((d) => !IGNORAR_PASSAGEM.has(d.class) && d.score >= conf * 0.8);

  const votos = {};
  for (const d of dets) votos[d.class] = (votos[d.class] || 0) + d.score;
  const alvoDets = dets.filter((d) => alvo.includes(d.class) && d.score >= conf);

  if (!alvoDets.length) {
    const outros = dets.filter((d) => d.score >= conf);
    if (!outros.length) return { decisao: 'nao-reconhecido', quantidade: 0 };
    const classe = Object.keys(votos).sort((a, b) => votos[b] - votos[a])[0];
    const ds = outros.filter((d) => d.class === classe);
    return { decisao: 'material', classe, score: Math.max(...ds.map((d) => d.score), 0), quantidade: 0 };
  }

  // Outro material domina claramente a votação (ex.: celular confundido 1 vez com garrafa)
  const votoAlvo = alvo.reduce((s, c) => s + (votos[c] || 0), 0);
  const [classeTop] = Object.keys(votos).sort((a, b) => votos[b] - votos[a]);
  if (!alvo.includes(classeTop) && votos[classeTop] > votoAlvo * 1.5) {
    return { decisao: 'material', classe: classeTop, score: votos[classeTop] / dets.filter((d) => d.class === classeTop).length, quantidade: 0 };
  }

  // Quantidade: maior número de itens do material vistos no mesmo quadro
  const porQuadro = {};
  for (const d of alvoDets) porQuadro[d.t] = (porQuadro[d.t] || 0) + 1;
  const quantidade = Math.max(...Object.values(porQuadro));
  const melhor = alvoDets.reduce((a, b) => (b.score > a.score ? b : a));
  const resultado = { classe: melhor.class, score: melhor.score, quantidade, melhor };

  if (exigirDescida) {
    const dir = direcaoPassagem(ev, alvoDets);
    resultado.direcao = dir;
    if (!dir.desceu) return { ...resultado, decisao: 'retirado', quantidade: 0 };
  }
  return { ...resultado, decisao: 'contado' };
}

// O item precisa atravessar a boca para baixo. Usa as posições do item detectado pela IA
// e a trajetória do movimento (muito mais amostras quando o item cai rápido).
function direcaoPassagem(ev, alvoDets) {
  const ord = [...alvoDets].sort((a, b) => a.t - b.t);
  const cy = (d) => d.bbox[1] + d.bbox[3] / 2;
  let dyDet = null;
  if (ord.length >= 2 && ord[ord.length - 1].t > ord[0].t) dyDet = cy(ord[ord.length - 1]) - cy(ord[0]);
  const p = ev.pontos;
  let dyMov = 0;
  let cyFinal = 0.5;
  if (p.length >= 2) {
    dyMov = p[p.length - 1].cy - p[0].cy;
    cyFinal = p[p.length - 1].cy;
  }
  // O movimento tem a palavra final: se a última coisa vista saiu pela parte de cima, o item voltou
  // (a IA costuma perder o item borrado na volta, então as detecções sozinhas parecem "descer").
  const saiuPorCima = p.length >= 2 && cyFinal < 0.4 && dyMov <= 0.05;
  const desceu = !saiuPorCima && (dyMov >= 0.12 || (cyFinal >= 0.6 && dyMov >= 0.03) || (dyDet !== null && dyDet >= 0.08 && cyFinal >= 0.4));
  return { desceu, saiuPorCima, dyDet, dyMov, cyFinal };
}

// Nitidez da área em movimento (energia de bordas na grade 64×64): quadros borrados pontuam pouco
function nitidezQuadro(cinza, lado, caixa) {
  if (!caixa) return 0;
  const x0 = Math.max(0, Math.floor(caixa[0] * lado));
  const y0 = Math.max(0, Math.floor(caixa[1] * lado));
  const x1 = Math.min(lado - 2, Math.ceil((caixa[0] + caixa[2]) * lado));
  const y1 = Math.min(lado - 2, Math.ceil((caixa[1] + caixa[3]) * lado));
  let s = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * lado + x;
      s += Math.abs(cinza[i] - cinza[i + 1]) + Math.abs(cinza[i] - cinza[i + lado]);
      n++;
    }
  }
  return n ? s / n : 0;
}

if (typeof module !== 'undefined') module.exports = { DetectorMovimento, decidirPassagem, direcaoPassagem, nitidezQuadro };
