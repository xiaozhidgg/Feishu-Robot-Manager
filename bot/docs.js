/**
 * 飞书云文档能力层
 * ---------------------------------------------
 * 解决一个问题：机器人怎么"知道"自己能操作哪些文档？
 *
 * 飞书没有"列出应用可见的全部文档"这种接口，应用身份的可见范围 = 被明确授权的那些文档。
 * 所以这里给了三条发现路径，从稳到松：
 *   1. docs.json 白名单  —— 最可控，人工登记，注入到提示词里，模型直接知道清单
 *   2. search_docs      —— 调飞书搜索接口，按关键词找当前有权限的文档（需 search:docs:read）
 *   3. 群成员直接甩链接  —— 解析 URL 拿到 token，再受文档自身权限约束
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, process.env.DOCS_CONFIG || 'docs.json');
const MAX_READ_CHARS = 12000;
const MAX_BLOCKS_PER_CALL = 40;

/* ============================ 配置 ============================ */
let _config = null;

export function loadConfig() {
  if (_config) return _config;
  if (!fs.existsSync(CONFIG_FILE)) {
    _config = { docs: [], folders: [] };
    return _config;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    _config = { docs: Array.isArray(raw.docs) ? raw.docs : [], folders: raw.folders || [] };
  } catch (e) {
    console.error('[docs] docs.json 解析失败：', e.message);
    _config = { docs: [], folders: [] };
  }
  return _config;
}

export function listConfigured() {
  return loadConfig().docs.filter((d) => d && (d.url || d.token));
}

/* ============================ 目标解析 ============================ */
/**
 * 把「文档名 / 链接 / token」统一解析成 { type, token }
 * 支持 /docx/ /docs/ /wiki/ /sheets/ /base/ /mindnotes/ /slides/
 */
export function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  let m = s.match(/\/docx\/([A-Za-z0-9]+)/);
  if (m) return { type: 'docx', token: m[1] };

  m = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (m) return { type: 'wiki', token: m[1] };

  m = s.match(/\/(docs|sheets|base|mindnotes|slides)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], token: m[2] };

  // 裸 token：飞书各类 token 一般以 3~5 位前缀 + 20 位以上字符构成
  if (/^[A-Za-z][A-Za-z0-9]{14,}$/.test(s)) {
    return { type: /^wik/.test(s) ? 'wiki' : 'docx', token: s };
  }

  // 按名称匹配白名单（支持包含匹配，例如"产品手册第3章"）
  const hit = listConfigured().find(
    (d) => d.name === s || d.alias === s || (d.name && s.includes(d.name)),
  );
  if (hit) return parseTarget(hit.url || hit.token);
  return null;
}

/** wiki 节点要换成实际文档 token 才能读写 */
async function resolveDoc(client, input) {
  const t = parseTarget(input);
  if (!t) {
    // 把可用文档列出来，模型下一次就能挑对，而不是拿名字反复试错把工具轮次耗光
    const list = listConfigured()
      .map((d, i) => `${i + 1}. ${d.name || '(未命名)'} ${d.url || d.token || ''}`)
      .join('；');
    throw new Error(`找不到文档「${input}」。可以直接给文档链接，或从已登记的里挑一个：${list || '（docs.json 是空的）'}`);
  }

  // 裸的电子表格链接：/sheets/xxx?shtcnxxxx
  if (t.type === 'sheets') {
    return { documentId: t.token, objType: 'sheet', title: '' };
  }

  if (t.type === 'wiki') {
    const r = await client.wiki.v2.space.getNode({ params: { token: t.token, obj_type: 'wiki' } });
    const node = r?.data?.node;
    if (!node?.obj_token) throw new Error('知识库节点解析失败，请确认机器人有该知识库的访问权限');
    // 知识库节点背后可能是 docx，也可能是 sheet / bitable，obj_type 才作数
    return { documentId: node.obj_token, objType: node.obj_type, title: node.title, wikiToken: t.token };
  }
  if (t.type !== 'docx' && t.type !== 'docs') {
    throw new Error(`暂只支持 docx 文档和电子表格，收到的是 ${t.type}`);
  }
  return { documentId: t.token, objType: t.type, title: '' };
}

/* ============================ 错误翻译 ============================ */
function humanError(e) {
  const d = e?.response?.data ?? {};
  const code = d.code ?? e?.code;
  const msg = String(d.msg ?? e?.message ?? '');
  if (code === 99991672) {
    const scopes = (msg.match(/\[([^\]]+)\]/) || [, ''])[1];
    return `应用缺少权限：${scopes || '未知'}。去开放平台开通后重新发布版本。`;
  }
  if (code === 1770032 || /forbidden|permission/i.test(msg)) {
    return '没有这篇文档的权限。把文档分享给机器人（添加协作者 → 搜索应用名），或把它分享到机器人所在的群。';
  }
  if (code === 1770002) return '文档不存在或已被删除，检查链接里的 token。';
  if (code === 99992402) return '文档 token 格式不对，把完整链接整条贴给我（形如 https://xxx.feishu.cn/docx/xxxx）。';
  return msg || String(e);
}

/* ============================ 电子表格 ============================ */
const SHEET_CACHE = new Map(); // spreadsheet_token -> { ts, payload }
const SHEET_TTL = 60 * 1000;
const SHEET_MAX_ROWS = 800;
const SHEET_MAX_COLS = 60;
const SHEET_PREVIEW_ROWS = 40;
const WRITE_MAX_ROWS = 200;
const WRITE_MAX_COLS = 30;

function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** 单元格可能是字符串/数字，也可能是图片、链接之类的对象 */
function cellText(c) {
  let out;
  if (c === null || c === undefined) return '';
  if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
    out = String(c);
  } else if (Array.isArray(c)) {
    out = c.map(cellText).join(' ');
  } else if (typeof c === 'object') {
    if (c.type === 'embed-image' || c.image_key) out = '[图片]';
    else if (c.text) out = String(c.text);
    else if (c.link) out = String(c.link);
    else {
      try {
        out = JSON.stringify(c).slice(0, 60);
      } catch {
        out = '[对象]';
      }
    }
  } else {
    out = String(c);
  }
  // 单元格里的换行会把"一行一条"的格式撑乱，压成空格
  out = out.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return out.length > 300 ? out.slice(0, 300) + '…' : out;
}

async function fetchSheetValues(client, token, sheetId, rows, cols, startRow = 1) {
  const from = Math.max(1, startRow);
  const range = `${sheetId}!A${from}:${colLetter(cols)}${rows}`;
  const r = await client.request({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`,
    params: { valueRenderOption: 'FormattedValue' },
  });
  return r?.data?.valueRange?.values || r?.data?.values || [];
}

/* ---------------- 写表格：追加 / 覆盖 ---------------- */
function parseA1(text) {
  const m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(String(text || '').trim().replace(/\s+/g, ''));
  if (!m) return null;
  const col = (s) => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  const c1 = col(m[1]);
  const r1 = parseInt(m[2], 10);
  const c2 = m[3] ? col(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) : r1;
  if (c2 < c1 || r2 < r1) return null;
  return { c1, r1, c2, r2 };
}

async function pickSheet(client, token, nameOrId) {
  const r = await client.sheets.v3.spreadsheetSheet.query({ path: { spreadsheet_token: token } });
  const sheets = r?.data?.sheets || [];
  if (!sheets.length) throw new Error('这个表格没有可见的工作表，确认机器人有该表格权限');
  const key = String(nameOrId || '').trim();
  if (!key) return sheets[0];
  const hit = sheets.find((s) => s.sheet_id === key || s.title === key);
  if (!hit) throw new Error(`没有叫「${key}」的工作表。现有：${sheets.map((s) => s.title).join('、')}`);
  return hit;
}

async function readRange(client, token, sheetId, a1) {
  const range = `${sheetId}!${a1}`;
  const r = await client.request({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`,
  });
  return r?.data?.valueRange?.values || r?.data?.values || [];
}

function normalizeValues(values) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error('values 要传二维数组（行优先），例如 [["产品","库存"],["JY-T004",12]]');
  }
  const rows = values.map((row) => (Array.isArray(row) ? row : [row]));
  const cols = Math.max(...rows.map((r) => r.length));
  if (!cols) throw new Error('values 里没有内容');
  if (rows.length > WRITE_MAX_ROWS || cols > WRITE_MAX_COLS) {
    throw new Error(`一次最多写 ${WRITE_MAX_ROWS} 行 × ${WRITE_MAX_COLS} 列，这次是 ${rows.length} 行 × ${cols} 列，分几次写`);
  }
  return rows.map((row) => {
    const out = row.slice(0, cols);
    while (out.length < cols) out.push('');
    return out.map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v));
  });
}

export async function writeSheet(client, input, args = {}) {
  const { documentId, objType, title } = await resolveDoc(client, input);
  if (objType !== 'sheet') throw new Error('write_sheet 只能写电子表格；docx 内容请用 append_doc');

  const sheet = await pickSheet(client, documentId, args.sheet);
  const mode = args.mode === 'set' ? 'set' : 'append';
  const values = normalizeValues(args.values);
  const nRows = values.length;
  const nCols = values[0].length;
  let a1;

  if (mode === 'append') {
    const box = args.range ? parseA1(args.range) : { c1: 1, r1: 1 };
    if (!box) throw new Error(`range 写法不对：「${args.range}」，形如 A1`);
    a1 = `${colLetter(box.c1)}${box.r1}`;
  } else {
    if (!args.range) throw new Error('mode=set 必须给 range，例如 "B2" 或 "B2:D5"');
    const box = parseA1(args.range);
    if (!box) throw new Error(`range 写法不对：「${args.range}」，形如 B2 或 B2:D5`);
    const wide = box.c2 - box.c1 + 1;
    const tall = box.r2 - box.r1 + 1;
    if (wide === 1 && tall === 1) {
      a1 = `${colLetter(box.c1)}${box.r1}:${colLetter(box.c1 + nCols - 1)}${box.r1 + nRows - 1}`;
    } else {
      if (wide !== nCols || tall !== nRows) {
        throw new Error(`range ${args.range} 是 ${tall} 行 × ${wide} 列，values 是 ${nRows} 行 × ${nCols} 列，对不上`);
      }
      a1 = `${colLetter(box.c1)}${box.r1}:${colLetter(box.c2)}${box.r2}`;
    }
    const before = await readRange(client, documentId, sheet.sheet_id, a1);
    let filled = 0;
    for (const row of before) for (const cell of row || []) if (cellText(cell).trim()) filled += 1;
    if (filled && args.confirm !== true) {
      return [
        `⚠️ ${sheet.title}!${a1} 里已经有 ${filled} 个格子有内容，直接写会覆盖掉。`,
        `要写入：${nRows} 行 × ${nCols} 列`,
        `首行：${values[0].map((v) => String(v).slice(0, 20)).join(' | ')}`,
        '确认覆盖就再调一次并带 confirm=true；想接着往下记请用 mode=append。',
      ].join('\n');
    }
  }

  const url =
    mode === 'append'
      ? `/open-apis/sheets/v2/spreadsheets/${documentId}/values_append`
      : `/open-apis/sheets/v2/spreadsheets/${documentId}/values`;
  await client.request({
    method: mode === 'append' ? 'POST' : 'PUT',
    url,
    data: { valueRange: { range: `${sheet.sheet_id}!${a1}`, values } },
  });
  SHEET_CACHE.delete(documentId);

  const head = values[0].map((v) => String(v).slice(0, 24)).join(' | ');
  return [
    `✅ ${mode === 'append' ? '已追加' : '已写入'}：${title ? title + ' · ' : ''}${sheet.title}!${a1}（${nRows} 行 × ${nCols} 列）`,
    `首行：${head}`,
    mode === 'append' ? '追加位置由飞书按该区域最后一个非空行决定。' : '要复核可以用 read_doc 再读一次。',
  ].join('\n');
}

/* ---------------- 查表：在机器人内部扫完，只把结论交给模型 ---------------- */
const SCAN_CHUNK = 800;
const SCAN_MAX_ROWS = 6000;
const Q_MAX_RESULT = 50;

function toNum(v) {
  if (typeof v === 'number') return v;
      const t = cellText(v).replace(/\|/g, '／').trim();
  if (!t) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function cellIsEmpty(v) {
  return cellText(v).trim() === '';
}

function colIndex(header, key, what = '列') {
  const k = String(key ?? '').trim();
  if (!k) return -1;
  let idx = header.findIndex((h) => String(h).trim() === k);
  if (idx < 0) idx = header.findIndex((h) => String(h).trim().includes(k));
  if (idx < 0) {
    throw new Error(`没有「${k}」这个${what}。表头是：${header.filter(Boolean).slice(0, 30).join(' / ')}`);
  }
  return idx;
}

function matchCond(row, header, cond) {
  const idx = colIndex(header, cond.col);
  if (idx < 0) return true;
  const raw = row[idx];
  const text = cellText(raw);
  const op = cond.op || 'contains';
  const target = cond.value;

  switch (op) {
    case 'contains':
      return text.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'not_contains':
      return !text.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'eq':
      return text === String(target);
    case 'ne':
      return text !== String(target);
    case 'empty':
      return cellIsEmpty(raw);
    case 'not_empty':
      return !cellIsEmpty(raw);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNum(raw);
      const b = toNum(target);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    case 'in': {
      const list = Array.isArray(target) ? target : String(target ?? '').split(/[,，|]/);
      return list.some((t) => text === String(t).trim());
    }
    default:
      throw new Error('不认识的筛选条件 ' + op + '，可用：contains / not_contains / eq / ne / gt / gte / lt / lte / in / empty / not_empty');
  }
}

async function scanSheet(client, token, sheetId, maxRows = SCAN_MAX_ROWS) {
  const rows = [];
  for (let start = 1; start <= maxRows; start += SCAN_CHUNK) {
    const end = Math.min(maxRows, start + SCAN_CHUNK - 1);
    const chunk = await fetchSheetValues(client, token, sheetId, end, SHEET_MAX_COLS, start);
    if (!chunk.length) break;
    rows.push(...chunk);
    if (chunk.length < end - start + 1) break;
  }
  while (rows.length && rows[rows.length - 1].every(cellIsEmpty)) rows.pop();
  return rows;
}

function mdTable(header, rows, width = 40) {
  const clip = (v) => {
    const t = cellText(v).replace(/\|/g, '／').trim();
    return t.length > width ? t.slice(0, width) + '…' : t;
  };
  const head = header.map((h, i) => String(h || '').trim() || colLetter(i + 1));
  const line = '| ' + head.map((h) => clip(h)).join(' | ') + ' |';
  const sep = '| ' + head.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => '| ' + r.map(clip).join(' | ') + ' |');
  return [line, sep, ...body].join('\n');
}

export async function querySheet(client, input, args = {}) {
  const { documentId, objType, title } = await resolveDoc(client, input);
  if (objType !== 'sheet') throw new Error('query_sheet 只能查电子表格');

  const sheet = await pickSheet(client, documentId, args.sheet);
  const all = await scanSheet(client, documentId, sheet.sheet_id, args.max_rows || SCAN_MAX_ROWS);
  if (!all.length) return `《${title || ''}》${sheet.title} 是空的。`;

  const headerOn = args.header !== false;
  const header = headerOn ? all[0].map((c) => cellText(c)) : all[0].map((_, i) => colLetter(i + 1));
  const body = headerOn ? all.slice(1) : all;
  const conds = Array.isArray(args.where) ? args.where : args.where ? [args.where] : [];
  // 这类表常拿一整行当分节标题（只有第一格有字），不算数据行
  const dense = args.keep_titles === true ? body : body.filter((row) => row.filter((c) => !cellIsEmpty(c)).length >= 2);
  const matched = dense.filter((row) => conds.every((c) => matchCond(row, header, c)));
  const total = dense.length;

  const groupKey = String(args.group_by || '').trim();
  const metrics = Array.isArray(args.metrics) ? args.metrics.filter((m) => m && m.col && m.fn) : [];

  if (groupKey || metrics.length) {
    const gIdx = groupKey ? colIndex(header, groupKey) : -1;
    const mIdx = metrics.map((m) => colIndex(header, m.col));

    const buckets = new Map();
    for (const row of matched) {
      const key = gIdx >= 0 ? cellText(row[gIdx]) || '(空)' : '全部';
      if (!buckets.has(key)) buckets.set(key, { rows: 0, sums: metrics.map(() => 0), counts: metrics.map(() => 0), mins: metrics.map(() => Infinity), maxs: metrics.map(() => -Infinity) });
      const b = buckets.get(key);
      b.rows += 1;
      metrics.forEach((m, i) => {
        const n = toNum(row[mIdx[i]]);
        if (Number.isNaN(n)) return;
        b.sums[i] += n;
        b.counts[i] += 1;
        b.mins[i] = Math.min(b.mins[i], n);
        b.maxs[i] = Math.max(b.maxs[i], n);
      });
    }

    const outHeader = [groupKey || '范围', '行数', ...metrics.map((m) => `${m.col}·${m.fn}`)];
    const outRows = [...buckets.entries()].map(([k, b]) => {
      const vals = metrics.map((m, i) => {
        const fn = String(m.fn).toLowerCase();
        if (fn === 'sum') return Math.round(b.sums[i] * 100) / 100;
        if (fn === 'avg') return b.counts[i] ? Math.round((b.sums[i] / b.counts[i]) * 100) / 100 : '';
        if (fn === 'count') return b.counts[i];
        if (fn === 'min') return b.counts[i] ? b.mins[i] : '';
        if (fn === 'max') return b.counts[i] ? b.maxs[i] : '';
        throw new Error('不支持的聚合 ' + m.fn + '，可用 sum / avg / count / min / max');
      });
      return [k, b.rows, ...vals];
    });

    if (args.sort && args.sort.col) {
      const si = outHeader.findIndex((h) => h === args.sort.col || h.includes(args.sort.col));
      if (si >= 0) outRows.sort((a, b) => (toNum(b[si]) - toNum(a[si])) * (args.sort.desc === false ? -1 : 1));
    }
    const top = Math.min(args.top || 30, 100);
    const shown = outRows.slice(0, top);
    return [
      `📊 ${title ? title + ' · ' : ''}${sheet.title}｜扫描 ${total} 行，命中 ${matched.length} 行，分组 ${outRows.length} 组`,
      '',
      mdTable(outHeader, shown, args.width || 40),
      outRows.length > shown.length ? `（只列前 ${shown.length} 组，共 ${outRows.length} 组）` : '',
    ].filter(Boolean).join('\n');
  }

  if (args.sort && args.sort.col) {
    const si = colIndex(header, args.sort.col);
    const dir = args.sort.desc === false ? -1 : 1;
    matched.sort((a, b) => {
      const na = toNum(a[si]);
      const nb = toNum(b[si]);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (nb - na) * dir;
      return String(cellText(a[si])).localeCompare(String(cellText(b[si])), 'zh') * dir;
    });
  }

  const limit = Math.min(args.top || Q_MAX_RESULT, Q_MAX_RESULT);
  const shown = matched.slice(0, limit);
  let keep = header.map((_, i) => i);
  const colsArg = String(args.cols || '').trim();
  if (colsArg) {
    const box = parseA1(colsArg.match(/\d/) ? colsArg : `${colsArg.split(':')[0]}1:${colsArg.split(':')[1]}1`);
    if (box) keep = keep.filter((i) => i + 1 >= box.c1 && i + 1 <= box.c2);
  }

  return [
    `🔎 ${title ? title + ' · ' : ''}${sheet.title}｜扫描 ${total} 行，命中 ${matched.length} 行`,
    '',
    mdTable(keep.map((i) => header[i]), shown.map((r) => keep.map((i) => r[i])), args.width || 40),
    matched.length > shown.length ? `（只列前 ${shown.length} 行，共 ${matched.length} 行；可用 top 调整）` : '',
  ].filter(Boolean).join('\n');
}

async function loadSheetData(client, token, title, force = false) {
  const cached = SHEET_CACHE.get(token);
  if (!force && cached && Date.now() - cached.ts < SHEET_TTL) return cached.payload;

  const listRes = await client.sheets.v3.spreadsheetSheet.query({
    path: { spreadsheet_token: token },
  });
  const sheets = listRes?.data?.sheets || [];
  if (!sheets.length) throw new Error('这个表格没有可见的工作表，确认机器人有该表格权限');

  const payload = { title, sheets: [] };
  for (const s of sheets) {
    const rowCount = Math.min(s.grid_properties?.row_count || 100, SHEET_MAX_ROWS);
    const colCount = Math.min(s.grid_properties?.column_count || 12, SHEET_MAX_COLS);
    let values = [];
    try {
      values = await fetchSheetValues(client, token, s.sheet_id, rowCount, colCount);
    } catch (e) {
      values = [];
    }
    payload.sheets.push({
      id: s.sheet_id,
      title: s.title,
      rows: s.grid_properties?.row_count,
      cols: s.grid_properties?.column_count,
      values,
    });
  }
  SHEET_CACHE.set(token, { ts: Date.now(), payload });
  return payload;
}

/** 列窗口：支持 "A:N"（字母）或 "1:14"（序号），不传就整表 */
function parseColWindow(cols, max) {
  const s = String(cols || '').trim().toUpperCase();
  if (!s) return [0, max];
  const toNum = (x) => [...x].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const m = s.match(/^([A-Z]+)\s*[:\-~]\s*([A-Z]+)$/);
  if (m) {
    const a = Math.max(1, toNum(m[1])) - 1;
    const b = Math.min(max, toNum(m[2]));
    if (b > a) return [a, b];
  }
  const n = s.match(/^(\d+)\s*[:\-~]\s*(\d+)$/);
  if (n) {
    const a = Math.max(1, parseInt(n[1], 10)) - 1;
    const b = Math.min(max, parseInt(n[2], 10));
    if (b > a) return [a, b];
  }
  return [0, max];
}

function renderSheet(payload, opts = {}) {
  const query = String(opts.query || '').trim();
  const q = query.toLowerCase();
  const pageSize = SHEET_PREVIEW_ROWS;
  const startRow = Math.max(1, parseInt(opts.start || 1, 10) || 1);

  const lines = [
    `表格：${payload.title || '(未命名)'}`,
    `工作表：${payload.sheets.map((s) => `${s.title}(${s.id})`).join('、')}`,
  ];
  if (q) lines.push(`筛选：包含「${query}」的行`);
  lines.push('---');

  let budget = MAX_READ_CHARS;
  let anyMatch = false;

  for (const s of payload.sheets) {
    const raw = (s.values || []).map((r) => (Array.isArray(r) ? r : []));
    if (!raw.length) continue;
    const width = Math.max(s.cols || 0, raw[0]?.length || 0);
    const [c0, c1] = parseColWindow(opts.cols, Math.max(width, s.cols || 0));
    const header = raw[0].slice(c0, c1).map(cellText);
    const body = raw.slice(1).map((r) => r.slice(c0, c1).map(cellText));

    let picked = [];
    let matchedTotal = 0;
    if (q) {
      body.forEach((r, i) => {
        if (!r.some((c) => c.toLowerCase().includes(q))) return;
        matchedTotal += 1;
        if (matchedTotal >= startRow && picked.length < pageSize) picked.push([i + 2, r]);
      });
    } else {
      const from = startRow - 1;
      body.slice(from, from + pageSize).forEach((r, i) => picked.push([from + i + 2, r]));
    }
    if (q && matchedTotal) anyMatch = true;

    const block = [`〔${s.title}〕${s.rows || raw.length} 行 × ${s.cols || width} 列（sheet_id ${s.id}）`];
    if (opts.cols) block.push(`只看第 ${c0 + 1}–${c1} 列（cols="${opts.cols}"）`);
    else if ((s.cols || width) > 20) block.push(`列比较多，只想看部分列时可以加 cols="A:N"`);
    if (header.some(Boolean)) block.push(`表头：${header.join(' | ')}`);
    if (!picked.length) {
      block.push(q ? '（这一批没有匹配的行）' : '（没有内容）');
    } else {
      for (const [rowNo, r] of picked) {
        const cells = [...r];
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (!cells.length) continue;
        block.push(`第${rowNo}行：${cells.join(' | ')}`);
      }
    }

    const dataRows = Math.max(0, (s.rows || raw.length) - 1);
    if (q) {
      if (matchedTotal > startRow - 1 + picked.length) {
        block.push(`（匹配 ${matchedTotal} 行，本批第 ${startRow}–${startRow + picked.length - 1} 条，继续看用 start=${startRow + picked.length}）`);
      } else if (picked.length) {
        block.push(`（匹配 ${matchedTotal} 行，已全部显示）`);
      }
    } else if (dataRows > startRow - 1 + picked.length) {
      block.push(`（共 ${dataRows} 行数据，本批第 ${startRow}–${startRow + picked.length - 1} 行，继续看用 start=${startRow + picked.length}）`);
    }

    const text = block.join('\n');
    if (budget - text.length < 0) {
      lines.push(text.slice(0, Math.max(0, budget)));
      lines.push('（内容超长，已截断；用 cols 缩窄列或 start 翻页）');
      return lines.join('\n');
    }
    budget -= text.length + 1;
    lines.push(text);
  }

  if (q && !anyMatch) lines.push('整张表里都没有包含该关键词的内容。');
  return lines.join('\n');
}

/* ============================ 读 ============================ */
export async function readDoc(client, input, opts = {}) {
  const { documentId, objType, title } = await resolveDoc(client, input);

  if (objType === 'sheet') {
    try {
      const payload = await loadSheetData(client, documentId, title || String(input));
      return renderSheet(payload, { query: opts.query, start: opts.start, cols: opts.cols });
    } catch (e) {
      throw new Error(humanError(e));
    }
  }

  if (objType === 'bitable') {
    throw new Error('这是多维表格（bitable），目前还不能读；能读的是 docx 文档和电子表格');
  }

  try {
    const r = await client.docx.v1.document.rawContent({ path: { document_id: documentId } });
    let content = r?.data?.content || '';
    let truncated = false;
    if (content.length > MAX_READ_CHARS) {
      content = content.slice(0, MAX_READ_CHARS);
      truncated = true;
    }
    return [
      `文档：${title || input}（${documentId}）`,
      truncated ? `（内容较长，仅返回前 ${MAX_READ_CHARS} 字）` : '',
      '---',
      content || '（空文档）',
    ]
      .filter(Boolean)
      .join('\n');
  } catch (e) {
    throw new Error(humanError(e));
  }
}

/* ============================ 写 ============================ */
export async function appendDoc(client, input, text) {
  const { documentId, objType, title } = await resolveDoc(client, input);
  if (objType === 'sheet') {
    throw new Error('往电子表格写数据还没开放，现在只支持读。要写的话告诉我具体工作表和范围，我来加。');
  }
  if (objType !== 'docx' && objType !== 'docs') {
    throw new Error(`暂不支持往 ${objType} 写内容`);
  }
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) throw new Error('要追加的内容是空的');

  const children = lines.map((line) => ({
    block_type: 2, // 2 = 文本块
    text: { elements: [{ text_run: { content: line } }], style: {} },
  }));

  let added = 0;
  for (let i = 0; i < children.length; i += MAX_BLOCKS_PER_CALL) {
    const batch = children.slice(i, i + MAX_BLOCKS_PER_CALL);
    const base = { path: { document_id: documentId, block_id: documentId }, data: { children: batch } };
    try {
      // index: -1 表示插到父块末尾
      await client.docx.v1.documentBlockChildren.create({ ...base, data: { ...base.data, index: -1 } });
    } catch (e) {
      try {
        await client.docx.v1.documentBlockChildren.create(base); // 不支持 index 时退回默认追加
      } catch (e2) {
        throw new Error(humanError(e2));
      }
    }
    added += batch.length;
  }
  return `已向《${title || input}》追加 ${added} 个段落。`;
}

export async function createDoc(client, title, text = '') {
  const folder = loadConfig().folders?.[0]?.token;
  try {
    const r = await client.docx.v1.document.create({
      data: { title: title || '未命名文档', ...(folder ? { folder_token: folder } : {}) },
    });
    const doc = r?.data?.document;
    if (!doc?.document_id) throw new Error('创建成功但没拿到 document_id');
    const link = `https://feishu.cn/docx/${doc.document_id}`;
    if (text) await appendDoc(client, doc.document_id, text).catch(() => {});
    return `已创建文档《${title}》：${link}\n（记得把文档分享给机器人，否则它之后改不了）`;
  } catch (e) {
    throw new Error(humanError(e));
  }
}

/* ============================ 搜 ============================ */
export async function searchDocs(client, query, limit = 8) {
  try {
    const r = await client.search.v2.docWiki.search({
      data: { query: String(query || '').slice(0, 50), page_size: limit },
    });
    const items = r?.data?.items || [];
    const rows = [];
    for (const it of items) {
      // 返回结构各版本略有差异：docs / wiki_infos / 直接平铺，都兜住
      const buckets = ['docs', 'wiki_infos', 'items'].flatMap((k) => (Array.isArray(it?.[k]) ? it[k] : []));
      for (const x of buckets.length ? buckets : [it]) {
        const row = {
          title: x.title ?? x.name ?? '',
          token: x.docs_token ?? x.token ?? x.node_token ?? x.wiki_token ?? '',
          type: x.docs_type ?? x.doc_type ?? x.obj_type ?? x.type ?? '',
          url: x.url ?? '',
        };
        if (row.title || row.token) rows.push(row);
      }
    }
    if (!rows.length) return `没搜到和「${query}」相关的文档（也可能是应用还没开通 search:docs:read）。`;
    return rows
      .slice(0, limit)
      .map((r, i) => `${i + 1}. ${r.title} [${r.type}] ${r.token}${r.url ? ' ' + r.url : ''}`)
      .join('\n');
  } catch (e) {
    throw new Error(humanError(e));
  }
}

/* ============================ 提示词注入 ============================ */
export function docsPromptSection() {
  const docs = listConfigured();
  const lines = [];
  if (docs.length) {
    lines.push('【你被授权操作的飞书云文档】');
    for (const d of docs) {
      const tag = [d.type || 'docx', d.writable === false ? '只读' : '可读写'].join(' · ');
      lines.push(`- ${d.name}（${tag}）：${d.url || d.token}${d.note ? ' —— ' + d.note : ''}`);
    }
  } else {
    lines.push('【飞书云文档】当前还没有在 docs.json 里登记任何文档。');
  }
  lines.push(
    '需要看文档内容时用 read_doc；文档可能是 docx 也可能是电子表格，读表格时把用户给的产品编号/关键词作为 query 传进去，只取相关行。',
    '要写入/追加 docx 时用 append_doc；要改电子表格用 write_sheet：默认 mode=append 接着写，只有用户明确说「改/替换某几格」才用 mode=set，且覆盖前把要写的内容念给用户确认。',
    '用户只给了名字没给链接时先用 search_docs 搜；不确定有哪些时用 list_docs。',
    '要按条件查表（例如「库存低于 1000 的」「按分类汇总」）用 query_sheet：它在机器人这边扫完表，只把命中的行或汇总给你，比 read_doc 省上下文。',
    '文档里没有的信息不要编造，明确告诉用户文档里没写。',
  );
  return lines.join('\n');
}

/* ============================ 工具定义 ============================ */
export const DOC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_docs',
      description: '列出机器人当前被授权可操作的飞书云文档清单',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: '在飞书里搜索文档，用于查找用户提到的、但清单里没有的文档',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，通常用文档标题' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: '读取一篇飞书文档的正文（docx）或电子表格内容；表格可按关键词只取相关行',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: '文档名称、文档链接或 document_id，三者任一' },
          query: {
            type: 'string',
            description: '可选。读电子表格时用：只返回包含这个关键词的行（例如产品编号），能避免整表塞满上下文',
          },
          start: {
            type: 'integer',
            description: '可选。翻页用：从第几条开始，默认 1。上次结果里提示「继续看用 start=N」就把 N 传进来',
          },
          cols: {
            type: 'string',
            description: '可选。列窗口，例如 "A:N" 只看前 14 列、"O:AP" 看后面的列；表格很宽时用它，避免每行太长被截断',
          },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_sheet',
      description:
        '查电子表格：机器人先在自己这边把表扫完，只把命中的行或分组汇总交给你。宽表/长表优先用它，不要用 read_doc 硬读整表',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: '表格名称、链接或 token' },
          sheet: { type: 'string', description: '可选。工作表名或 id，不传用第一个' },
          header: { type: 'boolean', description: '可选。第一行是否表头，默认 true' },
          where: {
            type: 'array',
            description:
              '筛选条件数组，多个条件是「并且」。每项 {col: 列名, op: contains|not_contains|eq|ne|gt|gte|lt|lte|in|empty|not_empty, value}',
            items: {
              type: 'object',
              properties: {
                col: { type: 'string' },
                op: { type: 'string' },
                value: {},
              },
              required: ['col', 'op'],
            },
          },
          group_by: { type: 'string', description: '按这一列分组（可选）' },
          metrics: {
            type: 'array',
            description: '分组时的指标，例如 [{col:"库存", fn:"sum"}]，fn 可用 sum/avg/count/min/max',
            items: {
              type: 'object',
              properties: { col: { type: 'string' }, fn: { type: 'string' } },
              required: ['col', 'fn'],
            },
          },
          sort: {
            type: 'object',
            description: '排序 {col, desc}',
            properties: { col: { type: 'string' }, desc: { type: 'boolean' } },
            required: ['col'],
          },
          top: { type: 'integer', description: '最多返回多少条/组，默认 50' },
          cols: { type: 'string', description: '可选。只返回这几列，如 "A:N"' },
          max_rows: { type: 'integer', description: '可选。最多扫描多少行，默认 6000' },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_doc',
      description: '在飞书文档末尾追加内容，每行会变成一个段落',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: '文档名称、文档链接或 document_id' },
          text: { type: 'string', description: '要追加的正文，支持换行' },
        },
        required: ['doc', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_sheet',
      description:
        '修改飞书电子表格。mode=append 在已有数据后面接着写（安全，默认）；mode=set 覆盖指定区域，区域里已有内容时必须带 confirm=true',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: '表格名称、链接或 token' },
          sheet: { type: 'string', description: '可选。工作表名或 id，不传就用第一个工作表' },
          mode: { type: 'string', enum: ['append', 'set'], description: 'append=接着写；set=覆盖写' },
          range: { type: 'string', description: 'append 时是起始锚点（如 A1）；set 时是要写的区域（如 B2 或 B2:D5）' },
          values: { type: 'array', items: { type: 'array', items: {} }, description: '二维数组，行优先；数字直接写数字' },
          confirm: { type: 'boolean', description: 'set 覆盖已有内容时必须为 true' },
        },
        required: ['doc', 'values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_doc',
      description: '新建一篇飞书 docx 文档',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题' },
          text: { type: 'string', description: '初始正文，可留空' },
        },
        required: ['title'],
      },
    },
  },
];

/** 工具调度：所有异常都转成可读文案返回给模型，不让它把整轮对话带崩 */
export async function runTool(client, name, args = {}) {
  try {
    switch (name) {
      case 'list_docs': {
        const docs = listConfigured();
        if (!docs.length) return '当前没有登记任何文档，docs.json 是空的。';
        return docs
          .map((d, i) => `${i + 1}. ${d.name} [${d.type || 'docx'}] ${d.writable === false ? '只读' : '可读写'} ${d.url || d.token}`)
          .join('\n');
      }
      case 'search_docs':
        return await searchDocs(client, args.query);
      case 'read_doc':
        return await readDoc(client, args.doc, { query: args.query, start: args.start, cols: args.cols });
      case 'append_doc':
        return await appendDoc(client, args.doc, args.text);
      case 'write_sheet':
        return await writeSheet(client, args.doc, args);
      case 'query_sheet':
        return await querySheet(client, args.doc, args);
      case 'create_doc':
        return await createDoc(client, args.title, args.text);
      default:
        return `未知工具：${name}`;
    }
  } catch (e) {
    return `❌ ${e?.message || e}`;
  }
}
