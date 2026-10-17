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

// Leitura de QR por foto: funciona no celular mesmo sem HTTPS
$('btn-scan').onclick = () => $('arquivo-qr').click();
$('arquivo-qr').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const escala = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escala);
    c.height = Math.round(img.height * escala);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const dados = g.getImageData(0, 0, c.width, c.height);
    const qr = jsQR(dados.data, c.width, c.height);
    if (!qr) return toast('QR code não encontrado. Tente aproximar a câmera.');
    abrirLixeira(extrairCodigo(qr.data));
  } catch (err) {
    toast('Não foi possível ler a imagem.');
  }
};

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
