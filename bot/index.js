/**
 * 飞书群聊 DeepSeek 机器人
 * ---------------------------------------------
 * 收：飞书「事件订阅 + 长连接(WebSocket)」→ im.message.receive_v1
 * 发：调用 DeepSeek OpenAI 兼容接口 → 回复到原消息
 *
 * 启动：npm install && npm start
 */
import 'dotenv/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { DOC_TOOLS, runTool, docsPromptSection, listConfigured } from './docs.js';
import { WEB_TOOLS, WEB_ENABLED, webPromptSection, isWebTool, runWebTool } from './search.js';
import { hasTable, splitTables, buildCard, isCardTooBig, cardToText } from './tablecard.js';

/* ============================ 配置 ============================ */
const APP_ID = (process.env.FEISHU_APP_ID || '').trim();
const APP_SECRET = (process.env.FEISHU_APP_SECRET || '').trim();
const DS_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DS_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DS_MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-flash').trim();
const BOT_NAME = process.env.BOT_NAME || 'DeepSeek';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || '你是一个乐于助人的中文助手，回答简洁、准确。';
const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS ?? 6);
const TABLE_HINT =
  '\n\n需要对比多个条目时，用 Markdown 表格呈现（| 表头 | ... |，第二行是 | --- |），我这边会自动渲染成表格；不要用空格对齐或代码块画表。';
const SYS_PROMPT_FULL = `${SYSTEM_PROMPT}\n\n${docsPromptSection()}${webPromptSection()}${TABLE_HINT}`;
const MAX_TOOL_ROUNDS = 5;
const TOOLS = [...DOC_TOOLS, ...WEB_TOOLS];
const HISTORY_TTL = 30 * 60 * 1000; // 上下文闲置 30 分钟后自动失效
const CHUNK_SIZE = 3000; // 单条飞书文本消息的字数上限（超长自动分段）

function fatal(msg) {
  console.error('\n[启动失败] ' + msg + '\n');
  process.exit(1);
}
if (!APP_ID) fatal('缺少 FEISHU_APP_ID，请复制 .env.example 为 .env 并填写');
if (!APP_SECRET) fatal('缺少 FEISHU_APP_SECRET，请复制 .env.example 为 .env 并填写');
if (!DS_KEY) fatal('缺少 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 并填写');

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a);

/**
 * 结构化消息：只有被管家拉起时（FBM_MANAGED=1）才打，
 * 管家把它渲染成「提问 / 思考中 / 回复」的可折叠日志。
 */
const MSG_PREFIX = '\x1eFBM ';
function emitMsg(kind, payload = {}) {
  if (process.env.FBM_MANAGED !== '1') return;
  try {
    process.stdout.write(MSG_PREFIX + JSON.stringify({ kind, ...payload }) + '\n');
  } catch {
    /* 输出被关掉也不影响主流程 */
  }
}

/* ============================ 会话上下文 ============================ */
/** key -> { messages: [], ts: number } */
const histories = new Map();

function historyKey(chatId, senderId, isGroup) {
  // 群聊里按「群 + 用户」隔离，避免多人对话串味；单聊直接用 chat_id
  return isGroup ? `${chatId}::${senderId}` : chatId;
}

function getHistory(key) {
  const h = histories.get(key);
  if (!h) return [];
  if (Date.now() - h.ts > HISTORY_TTL) {
    histories.delete(key);
    return [];
  }
  return h.messages;
}

function pushHistory(key, userText, assistantText) {
  if (MAX_HISTORY_TURNS <= 0) return;
  const h = histories.get(key) || { messages: [], ts: Date.now() };
  h.messages.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  );
  const limit = MAX_HISTORY_TURNS * 2;
  if (h.messages.length > limit) h.messages = h.messages.slice(-limit);
  h.ts = Date.now();
  histories.set(key, h);
}

/* ============================ 事件去重 ============================ */
const seen = new Map(); // message_id -> 时间戳

function isDuplicate(messageId) {
  const now = Date.now();
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  if (seen.size > 800) {
    for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  }
  return false;
}

/* ============================ 飞书客户端 ============================ */
// SDK 默认会把整个失败响应对象打到控制台，一次报错刷一屏。
// 这里压成一行，只留关键信息。
const flat = (...a) =>
  a
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

const quietLogger = {
  error: (...a) => console.error('[飞书]', flat(...a)),
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET, logger: quietLogger });

/** 引用回复某条消息，返回新消息的 message_id */
async function reply(parentMessageId, text) {
  const res = await client.im.v1.message.reply({
    path: { message_id: parentMessageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  return res?.data?.message_id;
}

function splitText(text, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

/** 引用回复一张消息卡片（带表格的答案走这条路径） */
async function replyCard(parentMessageId, card) {
  try {
    const res = await client.im.v1.message.reply({
      path: { message_id: parentMessageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return res?.data?.message_id;
  } catch (e) {
    // 飞书的 400 只会给一句「Request failed with status code 400」，
    // 真正的原因在 e.response.data 里，不打出来根本没法修
    const detail = safeJson(JSON.stringify(e?.response?.data || {})) || e?.response?.data;
    log('[卡片] 发送失败：', e?.message || e, detail ? JSON.stringify(detail).slice(0, 400) : '');
    throw e;
  }
}

/** 撤回自己发的消息；失败返回 false */
async function recall(messageId) {
  try {
    await client.im.v1.message.delete({ path: { message_id: messageId } });
    return true;
  } catch (e) {
    log('[提示] 撤回占位消息失败：', e?.message || e);
    return false;
  }
}

/** 用「先占位再改文案」的方式回填答案，失败则退回新消息；答案里有表格就改发卡片 */
async function settle(placeholderId, parentMessageId, text) {
  if (hasTable(text)) {
    // 有表格的答案要改发卡片，而文本消息不能改 msg_type。
    // 优先把占位消息改写成「见下一条」，比撤回更不打扰（撤回会在会话里留一条「撤回了一条消息」）。
    if (placeholderId) {
      try {
        await client.im.v1.message.update({
          path: { message_id: placeholderId },
          data: { msg_type: 'text', content: JSON.stringify({ text: '表格整理好了，见下一条 👇' }) },
        });
      } catch (e) {
        log('[提示] 占位消息改写失败，改为撤回：', e?.message || e);
        await recall(placeholderId);
      }
    }
    const segs = splitTables(text);
    const card = buildCard(segs);
    if (isCardTooBig(card)) {
      log('[卡片] 内容太大，改发纯文本');
    } else {
      try {
        await replyCard(parentMessageId, card);
        return;
      } catch {
        log('[卡片] 降级成纯文本重发');
      }
    }
    // 卡片发不出去（列太多 / 太大 / 参数不合规）时，至少把内容用文本发出去
    for (const part of splitText(cardToText(segs))) await reply(parentMessageId, part);
    return;
  }

  const parts = splitText(text);
  let filled = false;
  if (placeholderId) {
    try {
      await client.im.v1.message.update({
        path: { message_id: placeholderId },
        data: { msg_type: 'text', content: JSON.stringify({ text: parts[0] }) },
      });
      filled = true;
    } catch (e) {
      log('[提示] 占位消息更新失败，改为新消息回复：', e?.message || e);
    }
  }
  if (!filled) await reply(parentMessageId, parts[0]);
  for (let i = 1; i < parts.length; i++) await reply(parentMessageId, parts[i]);
}

/* ============================ DeepSeek ============================ */
async function postChat(body, attempt = 1) {
  const res = await fetch(`${DS_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DS_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      return postChat(body, attempt + 1);
    }
    throw new Error(`DeepSeek HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * 带工具调用的对话：模型说要查/写文档 → 本地执行 → 把结果喂回去 → 再问一轮
 * 最多 MAX_TOOL_ROUNDS 轮，防止模型在工具里打转
 */
async function askDeepSeek(messages) {
  const msgs = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const json = await postChat({
      model: DS_MODEL,
      messages: msgs,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const msg = json?.choices?.[0]?.message;
    if (!msg) return '';

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return sanitizeAnswer(msg.content || '');

    msgs.push(msg);
    for (const tc of calls) {
      const fn = tc?.function?.name;
      let out;
      try {
        const args = JSON.parse(tc?.function?.arguments || '{}');
        log(`[工具] ${fn} ${JSON.stringify(args).slice(0, 120)}`);
        out = isWebTool(fn) ? await runWebTool(fn, args) : await runTool(client, fn, args);
      } catch (e) {
        out = `调用失败：${e?.message || e}`;
        log(`[工具失败] ${fn} ${out}`);
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 12000) });
    }
  }

  // 轮次用尽后还要再问一次「直接回答」。这一轮必须带 tools + tool_choice:"none"，
  // 否则模型会想「再查一次」，把 <|DSML| invoke ...> 这种工具调用语法当正文吐出来。
  const json = await postChat({
    model: DS_MODEL,
    messages: [
      ...msgs,
      { role: 'system', content: '工具调用次数已用尽。请直接用已有信息回答，不要再调用工具，也不要输出任何工具调用标记。' },
    ],
    tools: TOOLS,
    tool_choice: 'none',
  });
  return sanitizeAnswer(json?.choices?.[0]?.message?.content || '');
}

/**
 * 兜底清洗：模型偶尔会把内部工具调用语法当正文吐出来（<|DSML| calls> 之类）。
 * 正常回答里不会出现这些标记，遇到就整段去掉；删干净后如果什么都不剩，返回空串由上层兜底。
 */
function sanitizeAnswer(text) {
  let s = String(text || '');
  // 模型偶尔会把内部工具调用标记当正文吐出来（<|DSML| calls>、< | | DSML | | invoke ...>），整行丢掉
  s = s
    .split('\n')
    .filter((line) => !/DSML|tool_calls|<\|.*\|>/.test(line))
    .join('\n');
  // 行内残留的 DSML 片段也清掉
  s = s.replace(/<[^<>\n]{0,120}DSML[^<>\n]{0,120}>?/gi, '');
  return s.trim();
}

/* ============================ 工具 ============================ */
/** 从飞书 text 消息体里取纯文本：{"text":"@_user_1 你好"} */
function extractText(content, mentions = []) {
  let text = '';
  try {
    text = JSON.parse(content)?.text ?? '';
  } catch {
    text = '';
  }
  // 去掉 @机器人 的占位符
  text = text.replace(/@_user_\d+/g, ' ');
  for (const m of mentions || []) if (m?.key) text = text.split(m.key).join(' ');
  return text.trim();
}

/* ============================ 图片 ============================ */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 按文件头判断真实格式，不信 content-type */
function detectMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/** 下载消息里的图片，转成 base64 data URL（DeepSeek 支持内联图片） */
async function downloadImage(messageId, fileKey) {
  const res = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: 'image' },
  });
  const chunks = [];
  for await (const chunk of res.getReadableStream()) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('下载到的图片是空的');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(buf.length / 1048576).toFixed(1)}MB），压缩后再发`);
  }
  const mime = detectMime(buf);
  log(`[图片] ${(buf.length / 1024).toFixed(0)}KB ${mime}`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 解析图文混排（post）消息，取出文字和图片 key */
function parsePost(content) {
  const texts = [];
  const imageKeys = [];
  const blocks = Array.isArray(content?.content) ? content.content : [];
  for (const line of blocks) {
    if (!Array.isArray(line)) continue;
    for (const node of line) {
      if (node?.text && (node.tag === 'text' || node.tag === 'a')) texts.push(node.text);
      else if (node?.tag === 'img' && node.image_key) imageKeys.push(node.image_key);
    }
  }
  const title = content?.title ? content.title + '\n' : '';
  return { text: (title + texts.join('')).replace(/@_user_\d+/g, ' ').trim(), imageKeys };
}

/* ============================ 引用回复 ============================ */
/**
 * 用户「引用」一条消息来提问时，事件里只有 parent_id，没有正文。
 * 这里按 id 把被引用的那条拉回来（10 分钟内缓存，重复引用不重复请求）。
 */
const QUOTE_TTL = 10 * 60 * 1000;
const QUOTE_MAX = 20;
const quoteCache = new Map();

async function fetchQuoted(parentId) {
  if (!parentId) return null;
  const hit = quoteCache.get(parentId);
  if (hit && Date.now() - hit.at < QUOTE_TTL) return hit;

  const res = await client.im.v1.message.get({ path: { message_id: parentId } });
  const item = res?.data?.items?.[0];
  if (!item) return null;

  const type = item.msg_type || item.message_type || 'unknown';
  const body = safeJson(item.body?.content) || {};
  let text = '';
  const images = [];

  if (type === 'text') {
    text = String(body.text || '').replace(/@_user_\d+/g, ' ').trim();
  } else if (type === 'post') {
    const post = parsePost(body);
    text = post.text;
    images.push(...post.imageKeys);
  } else if (type === 'image') {
    text = '（一张图片）';
    if (body.image_key) images.push(body.image_key);
  } else if (type === 'file') {
    text = `（文件：${body.file_name || '未命名'}）`;
  } else if (type === 'audio') {
    text = '（语音消息，我没有听过它的内容）';
  } else if (type === 'media') {
    text = '（视频）';
  } else if (type === 'merge_forward') {
    text = '（合并转发的聊天记录）';
  } else if (type === 'interactive') {
    text = '（一张消息卡片，我读不到里面的排版）';
  } else {
    text = `（${type} 类型的消息）`;
  }

  const entry = { text, images, messageId: parentId, at: Date.now() };
  if (quoteCache.size >= QUOTE_MAX) quoteCache.delete(quoteCache.keys().next().value);
  quoteCache.set(parentId, entry);
  return entry;
}

/* ============================ 消息处理 ============================ */
async function handleEvent(data) {
  const msg = data?.message;
  const sender = data?.sender;
  if (!msg?.message_id) return;
  if (isDuplicate(msg.message_id)) return;
  if (sender?.sender_type && sender.sender_type !== 'user') return;

  const isGroup = msg.chat_type !== 'p2p';
  const senderId = sender?.sender_id?.open_id || 'unknown';
  const key = historyKey(msg.chat_id, senderId, isGroup);

  // 输入解析：文字 / 图片 / 图文混排；其它类型直说看不了
  let text = '';
  const images = [];
  const MAX_IMAGES = 3;

  if (msg.message_type === 'image') {
    const imageKey = safeJson(msg.content)?.image_key;
    if (!imageKey) {
      await reply(msg.message_id, '这张图没解析出 image_key，麻烦重新发一次。');
      return;
    }
    try {
      images.push(await downloadImage(msg.message_id, imageKey));
    } catch (e) {
      await reply(msg.message_id, `❌ 图片读取失败：${e?.message || e}`);
      return;
    }
    text =
      '（用户只发了一张图，没有配文字）请说明这张图是什么；图中若有文字，请原样提取；有异常或值得注意的地方一并指出。';
  } else if (msg.message_type === 'post') {
    const post = parsePost(safeJson(msg.content));
    text = post.text;
    for (const key of post.imageKeys.slice(0, MAX_IMAGES)) {
      try {
        images.push(await downloadImage(msg.message_id, key));
      } catch (e) {
        log('[图片] 跳过一张：', e?.message || e);
      }
    }
    if (!text && !images.length) {
      await reply(msg.message_id, '这条消息里没读到文字和图片。');
      return;
    }
  } else if (msg.message_type === 'text') {
    text = extractText(msg.content, msg.mentions);
    if (!text) {
      await reply(msg.message_id, isGroup ? '在群里 @我 并说出问题就行～' : '直接把问题发给我就行～');
      return;
    }
  } else {
    const kind =
      { file: '文件', audio: '语音', media: '视频', sticker: '表情包' }[msg.message_type] ||
      msg.message_type;
    await reply(msg.message_id, `我看不了${kind}，支持的是文字和图片。`);
    return;
  }

  // 内置指令
  if (/^\/?(clear|reset|清除上下文|清空上下文|新对话)$/i.test(text)) {
    histories.delete(key);
    await reply(msg.message_id, '✅ 上下文已清空，我们重新开始。');
    return;
  }
  if (/^\/?(docs|doc|文档|文档清单)$/i.test(text)) {
    const docs = listConfigured();
    const body = docs.length
      ? docs
          .map((d, i) => `${i + 1}. ${d.name}${d.writable === false ? '（只读）' : '（可读写）'}`)
          .join('\n')
      : '还没在 docs.json 里登记任何文档。';
    await reply(msg.message_id, `📄 我能操作的文档：\n${body}`);
    return;
  }
  if (/^\/?(help|帮助|指令)$/i.test(text)) {
    await reply(
      msg.message_id,
      [
        `我是 ${BOT_NAME}，当前模型：${DS_MODEL}`,
        '· 直接提问即可，我会记住最近几轮对话',
        '· 可以发图片给我看：截图、照片、报错弹窗都行',
        '· 可以让我读/写飞书文档，比如「把今天结论追加到周报」',
        WEB_ENABLED ? '· 已开联网：需要实时信息我会自动搜，也可以说「搜一下今天的…」' : '',
        '· /docs 查看我能操作的文档清单',
        '· /clear 清空当前对话上下文',
        '· /help 查看指令',
        isGroup ? '· 群里需要 @我 才会被唤醒' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return;
  }

  // 引用回复：把被引用的那条也读进来（读不到就算了，不影响回答）
  let quoted = null;
  if (msg.parent_id || msg.upper_message_id) {
    log(`[引用] 检测到 parent_id=${msg.parent_id || msg.upper_message_id}`);
    try {
      quoted = await fetchQuoted(msg.parent_id || msg.upper_message_id);
      if (quoted?.text) {
        log(`[引用] ${quoted.text.slice(0, 40)}`);
        const room = Math.max(0, MAX_IMAGES - images.length);
        for (const key of (quoted.images || []).slice(0, room)) {
          try {
            images.push(await downloadImage(quoted.messageId, key));
          } catch (e) {
            log('[引用] 图片跳过：', e?.message || e);
          }
        }
      }
    } catch (e) {
      log('[引用] 读取失败：', e?.message || e);
    }
  }

  const asked = quoted?.text
    ? `[我引用的消息]
${quoted.text}

[我的问题]
${text || '（没有额外文字，请针对上面引用的内容回答）'}`
    : text;

  const userMessage =
    images.length > 0
      ? {
          role: 'user',
          content: [
            { type: 'text', text: asked || '请看看这几张图。' },
            ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
          ],
        }
      : { role: 'user', content: asked };

  const messages = [{ role: 'system', content: SYS_PROMPT_FULL }, ...getHistory(key), userMessage];

  const tag = images.length ? `图片×${images.length}` : isGroup ? '群' : '私聊';
  log(`[收到] ${tag} ${senderId.slice(-6)} : ${images.length ? text.slice(0, 40) : text.slice(0, 60)}`);
  emitMsg('ask', {
    text: text || (images.length ? `[${images.length} 张图片]` : ''),
    detail: asked || text || undefined,
  });
  const placeholderId = await reply(
    msg.message_id,
    images.length ? '🖼️ 正在看图…' : '🤔 正在思考…',
  ).catch(() => undefined);
  emitMsg('think', { model: DS_MODEL });

  let answer;
  try {
    answer = await askDeepSeek(messages);
  } catch (e) {
    log('[错误] 调用模型失败：', e?.message || e);
    await settle(placeholderId, msg.message_id, `❌ 调用模型失败：${e?.message || e}`);
    return;
  }

  if (!answer) answer = '（模型没有返回内容，请重试一次）';
  await settle(placeholderId, msg.message_id, answer || '我这边没能整理出答案（模型返回了空内容），换个问法再试一次？');
  emitMsg('reply', { text: answer });
  // 历史里不能塞 base64，图片只留一个占位标记
  pushHistory(key, images.length ? `[用户发送了 ${images.length} 张图片]` : asked || text, answer);
  log(`[回复] ${answer.length} 字`);
}

/* ============================ 启动 ============================ */
const wsClient = new Lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      // 关键：立刻 ACK，避免飞书 3 秒超时重推；真正的耗时处理放到后台
      handleEvent(data).catch((e) => log('[异常]', e?.stack || e));
      return Promise.resolve();
    },
    // 开放平台可能还订阅了这些事件，推过来没处理函数 SDK 会 warn 一句。
    // 我们不需要它们，注册空函数静音即可，不然日志里全是噪音。
    'im.message.message_read_v1': () => Promise.resolve(),
    'im.chat.access_event.bot_p2p_chat_entered_v1': () => Promise.resolve(),
  }),
});

log(
  `🚀 ${BOT_NAME} 机器人已启动，模型 ${DS_MODEL}，联网搜索 ${WEB_ENABLED ? '已开启' : '未开启'}，正在等待飞书消息…`,
);
log('   在飞书群里 @机器人 提问即可。Ctrl+C 退出。');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('已停止。');
    process.exit(0);
  });
}
