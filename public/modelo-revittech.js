// Modelo RevitTech: detector treinado para garrafa PET, copo plástico e lata de alumínio.
//
// Por que existe: o COCO-SSD genérico não conhece "lata de alumínio" e perde itens borrados.
// Este modelo foi treinado com fotos nossas (ver reciclaveis_yolo/) e exportado para ONNX,
// executado aqui pelo onnxruntime-web. Nenhuma imagem sai do navegador da lixeira.
//
// Expõe a mesma interface do cocoSsd — detect(fonte, maxItens, score) → [{class, score, bbox}] —
// para a estação funcionar com qualquer um dos dois modelos.

const REVITTECH_CLASSES = ['garrafa_pet', 'copo_plastico', 'lata_aluminio'];

// As classes do nosso modelo nos nomes que o resto da estação já usa
const REVITTECH_PARA_ESTACAO = {
  garrafa_pet: 'bottle',
  copo_plastico: 'cup',
  lata_aluminio: 'lata',
};

class ModeloRevitTech {
  constructor(sessao, lado, nomeEntrada, nomeSaida) {
    this.sessao = sessao;
    this.lado = lado;
    this.nomeEntrada = nomeEntrada;
    this.nomeSaida = nomeSaida;
    this.rotulo = 'RevitTech (YOLO26n treinado)';
    this.tela = document.createElement('canvas');
    this.tela.width = this.tela.height = lado;
    this.ctx = this.tela.getContext('2d', { willReadFrequently: true });
    this.buffer = new Float32Array(3 * lado * lado);
  }

  static async carregar(url = 'modelo/revittech.onnx', lado = 640) {
    if (typeof ort === 'undefined') throw new Error('onnxruntime-web não carregou');
    // Os .wasm locais (demo offline) precisam de URL absoluta: um caminho relativo solto
    // é interpretado como nome de módulo e falha com "Failed to resolve module specifier".
    if (!ort.env.wasm.wasmPaths) ort.env.wasm.wasmPaths = new URL('vendor/', document.baseURI).href;
    // Multi-thread exigiria os cabeçalhos COOP/COEP, que quebrariam os scripts da CDN.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    const sessao = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    const m = new ModeloRevitTech(sessao, lado, sessao.inputNames[0], sessao.outputNames[0]);
    await m.aquecer();
    return m;
  }

  async aquecer() {
    // a 1ª inferência é bem mais lenta (compila e aloca); fazemos com uma imagem em branco
    const t = new ort.Tensor('float32', new Float32Array(3 * this.lado * this.lado), [1, 3, this.lado, this.lado]);
    await this.sessao.run({ [this.nomeEntrada]: t });
  }

  /**
   * fonte: <video>, <canvas> ou <img>
   * Retorna bbox em pixels da fonte: [x, y, largura, altura]
   */
  async detect(fonte, maxItens = 20, score = 0.25) {
    const L = this.lado;
    const largura = fonte.videoWidth || fonte.width;
    const altura = fonte.videoHeight || fonte.height;
    if (!largura || !altura) return [];

    // "letterbox": encaixa a imagem no quadrado mantendo a proporção, com cinza nas sobras
    // (é assim que o YOLO foi treinado; esticar a imagem pioraria a detecção)
    const escala = Math.min(L / largura, L / altura);
    const novaL = Math.round(largura * escala);
    const novaA = Math.round(altura * escala);
    const padX = Math.floor((L - novaL) / 2);
    const padY = Math.floor((L - novaA) / 2);

    this.ctx.fillStyle = 'rgb(114,114,114)';
    this.ctx.fillRect(0, 0, L, L);
    this.ctx.drawImage(fonte, 0, 0, largura, altura, padX, padY, novaL, novaA);
    const px = this.ctx.getImageData(0, 0, L, L).data;

    // RGBA intercalado (0..255) → três planos R, G, B (0..1), que é o formato do modelo
    const n = L * L;
    const buf = this.buffer;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      buf[i] = px[j] / 255;
      buf[n + i] = px[j + 1] / 255;
      buf[2 * n + i] = px[j + 2] / 255;
    }

    const entrada = new ort.Tensor('float32', buf, [1, 3, L, L]);
    const saida = await this.sessao.run({ [this.nomeEntrada]: entrada });
    const t = saida[this.nomeSaida];
    const dados = t.data;
    const canais = t.dims[1];      // 4 coordenadas + uma pontuação por classe
    const ancoras = t.dims[2];     // 8400 candidatos
    const nClasses = canais - 4;

    const candidatos = [];
    for (let i = 0; i < ancoras; i++) {
      let melhor = 0;
      let melhorScore = dados[4 * ancoras + i];
      for (let c = 1; c < nClasses; c++) {
        const s = dados[(4 + c) * ancoras + i];
        if (s > melhorScore) { melhorScore = s; melhor = c; }
      }
      if (melhorScore < score) continue;

      // desfaz as barras e a escala, voltando para pixels da imagem original
      const cx = (dados[i] - padX) / escala;
      const cy = (dados[ancoras + i] - padY) / escala;
      const w = dados[2 * ancoras + i] / escala;
      const h = dados[3 * ancoras + i] / escala;
      const nome = REVITTECH_CLASSES[melhor];
      candidatos.push({
        class: REVITTECH_PARA_ESTACAO[nome] || nome,
        classeTreinada: nome,
        score: melhorScore,
        bbox: [cx - w / 2, cy - h / 2, w, h],
      });
    }

    return naoMaximos(candidatos, 0.45).slice(0, maxItens);
  }
}

// Supressão de não-máximos: várias caixas sobre o mesmo objeto viram uma só
function naoMaximos(caixas, limiarIoU) {
  const ordenadas = caixas.sort((a, b) => b.score - a.score);
  const mantidas = [];
  for (const c of ordenadas) {
    if (mantidas.every((m) => m.class !== c.class || iouCaixas(m.bbox, c.bbox) < limiarIoU)) {
      mantidas.push(c);
    }
  }
  return mantidas;
}

function iouCaixas(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uniao = a[2] * a[3] + b[2] * b[3] - inter;
  return uniao > 0 ? inter / uniao : 0;
}

if (typeof module !== 'undefined') {
  module.exports = { ModeloRevitTech, naoMaximos, iouCaixas, REVITTECH_CLASSES, REVITTECH_PARA_ESTACAO };
}
