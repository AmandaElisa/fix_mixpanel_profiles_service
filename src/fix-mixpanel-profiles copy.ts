/* eslint-disable no-console */
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import { config } from './config';
import { REQUIRED_MIXPANEL_FIELDS, MIXPANEL_TO_MONGO_FIELD, RequiredMixpanelField } from './mappings';

type UserDoc = {
  aid: string;
  [k: string]: any;
};

type JqlRow = {
  distinct_id: string;
  aid_prop?: string | null; // "Store Id (aid)" (ou o nome definido em AID_PROP_NAME)
  missing: RequiredMixpanelField[];
  props?: Partial<Record<RequiredMixpanelField, any>>;
};

// ————————————————————— helpers
function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const DATE_FIELDS = new Set<RequiredMixpanelField>(['endDate', 'toleranceEndDate']);
const RUN_TAG = process.env.SYNC_RUN_TAG || new Date().toISOString(); // carimbo de auditoria

function toMixpanelDate(v: any): string | undefined {
  if (v == null || v === '') return;
  let d: Date | undefined;

  if (v instanceof Date) d = v;
  else if (typeof v === 'string') d = new Date(v);
  else if (typeof v === 'number') d = v > 1e12 ? new Date(v) : new Date(v * 1000);

  if (!d || isNaN(d.getTime())) return;
  return d.toISOString(); // ex.: 2024-05-27T22:09:55.084Z
}

function isBlankish(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '' || s === 'undefined' || s === 'null' || s === 'nan' || s === 'none' || s === 'n/a' || s === '-';
  }
  return false;
}

function valuesEqual(a: any, b: any, field: RequiredMixpanelField) {
  if (field === 'endDate' || field === 'toleranceEndDate') {
    const toIso = (v: any) => {
      if (v == null || v === '') return undefined;
      const d = v instanceof Date ? v : new Date(v);
      return isNaN(d.getTime()) ? String(v) : d.toISOString();
    };
    return toIso(a) === toIso(b);
  }
  return String(a) === String(b);
}

// ————————————————————— JQL
function buildJQL(requiredProps: string[], max: number | null, aidPropName: string) {
  const arr = JSON.stringify(requiredProps);
  const cap = Math.max(0, Number(max || 0)); // 0 = sem limite
  const aidProp = JSON.stringify(aidPropName);

  return `
function main() {
  var required = ${arr};
  var cap = ${cap};
  var taken = 0;
  var aidPropName = ${aidProp};

  function isBlankish(v){
    if (v === null || v === undefined) return true;
    if (typeof v === 'string'){
      var s = v.trim().toLowerCase();
      return s === '' || s === 'undefined' || s === 'null' || s === 'nan' || s === 'none' || s === 'n/a' || s === '-';
    }
    return false;
  }

  return People()
    .filter(function(user){
      if (cap > 0 && taken >= cap) return false;
      var p = user.properties || {};
      var needs = required.some(function(k){
        return !(k in p) || isBlankish(p[k]);
      });
      if (needs) taken++;
      return needs;
    })
    .map(function(user){
      var p = user.properties || {};
      var missing = required.filter(function(k){
        return !(k in p) || isBlankish(p[k]);
      });
      var aid = p[aidPropName];
      return {
        distinct_id: user.distinct_id,
        aid_prop: aid,
        missing: missing,
        props: {
          status: p.status,
          plan: p.plan,
          endDate: p.endDate,
          toleranceEndDate: p.toleranceEndDate,
          recurrence: p.recurrence
        }
      };
    });
}
`.trim();
}

async function runJQL(jql: string): Promise<JqlRow[]> {
  const url = 'https://mixpanel.com/api/2.0/jql';
  const auth = Buffer.from(`${config.MIXPANEL_SERVICE_USERNAME}:${config.MIXPANEL_SERVICE_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('project_id', config.MIXPANEL_PROJECT_ID);
  params.append('script', jql);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JQL error ${res.status}: ${text}`);
  }
  return (await res.json()) as JqlRow[];
}

// ————————————————————— Mongo em lotes
async function fetchUsersFromMongoBatched(
  aids: string[],
  { batchSize, sampleLimit }: { batchSize: number; sampleLimit: number }
) {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  try {
    const col = client.db(config.MONGODB_DB).collection<UserDoc>(config.MONGODB_COLLECTION);

    const byAid = new Map<string, UserDoc>();
    let processed = 0;

    const proj = {
      aid: 1,
      status: 1,
      plan: 1,
      expireDate: 1,
      toleranceDate: 1,
      recurrence: 1,
      _id: 0,
    } as const;

    for (let i = 0; i < aids.length; i += batchSize) {
      const slice = aids.slice(i, i + batchSize);
      const docs = await col.find({ aid: { $in: slice } }, { projection: proj }).toArray();

      for (const d of docs) {
        if (d?.aid) byAid.set(d.aid, d);
      }
      processed += slice.length;

      if (processed % 100000 === 0 || i + batchSize >= aids.length) {
        console.log(`... Mongo: processados ${processed}/${aids.length}, encontrados ${byAid.size}`);
      }
    }

    // Amostra controlada por env (recomendado manter 0 em produção)
    if (sampleLimit > 0) {
      console.log(`✅ Localizados ${byAid.size} usuários no Mongo (de ${aids.length} solicitados) — amostra:`);
      let shown = 0;
      for (const [aid, user] of byAid.entries()) {
        console.log(aid, user);
        if (++shown >= sampleLimit) break;
      }
    }

    return byAid;
  } finally {
    await client.close();
  }
}

// ————————————————————— montagem do payload (Mongo → Mixpanel)
function buildUpdatePayloadFromMongo(user: UserDoc, row: JqlRow, forceIfDifferent: boolean) {
  const toSet: Record<string, any> = {};
  const existing = row.props ?? {};

  for (const mpField of REQUIRED_MIXPANEL_FIELDS) {
    const mongoField = MIXPANEL_TO_MONGO_FIELD[mpField];
    const raw = user?.[mongoField];
    if (raw === undefined || raw === null || raw === '') continue;

    const val = DATE_FIELDS.has(mpField) ? toMixpanelDate(raw) : raw;
    if (val === undefined) continue;

    const wasMissingByJql = row.missing.includes(mpField);
    const existingHas = Object.prototype.hasOwnProperty.call(existing, mpField);
    const existingVal = existingHas ? (existing as any)[mpField] : undefined;
    const existingIsBlank = existingHas && isBlankish(existingVal);

    const isDifferent = forceIfDifferent && existingHas && !existingIsBlank && !valuesEqual(val, existingVal, mpField);

    if (wasMissingByJql || existingIsBlank || isDifferent) {
      toSet[mpField] = val;
    }
  }

  // carimbo de auditoria do run
  if (Object.keys(toSet).length > 0) {
    toSet.kyte_last_profile_sync_at = RUN_TAG;
  }
  return toSet;
}

// ————————————————————— envio em lote: profile-batch-update
async function sendProfileBatchUpdates(
  updates: { distinct_id: string; set: Record<string, any> }[],
  {
    batchSize = Number(process.env.BATCH_UPDATE_SIZE || '1000'),
    pauseMs = Number(process.env.BATCH_UPDATE_PAUSE_MS || '300'),
    dryRun = false,
  } = {}
) {
  const total = updates.length;
  let sent = 0;
  let batchNo = 0;

  const toEngage = (slice: { distinct_id: string; set: Record<string, any> }[]) =>
    slice.map(u => ({
      $token: config.MIXPANEL_TOKEN,
      $distinct_id: u.distinct_id,
      $ip: '0',
      $set: u.set,
    }));

  const started = Date.now();
  for (let i = 0; i < updates.length; i += batchSize) {
    batchNo++;
    const slice = updates.slice(i, i + batchSize);

    if (dryRun) {
      if (batchNo === 1) {
        console.log(`[DRY_RUN] profile-batch-update preview (size=${slice.length}) — 3 exemplos:`);
        console.log(JSON.stringify(toEngage(slice.slice(0, 3)), null, 2));
      }
      sent += slice.length;
      const pct = ((sent / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`⏩ [DRY_RUN] lote ${batchNo} · ${sent}/${total} (${pct}%) · ${elapsed}s`);
      continue;
    }

    const body = JSON.stringify(toEngage(slice));
    const res = await fetch('https://api.mixpanel.com/engage#profile-batch-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`❌ Lote ${batchNo} falhou: HTTP ${res.status} — ${text}`);
    } else {
      sent += slice.length;
      const pct = ((sent / total) * 100).toFixed(1);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`✅ Lote ${batchNo} enviado · ${sent}/${total} (${pct}%) · ${elapsed}s`);
    }

    if (slice.length === batchSize) {
      await new Promise(r => setTimeout(r, pauseMs));
    }
  }

  return sent;
}

// ————————————————————— main
async function main() {
  console.log('🔎 Checando perfis no Mixpanel com campos ausentes (OR):', REQUIRED_MIXPANEL_FIELDS.join(', '));

  // 1) Rodar JQL (com limite opcional)
  const maxJql = Number(process.env.MAX_JQL_RESULTS || '0');
  const jql = buildJQL(REQUIRED_MIXPANEL_FIELDS as unknown as string[], maxJql, config.AID_PROP_NAME);
  const needFix = await runJQL(jql);

  if (needFix.length === 0) {
    console.log('✅ Nenhum usuário com campos faltantes.');
    return;
  }
  console.log(`JQL retornou ${needFix.length} perfis com algum campo faltando.`);

  // Diagnóstico de cobertura
  const missingAidProp = needFix.filter(r => !r.aid_prop || isBlankish(r.aid_prop)).length;
  console.log(`ℹ️ Perfis do JQL sem "${config.AID_PROP_NAME}": ${missingAidProp}`);

  // 2) Coletar AIDs a partir da propriedade do Mixpanel ("Store Id (aid)")
  let aidsFromMP = needFix
    .map(r => r.aid_prop)
    .filter((a): a is string => !!a && !isBlankish(a));
  aidsFromMP = Array.from(new Set(aidsFromMP)); // dedup

  // 2.1) DRY_RUN_LIMIT (corte local) — aplicado sobre os AIDs
  const dryRunLimit = Number(process.env.DRY_RUN_LIMIT || '0');
  if (config.DRY_RUN && dryRunLimit > 0 && aidsFromMP.length > dryRunLimit) {
    aidsFromMP = aidsFromMP.slice(0, dryRunLimit);
  }

  console.log(`AIDs vindos do Mixpanel ("${config.AID_PROP_NAME}") para buscar no Mongo: ${aidsFromMP.length}`);

  // 3) Buscar no Mongo em lotes usando os AIDs coletados
  const batchSize = Number(process.env.MONGO_BATCH_SIZE || '1000');
  const sampleLimit = Number(process.env.MONGO_SAMPLE_LIMIT || '0');
  const usersByAid = await fetchUsersFromMongoBatched(aidsFromMP, { batchSize, sampleLimit });

  console.log(`✅ Localizados ${usersByAid.size} usuários no Mongo (de ${aidsFromMP.length} solicitados)`);

  // 4) Montar updates usando o doc do Mongo encontrado por aid_prop e enviar para o $distinct_id
  const updates: { distinct_id: string; set: Record<string, any> }[] = [];
  let notFoundInMongo = 0;

  for (const row of needFix) {
    // usar "Store Id (aid)" do Mixpanel; opcionalmente cair para distinct_id se habilitado no .env
    let aidKey = row.aid_prop && !isBlankish(row.aid_prop) ? row.aid_prop : undefined;
    if (!aidKey && config.FALLBACK_AID_EQUALS_DISTINCT) {
      aidKey = row.distinct_id;
    }
    if (!aidKey) continue;

    const userDoc = usersByAid.get(aidKey);
    if (!userDoc) {
      notFoundInMongo++;
      continue;
    }

    const set = buildUpdatePayloadFromMongo(userDoc, row, config.FORCE_UPDATE_IF_DIFFERENT);
    if (Object.keys(set).length > 0) {
      updates.push({ distinct_id: row.distinct_id, set }); // <- envia para o $distinct_id do Mixpanel
    }
  }

  console.log(`ℹ️ Sem doc no Mongo para o aid: ${notFoundInMongo}`);
  console.log(`ℹ️ Updates a enviar: ${updates.length}`);

  if (updates.length === 0) {
    console.log('ℹ️ Sem dados úteis no Mongo para preencher/atualizar.');
    return;
  }

  console.log(`✍️ Preparando para atualizar (batch) ${updates.length} perfis no Mixpanel...`);
  console.log(`🚦 Modo: ${config.DRY_RUN ? 'DRY_RUN (simulação)' : 'LIVE (atualizando)'} · batchSize=${process.env.BATCH_UPDATE_SIZE || 1000} · pauseMs=${process.env.BATCH_UPDATE_PAUSE_MS || 300}`);

  const count = await sendProfileBatchUpdates(updates, { dryRun: config.DRY_RUN });

  if (config.DRY_RUN) {
    console.log(`✅ [DRY_RUN] Atualizações simuladas para ${count} perfis.`);
  } else {
    console.log(`✅ Perfis atualizados com sucesso: ${count}`);
    console.log(`🔖 Carimbo desta execução (kyte_last_profile_sync_at): ${RUN_TAG}`);
  }
}

main().catch((e) => {
  console.error('Erro geral:', e);
  process.exit(1);
});
