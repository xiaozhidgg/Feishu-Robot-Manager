/**
 * 把模型回答里的 Markdown 管道表格转成飞书消息卡片。
 *
 * 纯文本消息（msg_type=text）不支持表格，只有消息卡片的 table 组件能渲染成真表格，
 * 所以这里做两件事：拆出表格段落、拼一张卡片。
 */

/** 一行是不是表格行（| a | b |） */
function isRow(line) {
  return /^\s*\|.*\|\s*$/.test(line) && line.split('|').length >= 3;
}

/** 是不是分隔行（| --- | :--: |） */
function isSep(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

/** 按 | 拆单元格，去掉首尾空段 */
function cells(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => c.trim());
}

/** 一张表至少要「表头 + 分隔行 + 至少一行数据」 */
function parseTable(lines, start) {
  const header = cells(lines[start]);
  if (!isSep(lines[start + 1])) return null;
  const rows = [];
  let i = start + 2;
  while (i < lines.length && isRow(lines[i])) {
    const r = cells(lines[i]);
    rows.push(header.map((_, idx) => r[idx] ?? ''));
    i += 1;
  }
  if (!rows.length) return null;
  return { header, rows, next: i };
}

/**
 * 把文本拆成若干段：{ kind: 'text', text } 或 { kind: 'table', header, rows }
 * 代码块（``` 包起来的内容）里的 | 不当作表格。
 */
export function splitTables(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const segs = [];
  let buf = [];
  let fence = false;

  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) segs.push({ kind: 'text', text: t });
    buf = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      fence = !fence;
      buf.push(line);
      i += 1;
      continue;
    }

    if (!fence && isRow(line)) {
      const table = parseTable(lines, i);
      if (table) {
        flush();
        segs.push({ kind: 'table', header: table.header, rows: table.rows });
        i = table.next;
        continue;
      }
    }

    buf.push(line);
    i += 1;
  }
  flush();
  return segs;
}

/** 有表格就返回 true */
export function hasTable(text) {
  return splitTables(text).some((s) => s.kind === 'table');
}

/** 表格段 → 卡片 table 组件 */
/** 单元格转成单行纯文本（飞书表格不接受换行与超长内容） */
function cell(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** 表格降级成 Markdown 管道表格（列太多时卡片组件撑不住） */
export function tableToMarkdown(table) {
  const head = `| ${table.header.map(cell).join(' | ')} |`;
  const sep = `| ${table.header.map(() => '---').join(' | ')} |`;
  const body = table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** 卡片发不出去时，把整张卡片的内容拍回纯文本 */
export function cardToText(segments, title = '') {
  const parts = segments.map((s) => (s.kind === 'text' ? s.text : tableToMarkdown(s)));
  return (title ? `${title}\n\n` : '') + parts.join('\n\n');
}

const MAX_TABLE_COLS = 9;

function tableElement(table) {
  const pageSize = Math.min(Math.max(table.rows.length, 1), 10);
  return {
    tag: 'table',
    page_size: pageSize,
    // 飞书表格组件列数有限，超了整张卡片会 400
    row_height: 'low',
    header_style: { text_align: 'left', background_style: 'grey' },
    columns: table.header.map((name, idx) => ({
      name: `c${idx}`,
      display_name: name || `列${idx + 1}`,
      data_type: 'text',
      width: 'auto',
    })),
    rows: table.rows.map((row) => {
      const o = {};
      row.forEach((v, idx) => {
        o[`c${idx}`] = cell(v);
      });
      return o;
    }),
  };
}

/** 一组段落 → 卡片 JSON（不带 header，看起来接近普通消息） */
export function buildCard(segments, title = '') {
  const elements = [];
  for (const seg of segments) {
    if (seg.kind === 'text') {
      elements.push({ tag: 'markdown', content: seg.text });
    } else if (seg.header.length > MAX_TABLE_COLS) {
      // 列太多：表格组件会撑爆卡片（飞书直接 400），降级成 Markdown 表格
      elements.push({ tag: 'markdown', content: tableToMarkdown(seg) });
    } else {
      elements.push(tableElement(seg));
    }
  }

  const card = {
    config: { wide_screen_mode: true },
    elements: elements.length ? elements : [{ tag: 'markdown', content: '（空）' }],
  };
  if (title) {
    card.header = { title: { tag: 'plain_text', content: title }, template: 'blue' };
  }
  return card;
}

/** 卡片体积守卫：飞书对单条卡片有大小上限，超了直接 400 */
export function isCardTooBig(card, limit = 26000) {
  return JSON.stringify(card).length > limit;
}
