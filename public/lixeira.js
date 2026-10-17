// Estação da lixeira inteligente: webcam + COCO-SSD validam cada item depositado
const params = new URLSearchParams(location.search);
const ID = params.get('id') || 'GIN-01';
const MODELO = params.get('modelo') === 'lite' ? 'lite_mobilenet_v2' : 'mobilenet_v2';

const TEMPO_SESSAO = 45;      // segundos para depositar
const SCORE_CONTAGEM = 0.5;   // confiança mínima para contar um item
const SCORE_DESENHO = 0.35;   // confiança mínima para desenhar a caixa
const MS_CONFIRMA = 250;      // objeto precisa aparecer por esse tempo para iniciar um episódio
const MS_SAIDA = 700;         // ausência necessária para considerar que o item caiu na lixeira
const MS_RESULTADO = 6000;    // tempo exibindo o resultado antes de trancar

const NOMES = { bottle: 'garrafa', cup: 'copo/lata', 'wine glass': 'taça', bowl: 'pote', 'cell phone': 'celular', book: 'papel/livro', banana: 'orgânico', apple: 'orgânico', orange: 'orgânico', sandwich: 'orgânico' };

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let model = null;
let lixeira = null;
let sessao = null;
let alvo = [];
let cont = null;
let fimEm = 0;
let finalizando = false;
let bloqueioAte = 0;
let ultimasPreds = [];
let audio = null;
let fps = 0;
let ultimoFrame = performance.now();

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
    $('status-ia').classList.add('pronto');
    $('status-ia-txt').textContent = `IA pronta · COCO-SSD (${tf.getBackend()})`;
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
  if ((e.key === '+' || e.key === '=') && sessao && !finalizando) contar(1, true); // plano B manual
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
  if (e.key === 'c' && sessao) finalizar();
});
$('btn-concluir').onclick = () => finalizar();

// ---------- Loop de visão computacional ----------
async function loop() {
  if (model && video.readyState >= 2) {
    try {
      const preds = await model.detect(video, 12, SCORE_DESENHO);
      ultimasPreds = preds;
      desenhar(preds);
      if (sessao && !finalizando) processar(preds, Date.now());
    } catch (e) { console.error(e); }
    const agora = performance.now();
    fps = fps * 0.85 + (1000 / (agora - ultimoFrame)) * 0.15;
    ultimoFrame = agora;
    const alvoTxt = sessao ? ` · procurando: ${alvo.map((c) => NOMES[c] || c).join(', ')}` : '';
    $('hud').textContent = `${fmtNum(fps)} fps · ${ultimasPreds.length} objeto(s)${alvoTxt}`;
  }
  if (sessao && !finalizando) atualizarTempo();
  requestAnimationFrame(loop);
}

function desenhar(preds) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const esp = Math.max(3, canvas.width / 260);
  ctx.font = `700 ${Math.round(canvas.width / 42)}px Inter, system-ui, sans-serif`;
  for (const p of preds) {
    if (p.class === 'person' || p.score < SCORE_DESENHO) continue;
    const [x, y, w, h] = p.bbox;
    const mx = canvas.width - x - w; // vídeo é espelhado
    const valido = sessao && alvo.includes(p.class) && p.score >= SCORE_CONTAGEM;
    const reciclavel = p.class === 'bottle' || p.class === 'cup';
    const cor = valido ? '#22c55e' : reciclavel ? '#facc15' : 'rgba(255,255,255,.7)';
    ctx.lineWidth = esp;
    ctx.strokeStyle = cor;
    ctx.beginPath();
    ctx.roundRect(mx, y, w, h, 12);
    ctx.stroke();
    const label = `${NOMES[p.class] || p.class} ${Math.round(p.score * 100)}%`;
    const tw = ctx.measureText(label).width + 16;
    const th = canvas.width / 42 + 12;
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.roundRect(mx, Math.max(0, y - th), tw, th, 8);
    ctx.fill();
    ctx.fillStyle = valido || reciclavel ? '#0b3d2e' : '#000';
    ctx.fillText(label, mx + 8, Math.max(0, y - th) + th - 9);
  }
}

// Contagem por evento: um item aparece na boca da lixeira, some (caiu) → conta.
function processar(preds, agora) {
  const n = preds.filter((p) => alvo.includes(p.class) && p.score >= SCORE_CONTAGEM).length;
  if (n > 0) {
    cont.ultimaPresenca = agora;
    if (!cont.inicioPresenca) cont.inicioPresenca = agora;
    if (!cont.emEpisodio && agora - cont.inicioPresenca >= MS_CONFIRMA) {
      cont.emEpisodio = true;
      cont.maxEp = 0;
    }
    if (cont.emEpisodio && n > cont.maxEp) {
      cont.maxEp = n;
      cont.snapshot = capturar();
    }
  } else if (cont.emEpisodio) {
    if (agora - cont.ultimaPresenca >= MS_SAIDA) {
      const k = cont.maxEp;
      cont.emEpisodio = false;
      cont.inicioPresenca = null;
      cont.maxEp = 0;
      contar(k);
    }
  } else if (cont.inicioPresenca && agora - cont.ultimaPresenca > MS_SAIDA) {
    cont.inicioPresenca = null;
  }
}

function contar(k, manual = false) {
  if (!k) return;
  cont.contados += k;
  if (manual) cont.manuais += k;
  $('s-contados').textContent = cont.contados;
  const flash = $('flash');
  flash.textContent = `+${k}`;
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
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

// ---------- Sessão de depósito ----------
function iniciarSessao(s) {
  sessao = s;
  alvo = s.materialInfo.classes;
  cont = { contados: 0, manuais: 0, inicioPresenca: null, ultimaPresenca: 0, emEpisodio: false, maxEp: 0, snapshot: null };
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
  $('video-box').classList.add('liberada');
  $('zona').textContent = 'Passe cada item pela boca da lixeira';
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
  $('zona').textContent = 'Boca da lixeira';
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
  const notas = { abrir: [523, 659, 784], item: [988], ok: [523, 659, 784, 1047], erro: [392, 311] }[tipo] || [];
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
