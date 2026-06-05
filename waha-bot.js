const http = require('http');
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const key = k.trim();
    const value = rest.join('=').trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const BOT_PORT = Number(process.env.BOT_PORT || 8787);
const BOT_MENTION = (process.env.BOT_MENTION || '@bot').toLowerCase();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'chatbot';
const WAHA_BASE_URL = process.env.WAHA_BASE_URL || 'http://localhost:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';
const WAHA_WEBHOOK_URL = process.env.WAHA_WEBHOOK_URL || `http://host.docker.internal:${BOT_PORT}/webhook/waha`;
const pendingDateByChat = new Map();
const processedMessageIds = new Map();
const SUPPORTED_MESSAGE_EVENTS = new Set(['message']);
const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const MONTHS = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  'março': 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12
};

const WEEKDAYS = {
  domingo: 0,
  segunda: 1,
  'segunda-feira': 1,
  ter: 2,
  terca: 2,
  'terça': 2,
  'terca-feira': 2,
  'terça-feira': 2,
  quarta: 3,
  'quarta-feira': 3,
  quinta: 4,
  'quinta-feira': 4,
  sexta: 5,
  'sexta-feira': 5,
  sabado: 6,
  'sábado': 6
};

function normalize(text) {
  return String(text || '').trim().toLowerCase();
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function wahaHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {})
  };
}

async function ensureWahaSession() {
  const sessionUrl = `${WAHA_BASE_URL}/api/sessions/${encodeURIComponent(WAHA_SESSION)}`;
  const desiredConfig = {
    webhooks: [
      {
        url: WAHA_WEBHOOK_URL,
        events: [...SUPPORTED_MESSAGE_EVENTS]
      }
    ]
  };

  const sessionRes = await fetch(sessionUrl, { headers: wahaHeaders() });
  if (!sessionRes.ok) {
    throw new Error(`WAHA session ${sessionRes.status}: ${await sessionRes.text()}`);
  }

  let session = await sessionRes.json();
  const webhook = session?.config?.webhooks?.find((item) => item?.url === WAHA_WEBHOOK_URL);
  const configuredEvents = new Set(webhook?.events || []);
  const webhookReady =
    configuredEvents.size === SUPPORTED_MESSAGE_EVENTS.size &&
    [...SUPPORTED_MESSAGE_EVENTS].every((event) => configuredEvents.has(event));

  if (!webhookReady) {
    const updateRes = await fetch(sessionUrl, {
      method: 'PUT',
      headers: wahaHeaders(),
      body: JSON.stringify({
        name: WAHA_SESSION,
        config: desiredConfig
      })
    });

    if (!updateRes.ok) {
      throw new Error(`WAHA update session ${updateRes.status}: ${await updateRes.text()}`);
    }

    session = await updateRes.json();
    log(`Webhook WAHA configurado: ${WAHA_WEBHOOK_URL}`);
  }

  if (session.status === 'STOPPED' || session.status === 'FAILED') {
    const startRes = await fetch(`${sessionUrl}/start`, {
      method: 'POST',
      headers: wahaHeaders(),
      body: '{}'
    });

    if (!startRes.ok) {
      throw new Error(`WAHA start session ${startRes.status}: ${await startRes.text()}`);
    }

    log(`Sessao WAHA '${WAHA_SESSION}' iniciada.`);
  } else {
    log(`Sessao WAHA '${WAHA_SESSION}' em estado ${session.status}.`);
  }
}

function maintainWahaSession() {
  ensureWahaSession().catch((err) => {
    log(`Falha ao preparar sessao WAHA: ${err?.message || err}`);
  });
}

function getMessageText(payload) {
  return String(
    payload?.body ??
    payload?.text ??
    payload?.message?.text ??
    payload?.message?.conversation ??
    ''
  );
}

function getChatId(payload) {
  return payload?.from || payload?.chatId || payload?.chat?.id || payload?.to;
}

function getMessageId(payload) {
  return payload?.id?._serialized || payload?.id || payload?.message?.id?._serialized || payload?.message?.id;
}

function isDuplicateMessage(payload) {
  const messageId = getMessageId(payload);
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, timestamp] of processedMessageIds) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

function detectTipo(text) {
  const t = normalize(text);
  if (t.includes('projeto') || t.includes('projetado') || t.includes('projetos')) return 'projetado';
  if (t.includes('fabricado') || t.includes('produzido') || t.includes('producao') || t.includes('produção') || t.includes('armado')) return 'fabricado';
  if (t.includes('acabado') || t.includes('qualidade') || t.includes('acabamento')) return 'acabado';
  if (t.includes('expedido') || t.includes('expedicao') || t.includes('expedição') || t.includes('logistica') || t.includes('logística')) return 'expedido';
  if (t.includes('montado') || t.includes('montagem')) return 'montado';
  return null;
}

function detectReportMode(text) {
  const t = normalize(text);
  const wantsProgramado = t.includes('programado') || t.includes('realizado') || t.includes('setor') || t.includes('setores');
  const wantsVolume = t.includes('volume') || t.includes('volumes') || t.includes('tipo') || t.includes('tipos');

  if (wantsProgramado && !wantsVolume) return 'programado';
  if (wantsVolume && !wantsProgramado) return 'volume';
  return 'ambos';
}

function stripMention(text) {
  return normalize(text).replace(BOT_MENTION, '').trim();
}

function isOnlyMention(text) {
  const withoutMention = stripMention(text);
  return withoutMention === '';
}

function looksLikePeriodo(text) {
  const t = normalize(text);
  return (
    /[uú]l?tim[oa]\s+(domingo|segunda|ter|ter[çc]a|quarta|quinta|sexta|s[áa]bado|semana|m[eê]s)/i.test(t) ||
    /(nesta|nessa|esta|essa)\s+semana|semana\s+(atual|passada)|neste\s+m[eê]s|nesse\s+m[eê]s|este\s+m[eê]s|esse\s+m[eê]s|m[eê]s\s+(atual|passad[ao])/i.test(t) ||
    /(?:dia\s*)?\d{1,2}\/\d{1,2}(?:\/\d{4})?/i.test(t) ||
    /dia\s+\d{1,2}\s+de\s+[a-zç]+\s+de\s+\d{4}/i.test(t) ||
    /m[eê]s\s+de\s+[a-zç]+\s+de\s+\d{4}/i.test(t) ||
    /hoje|ontem|amanh[aã]/i.test(t)
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getLastWeekdayDate(targetWeekday) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let diff = (d.getDay() - targetWeekday + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function getPreviousWeekRange() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = today.getDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceMonday - 7);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { start, end };
}

function getCurrentWeekRange() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = today.getDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceMonday);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { start, end };
}

function getPreviousMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start, end };
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start, end };
}

function formatRangeLabel(start, end) {
  return `${pad2(start.getDate())}/${pad2(start.getMonth() + 1)}/${start.getFullYear()} a ${pad2(end.getDate())}/${pad2(end.getMonth() + 1)}/${end.getFullYear()}`;
}

function extractPeriodo(text) {
  const t = normalize(text);

  if (/\bhoje\b/i.test(t)) {
    const today = new Date();
    const d = formatISODate(today);
    return { modo: 'dia', ini: d, fim: d, label: `dia ${pad2(today.getDate())}/${pad2(today.getMonth() + 1)}/${today.getFullYear()}` };
  }

  if (/\bontem\b/i.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const iso = formatISODate(d);
    return { modo: 'dia', ini: iso, fim: iso, label: `dia ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` };
  }

  if (/\bamanh[aã]\b/i.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const iso = formatISODate(d);
    return { modo: 'dia', ini: iso, fim: iso, label: `dia ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` };
  }

  if (/(nesta|nessa|esta|essa)\s+semana/i.test(t) || /semana\s+atual/i.test(t)) {
    const { start, end } = getCurrentWeekRange();
    return {
      modo: 'semana',
      ini: formatISODate(start),
      fim: formatISODate(end),
      label: `semana ${formatRangeLabel(start, end)}`
    };
  }

  if (/[uú]l?tim[ao]\s+semana/i.test(t) || /semana\s+passada/i.test(t)) {
    const { start, end } = getPreviousWeekRange();
    return {
      modo: 'semana',
      ini: formatISODate(start),
      fim: formatISODate(end),
      label: `semana ${formatRangeLabel(start, end)}`
    };
  }

  if (/neste\s+m[eê]s/i.test(t) || /nesse\s+m[eê]s/i.test(t) || /este\s+m[eê]s/i.test(t) || /esse\s+m[eê]s/i.test(t) || /m[eê]s\s+atual/i.test(t)) {
    const { start, end } = getCurrentMonthRange();
    return {
      modo: 'mes',
      ini: formatISODate(start),
      fim: formatISODate(end),
      label: `mes ${pad2(start.getMonth() + 1)}/${start.getFullYear()}`
    };
  }

  if (/[uú]l?tim[ao]\s+m[eê]s/i.test(t) || /m[eê]s\s+passad[ao]/i.test(t)) {
    const { start, end } = getPreviousMonthRange();
    return {
      modo: 'mes',
      ini: formatISODate(start),
      fim: formatISODate(end),
      label: `mes ${pad2(start.getMonth() + 1)}/${start.getFullYear()}`
    };
  }

  const ultimaSemana = t.match(/[uú]l?tim[oa]\s+(domingo|segunda(?:-feira)?|ter|ter[çc]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[áa]bado)/i);
  if (ultimaSemana) {
    const rawDia = ultimaSemana[1]
      .toLowerCase()
      .replace('ç', 'c')
      .replace('á', 'a');
    const wk = WEEKDAYS[rawDia];
    if (wk !== undefined) {
      const d = getLastWeekdayDate(wk);
      const iso = formatISODate(d);
      return { modo: 'dia', ini: iso, fim: iso, label: `dia ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` };
    }
  }

  const diaMesAno = t.match(/dia\s+(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i);
  if (diaMesAno) {
    const day = Number(diaMesAno[1]);
    const month = MONTHS[diaMesAno[2]];
    const year = Number(diaMesAno[3]);
    if (month) {
      const d = `${year}-${pad2(month)}-${pad2(day)}`;
      return { modo: 'dia', ini: d, fim: d, label: `dia ${pad2(day)}/${pad2(month)}/${year}` };
    }
  }

  const diaMesCurto = t.match(/(?:dia\s*)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/i);
  if (diaMesCurto) {
    const day = Number(diaMesCurto[1]);
    const month = Number(diaMesCurto[2]);
    const year = diaMesCurto[3] ? Number(diaMesCurto[3]) : new Date().getFullYear();
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const d = `${year}-${pad2(month)}-${pad2(day)}`;
      return { modo: 'dia', ini: d, fim: d, label: `dia ${pad2(day)}/${pad2(month)}/${year}` };
    }
  }

  const mesAno = t.match(/m[eê]s\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i) || t.match(/([a-zç]+)\s+de\s+(\d{4})/i);
  if (mesAno) {
    const month = MONTHS[mesAno[1]];
    const year = Number(mesAno[2]);
    if (month) {
      const lastDay = new Date(year, month, 0).getDate();
      return {
        modo: 'mes',
        ini: `${year}-${pad2(month)}-01`,
        fim: `${year}-${pad2(month)}-${pad2(lastDay)}`,
        label: `mes ${pad2(month)}/${year}`
      };
    }
  }

  const today = new Date();
  const d = formatISODate(today);
  return { modo: 'dia', ini: d, fim: d, label: `dia ${pad2(today.getDate())}/${pad2(today.getMonth() + 1)}/${today.getFullYear()}` };
}

async function querySupabase(tipo, ini, fim) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_volume_periodo`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SUPABASE_SCHEMA,
      'Content-Profile': SUPABASE_SCHEMA
    },
    body: JSON.stringify({
      p_tipo: tipo,
      p_data_inicial: ini,
      p_data_final: fim,
      p_obra: null
    })
  });

  if (!res.ok) throw new Error(`Supabase RPC ${res.status} [schema=${SUPABASE_SCHEMA}]`);
  const data = await res.json();
  return data?.[0] || { volume_total: 0, quantidade_total: 0 };
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SUPABASE_SCHEMA,
      'Content-Profile': SUPABASE_SCHEMA
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Supabase RPC ${name} ${res.status} [schema=${SUPABASE_SCHEMA}]`);
  return res.json();
}

async function queryProgramadoRealizado(ini, fim) {
  const [setores, volumes] = await Promise.all([
    rpc('get_programado_realizado_periodo', {
      p_data_inicial: ini,
      p_data_final: fim,
      p_setor: null
    }),
    rpc('get_volume_geral_periodo', {
      p_data_inicial: ini,
      p_data_final: fim
    })
  ]);

  const montado = volumes.find((item) => item.tipo === 'montado');

  return setores.map((setor) => {
    if (setor.setor !== 'montagem' || !montado) return setor;

    return {
      ...setor,
      realizado_total: montado.volume_total,
      realizado_quantidade: montado.quantidade_total,
      realizado_unidade: 'm3'
    };
  });
}

async function queryVolumeGeral(ini, fim) {
  const [volumes, setores] = await Promise.all([
    rpc('get_volume_geral_periodo', {
      p_data_inicial: ini,
      p_data_final: fim
    }),
    queryProgramadoRealizado(ini, fim)
  ]);

  const setorPorTipo = {
    acabado: 'acabamento',
    expedido: 'expedicao'
  };

  return volumes.map((volume) => {
    const setor = setores.find((item) => item.setor === setorPorTipo[volume.tipo]);
    if (!setor) return volume;

    return {
      ...volume,
      volume_total: setor.realizado_total,
      quantidade_total: setor.realizado_quantidade
    };
  });
}

function fmtVolume(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function fmtQuantidade(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    maximumFractionDigits: 0
  });
}

function fmtUnit(unit) {
  const normalized = normalize(unit).replace('m3', 'm³');
  return normalized || 'm³';
}

function formatProgramadoRealizado(rows) {
  const totalM3 = rows.reduce((acc, row) => {
    const progUnit = fmtUnit(row.programado_unidade);
    const realUnit = fmtUnit(row.realizado_unidade);
    if (progUnit === 'm³') acc.programado += Number(row.programado_total || 0);
    if (realUnit === 'm³') acc.realizado += Number(row.realizado_total || 0);
    return acc;
  }, { programado: 0, realizado: 0 });

  return [
    '*Programado vs Realizado*',
    ...rows.map((row) => {
      const progUnit = fmtUnit(row.programado_unidade);
      const realUnit = fmtUnit(row.realizado_unidade);
      return `* ${row.label}: ${fmtVolume(row.programado_total)} ${progUnit} ${fmtQuantidade(row.programado_quantidade)} pçs | *${fmtVolume(row.realizado_total)} ${realUnit} ${fmtQuantidade(row.realizado_quantidade)} pçs*`;
    }),
    `* *TOTAL m³: ${fmtVolume(totalM3.programado)} m³ | ${fmtVolume(totalM3.realizado)} m³*`
  ].join('\n');
}

function formatVolumeGeral(rows) {
  const total = rows.reduce((sum, row) => sum + Number(row.volume_total || 0), 0);
  const quantidadeTotal = rows.reduce((sum, row) => sum + Number(row.quantidade_total || 0), 0);

  return [
    '*Volume geral*',
    ...rows.map((row) => `* ${row.label}: ${fmtVolume(row.volume_total)} m³ ${fmtQuantidade(row.quantidade_total)} pçs`),
    `* *TOTAL: ${fmtVolume(total)} m³ ${fmtQuantidade(quantidadeTotal)} pçs*`
  ].join('\n');
}

function formatPeriodoHeader(periodo) {
  return `*Data consultada:* ${periodo.label}`;
}

async function buildResumoCompleto(periodo) {
  const [programadoRealizado, volumeGeral] = await Promise.all([
    queryProgramadoRealizado(periodo.ini, periodo.fim),
    queryVolumeGeral(periodo.ini, periodo.fim)
  ]);

  return [
    formatPeriodoHeader(periodo),
    '',
    formatProgramadoRealizado(programadoRealizado),
    '',
    formatVolumeGeral(volumeGeral)
  ].join('\n');
}

function perguntaData() {
  return [
    'Qual a data que deseja consultar?',
    '',
    'Exemplos:',
    '* 29/05',
    '* hoje',
    '* ontem',
    '* última sexta',
    '* última semana',
    '* último mês',
    '* junho de 2026'
  ].join('\n');
}

async function sendText(chatId, text) {
  const res = await fetch(`${WAHA_BASE_URL}/api/sendText`, {
    method: 'POST',
    headers: wahaHeaders(),
    body: JSON.stringify({
      session: WAHA_SESSION,
      chatId,
      text
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WAHA sendText ${res.status}: ${body}`);
  }
}

async function processMessage(event) {
  if (!SUPPORTED_MESSAGE_EVENTS.has(event?.event)) {
    log(`Evento ignorado: ${event?.event || 'sem event'}`);
    return;
  }

  const payload = event?.payload || {};
  if (payload.fromMe) return;
  if (isDuplicateMessage(payload)) {
    log(`Mensagem duplicada ignorada: ${getMessageId(payload)}.`);
    return;
  }

  const body = getMessageText(payload);
  const chatId = getChatId(payload);

  if (!chatId) {
    log('Mensagem ignorada: chatId ausente no payload.');
    return;
  }

  if (!body.trim()) {
    log(`Mensagem ignorada: texto vazio para chatId ${chatId}.`);
    return;
  }

  if (!body.toLowerCase().includes(BOT_MENTION) && pendingDateByChat.has(chatId)) {
    if (!looksLikePeriodo(body)) {
      await sendText(chatId, 'Nao entendi a data. Pode enviar algo como 29/05, hoje ou ultima sexta?');
      return;
    }

    pendingDateByChat.delete(chatId);
    const periodo = extractPeriodo(body);
    await sendText(chatId, await buildResumoCompleto(periodo));
    return;
  }

  if (!body.toLowerCase().includes(BOT_MENTION)) return;

  if (isOnlyMention(body)) {
    pendingDateByChat.set(chatId, { createdAt: Date.now() });
    await sendText(chatId, perguntaData());
    return;
  }

  const tipo = detectTipo(body);
  const mode = detectReportMode(body);

  const periodo = extractPeriodo(body);
  let resposta;

  if (tipo && mode === 'volume' && !body.toLowerCase().includes('geral')) {
    const result = await querySupabase(tipo, periodo.ini, periodo.fim);
    const volume = Number(result.volume_total || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    const qtd = Number(result.quantidade_total || 0).toLocaleString('pt-BR');
    resposta = [
      formatPeriodoHeader(periodo),
      '',
      `*Resumo ${tipo}*`,
      `Volume: ${volume} m³`,
      `Quantidade: ${qtd}`
    ].join('\n');
  } else {
    const blocos = [];

    if (mode === 'programado' || mode === 'ambos') {
      blocos.push(formatProgramadoRealizado(await queryProgramadoRealizado(periodo.ini, periodo.fim)));
    }

    if (mode === 'volume' || mode === 'ambos') {
      blocos.push(formatVolumeGeral(await queryVolumeGeral(periodo.ini, periodo.fim)));
    }

    resposta = [
      formatPeriodoHeader(periodo),
      '',
      blocos.join('\n\n')
    ].join('\n');
  }

  await sendText(chatId, resposta);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook/waha') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try {
        const event = JSON.parse(raw || '{}');
        await processMessage(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log(`Erro no webhook: ${err?.stack || err}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${BOT_PORT} ja esta em uso. O bot provavelmente ja esta rodando.`);
    console.error(`Teste com: Invoke-WebRequest http://localhost:${BOT_PORT}/health -UseBasicParsing`);
    console.error('Se precisar reiniciar, encerre o processo node antigo antes de iniciar outro.');
    process.exit(1);
  }

  throw err;
});

server.listen(BOT_PORT, () => {
  console.log(`Bot ouvindo na porta ${BOT_PORT}`);
  maintainWahaSession();
  setInterval(maintainWahaSession, 60_000).unref();
});
