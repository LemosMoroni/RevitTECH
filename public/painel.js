// Painel ESG: KPIs, ranking, materiais, lixeiras (logística reversa) e feed com evidências
const $ = (id) => document.getElementById(id);
const vistos = new Set();
let primeiraCarga = true;

async function atualizar() {
  try {
    render(await api('/api/painel'));
  } catch (e) {
    console.warn(e);
  }
  $('relogio').textContent = new Date().toLocaleTimeString('pt-BR');
}

function render(p) {
  const k = p.kpis;
  $('k-co2').innerHTML = k.co2Kg < 1 ? `${fmtNum(k.co2Kg * 1000)}<small> g</small>` : `${fmtNum(k.co2Kg, 2)}<small> kg</small>`;
  $('k-itens').textContent = fmtNum(k.itens);
  $('k-dep').textContent = `${fmtNum(k.depositos)} depósitos`;
  $('k-kg').innerHTML = `${fmtNum(k.kg, 2)}<small> kg</small>`;
  $('k-part').textContent = `${fmtNum(k.participantes)} participantes`;
  $('k-taxa').innerHTML = `${fmtNum(k.taxaValidacao * 100, 1)}<small> %</small>`;
  $('k-div').textContent = `⚠ ${fmtNum(k.divergencias)} divergências barradas`;

  const maxPts = Math.max(1, ...p.rankingDelegacoes.map((r) => r.pontos));
  const medalha = ['🥇', '🥈', '🥉'];
  $('ranking').innerHTML = p.rankingDelegacoes.map((r, i) => `
    <div class="barra-linha ${i === 0 ? 'lider' : ''}" title="${escapar(r.delegacao)}: ${r.pontos} pts · ${r.itens} itens · ${fmtCO2(r.co2Kg)} CO₂e">
      <span class="pos">${medalha[i] || i + 1}</span>
      <span class="nome">${escapar(r.delegacao)}</span>
      <span class="trilho"><i style="width:${(r.pontos / maxPts) * 100}%"></i></span>
      <span class="valor">${fmtNum(r.pontos)}</span>
    </div>`).join('');

  $('top-usuarios').innerHTML = p.rankingUsuarios.map((u, i) => `
    <li><span>${i + 1}. <b>${escapar(u.nome)}</b> <span class="muted">· ${escapar(u.delegacao)} · ${u.tipo}</span></span><b>${fmtNum(u.pontos)}</b></li>`).join('');

  const maxItens = Math.max(1, ...p.porMaterial.map((m) => m.itens));
  $('materiais').innerHTML = p.porMaterial.map((m) => `
    <div class="mat-linha" title="${escapar(m.nome)}: ${m.itens} itens · ${fmtNum(m.kg, 2)} kg · ${fmtCO2(m.co2Kg)} CO₂e">
      <span class="ic">${m.icone}</span>
      <div><b>${escapar(m.nome)}</b><div class="trilho"><i style="width:${(m.itens / maxItens) * 100}%"></i></div></div>
      <div class="num"><b>${fmtNum(m.itens)}</b><small>${fmtNum(m.kg, 2)} kg · ${fmtCO2(m.co2Kg)} CO₂e</small></div>
    </div>`).join('');

  $('lixeiras').innerHTML = p.lixeiras.map((l) => {
    const pct = l.nivel / l.capacidade;
    const st = l.emUso ? '<span class="selo info">🔓 Em uso</span>'
      : pct >= 0.8 ? '<span class="selo erro">⚠ Coletar</span>'
        : pct >= 0.6 ? '<span class="selo alerta">◐ Atenção</span>'
          : '<span class="selo ok">✓ OK</span>';
    return `<div class="lix ${pct >= 0.8 ? 'cheia' : ''}">
      <div class="topo-lix"><div><b>${escapar(l.nome)}</b><br><small>${l.id} · ${escapar(l.local)}</small></div>${st}</div>
      <div class="pct">${Math.round(pct * 100)}%</div>
      <div class="barra ${pct >= 0.8 ? 'cheia' : pct >= 0.6 ? 'alerta' : ''}"><i style="width:${Math.min(100, pct * 100)}%"></i></div>
      <small>${l.nivel}/${l.capacidade} itens · última coleta ${l.ultimaColeta ? fmtHora(l.ultimaColeta) : '—'}</small>
      <button class="btn pequeno ${pct >= 0.8 ? 'perigo' : 'fantasma'}" data-coletar="${l.id}" ${l.nivel === 0 ? 'disabled' : ''}>🚛 Registrar coleta</button>
    </div>`;
  }).join('');

  $('coletas').innerHTML = p.coletas.length
    ? p.coletas.map((c) => `<div class="coleta"><span>🚛</span><span><b>${escapar(c.lixeira)}</b><br><span class="muted">${c.itens} itens · ${fmtNum(c.kg, 2)} kg → Cooperativa</span></span><span class="muted">${fmtHora(c.data)}</span></div>`).join('')
    : '<p class="muted">Nenhuma coleta registrada.</p>';

  $('feed').innerHTML = p.ultimos.map((d) => {
    const st = STATUS_DEP[d.status];
    const novo = !primeiraCarga && !vistos.has(d.id + d.status);
    vistos.add(d.id + d.status);
    const evid = d.temSnapshot
      ? `<a href="/api/depositos/${d.id}/snapshot" target="_blank"><img class="thumb" src="/api/depositos/${d.id}/snapshot" alt="Evidência" loading="lazy"></a>`
      : '<div class="thumb-vazio">—</div>';
    return `<tr class="${novo ? 'novo' : ''}">
      <td>${fmtHora(d.criadoEm)}</td>
      <td>${evid}</td>
      <td><b>${escapar(d.usuario?.nome || '—')}</b><br><small class="muted">${escapar(d.usuario?.delegacao || '')}</small></td>
      <td>${escapar(d.lixeira?.nome || d.lixeiraId)}</td>
      <td>${d.materialInfo.icone} ${escapar(d.materialInfo.nome)}</td>
      <td class="num">${d.declarado}</td>
      <td class="num">${d.status === 'liberada' ? d.contados || 0 : d.validado}</td>
      <td><span class="selo ${st.cls}">${st.txt}</span></td>
      <td class="num">${d.status === 'liberada' ? '…' : '+' + (d.pontos || 0)}</td>
    </tr>`;
  }).join('');
  primeiraCarga = false;
}

$('lixeiras').onclick = async (e) => {
  const b = e.target.closest('[data-coletar]');
  if (!b) return;
  b.disabled = true;
  try {
    const lix = await api(`/api/lixeiras/${b.dataset.coletar}/coletar`, { method: 'POST' });
    const c = lix.coletas.at(-1);
    toast(`🚛 Coleta registrada: ${c.itens} itens (${fmtNum(c.kg, 2)} kg) enviados à cooperativa`);
    atualizar();
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
};

atualizar();
setInterval(atualizar, 3000);
