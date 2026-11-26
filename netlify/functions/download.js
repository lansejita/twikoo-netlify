/* 下载量统计云函数（Netlify Functions）
   部署：把本文件放到 Netlify 项目的 netlify/functions/download.js，项目根目录 package.json 加 mongodb 依赖。
   环境变量：MONGODB_URI（复用现有 Twikoo 项目里那个，含密码，不要在代码里写死）。
   数据库：独立的 download_stats（不碰 twikoo 库），集合 hits。

   接口（统一 POST，Twikoo 风格的 event 协议）：
     {"event":"hit","id":"ns9751","platform":"NS"}  → 记一次下载，返回 {ok:true}
     {"event":"top","limit":10}                     → 返回 {ok:true, top:[{id,count}, ...]}
     {"event":"ping"}                               → 自检，返回 {ok:true, version, db}

   统计口径：点一次记一次（按 id 聚合，不去重 IP）。
*/
const { MongoClient } = require('mongodb');

const DB_NAME = 'download_stats';
const COL = 'hits';
const VERSION = '1.0.0';

/* 连接缓存：Netlify 函数会复用进程，缓存 client 避免每次请求重连 */
let cachedClient = null;
let cachedUri = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

async function getCollection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('未配置 MONGODB_URI 环境变量');
  if (cachedClient && cachedUri === uri) return cachedClient.db(DB_NAME).collection(COL);
  const client = new MongoClient(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 5000 });
  await client.connect();          // 启动时验证连通，失败直接抛
  cachedClient = client;
  cachedUri = uri;
  return client.db(DB_NAME).collection(COL);
}

/* id 白名单口径：字母数字下划线短横线，1~40 位，挡掉乱写 */
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: '只支持 POST' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { ok: false, error: '请求体不是合法 JSON' }); }

  try {
    const col = await getCollection();

    if (body.event === 'ping') {
      return reply(200, { ok: true, version: VERSION, db: DB_NAME });
    }

    if (body.event === 'hit') {
      if (!validId(body.id)) return reply(400, { ok: false, error: 'id 不合法' });
      await col.insertOne({
        id: body.id,
        platform: typeof body.platform === 'string' ? body.platform.slice(0, 10) : '',
        at: new Date(),
      });
      return reply(200, { ok: true });
    }

    if (body.event === 'top') {
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
      const top = await col.aggregate([
        { $group: { _id: '$id', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, id: '$_id', count: 1 } },
      ]).toArray();
      return reply(200, { ok: true, top });
    }

    return reply(400, { ok: false, error: '未知 event' });
  } catch (err) {
    console.error('[download]', err);
    return reply(500, { ok: false, error: String(err && err.message || err).slice(0, 200) });
  }
};
