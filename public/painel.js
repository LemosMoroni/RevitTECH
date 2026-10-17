// Painel ESG: KPIs, ranking, materiais, lixeiras (logística reversa) e feed com evidências
const $ = (id) => document.getElementById(id);
const vistos = new Set();
let primeiraCarga = true;
let ultimosDados = null;   // dados por hora, para redesenhar o gráfico ao redimensionar

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
  // equivalência para dar escala ao número (carro de passeio ~0,17 kgCO₂e/km)
  $('k-co2-eq').textContent = `≈ ${fmtNum(k.kmCarro)} km de carro não rodados · estimativa`;
  $('k-itens').textContent = fmtNum(k.itens);
  $('k-dep').textContent = `${fmtNum(k.depositos)} depósitos de ${fmtNum(k.participantes)} participantes`;
  $('k-kg').innerHTML = `${fmtNum(k.kg, 2)}<small> kg</small>`;
  $('k-part').textContent = k.itens ? `média de ${fmtNum((k.kg / k.itens) * 1000)} g por item` : '—';
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
    </div>`).join('') + '<div class="sub-escala">Barras proporcionais ao 1º colocado.</div>';

  $('top-usuarios').innerHTML = p.rankingUsuarios.map((u, i) => `
    <li><span>${i + 1}. <b>${escapar(u.nome)}</b> <span class="muted">· ${escapar(u.delegacao)} · ${u.tipo}</span></span><b>${fmtNum(u.pontos)}</b></li>`).join('');

  const maxItens = Math.max(1, ...p.porMaterial.map((m) => m.itens));
  $('materiais').innerHTML = p.porMaterial.map((m) => `
    <div class="mat-linha" title="${escapar(m.nome)}: ${m.itens} itens · ${fmtNum(m.kg, 2)} kg · ${fmtCO2(m.co2Kg)} CO₂e">
      <span class="ic">${m.icone}</span>
      <div><b>${escapar(m.nome)}</b><div class="trilho"><i style="width:${(m.itens / maxItens) * 100}%"></i></div></div>
      <div class="num"><b>${fmtNum(m.itens)}</b><small>${fmtNum(m.kg, 2)} kg · ${fmtCO2(m.co2Kg)} CO₂e</small></div>
    </div>`).join('') + '<div class="sub-escala">Barras proporcionais ao material mais reciclado.</div>';

  ultimosDados = p.porHora || [];
  renderGraficoHora(ultimosDados);

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
    // Depósitos de demonstração não passaram pela câmera: dizemos isso em vez de fingir uma foto
    const evid = d.temSnapshot
      ? `<a href="/api/depositos/${d.id}/snapshot" target="_blank" title="Abrir a foto capturada pela câmera"><img class="thumb" src="/api/depositos/${d.id}/snapshot" alt="Evidência" loading="lazy"></a>`
      : '<div class="thumb-vazio" title="Depósito de demonstração, criado sem passar pela câmera da estação"><b>📷</b>demo</div>';
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
  $('feed-resumo').textContent = k.comEvidencia
    ? `${fmtNum(k.comEvidencia)} com foto da câmera · últimos ${p.ultimos.length} de ${fmtNum(k.depositos)}`
    : `últimos ${p.ultimos.length} de ${fmtNum(k.depositos)} · fotos aparecem nos depósitos feitos na estação`;
  primeiraCarga = false;
}

// ---------- Gráfico de colunas: itens validados por hora ----------
let ultimoGrafico = '';

function renderGraficoHora(horas) {
  const caixa = $('grafico-hora');
  if (!horas.length) { caixa.innerHTML = '<p class="muted">Sem dados.</p>'; return; }
  // largura real do cartão: o texto do eixo fica legível em qualquer tela (o SVG não encolhe a fonte)
  const W = Math.max(280, Math.round(caixa.clientWidth || 560));
  // o painel atualiza a cada 3 s; só redesenha se os dados mudaram (mantém a dica do mouse)
  const chave = W + JSON.stringify(horas);
  if (chave === ultimoGrafico) return;
  ultimoGrafico = chave;
  const H = 170, mEsq = 28, mDir = 8, mTopo = 22, mBase = 22;
  const larguraUtil = W - mEsq - mDir;
  const alturaUtil = H - mTopo - mBase;
  const max = Math.max(1, ...horas.map((h) => h.itens));
  // topo do eixo num número "redondo"
  const passo = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : 20;
  const topo = Math.ceil(max / passo) * passo;
  const passoCol = larguraUtil / horas.length;
  const larguraCol = Math.max(4, Math.min(28, passoCol * 0.62));   // marcas finas, com respiro
  const y = (v) => mTopo + alturaUtil - (v / topo) * alturaUtil;
  const idxMax = horas.reduce((m, h, i) => (h.itens > horas[m].itens ? i : m), 0);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Itens validados por hora nas últimas 12 horas">`;
  // grade horizontal recessiva
  for (let v = 0; v <= topo; v += passo) {
    svg += `<line class="${v === 0 ? 'base' : 'grade'}" x1="${mEsq}" x2="${W - mDir}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${mEsq - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  horas.forEach((h, i) => {
    const x = mEsq + i * passoCol + (passoCol - larguraCol) / 2;
    const yTopo = y(h.itens);
    const alt = mTopo + alturaUtil - yTopo;
    const r = Math.min(4, larguraCol / 2, alt);
    // coluna com cantos arredondados só no topo, ancorada na base
    const d = alt > 0
      ? `M${x},${yTopo + alt} V${yTopo + r} Q${x},${yTopo} ${x + r},${yTopo} H${x + larguraCol - r} Q${x + larguraCol},${yTopo} ${x + larguraCol},${yTopo + r} V${yTopo + alt} Z`
      : '';
    const horaTxt = new Date(h.hora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    // alvo de hover maior que a coluna (a altura inteira da faixa)
    svg += `<rect class="alvo" x="${mEsq + i * passoCol}" y="${mTopo}" width="${passoCol}" height="${alturaUtil}" fill="transparent"
      data-i="${i}" data-hora="${horaTxt}" data-itens="${h.itens}" data-co2="${h.co2Kg}"/>`;
    svg += d ? `<path class="col" d="${d}"/>` : '';
    // rótulos do eixo x: só a cada 3 horas, para não poluir
    if (i % 3 === 0 || i === horas.length - 1) {
      svg += `<text x="${x + larguraCol / 2}" y="${H - 6}" text-anchor="middle">${horaTxt.slice(0, 2)}h</text>`;
    }
    // rótulo direto só no pico
    if (i === idxMax && h.itens > 0) {
      svg += `<text class="rotulo-max" x="${x + larguraCol / 2}" y="${yTopo - 6}" text-anchor="middle">${h.itens}</text>`;
    }
  });
  svg += '</svg><div class="dica" id="dica-hora"></div>';
  caixa.innerHTML = svg;

  const total = horas.reduce((s, h) => s + h.itens, 0);
  const pico = horas[idxMax];
  $('hora-resumo').textContent = total
    ? `pico às ${new Date(pico.hora).getHours()}h · ${fmtNum(total)} itens em 12 h`
    : 'últimas 12 h';

  const dica = $('dica-hora');
  caixa.querySelectorAll('.alvo').forEach((alvo) => {
    alvo.addEventListener('mouseenter', () => {
      const de = Number(alvo.dataset.hora.slice(0, 2));
      const ate = String((de + 1) % 24).padStart(2, '0');
      dica.innerHTML = `<b>${alvo.dataset.itens} itens</b>${String(de).padStart(2, '0')}h–${ate}h · ${fmtCO2(Number(alvo.dataset.co2))} CO₂e`;
      const rCaixa = caixa.getBoundingClientRect();
      const rAlvo = alvo.getBoundingClientRect();
      dica.style.left = `${rAlvo.left - rCaixa.left + rAlvo.width / 2}px`;
      dica.style.top = `${Math.max(0, rAlvo.top - rCaixa.top + 10)}px`;
      dica.classList.add('on');
      alvo.nextElementSibling?.classList.add('ativa');
    });
    alvo.addEventListener('mouseleave', () => {
      dica.classList.remove('on');
      alvo.nextElementSibling?.classList.remove('ativa');
    });
  });
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
// redesenha o gráfico ao mudar o tamanho da tela (ex.: girar o celular)
window.addEventListener('resize', () => { if (ultimosDados) renderGraficoHora(ultimosDados); });
