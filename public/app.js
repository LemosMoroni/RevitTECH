// App do atleta/torcedor: cadastro, leitura do QR, declaração do depósito e acompanhamento
const LS_USUARIO = 'revittech_usuario';
const $ = (id) => document.getElementById(id);

let config = null;
let usuario = null;
let lixeiras = [];
let lixeiraSel = null;
let materialSel = 'pet';
let qtd = 1;
let tipoSel = 'atleta';
let lixeiraPendente = null;
let depAtual = null;
let pollTimer = null;

const lsGet = () => { try { return localStorage.getItem(LS_USUARIO); } catch { return null; } };
const lsSet = (v) => { try { v ? localStorage.setItem(LS_USUARIO, v) : localStorage.removeItem(LS_USUARIO); } catch {} };

function mostrar(tela) {
  document.querySelectorAll('.tela').forEach((t) => { t.hidden = t.id !== `tela-${tela}`; });
  window.scrollTo(0, 0);
}

async function init() {
  config = await api('/api/config');
  lixeiras = await api('/api/lixeiras');

  $('delegacao').innerHTML = '<option value="">Selecione…</option>' + config.delegacoes.map((d) => `<option>${escapar(d)}</option>`).join('');
  $('chips-lixeiras').innerHTML = lixeiras.map((l) => `<button class="chip" data-id="${l.id}">🗑️ ${escapar(l.nome)}</button>`).join('');
  renderMateriais();

  const params = new URLSearchParams(location.search);
  lixeiraPendente = params.get('lixeira');
  if (lixeiraPendente) history.replaceState(null, '', location.pathname);

  const id = lsGet();
  if (id) {
    try { usuario = await api(`/api/usuarios/${id}`); } catch { usuario = null; lsSet(null); }
  }
  if (!usuario) return mostrar('cadastro');
  seguir();
}

function seguir() {
  if (lixeiraPendente) {
    const cod = lixeiraPendente;
    lixeiraPendente = null;
    abrirLixeira(cod);
  } else {
    irHome();
  }
}

// ---------- Cadastro ----------
$('tipo').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  tipoSel = b.dataset.v;
  $('tipo').querySelectorAll('button').forEach((x) => x.classList.toggle('ativo', x === b));
};

$('form-cadastro').onsubmit = async (e) => {
  e.preventDefault();
  try {
    usuario = await api('/api/usuarios', { body: { nome: $('nome').value, delegacao: $('delegacao').value, tipo: tipoSel } });
    lsSet(usuario.id);
    toast(`Bem-vindo(a), ${usuario.nome.split(' ')[0]}! 🌱`);
    seguir();
  } catch (err) {
    toast(err.message);
  }
};

$('h-avatar').onclick = () => {
  if (confirm('Sair desta conta?')) {
    lsSet(null);
    usuario = null;
    mostrar('cadastro');
  }
};

// ---------- Home ----------
async function irHome() {
  clearTimeout(pollTimer);
  try { usuario = await api(`/api/usuarios/${usuario.id}`); } catch {}
  $('h-avatar').textContent = iniciais(usuario.nome);
  $('h-nome').textContent = usuario.nome;
  $('h-delegacao').textContent = `Delegação ${usuario.delegacao}`;
  $('h-pontos').textContent = fmtNum(usuario.pontos);
  $('h-posicao').textContent = usuario.posicaoDelegacao ? `${usuario.posicaoDelegacao}º lugar` : '—';
  const hist = usuario.historico || [];
  $('historico').innerHTML = hist.length
    ? hist.map((d) => {
      const st = STATUS_DEP[d.status];
      return `<div class="hist-item"><div class="ic">${d.materialInfo.icone}</div>
        <div><b>${d.validado ?? 0}/${d.declarado} ${escapar(d.materialInfo.nome)}</b><br>
        <small>${escapar(d.lixeira?.nome || '')} · ${fmtHora(d.criadoEm)}</small> <span class="selo ${st.cls}">${st.txt}</span></div>
        <div class="pts">+${d.pontos || 0}</div></div>`;
    }).join('')
    : '<p class="muted centro" style="font-size:14px">Nenhum depósito ainda. Escaneie uma lixeira para começar!</p>';
  mostrar('home');
}

$('chips-lixeiras').onclick = (e) => {
  const b = e.target.closest('.chip');
  if (b) abrirLixeira(b.dataset.id);
};

$('form-codigo').onsubmit = (e) => {
  e.preventDefault();
  abrirLixeira($('codigo').value);
};

// ---------- Leitura do QR da lixeira ----------
// O botão abre a tela do scanner ao vivo (câmera dentro do app, lendo vários quadros por segundo).
// A câmera ao vivo exige HTTPS (ou localhost); a foto continua como alternativa.
$('btn-scan').onclick = () => abrirScanner();

const qrCanvas = document.createElement('canvas');
const qrCtx = qrCanvas.getContext('2d', { willReadFrequently: true });

// Tons de cinza + estica o histograma (percentis 2–98%): recupera fotos de tela lavadas ou com reflexo
function realcarContraste(px) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const v = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    px[i] = v;
    hist[v]++;
  }
  const total = px.length / 4;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, (px[i] - lo) * k));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
}

function lerQRRegiao(fonte, W, H, [rx, ry, rw, rh], lado, realcar) {
  const sw = W * rw;
  const sh = H * rh;
  const esc = Math.min(1, lado / Math.max(sw, sh));
  qrCanvas.width = Math.max(1, Math.round(sw * esc));
  qrCanvas.height = Math.max(1, Math.round(sh * esc));
  qrCtx.drawImage(fonte, W * rx, H * ry, sw, sh, 0, 0, qrCanvas.width, qrCanvas.height);
  const d = qrCtx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
  if (realcar) realcarContraste(d.data);
  const qr = jsQR(d.data, qrCanvas.width, qrCanvas.height, { inversionAttempts: realcar ? 'dontInvert' : 'attemptBoth' });
  return qr ? qr.data : null;
}

// Foto: tenta várias escalas e recortes (QR pequeno, grande, com reflexo de um lado...)
function lerQRFoto(img) {
  const W = img.width;
  const H = img.height;
  const recortes = [[0, 0, 1, 1], [0.15, 0.15, 0.7, 0.7], [0.25, 0.25, 0.5, 0.5], [0, 0, 1, 0.6], [0, 0.4, 1, 0.6], [0, 0, 0.6, 1], [0.4, 0, 0.6, 1]];
  for (const lado of [1000, 1600, 650]) {
    for (const realcar of [false, true]) {
      for (const r of recortes) {
        const texto = lerQRRegiao(img, W, H, r, lado, realcar);
        if (texto) return texto;
      }
    }
  }
  return null;
}

async function carregarImagem(file) {
  try { return await createImageBitmap(file); } catch {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

$('arquivo-qr').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('🔍 Lendo QR code…', 10000);
  try {
    const img = await carregarImagem(file);
    await new Promise((r) => setTimeout(r, 30)); // deixa o aviso aparecer antes do processamento
    const texto = lerQRFoto(img);
    if (!texto) return toast('QR code não encontrado. Fotografe o código de frente, sem reflexo — ou toque na lixeira abaixo.', 5000);
    toast('QR code lido ✓', 1200);
    abrirLixeira(extrairCodigo(texto));
  } catch (err) {
    toast('Não foi possível ler a imagem. Toque na lixeira abaixo.');
  }
};

// Scanner ao vivo
let scanStream = null;
let scanAtivo = false;
let detectorNativo = null; // leitor de QR do próprio navegador (Android/Chrome), mais rápido que o jsQR

if ('BarcodeDetector' in window) {
  BarcodeDetector.getSupportedFormats?.()
    .then((f) => { if (f.includes('qr_code')) detectorNativo = new BarcodeDetector({ formats: ['qr_code'] }); })
    .catch(() => {});
}

function avisoScanner(texto, botao) {
  $('scan-aviso').hidden = !texto;
  $('scan-aviso-txt').textContent = texto || '';
  $('scan-aviso-btn').hidden = !botao;
  if (botao) {
    $('scan-aviso-btn').textContent = botao.texto;
    $('scan-aviso-btn').onclick = botao.acao;
  }
}

async function abrirScanner() {
  $('scanner').hidden = false;
  avisoScanner('');
  $('scan-status').textContent = 'Abrindo a câmera…';

  if (!navigator.mediaDevices?.getUserMedia) {
    // Endereço HTTP na rede: o navegador bloqueia a câmera ao vivo
    const urlSegura = config?.httpsPort && location.protocol === 'http:'
      ? `https://${location.hostname}:${config.httpsPort}${location.pathname}`
      : null;
    $('scan-status').textContent = '';
    return avisoScanner(
      'Por segurança, o navegador só libera a câmera ao vivo na versão segura (HTTPS) do app.',
      urlSegura ? { texto: '🔒 Abrir versão segura', acao: () => { location.href = urlSegura; } } : null,
    );
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    $('scan-status').textContent = '';
    const negado = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    return avisoScanner(negado
      ? 'Permita o acesso à câmera: toque no ícone ao lado do endereço do site e libere "Câmera". Depois tente de novo.'
      : `Não foi possível abrir a câmera (${e.name || e.message}).`,
    { texto: 'Tentar de novo', acao: () => { fecharScanner(); abrirScanner(); } });
  }
  if ($('scanner').hidden) return fecharScanner(); // usuário cancelou enquanto a câmera abria

  const v = $('scan-video');
  v.srcObject = scanStream;
  await v.play().catch(() => {});
  $('scan-status').textContent = 'Procurando QR code…';
  scanAtivo = true;
  let n = 0;
  const passo = async () => {
    if (!scanAtivo) return;
    let texto = null;
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        if (detectorNativo) {
          const r = await detectorNativo.detect(v);
          texto = r[0]?.rawValue || null;
        }
        if (!texto && (!detectorNativo || n % 3 === 2)) {
          // jsQR: alterna recorte central e quadro inteiro, com e sem realce de contraste
          const r = n % 2 ? [0, 0, 1, 1] : [0.2, 0.2, 0.6, 0.6];
          texto = lerQRRegiao(v, v.videoWidth, v.videoHeight, r, 800, n % 4 >= 2);
        }
      } catch {}
      n++;
    }
    if (texto && scanAtivo) {
      fecharScanner();
      if (navigator.vibrate) navigator.vibrate(60);
      toast('QR code lido ✓', 1200);
      return abrirLixeira(extrairCodigo(texto));
    }
    setTimeout(passo, 80);
  };
  passo();
}

function fecharScanner() {
  scanAtivo = false;
  $('scanner').hidden = true;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('scan-video').srcObject = null;
}

$('scan-fechar').onclick = fecharScanner;
$('scan-foto').onclick = () => { fecharScanner(); $('arquivo-qr').click(); };

function extrairCodigo(texto) {
  try { return new URL(texto).searchParams.get('lixeira') || texto; } catch { return texto; }
}

// ---------- Depósito ----------
async function abrirLixeira(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  lixeiras = await api('/api/lixeiras').catch(() => lixeiras);
  const lix = lixeiras.find((l) => l.id === cod);
  if (!lix) return toast(`Lixeira "${cod}" não encontrada.`);
  lixeiraSel = lix;
  qtd = 1;
  $('d-lix-nome').textContent = lix.nome;
  $('d-lix-local').textContent = `${lix.local} · ${Math.round((lix.nivel / lix.capacidade) * 100)}% cheia`;
  $('d-lix-id').textContent = lix.id;
  atualizarResumo();
  mostrar('deposito');
}

function renderMateriais() {
  $('materiais').innerHTML = Object.values(config.materiais).map((m) => `
    <button type="button" class="mat ${m.id === materialSel ? 'ativo' : ''}" data-id="${m.id}">
      <span class="ic">${m.icone}</span>
      <span><b>${escapar(m.nome)}</b><small>🌱 ${fmtCO2(m.pesoKg * m.co2PorKg)} CO₂e evitados por item</small></span>
      <span class="pts">+${m.pontos}/item</span>
    </button>`).join('');
}

$('materiais').onclick = (e) => {
  const b = e.target.closest('.mat');
  if (!b) return;
  materialSel = b.dataset.id;
  renderMateriais();
  atualizarResumo();
};

$('menos').onclick = () => { qtd = Math.max(1, qtd - 1); atualizarResumo(); };
$('mais').onclick = () => { qtd = Math.min(20, qtd + 1); atualizarResumo(); };
$('btn-voltar').onclick = () => irHome();

function atualizarResumo() {
  const m = config.materiais[materialSel];
  $('qtd').textContent = qtd;
  $('d-ganho').textContent = `${qtd * m.pontos + config.bonus} pts · ${fmtCO2(qtd * m.pesoKg * m.co2PorKg)} CO₂e`;
}

$('btn-liberar').onclick = async () => {
  const btn = $('btn-liberar');
  btn.disabled = true;
  try {
    depAtual = await api('/api/depositos', { body: { usuarioId: usuario.id, lixeiraId: lixeiraSel.id, material: materialSel, quantidade: qtd } });
    $('a-instrucao').textContent = `Deposite ${textoMaterial(depAtual.materialInfo, depAtual.declarado)}`;
    $('a-contados').textContent = '0';
    $('a-declarado').textContent = depAtual.declarado;
    $('a-lix').textContent = `${lixeiraSel.nome} (${lixeiraSel.id})`;
    if (navigator.vibrate) navigator.vibrate(120);
    mostrar('acompanhamento');
    acompanhar();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
};

async function acompanhar() {
  clearTimeout(pollTimer);
  try {
    const d = await api(`/api/depositos/${depAtual.id}`);
    $('a-contados').textContent = d.contados || 0;
    if (d.status !== 'liberada') return mostrarResultado(d);
  } catch {}
  pollTimer = setTimeout(acompanhar, 1000);
}

$('btn-terminei').onclick = async () => {
  try {
    clearTimeout(pollTimer);
    mostrarResultado(await api(`/api/depositos/${depAtual.id}/cancelar`, { method: 'POST' }));
  } catch (err) {
    toast(err.message);
    acompanhar();
  }
};

function mostrarResultado(d) {
  clearTimeout(pollTimer);
  const mat = d.materialInfo;
  const itens = (d.declarado === 1 ? mat.nome : mat.plural).toLowerCase();
  const cfg = {
    concluida: ['✅', 'Depósito validado!', `A câmera confirmou ${d.validado} de ${d.declarado} ${itens}. Bônus de declaração correta incluído!`],
    divergente: ['⚠️', 'Divergência detectada', `A câmera confirmou ${d.validado} de ${d.declarado} ${itens}. Pontos só pelos itens validados.`],
    expirada: ['❌', 'Nenhum item validado', 'A câmera não detectou itens entrando na lixeira. Tente novamente.'],
  }[d.status];
  $('r-icone').textContent = cfg[0];
  $('r-titulo').textContent = cfg[1];
  $('r-texto').textContent = cfg[2];
  $('r-pontos').textContent = `+${d.pontos || 0} pts`;
  $('r-pontos').style.color = d.status === 'concluida' ? 'var(--verde)' : d.status === 'divergente' ? 'var(--amarelo)' : 'var(--muted)';
  $('r-co2').textContent = d.co2Kg ? `🌱 Você evitou ${fmtCO2(d.co2Kg)} de CO₂e` : '';
  if (navigator.vibrate) navigator.vibrate(d.status === 'concluida' ? [80, 60, 80] : 300);
  mostrar('resultado');
}

$('btn-inicio').onclick = () => irHome();

init().catch((e) => toast('Erro ao conectar ao servidor: ' + e.message, 6000));
