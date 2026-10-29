/**
 * 文档权限自检
 * 逐个调用云文档相关接口，告诉你哪个通了、哪个还缺 scope。
 * 用法：node check-perms.mjs
 */
import 'dotenv/config';
import * as Lark from '@larksuiteoapi/node-sdk';

const client = new Lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  // 默认 logger 会把失败响应整个打出来，这里压成一行
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} },
});

const FAKE_DOC = 'doxcnAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_WIKI = 'wikcnAAAAAAAAAAAAAAAAAAAAAA';

const probes = [
  ['读文档正文 docx.rawContent', () => client.docx.v1.document.rawContent({ path: { document_id: FAKE_DOC } })],
  ['新建文档 docx.create', () => client.docx.v1.document.create({ data: { title: 'perm-probe' } })],
  ['追加段落 blockChildren.create', () => client.docx.v1.documentBlockChildren.create({
    path: { document_id: FAKE_DOC, block_id: FAKE_DOC },
    data: { children: [{ block_type: 2, text: { elements: [{ text_run: { content: 'x' } }], style: {} } }], index: -1 },
  })],
  ['知识库节点 wiki.getNode', () => client.wiki.v2.space.getNode({ params: { token: FAKE_WIKI, obj_type: 'wiki' } })],
  ['搜索文档 search.docWiki', () => client.search.v2.docWiki.search({ data: { query: 'test', page_size: 1 } })],
  ['云空间列举 drive.file.list', () => client.drive.v1.file.list({ params: { page_size: 1 } })],
];

// 用假 token 调用，重点看错误码：
//   99991672 = 缺 scope（要开通权限）
//   1770002 / 1770032 / 99992402 = 权限已过，卡在文档本身（说明 scope 没问题）
const results = [];

for (const [label, fn] of probes) {
  try {
    await fn();
    results.push([label, 'ok', '通过']);
  } catch (e) {
    const d = e?.response?.data ?? {};
    const msg = String(d.msg ?? e?.message ?? '');
    if (d.code === 99991672) {
      const scopes = (msg.match(/\[([^\]]+)\]/) || [, '未知'])[1];
      results.push([label, 'scope', `缺权限 ${scopes}`]);
    } else {
      results.push([label, 'pass', `已通过鉴权（${d.code || '?'} ${msg.slice(0, 40)}）`]);
    }
  }
}

const width = Math.max(...results.map((r) => r[0].length)) + 2;
console.log('\n=== 云文档权限自检 ===\n');
for (const [label, kind, note] of results) {
  const icon = kind === 'scope' ? '✗' : '✓';
  console.log(`${icon} ${label.padEnd(width)} ${note}`);
}

const missing = results.filter((r) => r[1] === 'scope').map((r) => r[2]);
console.log('\n结论：');
if (!missing.length) {
  console.log('所有接口都能通过鉴权。剩下只需确认目标文档已把机器人加为协作者。');
} else {
  console.log('还有权限没开，去开放平台「权限管理」开通后重新发布版本：');
  for (const m of missing) console.log('  ·', m);
}
