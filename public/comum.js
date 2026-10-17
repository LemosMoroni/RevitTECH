// Utilitários compartilhados entre App, Lixeira e Painel
async function api(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.erro || `Erro ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  if (!el) return alert(msg);
  el.textContent = msg;
  el.classList.add('visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visivel'), ms);
}

const fmtNum = (n, casas = 0) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const fmtCO2 = (kg) => (kg < 1 ? `${fmtNum(kg * 1000)} g` : `${fmtNum(kg, 1)} kg`);
const fmtHora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const iniciais = (nome) => (nome || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const escapar = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function textoMaterial(mat, qtd) {
  return `${qtd} ${(qtd === 1 ? mat.nome : mat.plural).toLowerCase()}`;
}

const STATUS_DEP = {
  liberada: { txt: 'Em andamento', cls: 'info' },
  concluida: { txt: '✓ Validado', cls: 'ok' },
  divergente: { txt: '⚠ Divergente', cls: 'alerta' },
  expirada: { txt: '✕ Não validado', cls: 'erro' },
};
