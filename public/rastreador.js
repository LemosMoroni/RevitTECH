// Rastreador multi-objeto para a estação da lixeira.
// Recebe as detecções de cada quadro, associa-as a "trilhas" (um objeto físico ao longo do tempo)
// e decide, quando o objeto some, se ele realmente entrou na lixeira.
//
// Decisões ao encerrar uma trilha:
//   'contado'  → objeto do material declarado que desceu/saiu pela boca da lixeira
//   'retirado' → objeto do material certo que foi mostrado e retirado (não desceu)
//   'material' → objeto de outro material/classe (não conta)
//   'ruido'    → detecção curta demais para ser confiável

const NORMALIZAR_CLASSE = { 'wine glass': 'cup' };
const CLASSES_IGNORADAS = new Set(['person', 'chair', 'couch', 'bed', 'dining table', 'tv', 'laptop', 'refrigerator', 'oven', 'toilet', 'bench']);

const PADRAO = {
  scoreNovo: 0.5,       // confiança mínima para iniciar uma trilha
  scoreManter: 0.3,     // confiança mínima para manter uma trilha já existente (histerese)
  iouMin: 0.15,         // sobreposição mínima para associar detecção à trilha
  distMax: 1.6,         // associação por distância: até 1,6× o tamanho do objeto (movimento rápido)
  minHits: 3,           // quadros mínimos para confirmar um objeto
  msMin: 150,           // tempo mínimo de vida de uma trilha confirmada
  msPerdido: 600,       // tempo sem ver o objeto para considerá-lo fora da zona
  suavizar: 0.7,        // peso da nova caixa na suavização
  exigirDescida: true,  // anti-fraude: o item precisa descer para dentro da lixeira
  descidaMin: 0.1,      // deslocamento vertical mínimo (fração da altura da zona)
  bordaInferior: 0.18,  // saiu pela faixa inferior da zona (fração da altura)
};

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uniao = a[2] * a[3] + b[2] * b[3] - inter;
  return uniao > 0 ? inter / uniao : 0;
}

const centro = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

class Rastreador {
  constructor(opts = {}) {
    this.opts = { ...PADRAO, ...opts };
    this.trilhas = [];
    this.proxId = 1;
  }

  configurar(opts) {
    Object.assign(this.opts, opts);
  }

  limpar() {
    this.trilhas = [];
  }

  // dets: [{ bbox: [x, y, w, h], class, score }] em coordenadas do quadro
  // zona: { x, y, w, h } em coordenadas do quadro
  // alvo: classes aceitas na sessão atual (null quando não há sessão)
  atualizar(dets, zona, agora, alvo) {
    const o = this.opts;
    const validas = dets
      .map((d) => ({ ...d, class: NORMALIZAR_CLASSE[d.class] || d.class }))
      .filter((d) => !CLASSES_IGNORADAS.has(d.class) && d.score >= o.scoreManter);

    const livresT = new Set(this.trilhas);
    const livresD = new Set(validas.keys());

    // 1) associação por sobreposição (IoU), maior primeiro
    const pares = [];
    for (const t of this.trilhas) {
      validas.forEach((d, i) => {
        const s = iou(t.bbox, d.bbox);
        if (s >= o.iouMin) pares.push([s, t, i]);
      });
    }
    pares.sort((a, b) => b[0] - a[0]);
    for (const [, t, i] of pares) {
      if (!livresT.has(t) || !livresD.has(i)) continue;
      this._atualizarTrilha(t, validas[i], agora);
      livresT.delete(t);
      livresD.delete(i);
    }

    // 2) associação por distância dos centros (objeto caindo rápido não se sobrepõe entre quadros)
    for (const t of [...livresT]) {
      const [cx, cy] = centro(t.bbox);
      const limite = o.distMax * Math.max(t.bbox[2], t.bbox[3]);
      let melhor = -1;
      let melhorDist = Infinity;
      for (const i of livresD) {
        const [dx, dy] = centro(validas[i].bbox);
        const dist = Math.hypot(dx - cx, dy - cy);
        if (dist <= limite && dist < melhorDist) { melhor = i; melhorDist = dist; }
      }
      if (melhor >= 0) {
        this._atualizarTrilha(t, validas[melhor], agora);
        livresT.delete(t);
        livresD.delete(melhor);
      }
    }

    // 3) novas trilhas para detecções confiantes não associadas
    for (const i of livresD) {
      const d = validas[i];
      if (d.score < o.scoreNovo) continue;
      const c = centro(d.bbox);
      this.trilhas.push({
        id: this.proxId++,
        bbox: [...d.bbox],
        votos: { [d.class]: d.score },
        qtdVotos: { [d.class]: 1 },
        hits: 1,
        inicio: agora,
        ultimaVez: agora,
        centroInicial: c,
        rastro: [c],
        melhorScore: d.score,
        vistoAgora: true,
        snapshot: null,
      });
    }
    for (const t of livresT) t.vistoAgora = false;

    // 4) encerra trilhas que sumiram e decide o destino de cada uma
    const finalizados = [];
    this.trilhas = this.trilhas.filter((t) => {
      if (agora - t.ultimaVez <= o.msPerdido) return true;
      if (alvo) finalizados.push({ trilha: t, ...this._decidir(t, zona, alvo) });
      return false;
    });

    return { trilhas: this.trilhas, finalizados };
  }

  _atualizarTrilha(t, d, agora) {
    const a = this.opts.suavizar;
    t.bbox = t.bbox.map((v, k) => v * (1 - a) + d.bbox[k] * a);
    t.votos[d.class] = (t.votos[d.class] || 0) + d.score;
    t.qtdVotos[d.class] = (t.qtdVotos[d.class] || 0) + 1;
    t.hits++;
    t.ultimaVez = agora;
    t.vistoAgora = true;
    t.melhorScore = Math.max(t.melhorScore, d.score);
    t.rastro.push(centro(t.bbox));
    if (t.rastro.length > 40) t.rastro.shift();
  }

  // Classe vencedora pela soma das confianças ao longo da trilha
  classe(t) {
    let melhor = null;
    for (const c in t.votos) if (!melhor || t.votos[c] > t.votos[melhor]) melhor = c;
    return { classe: melhor, score: t.votos[melhor] / t.qtdVotos[melhor] };
  }

  confirmada(t) {
    return t.hits >= this.opts.minHits && t.ultimaVez - t.inicio >= this.opts.msMin;
  }

  _decidir(t, zona, alvo) {
    const o = this.opts;
    const { classe, score } = this.classe(t);
    if (!this.confirmada(t)) return { decisao: 'ruido', classe, score };
    if (!alvo.includes(classe)) return { decisao: 'material', classe, score };
    if (o.exigirDescida) {
      const [, cyFinal] = t.rastro[t.rastro.length - 1];
      const desceu = cyFinal - t.centroInicial[1] >= zona.h * o.descidaMin;
      const saiuPorBaixo = t.bbox[1] + t.bbox[3] >= zona.y + zona.h * (1 - o.bordaInferior);
      if (!desceu && !saiuPorBaixo) return { decisao: 'retirado', classe, score };
    }
    return { decisao: 'contado', classe, score };
  }
}

if (typeof module !== 'undefined') module.exports = { Rastreador, iou };
