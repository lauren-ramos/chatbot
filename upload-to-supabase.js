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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'chatbot';
const BASE_PREINFRA = 'http://179.124.195.91:1890/ADM_PreInfra/api/bi';
const URL_GLOBAL = `${BASE_PREINFRA}/informacaoGlobalPeca?somenteAtivas=true`;
const URL_QUADRO = 'https://programacao-de-fabrica.vercel.app/api/quadro';
const URL_ESCOAMENTO = 'https://frota-web-2.vercel.app/api/escoamento';
const SYNC_DATA_INICIAL = process.env.SYNC_DATA_INICIAL || '2026-01-01';
const SYNC_DATA_FINAL = process.env.SYNC_DATA_FINAL || new Date().toISOString().slice(0, 10);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 60000);
const API_RETRIES = Number(process.env.API_RETRIES || 2);
const SYNC_YEAR = Number(SYNC_DATA_FINAL.slice(0, 4));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  process.exit(1);
}

function normText(v) {
  return String(v ?? '').trim().toUpperCase();
}

function normKey(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const MONTHS = {
  jan: 1,
  janeiro: 1,
  fev: 2,
  fevereiro: 2,
  mar: 3,
  marco: 3,
  março: 3,
  abr: 4,
  abril: 4,
  mai: 5,
  maio: 5,
  jun: 6,
  junho: 6,
  jul: 7,
  julho: 7,
  ago: 8,
  agosto: 8,
  set: 9,
  setembro: 9,
  out: 10,
  outubro: 10,
  nov: 11,
  novembro: 11,
  dez: 12,
  dezembro: 12
};

function toISODate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === 'null') return null;

  const shortBr = normKey(raw).match(/^(\d{1,2})\/([a-z]+)(?:\/(\d{2}|\d{4}))?$/);
  if (shortBr) {
    const [, dd, monthRaw, yyyyRaw] = shortBr;
    const month = MONTHS[monthRaw];
    if (month) {
      const year = yyyyRaw ? (yyyyRaw.length === 2 ? Number(`20${yyyyRaw}`) : Number(yyyyRaw)) : SYNC_YEAR;
      return `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+\d{2}:\d{2}:\d{2})?$/);
  if (br) {
    const [, dd, mm, yyyyRaw] = br;
    const yyyy = yyyyRaw.length === 2 ? `20${yyyyRaw}` : yyyyRaw;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString().slice(0, 10);

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = API_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Falha em ${url}: ${res.status}`);
  return res.json();
}

async function fetchJsonSafe(label, url) {
  let lastError = null;

  for (let attempt = 0; attempt <= API_RETRIES; attempt += 1) {
    try {
      if (attempt > 0) {
        console.warn(`Aviso: tentando novamente ${label} (${attempt}/${API_RETRIES})...`);
        await sleep(1000 * attempt);
      }

      return await fetchJson(url);
    } catch (err) {
      lastError = err;
    }
  }

  console.warn(`Aviso: ${label} indisponivel apos ${API_RETRIES + 1} tentativa(s): ${lastError}`);
  return null;
}

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['pecas', 'data', 'items', 'results', 'rows', 'dados']) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  return [];
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  }

  for (const wantedKey of keys.map(normKey)) {
    for (const [key, value] of Object.entries(row || {})) {
      if (normKey(key) === wantedKey && value !== undefined && value !== null && value !== '') return value;
    }
  }

  return null;
}

function firstDate(row, keys) {
  const direct = firstValue(row, keys);
  const date = toISODate(direct);
  if (date) return date;

  for (const [key, value] of Object.entries(row || {})) {
    const normalized = normKey(key);
    if ((normalized.includes('data') || normalized.includes('date')) && keys.some((k) => normalized.includes(normKey(k)))) {
      const found = toISODate(value);
      if (found) return found;
    }
  }

  return null;
}

function detectSetor(row, fallback = '') {
  const text = normKey([
    fallback,
    firstValue(row, ['setor', 'nomeSetor', 'descricaoSetor', 'centroTrabalho', 'faseProducao', 'etapa', 'tipo', 'status', 'processo']),
    firstValue(row, ['nomePeca', 'produto', 'descricao', 'observacao'])
  ].filter(Boolean).join(' '));

  if (text.includes('escoamento')) return 'escoamento';
  if (text.includes('armacao') || text.includes('armação') || text.includes('arma')) return 'armacao';
  if (text.includes('acab')) return 'acabamento';
  if (text.includes('exped') || text.includes('carga') || text.includes('logistica')) return 'expedicao';
  if (text.includes('mont')) return 'montagem';
  if (text.includes('concret') || text.includes('forma') || text.includes('pista') || text.includes('painel')) return 'concretagem';

  return null;
}

function volumeFrom(row, setor = null) {
  if (Array.isArray(row?.pecas)) {
    return row.pecas.reduce((sum, peca) => {
      const quantidade = numOrZero(firstValue(peca, ['Quantidade', 'quantidade', 'qtd'])) || 1;
      return sum + (volumeFrom(peca, setor) * quantidade);
    }, 0);
  }

  if (setor === 'armacao') {
    return numOrZero(firstValue(row, [
      'taxaAco',
      'TaxaAco',
      'taxaAcoFrouxo',
      'TaxaAcoFrouxo',
      'peso',
      'Peso',
      'pesoTotal',
      'PesoTotal',
      'kg',
      'volume_lanc_final',
      'volumeLancFinal',
      'volume',
      'Volume'
    ]));
  }

  return numOrZero(firstValue(row, [
    'volume_lanc_final',
    'volumeLancFinal',
    'volume',
    'Volume',
    'volumeTotal',
    'VolumeTotal',
    'volumePeca',
    'VolumePeca',
    'metrosCubicos',
    'm3'
  ]));
}

function quantidadeFrom(row) {
  if (Array.isArray(row?.pecas)) {
    return row.pecas.reduce((sum, peca) => {
      const quantidade = numOrZero(firstValue(peca, ['Quantidade', 'quantidade', 'qtd']));
      return sum + (quantidade > 0 ? quantidade : 1);
    }, 0);
  }

  const value = numOrZero(firstValue(row, ['quantidade', 'qtd', 'pecas', 'qtdPecas', 'totalPecas']));
  return value > 0 ? value : 1;
}

function unidadeFrom(row, setor = null) {
  const unit = String(firstValue(row, ['unidade', 'unit', 'medida']) || '').trim();
  const normalizedUnit = normKey(unit).replace('³', '3');
  if (['m3', 'm2', 'kg', 'ton', 't'].includes(normalizedUnit)) return normalizedUnit === 't' ? 'ton' : normalizedUnit;

  if (setor === 'armacao') return 'kg';
  return 'm3';
}

function isDateInSyncRange(data) {
  return data >= SYNC_DATA_INICIAL && data <= SYNC_DATA_FINAL;
}

function addSetor(acc, data, setor, campo, volume, quantidade, unidade, fonte) {
  if (!data || !setor || (!volume && !quantidade)) return;
  if (!isDateInSyncRange(data)) return;

  const key = `${data}__${setor}`;
  const curr = acc.get(key) ?? {
    data,
    setor,
    programado_volume: 0,
    realizado_volume: 0,
    programado_quantidade: 0,
    realizado_quantidade: 0,
    programado_unidade: unidade || 'm3',
    realizado_unidade: unidade || 'm3',
    fonte: {}
  };

  curr[`${campo}_volume`] += volume;
  curr[`${campo}_quantidade`] += quantidade;
  curr[`${campo}_unidade`] = unidade || curr[`${campo}_unidade`] || 'm3';
  curr.fonte[fonte] = true;
  acc.set(key, curr);
}

function buildRowsFromApi(rows) {
  const eventos = [];

  for (const r of rows) {
    const sigla = normText(r.sigla);
    const obra = String(r.nomeObra ?? '').trim();

    if (sigla.includes('OAE') || normText(obra).includes('OAE')) continue;
    if (obra === 'ESTOQUE-PRÃ‰ INFRA' || obra === 'TERMASA - SUBESTAÃ‡ÃƒO') continue;

    const vol = numOrZero(r.volume_lanc_final);
    const regras = [
      { tipo: 'projetado', data: toISODate(r.data_Projeto), ok: normText(r.status_Projeto) === 'LIBERADO' },
      { tipo: 'fabricado', data: toISODate(r.data_Armacao), ok: normText(r.status_Armacao) === 'LIBERADO' },
      { tipo: 'acabado', data: toISODate(r.data_Acabamento), ok: normText(r.status_Acabamento) === 'LIBERADO' },
      { tipo: 'expedido', data: toISODate(r.data_Expedicao), ok: normText(r.status_Logistica) === 'EXPEDIDA' },
      { tipo: 'montado', data: toISODate(r.dataMontada), ok: numOrZero(r.montada) === 1 }
    ];

    for (const reg of regras) {
      if (!reg.data || !reg.ok || vol === 0) continue;
      eventos.push({
        data: reg.data,
        obra,
        tipo: reg.tipo,
        volume: vol,
        quantidade: 1
      });
    }
  }

  const acc = new Map();
  for (const e of eventos) {
    const k = `${e.data}__${e.obra}__${e.tipo}`;
    const curr = acc.get(k) ?? { data: e.data, obra: e.obra, tipo: e.tipo, volume: 0, quantidade: 0 };
    curr.volume += e.volume;
    curr.quantidade += e.quantidade;
    acc.set(k, curr);
  }

  return [...acc.values()];
}

function buildSetorRows({ globalRows, quadroRows, producaoRows, acabadasRows, montadasRows, cargasRows, escoamento }) {
  const acc = new Map();

  for (const r of quadroRows) {
    const setor = detectSetor(r);
    const data = firstDate(r, ['data', 'dataProgramada', 'data_programada', 'programado', 'inicio', 'dataInicio']);
    addSetor(acc, data, setor, 'programado', volumeFrom(r, setor), quantidadeFrom(r), unidadeFrom(r, setor), 'quadro');
  }

  for (const r of producaoRows) {
    const setor = detectSetor(r);
    const data = firstDate(r, ['data', 'dataProducao', 'data_producao', 'dataLancamento', 'created_at']);
    addSetor(acc, data, setor, 'realizado', volumeFrom(r, setor), quantidadeFrom(r), unidadeFrom(r, setor), 'producao');
  }

  for (const r of acabadasRows) {
    const data = firstDate(r, ['data', 'dataAcabamento', 'data_acabamento', 'dataLancamento', 'created_at']);
    addSetor(acc, data, 'acabamento', 'realizado', volumeFrom(r, 'acabamento'), quantidadeFrom(r), unidadeFrom(r, 'acabamento'), 'acabadas');
  }

  for (const r of cargasRows) {
    const data = firstDate(r, ['DataProgramacao', 'dataProgramacao', 'data', 'dataProgramada', 'data_programada', 'dataCarga', 'dataExpedicao']);
    const volume = volumeFrom(r, 'expedicao');
    const quantidade = quantidadeFrom(r);
    const unidade = unidadeFrom(r, 'expedicao');
    addSetor(acc, data, 'expedicao', 'programado', volume, quantidade, unidade, 'cargasProgramadas');

    if (normText(firstValue(r, ['StatusCarga', 'statusCarga'])) === 'EXPEDIDA') {
      addSetor(acc, data, 'expedicao', 'realizado', volume, quantidade, unidade, 'cargasProgramadas');
    }
  }

  for (const r of globalRows) {
    const vol = numOrZero(r.volume_lanc_final);
    if (!vol) continue;

    if (numOrZero(r.montada) === 1) {
      addSetor(acc, toISODate(r.dataMontada), 'montagem', 'realizado', vol, 1, 'm3', 'informacaoGlobalPeca');
    }
  }

  for (const dia of escoamento?.dias || []) {
    const data = toISODate(dia.data);
    addSetor(acc, data, 'escoamento', 'programado', numOrZero(dia.programado?.volume), numOrZero(dia.programado?.pecas), 'm3', 'escoamento');
    addSetor(acc, data, 'escoamento', 'realizado', numOrZero(dia.realizado?.volume), numOrZero(dia.realizado?.pecas), 'm3', 'escoamento');
  }

  return [...acc.values()].sort((a, b) => {
    const d = a.data.localeCompare(b.data);
    if (d !== 0) return d;
    return a.setor.localeCompare(b.setor);
  });
}

async function supabaseRequest(endpoint, method, body, prefer = 'return=minimal') {
  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': SUPABASE_SCHEMA,
      'Content-Profile': SUPABASE_SCHEMA,
      Prefer: prefer
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} ${endpoint} [schema=${SUPABASE_SCHEMA}] -> ${res.status}: ${txt}`);
  }
}

async function main() {
  const global = await fetchJson(URL_GLOBAL);
  const globalRows = Array.isArray(global) ? global : [];
  const allRows = buildRowsFromApi(globalRows);

  const [quadro, producao, acabadas, montadas, cargas, escoamento] = await Promise.all([
    fetchJsonSafe('quadro', URL_QUADRO),
    fetchJsonSafe('producao', `${BASE_PREINFRA}/producao?dataInicial=${SYNC_DATA_INICIAL}&dataFinal=${SYNC_DATA_FINAL}`),
    fetchJsonSafe('producaoPecasAcabadas', `${BASE_PREINFRA}/producaoPecasAcabadas?dataInicial=${SYNC_DATA_INICIAL}&dataFinal=${SYNC_DATA_FINAL}`),
    fetchJsonSafe('pecasMontadas', `${BASE_PREINFRA}/pecasMontadas?dataInicial=${SYNC_DATA_INICIAL}&dataFinal=${SYNC_DATA_FINAL}`),
    fetchJsonSafe('cargasProgramadas', `${BASE_PREINFRA}/cargasProgramadas?dataInicial=${SYNC_DATA_INICIAL}&dataFinal=${SYNC_DATA_FINAL}`),
    fetchJsonSafe('escoamento', URL_ESCOAMENTO)
  ]);

  const setorRows = buildSetorRows({
    globalRows,
    quadroRows: asRows(quadro),
    producaoRows: asRows(producao),
    acabadasRows: asRows(acabadas),
    montadasRows: asRows(montadas),
    cargasRows: asRows(cargas),
    escoamento
  });

  await supabaseRequest('/rest/v1/volumes_diarios?tipo=in.(projetos,projetado,fabricado,qualidade,acabado,expedido,montado)', 'DELETE');
  await supabaseRequest('/rest/v1/setores_diarios?id=not.is.null', 'DELETE');

  const chunkSize = 1000;
  for (let i = 0; i < allRows.length; i += chunkSize) {
    const chunk = allRows.slice(i, i + chunkSize);
    await supabaseRequest('/rest/v1/volumes_diarios', 'POST', chunk);
  }

  for (let i = 0; i < setorRows.length; i += chunkSize) {
    const chunk = setorRows.slice(i, i + chunkSize);
    await supabaseRequest(
      '/rest/v1/setores_diarios?on_conflict=data,setor',
      'POST',
      chunk,
      'return=minimal,resolution=merge-duplicates'
    );
  }

  console.log(`Sincronizacao concluida. Schema: ${SUPABASE_SCHEMA}. Volumes: ${allRows.length}. Setores: ${setorRows.length}. Periodo setores: ${SYNC_DATA_INICIAL} a ${SYNC_DATA_FINAL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


