const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
// HTTPS é necessário para o celular liberar a câmera ao vivo (scanner de QR) dentro do app
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const SESSAO_EXPIRA_MS = 120 * 1000; // segurança: libera a lixeira se a estação não responder
const BONUS_DECLARACAO_CORRETA = 5;

// Fatores aproximados (estimativa): peso médio por item e emissões evitadas pela reciclagem
// (referência: EPA WARM — alumínio ~9 kgCO2e/kg, PET ~1,5 kgCO2e/kg).
const MATERIAIS = {
  // PET aceita "cup": com o item caindo borrado, o modelo confunde garrafa e copo com frequência
  pet: { id: 'pet', nome: 'Garrafa PET', plural: 'Garrafas PET', icone: '🧴', classes: ['bottle', 'cup'], pesoKg: 0.025, co2PorKg: 1.5, pontos: 10 },
  lata: { id: 'lata', nome: 'Lata de alumínio', plural: 'Latas de alumínio', icone: '🥫', classes: ['cup', 'bottle'], pesoKg: 0.014, co2PorKg: 9.0, pontos: 15 },
  copo: { id: 'copo', nome: 'Copo plástico', plural: 'Copos plásticos', icone: '🥤', classes: ['cup'], pesoKg: 0.004, co2PorKg: 1.5, pontos: 5 },
};

const DELEGACOES = ['Joinville', 'Blumenau', 'Chapecó', 'Criciúma', 'Florianópolis', 'Lages', 'Itajaí', 'Jaraguá do Sul'];

// ---------- Persistência ----------
const novoId = () => crypto.randomUUID().slice(0, 8);

function seed() {
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const nomes = ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Eduarda Alves', 'Felipe Costa', 'Gabriela Nunes',
    'Henrique Melo', 'Isabela Freitas', 'João Pedro Silva', 'Larissa Prado', 'Mateus Ribeiro', 'Natália Cruz', 'Otávio Reis'];
  const usuarios = nomes.map((nome, i) => ({
    id: novoId(), nome, delegacao: DELEGACOES[i % DELEGACOES.length], tipo: i % 3 === 0 ? 'torcedor' : 'atleta', criadoEm: Date.now() - 8 * 3600e3,
  }));

  const lixeiras = [
    { id: 'GIN-01', nome: 'Ginásio Central', local: 'Praça esportiva — quadra principal', capacidade: 25, nivel: 13, coletas: [] },
    { id: 'ALO-01', nome: 'Alojamento Bloco A', local: 'Alojamento das delegações', capacidade: 80, nivel: 31, coletas: [] },
    { id: 'PRA-01', nome: 'Praça de Alimentação', local: 'Arredores do ginásio', capacidade: 100, nivel: 86, coletas: [] },
  ];

  const depositos = [];
  const agora = Date.now();
  for (let i = 0; i < 38; i++) {
    const r = rnd();
    const material = r < 0.5 ? 'pet' : r < 0.8 ? 'lata' : 'copo';
    const declarado = 1 + Math.floor(rnd() * 5);
    const q = rnd();
    const validado = q < 0.84 ? declarado : q < 0.95 ? Math.max(1, declarado - 1 - Math.floor(rnd() * 2)) : 0;
    const quando = agora - Math.floor(rnd() * 6 * 3600e3) - 10 * 60e3;
    const dep = {
      id: novoId(), usuarioId: pick(usuarios).id, lixeiraId: pick(lixeiras).id, material, declarado,
      contados: validado, criadoEm: quando, finalizadoEm: quando + 20e3 + Math.floor(rnd() * 20e3),
    };
    finalizarCalculo(dep, validado);
    depositos.push(dep);
  }
  depositos.sort((a, b) => a.criadoEm - b.criadoEm);

  lixeiras[1].coletas.push({ id: novoId(), itens: 74, kg: 1.6, data: agora - 4 * 3600e3 });
  lixeiras[2].coletas.push({ id: novoId(), itens: 100, kg: 2.1, data: agora - 3 * 3600e3 });

  return { usuarios, lixeiras, depositos };
}

function carregar() {
  if (process.argv.includes('--reset')) return null;
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; }
}

let db = carregar();
if (!db) { db = seed(); salvar(); }

function salvar() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  } catch (e) {
    console.error('Falha ao salvar banco:', e.message);
  }
}

// ---------- Regras de negócio ----------
function finalizarCalculo(dep, validado) {
  const mat = MATERIAIS[dep.material];
  dep.validado = Math.max(0, Math.min(validado, dep.declarado));
  dep.status = dep.validado === 0 ? 'expirada' : dep.validado < dep.declarado ? 'divergente' : 'concluida';
  dep.pontos = dep.validado * mat.pontos + (dep.status === 'concluida' ? BONUS_DECLARACAO_CORRETA : 0);
  dep.kg = +(dep.validado * mat.pesoKg).toFixed(4);
  dep.co2Kg = +(dep.kg * mat.co2PorKg).toFixed(4);
}

function expirarSessoesAntigas() {
  const agora = Date.now();
  for (const dep of db.depositos) {
    if (dep.status === 'liberada' && agora - dep.criadoEm > SESSAO_EXPIRA_MS) {
      dep.finalizadoEm = agora;
      finalizarCalculo(dep, dep.contados || 0);
      aplicarNaLixeira(dep);
      salvar();
    }
  }
}

function aplicarNaLixeira(dep) {
  const lix = db.lixeiras.find((l) => l.id === dep.lixeiraId);
  if (lix) lix.nivel = Math.min(lix.capacidade, lix.nivel + dep.validado);
}

const sessaoAtiva = (lixeiraId) => db.depositos.find((d) => d.lixeiraId === lixeiraId && d.status === 'liberada');
const pontosDoUsuario = (id) => db.depositos.filter((d) => d.usuarioId === id).reduce((s, d) => s + (d.pontos || 0), 0);

function publicoUsuario(u) {
  return u && { ...u, pontos: pontosDoUsuario(u.id) };
}

function publicoDeposito(dep) {
  if (!dep) return null;
  const { snapshot, ...resto } = dep;
  const u = db.usuarios.find((x) => x.id === dep.usuarioId);
  const lix = db.lixeiras.find((l) => l.id === dep.lixeiraId);
  return {
    ...resto,
    temSnapshot: !!snapshot,
    materialInfo: MATERIAIS[dep.material],
    usuario: u ? { id: u.id, nome: u.nome, delegacao: u.delegacao, pontos: pontosDoUsuario(u.id) } : null,
    lixeira: lix ? { id: lix.id, nome: lix.nome, nivel: lix.nivel, capacidade: lix.capacidade } : null,
  };
}

function ipsLocais() {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const a of lista || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) ips.push(a.address);
  }
  const privado = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return ips.sort((a, b) => privado(b) - privado(a));
}

// Certificado autoassinado para a rede local (gerado uma vez e reaproveitado)
function certificado() {
  const arquivo = path.join(path.dirname(DB_FILE), 'certificado.json');
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch {}
  const selfsigned = require('selfsigned');
  const altNames = [{ type: 2, value: 'localhost' }, ...['127.0.0.1', ...ipsLocais()].map((ip) => ({ type: 7, ip }))];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'RevitTech (rede local)' }], {
    days: 825, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
  });
  const c = { key: pems.private, cert: pems.cert };
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(c));
  } catch (e) {
    console.error('Não foi possível salvar o certificado:', e.message);
  }
  return c;
}

let httpsAtivo = false;
const baseUrl = () => process.env.PUBLIC_URL
  || (httpsAtivo ? `https://${ipsLocais()[0] || 'localhost'}:${HTTPS_PORT}` : `http://${ipsLocais()[0] || 'localhost'}:${PORT}`);
const ehLocal = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
// Celular abrindo o app pelo endereço HTTP da rede → manda para a versão HTTPS (câmera ao vivo)
app.use((req, res, next) => {
  if (httpsAtivo && !req.secure && req.path === '/app.html' && !ehLocal(req.hostname)) {
    return res.redirect(302, `https://${req.hostname}:${HTTPS_PORT}${req.originalUrl}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => { expirarSessoesAntigas(); next(); });

app.get('/api/config', (req, res) => {
  res.json({ baseUrl: baseUrl(), ips: ipsLocais(), httpsPort: httpsAtivo ? HTTPS_PORT : null, materiais: MATERIAIS, delegacoes: DELEGACOES, bonus: BONUS_DECLARACAO_CORRETA });
});

app.post('/api/usuarios', (req, res) => {
  const { nome, delegacao, tipo } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe seu nome.' });
  if (!DELEGACOES.includes(delegacao)) return res.status(400).json({ erro: 'Delegação inválida.' });
  const u = { id: novoId(), nome: nome.trim().slice(0, 40), delegacao, tipo: tipo === 'torcedor' ? 'torcedor' : 'atleta', criadoEm: Date.now() };
  db.usuarios.push(u);
  salvar();
  res.status(201).json(publicoUsuario(u));
});

app.get('/api/usuarios/:id', (req, res) => {
  const u = db.usuarios.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  const ranking = rankingDelegacoes();
  const historico = db.depositos.filter((d) => d.usuarioId === u.id).slice(-10).reverse().map(publicoDeposito);
  res.json({ ...publicoUsuario(u), posicaoDelegacao: ranking.findIndex((r) => r.delegacao === u.delegacao) + 1, historico });
});

app.get('/api/lixeiras', (req, res) => {
  res.json(db.lixeiras.map((l) => ({ ...l, emUso: !!sessaoAtiva(l.id) })));
});

app.get('/api/lixeiras/:id/qrcode', async (req, res) => {
  const lix = db.lixeiras.find((l) => l.id === req.params.id);
  if (!lix) return res.status(404).end();
  // preto puro e borda de 4 módulos (especificação): mais fácil de ler em foto de tela
  const png = await QRCode.toBuffer(`${baseUrl()}/app.html?lixeira=${lix.id}`, { width: 520, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  res.type('png').send(png);
});

app.get('/api/qrcode-app', async (req, res) => {
  const png = await QRCode.toBuffer(`${baseUrl()}/app.html`, { width: 360, margin: 1, color: { dark: '#0b3d2e', light: '#ffffff' } });
  res.type('png').send(png);
});

app.get('/api/lixeiras/:id/sessao', (req, res) => {
  const lix = db.lixeiras.find((l) => l.id === req.params.id);
  if (!lix) return res.status(404).json({ erro: 'Lixeira não encontrada.' });
  res.json({ lixeira: lix, sessao: publicoDeposito(sessaoAtiva(lix.id)) });
});

app.post('/api/lixeiras/:id/coletar', (req, res) => {
  const lix = db.lixeiras.find((l) => l.id === req.params.id);
  if (!lix) return res.status(404).json({ erro: 'Lixeira não encontrada.' });
  const desde = lix.coletas.length ? lix.coletas[lix.coletas.length - 1].data : 0;
  const kg = db.depositos.filter((d) => d.lixeiraId === lix.id && d.finalizadoEm > desde).reduce((s, d) => s + (d.kg || 0), 0);
  lix.coletas.push({ id: novoId(), itens: lix.nivel, kg: +kg.toFixed(2), data: Date.now() });
  lix.nivel = 0;
  salvar();
  res.json(lix);
});

app.post('/api/depositos', (req, res) => {
  const { usuarioId, lixeiraId, material } = req.body || {};
  const quantidade = parseInt(req.body?.quantidade, 10);
  const u = db.usuarios.find((x) => x.id === usuarioId);
  const lix = db.lixeiras.find((l) => l.id === lixeiraId);
  if (!u) return res.status(400).json({ erro: 'Faça seu cadastro novamente.' });
  if (!lix) return res.status(404).json({ erro: 'Lixeira não encontrada.' });
  if (!MATERIAIS[material]) return res.status(400).json({ erro: 'Material inválido.' });
  if (!(quantidade >= 1 && quantidade <= 20)) return res.status(400).json({ erro: 'Quantidade deve ser entre 1 e 20.' });
  if (sessaoAtiva(lix.id)) return res.status(409).json({ erro: 'Lixeira em uso. Aguarde alguns segundos.' });
  if (lix.nivel + quantidade > lix.capacidade) return res.status(409).json({ erro: 'Lixeira cheia! A equipe de coleta já foi avisada.' });

  const dep = { id: novoId(), usuarioId: u.id, lixeiraId: lix.id, material, declarado: quantidade, contados: 0, status: 'liberada', criadoEm: Date.now() };
  db.depositos.push(dep);
  salvar();
  res.status(201).json(publicoDeposito(dep));
});

app.get('/api/depositos/:id', (req, res) => {
  const dep = db.depositos.find((d) => d.id === req.params.id);
  if (!dep) return res.status(404).json({ erro: 'Depósito não encontrado.' });
  res.json(publicoDeposito(dep));
});

app.get('/api/depositos/:id/snapshot', (req, res) => {
  const dep = db.depositos.find((d) => d.id === req.params.id);
  if (!dep || !dep.snapshot) return res.status(404).end();
  res.type('jpeg').send(Buffer.from(dep.snapshot.split(',')[1], 'base64'));
});

app.post('/api/depositos/:id/progresso', (req, res) => {
  const dep = db.depositos.find((d) => d.id === req.params.id);
  if (!dep || dep.status !== 'liberada') return res.status(409).json({ erro: 'Sessão encerrada.' });
  dep.contados = Math.max(0, parseInt(req.body?.contados, 10) || 0);
  res.json({ ok: true });
});

app.post('/api/depositos/:id/resultado', (req, res) => {
  const dep = db.depositos.find((d) => d.id === req.params.id);
  if (!dep) return res.status(404).json({ erro: 'Depósito não encontrado.' });
  if (dep.status !== 'liberada') return res.json(publicoDeposito(dep));
  const validado = Math.max(0, parseInt(req.body?.validado, 10) || 0);
  dep.contados = validado;
  dep.finalizadoEm = Date.now();
  if (typeof req.body?.snapshot === 'string' && req.body.snapshot.startsWith('data:image/jpeg')) dep.snapshot = req.body.snapshot;
  finalizarCalculo(dep, validado);
  aplicarNaLixeira(dep);
  salvar();
  res.json(publicoDeposito(dep));
});

app.post('/api/depositos/:id/cancelar', (req, res) => {
  const dep = db.depositos.find((d) => d.id === req.params.id);
  if (!dep) return res.status(404).json({ erro: 'Depósito não encontrado.' });
  if (dep.status === 'liberada') {
    dep.finalizadoEm = Date.now();
    finalizarCalculo(dep, dep.contados || 0);
    aplicarNaLixeira(dep);
    salvar();
  }
  res.json(publicoDeposito(dep));
});

function rankingDelegacoes() {
  const mapa = Object.fromEntries(DELEGACOES.map((d) => [d, { delegacao: d, pontos: 0, itens: 0, co2Kg: 0 }]));
  for (const dep of db.depositos) {
    const u = db.usuarios.find((x) => x.id === dep.usuarioId);
    if (!u || !mapa[u.delegacao]) continue;
    mapa[u.delegacao].pontos += dep.pontos || 0;
    mapa[u.delegacao].itens += dep.validado || 0;
    mapa[u.delegacao].co2Kg += dep.co2Kg || 0;
  }
  return Object.values(mapa).sort((a, b) => b.pontos - a.pontos);
}

app.get('/api/painel', (req, res) => {
  const finalizados = db.depositos.filter((d) => d.status !== 'liberada');
  const soma = (arr, k) => arr.reduce((s, d) => s + (d[k] || 0), 0);
  const declarados = soma(finalizados, 'declarado');

  const porMaterial = Object.values(MATERIAIS).map((m) => {
    const ds = finalizados.filter((d) => d.material === m.id);
    return { id: m.id, nome: m.nome, icone: m.icone, itens: soma(ds, 'validado'), kg: soma(ds, 'kg'), co2Kg: soma(ds, 'co2Kg') };
  });

  const usuarios = db.usuarios.map(publicoUsuario).filter((u) => u.pontos > 0).sort((a, b) => b.pontos - a.pontos).slice(0, 5);

  const coletas = db.lixeiras.flatMap((l) => l.coletas.map((c) => ({ ...c, lixeira: l.nome }))).sort((a, b) => b.data - a.data).slice(0, 6);

  res.json({
    kpis: {
      itens: soma(finalizados, 'validado'),
      kg: soma(finalizados, 'kg'),
      co2Kg: soma(finalizados, 'co2Kg'),
      taxaValidacao: declarados ? soma(finalizados, 'validado') / declarados : 1,
      depositos: finalizados.length,
      divergencias: finalizados.filter((d) => d.status !== 'concluida').length,
      participantes: new Set(db.depositos.map((d) => d.usuarioId)).size,
    },
    porMaterial,
    rankingDelegacoes: rankingDelegacoes(),
    rankingUsuarios: usuarios,
    lixeiras: db.lixeiras.map((l) => ({ ...l, coletas: undefined, emUso: !!sessaoAtiva(l.id), ultimaColeta: l.coletas.at(-1)?.data || null })),
    coletas,
    ultimos: db.depositos.slice(-12).reverse().map(publicoDeposito),
  });
});

try {
  https.createServer(certificado(), app)
    .on('error', (e) => console.error(`HTTPS indisponível (${e.code || e.message}); o scanner ao vivo não funcionará no celular.`))
    .listen(HTTPS_PORT, '0.0.0.0', () => { httpsAtivo = true; });
} catch (e) {
  console.error('HTTPS desativado:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  setTimeout(() => {
    console.log('\n♻️  RevitTech rodando!');
    console.log(`   Local:     http://localhost:${PORT}`);
    for (const ip of ipsLocais()) console.log(`   Rede:      http://${ip}:${PORT}`);
    console.log(`\n   Lixeira:   http://localhost:${PORT}/lixeira.html?id=GIN-01`);
    console.log(`   Painel:    http://localhost:${PORT}/painel.html`);
    console.log(`   App (QR):  ${baseUrl()}/app.html`);
    if (httpsAtivo) console.log('              (no celular, aceite o aviso de certificado uma vez: "Avançado" → "Continuar")');
    console.log('');
  }, 300);
});
