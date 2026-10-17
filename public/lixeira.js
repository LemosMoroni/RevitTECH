// Estação da lixeira inteligente: webcam + COCO-SSD + rastreador validam cada item depositado
const params = new URLSearchParams(location.search);
const ID = params.get('id') || 'GIN-01';
const MODELO = params.get('modelo') === 'lite' ? 'lite_mobilenet_v2' : 'mobilenet_v2';

const TEMPO_SESSAO = 45;      // segundos para depositar
const MS_RESULTADO = 6000;    // tempo exibindo o resultado antes de trancar
const LADO_RECORTE = 640;     // lado máximo do recorte da zona enviado ao modelo

const NOMES = { bottle: 'garrafa', cup: 'copo/lata', bowl: 'pote', 'cell phone': 'celular', book: 'papel', banana: 'orgânico', apple: 'orgânico', orange: 'orgânico', sandwich: 'orgânico', remote: 'controle', mouse: 'mouse', scissors: 'tesoura', 'sports ball': 'bola', handbag: 'bolsa', backpack: 'mochila', umbrella: 'guarda-chuva', keyboard: 'teclado', clock: 'relógio', vase: 'vaso', 'teddy bear': 'pelúcia', toothbrush: 'escova' };
const RECICLAVEIS = ['bottle', 'cup'];

// ---------- Configuração da visão (salva por lixeira) ----------
const CFG_KEY = `revittech_visao_${ID}`;
// zona: null = automática (quadrado central: sem distorção na entrada 300×300 do modelo e com zoom)
const CFG_PADRAO = { zona: null, confianca: 0.45, exigirDescida: true, tecnico: false };

function carregarCfg() {
  try {
    const c = { ...CFG_PADRAO, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') };
    const z = c.zona;
    if (z && !(z.w >= 0.1 && z.h >= 0.1 && z.x >= 0 && z.y >= 0 && z.x + z.w <= 1.001 && z.y + z.h <= 1.001)) c.zona = null;
    return c;
  } catch {
    return { ...CFG_PADRAO };
  }
}
function salvarCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
  rastreador.configurar(opcoesRastreador());
}
const opcoesRastreador = () => ({ scoreNovo: cfg.confianca, scoreManter: Math.max(0.2, cfg.confianca - 0.2), exigirDescida: cfg.exigirDescida });

let cfg = carregarCfg();
const rastreador = new Rastreador(opcoesRastreador());

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const recorte = document.createElement('canvas');
const rctx = recorte.getContext('2d');

let model = null;
let lixeira = null;
let sessao = null;
let alvo = [];
let cont = null;
let fimEm = 0;
let finalizando = false;
let bloqueioAte = 0;
let ultimasDets = [];
let audio = null;
let fps = 0;
let inferMs = 0;
let ultimoFrame = performance.now();
let editandoZona = false;
let zonaRascunho = null;

// ---------- Inicialização ----------
$('qr').src = `/api/lixeiras/${ID}/qrcode`;
$('codigo').textContent = ID;

(async function carregarModelo() {
  try {
    await tf.ready();
    // Tenta o modelo local (offline); se não existir, baixa da CDN do TensorFlow
    try {
      if (MODELO !== 'mobilenet_v2') throw new Error('sem cópia local');
      model = await cocoSsd.load({ base: MODELO, modelUrl: 'vendor/ssd_mobilenet_v2/model.json' });
    } catch {
      model = await cocoSsd.load({ base: MODELO });
    }
    // Aquecimento: a primeira inferência compila os shaders da GPU
    const aquecer = document.createElement('canvas');
    aquecer.width = aquecer.height = 300;
    await model.detect(aquecer);
    $('status-ia').classList.add('pronto');
    $('status-ia-txt').textContent = `IA pronta · ${MODELO === 'mobilenet_v2' ? 'SSD MobileNet v2' : 'SSDLite'} (${tf.getBackend()})`;
  } catch (e) {
    console.error(e);
    $('status-ia-txt').textContent = 'Falha ao carregar IA (sem internet?)';
  }
})();

$('btn-ativar').onclick = async () => {
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ar = video.videoWidth / video.videoHeight;
    $('video-box').style.aspectRatio = String(ar);
    $('video-box').style.maxWidth = `calc((100vh - 120px) * ${ar})`;
    $('ativar').hidden = true;
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    toast('Não foi possível acessar a câmera: ' + e.message, 5000);
  }
};

document.addEventListener('keydown', (e) => {
  if ($('dlg-ajustes').open) return;
  if ((e.key === '+' || e.key === '=') && sessao && !finalizando) contar(1, true); // plano B manual
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
  if (e.key === 'c' && sessao) finalizar();
  if (e.key === 's') abrirAjustes();
  if (e.key === 'z') iniciarEdicaoZona();
  if (e.key === 'Escape' && editandoZona) encerrarEdicaoZona();
});
$('btn-concluir').onclick = () => finalizar();

// ---------- Loop de visão computacional ----------
function zonaPx() {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!cfg.zona) {
    const lado = Math.min(W, H) * 0.92;
    return { x: (W - lado) / 2, y: (H - lado) / 2, w: lado, h: lado };
  }
  return { x: cfg.zona.x * W, y: cfg.zona.y * H, w: cfg.zona.w * W, h: cfg.zona.h * H };
}

async function loop() {
  if (model && video.readyState >= 2) {
    try {
      // 1) Recorta e amplia só a zona de depósito: objetos ficam maiores para o modelo
      const z = zonaPx();
      const escala = Math.min(1, LADO_RECORTE / Math.max(z.w, z.h));
      const rw = Math.round(z.w * escala);
      const rh = Math.round(z.h * escala);
      if (recorte.width !== rw || recorte.height !== rh) { recorte.width = rw; recorte.height = rh; }
      rctx.drawImage(video, z.x, z.y, z.w, z.h, 0, 0, rw, rh);

      // 2) Detecção
      const t0 = performance.now();
      const preds = await model.detect(recorte, 20, 0.2);
      inferMs = inferMs ? inferMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
      const k = 1 / escala;
      ultimasDets = preds.map((p) => ({ class: p.class, score: p.score, bbox: [z.x + p.bbox[0] * k, z.y + p.bbox[1] * k, p.bbox[2] * k, p.bbox[3] * k] }));

      // 3) Rastreamento + decisão
      const ativa = sessao && !finalizando;
      const { trilhas, finalizados } = rastreador.atualizar(ultimasDets, z, Date.now(), ativa ? alvo : null);
      desenhar(trilhas, z);
      if (ativa) {
        for (const t of trilhas) {
          if (!t.snapshot && t.vistoAgora && rastreador.confirmada(t) && alvo.includes(rastreador.classe(t).classe)) t.snapshot = capturar();
        }
        for (const f of finalizados) tratarFinalizado(f);
      }
    } catch (e) { console.error(e); }

    const agora = performance.now();
    fps = fps * 0.85 + (1000 / (agora - ultimoFrame)) * 0.15;
    ultimoFrame = agora;
    const alvoTxt = sessao ? ` · procurando: ${alvo.map((c) => NOMES[c] || c).join(', ')}` : '';
    $('hud').textContent = `${fmtNum(fps)} fps · ${fmtNum(inferMs)} ms · ${rastreador.trilhas.length} objeto(s)${alvoTxt}`;
    if ($('dlg-ajustes').open) atualizarStats();
  }
  if (sessao && !finalizando) atualizarTempo();
  requestAnimationFrame(loop);
}

// ---------- Desenho (o vídeo é espelhado, então o eixo x é invertido) ----------
const espX = (x, w = 0) => canvas.width - x - w;

function desenhar(trilhas, z) {
  const W = canvas.width;
  const H = canvas.height;
  const fonte = Math.round(W / 46);
  ctx.clearRect(0, 0, W, H);

  // Holofote na zona de depósito
  const zx = espX(z.x, z.w);
  ctx.fillStyle = 'rgba(0, 0, 0, .38)';
  ctx.fillRect(0, 0, W, H);
  ctx.clearRect(zx, z.y, z.w, z.h);
  ctx.setLineDash([14, 10]);
  ctx.lineWidth = Math.max(2, W / 400);
  ctx.strokeStyle = sessao ? '#22c55e' : 'rgba(255,255,255,.65)';
  ctx.strokeRect(zx, z.y, z.w, z.h);
  ctx.setLineDash([]);
  ctx.font = `700 ${Math.round(fonte * 0.8)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = sessao ? '#22c55e' : 'rgba(255,255,255,.8)';
  ctx.textAlign = 'center';
  ctx.fillText('ZONA DE DEPÓSITO', zx + z.w / 2, z.y + fonte + 6);
  ctx.textAlign = 'left';

  if (zonaRascunho) {
    const r = zonaRascunho;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.strokeRect(espX(r.x * W, r.w * W), r.y * H, r.w * W, r.h * H);
    ctx.setLineDash([]);
  }

  // Modo técnico: detecções brutas do modelo
  if (cfg.tecnico) {
    ctx.lineWidth = 1;
    ctx.font = `500 ${Math.round(fonte * 0.6)}px Inter, system-ui, sans-serif`;
    for (const d of ultimasDets) {
      const [x, y, w, h] = d.bbox;
      ctx.strokeStyle = 'rgba(56,189,248,.8)';
      ctx.strokeRect(espX(x, w), y, w, h);
      ctx.fillStyle = 'rgba(56,189,248,.95)';
      ctx.fillText(`${d.class} ${Math.round(d.score * 100)}%`, espX(x, w) + 3, y + h - 4);
    }
  }

  // Trilhas rastreadas
  const esp = Math.max(3, W / 260);
  ctx.font = `700 ${fonte}px Inter, system-ui, sans-serif`;
  for (const t of trilhas) {
    const { classe, score } = rastreador.classe(t);
    const confirmada = rastreador.confirmada(t);
    const ehAlvo = sessao && alvo.includes(classe);
    const cor = ehAlvo ? (confirmada ? '#22c55e' : '#86efac') : RECICLAVEIS.includes(classe) ? '#facc15' : 'rgba(255,255,255,.8)';
    ctx.globalAlpha = t.vistoAgora ? 1 : 0.45;

    // rastro do movimento
    if (t.rastro.length > 1) {
      ctx.strokeStyle = cor;
      ctx.lineWidth = esp * 0.8;
      ctx.beginPath();
      t.rastro.forEach(([cx, cy], i) => (i ? ctx.lineTo(espX(cx), cy) : ctx.moveTo(espX(cx), cy)));
      ctx.stroke();
    }

    const [x, y, w, h] = t.bbox;
    const mx = espX(x, w);
    ctx.lineWidth = esp;
    ctx.strokeStyle = cor;
    if (!confirmada) ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.roundRect(mx, y, w, h, 12);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `#${t.id} ${NOMES[classe] || classe} ${Math.round(score * 100)}%`;
    const tw = ctx.measureText(label).width + 16;
    const th = fonte + 12;
    const ly = Math.max(0, y - th);
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.roundRect(mx, ly, tw, th, 8);
    ctx.fill();
    ctx.fillStyle = '#0b3d2e';
    ctx.fillText(label, mx + 8, ly + th - 9);
    ctx.globalAlpha = 1;
  }
}

// ---------- Decisões do rastreador ----------
function tratarFinalizado({ trilha, decisao, classe, score }) {
  const nome = NOMES[classe] || classe;
  const pct = Math.round(score * 100);
  if (decisao === 'contado') {
    if (trilha.snapshot) cont.snapshot = trilha.snapshot;
    evento('ok', '✓', `#${trilha.id} ${nome} entrou na lixeira · ${pct}%`);
    contar(1);
  } else if (decisao === 'retirado') {
    evento('alerta', '↩', `#${trilha.id} ${nome} foi mostrada e retirada: não conta`);
    piscar('✕', 'neg');
    som('aviso');
  } else if (decisao === 'material') {
    evento('erro', '✕', `#${trilha.id} ${nome}: não é ${sessao.materialInfo.nome.toLowerCase()}`);
    piscar('✕', 'neg');
    som('aviso');
  }
}

function evento(tipo, icone, texto) {
  if (!cont) return;
  cont.eventos.unshift({ tipo, icone, texto, hora: new Date() });
  renderEventos();
}

function renderEventos() {
  const evs = cont?.eventos || [];
  $('s-eventos').innerHTML = evs.length
    ? evs.slice(0, 5).map((e) => `<li class="ev-${e.tipo}"><span>${e.icone}</span>${escapar(e.texto)}</li>`).join('')
    : '<li class="ev-vazio">Aguardando itens na zona de depósito…</li>';
}

function piscar(texto, cls = '') {
  const flash = $('flash');
  flash.textContent = texto;
  flash.className = `flash ${cls}`;
  void flash.offsetWidth;
  flash.classList.add('on');
}

function contar(k, manual = false) {
  if (!k || !cont) return;
  cont.contados += k;
  if (manual) {
    cont.manuais += k;
    evento('info', '✋', `+${k} registrado manualmente pelo operador`);
  }
  $('s-contados').textContent = cont.contados;
  piscar(`+${k}`);
  som('item');
  enviarProgresso();
  if (cont.contados >= sessao.declarado) setTimeout(finalizar, 700);
}

function capturar() {
  if (!video.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = Math.round(480 * video.videoHeight / video.videoWidth);
  const g = c.getContext('2d');
  g.save();
  g.translate(c.width, 0);
  g.scale(-1, 1);
  g.drawImage(video, 0, 0, c.width, c.height);
  g.restore();
  g.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

// ---------- Zona de depósito: desenhar com o mouse ----------
function pontoNormalizado(e) {
  const r = canvas.getBoundingClientRect();
  const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return [1 - px, py]; // desfaz o espelhamento
}

function iniciarEdicaoZona() {
  if (!video.videoWidth) return toast('Ative a câmera primeiro.');
  editandoZona = true;
  $('aviso-zona').hidden = false;
  canvas.style.cursor = 'crosshair';
}

function encerrarEdicaoZona() {
  editandoZona = false;
  zonaRascunho = null;
  $('aviso-zona').hidden = true;
  canvas.style.cursor = '';
}

let inicioArraste = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!editandoZona) return;
  inicioArraste = pontoNormalizado(e);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!editandoZona || !inicioArraste) return;
  const [x1, y1] = pontoNormalizado(e);
  const [x0, y0] = inicioArraste;
  zonaRascunho = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
});
canvas.addEventListener('pointerup', () => {
  if (!editandoZona || !inicioArraste) return;
  inicioArraste = null;
  if (zonaRascunho && zonaRascunho.w >= 0.1 && zonaRascunho.h >= 0.1) {
    cfg.zona = zonaRascunho;
    salvarCfg();
    rastreador.limpar();
    toast('Zona de depósito atualizada ✓');
    encerrarEdicaoZona();
  } else {
    zonaRascunho = null;
    toast('Zona muito pequena. Arraste uma área maior.');
  }
});

// ---------- Ajustes ----------
function abrirAjustes() {
  $('aj-conf').value = Math.round(cfg.confianca * 100);
  $('aj-conf-val').textContent = `${Math.round(cfg.confianca * 100)}%`;
  $('aj-descida').checked = cfg.exigirDescida;
  $('aj-tecnico').checked = cfg.tecnico;
  $('aj-modelo').value = params.get('modelo') === 'lite' ? 'lite' : '';
  atualizarStats();
  $('dlg-ajustes').showModal();
}

function atualizarStats() {
  const z = video.videoWidth ? zonaPx() : null;
  $('aj-stats').innerHTML = [
    ['Backend', typeof tf !== 'undefined' ? tf.getBackend() : '—'],
    ['Câmera', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'desligada'],
    ['Zoom da zona', z ? `${fmtNum(video.videoWidth / z.w, 1)}×` : '—'],
    ['Velocidade', `${fmtNum(fps)} fps`],
    ['Inferência', `${fmtNum(inferMs)} ms`],
  ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
}

$('btn-ajustes').onclick = abrirAjustes;
$('aj-conf').oninput = (e) => {
  cfg.confianca = Number(e.target.value) / 100;
  $('aj-conf-val').textContent = `${e.target.value}%`;
  salvarCfg();
};
$('aj-descida').onchange = (e) => { cfg.exigirDescida = e.target.checked; salvarCfg(); };
$('aj-tecnico').onchange = (e) => { cfg.tecnico = e.target.checked; salvarCfg(); };
$('aj-modelo').onchange = (e) => {
  if (e.target.value) params.set('modelo', e.target.value); else params.delete('modelo');
  location.search = params.toString();
};
$('aj-desenhar').onclick = () => { $('dlg-ajustes').close(); iniciarEdicaoZona(); };
$('aj-inteira').onclick = () => {
  cfg.zona = { x: 0, y: 0, w: 1, h: 1 };
  salvarCfg();
  rastreador.limpar();
  toast('Usando o quadro inteiro');
};
$('aj-restaurar').onclick = () => {
  cfg = { ...CFG_PADRAO };
  salvarCfg();
  rastreador.limpar();
  abrirAjustes();
};

// ---------- Sessão de depósito ----------
function iniciarSessao(s) {
  sessao = s;
  alvo = s.materialInfo.classes;
  cont = { contados: 0, manuais: 0, snapshot: null, eventos: [] };
  fimEm = Date.now() + TEMPO_SESSAO * 1000;
  finalizando = false;

  setEstado('liberada', '🔓', 'LIBERADA', 'Deposite os itens um de cada vez');
  $('bloco-qr').hidden = true;
  $('bloco-resultado').hidden = true;
  $('bloco-sessao').hidden = false;
  $('s-avatar').textContent = iniciais(s.usuario?.nome);
  $('s-nome').textContent = s.usuario?.nome || '—';
  $('s-delegacao').textContent = `Delegação ${s.usuario?.delegacao || '—'}`;
  $('s-instrucao').innerHTML = `${s.materialInfo.icone} Deposite <b>${escapar(textoMaterial(s.materialInfo, s.declarado))}</b>`;
  $('s-contados').textContent = '0';
  $('s-declarado').textContent = s.declarado;
  renderEventos();
  $('video-box').classList.add('liberada');
  $('faixa').textContent = 'Passe cada item pela zona e solte dentro da lixeira';
  som('abrir');
}

function atualizarTempo() {
  const rest = Math.max(0, fimEm - Date.now());
  $('s-tempo').textContent = `${Math.ceil(rest / 1000)}s`;
  $('s-tempo-barra').style.width = `${(rest / (TEMPO_SESSAO * 1000)) * 100}%`;
  if (rest <= 0) finalizar();
}

async function finalizar() {
  if (!sessao || finalizando) return;
  finalizando = true;
  setEstado('validando', '🔍', 'VALIDANDO', 'Conferindo os itens depositados…');
  const snapshot = cont.snapshot || capturar();
  try {
    const d = await api(`/api/depositos/${sessao.id}/resultado`, { body: { validado: cont.contados, snapshot } });
    mostrarResultado(d);
  } catch (e) {
    toast('Erro ao enviar resultado: ' + e.message);
    mostrarResultado({ ...sessao, status: 'expirada', validado: 0, pontos: 0, co2Kg: 0 });
  }
}

async function enviarProgresso() {
  if (!sessao || finalizando) return;
  try {
    await api(`/api/depositos/${sessao.id}/progresso`, { body: { contados: cont.contados } });
  } catch (e) {
    if (e.status === 409 && sessao && !finalizando) {
      // sessão encerrada pelo app ou expirada no servidor
      finalizando = true;
      mostrarResultado(await api(`/api/depositos/${sessao.id}`));
    }
  }
}

function mostrarResultado(d) {
  const mat = d.materialInfo || sessao?.materialInfo;
  sessao = null;
  alvo = [];
  bloqueioAte = Date.now() + MS_RESULTADO;
  if (d.lixeira && lixeira) {
    lixeira = { ...lixeira, nivel: d.lixeira.nivel };
    renderNivel();
  }
  $('bloco-sessao').hidden = true;
  $('video-box').classList.remove('liberada');
  $('faixa').textContent = 'Boca da lixeira';
  setEstado('trancada', '🔒', 'TRANCADA', 'Obrigado por reciclar!');

  const r = $('bloco-resultado');
  const linhaItens = `<p class="muted">A câmera validou <b>${d.validado} de ${d.declarado}</b> ${escapar((d.declarado === 1 ? mat.nome : mat.plural).toLowerCase())}</p>`;
  if (d.status === 'concluida') {
    r.innerHTML = `<div class="resultado"><div class="icone">✅</div><h3>Depósito validado!</h3>${linhaItens}
      <div class="pts">+${d.pontos} pts</div><p>🌱 ${fmtCO2(d.co2Kg)} de CO₂e evitados</p></div>`;
    som('ok');
  } else if (d.status === 'divergente') {
    r.innerHTML = `<div class="resultado"><div class="icone">⚠️</div><h3>Divergência detectada</h3>${linhaItens}
      <div class="pts" style="color:var(--amarelo)">+${d.pontos} pts</div><p class="muted">Pontos só pelos itens confirmados.</p></div>`;
    som('erro');
  } else {
    r.innerHTML = `<div class="resultado"><div class="icone">❌</div><h3>Nenhum item validado</h3>${linhaItens}
      <p class="muted">Nenhum ponto foi creditado.</p></div>`;
    som('erro');
  }
  r.hidden = false;

  setTimeout(() => {
    finalizando = false;
    r.hidden = true;
    $('bloco-qr').hidden = false;
    setEstado('trancada', '🔒', 'TRANCADA', 'Escaneie o QR code no app RevitTech');
  }, MS_RESULTADO);
}

function setEstado(cls, icone, titulo, sub) {
  $('estado').className = `estado ${cls}`;
  $('estado-icone').textContent = icone;
  $('estado-titulo').textContent = titulo;
  $('estado-sub').textContent = sub;
}

function renderNivel() {
  if (!lixeira) return;
  $('lix-nome').textContent = `${lixeira.nome} · ${lixeira.id}`;
  $('lix-local').textContent = lixeira.local;
  const pct = lixeira.nivel / lixeira.capacidade;
  $('nivel-itens').textContent = `${lixeira.nivel} / ${lixeira.capacidade} itens`;
  $('nivel-pct').textContent = `${Math.round(pct * 100)}%`;
  $('nivel-status').textContent = pct >= 0.8 ? '⚠️ Coleta solicitada' : 'Operando normalmente';
  const barra = $('nivel-barra');
  barra.className = `barra ${pct >= 0.8 ? 'cheia' : pct >= 0.6 ? 'alerta' : ''}`;
  barra.firstElementChild.style.width = `${Math.min(100, pct * 100)}%`;
}

// ---------- Polling do servidor ----------
async function poll() {
  try {
    if (!sessao && !finalizando) {
      const r = await api(`/api/lixeiras/${ID}/sessao`);
      lixeira = r.lixeira;
      renderNivel();
      if (r.sessao && Date.now() > bloqueioAte) iniciarSessao(r.sessao);
    } else if (sessao && !finalizando) {
      await enviarProgresso();
    }
  } catch (e) {
    console.warn(e);
  }
  setTimeout(poll, 1000);
}
poll();

// ---------- Sons (WebAudio) ----------
function som(tipo) {
  if (!audio) return;
  const notas = { abrir: [523, 659, 784], item: [988], ok: [523, 659, 784, 1047], erro: [392, 311], aviso: [440, 349] }[tipo] || [];
  const t0 = audio.currentTime;
  notas.forEach((f, i) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.11;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.22);
  });
}
