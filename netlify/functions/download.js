/* 通用浏览量统计云函数（Netlify Functions）
   部署：netlify/functions/download.js；环境变量 MONGODB_URI（复用 Twikoo 项目那个，不写死密码）。
   数据库：独立库 stats（旧版 download_stats 自动兼容），集合 events。

   设计：一条事件 = {type, id, platform, at, ...extra}
     type     资源类型：download / cheat / guide / music / ...（默认 download，可任意扩展）
     id       资源 id（游戏 id 或 帖子 id）
     platform 机种：PS4 / PS5 / NS / PC ...（可选）
     extra    任意附加字段（如 subId 子资源、ref 来源），白名单前缀 x_ 存，防止乱写

   接口（统一 POST，event 区分）：
     hit      记一次浏览   {event,hit,id,type?,platform?,x_*?}        → {ok:true}
     top      总榜         {event,top,type?,platform?,limit?,since?,days?} → {ok:true,top:[{id,count}]}
     today    今日榜       {event,today,type?,platform?,limit?,offsetMs?} → {ok:true,top:[{id,count}]}
     recent   最近浏览     {event,recent,type?,platform?,limit?}      → {ok:true,recent:[{id,type,platform,at}]}
     stats    容量/总量自查 {event,stats}                              → {ok:true,total,byType:[...],dbSizeBytes?}
     ping     自检         {event,ping}                               → {ok:true,version,db,collection}

   统计口径：点一次记一次（按 type+id 聚合，不去重 IP）。
*/
const { MongoClient } = require('mongodb');

/* 库表沿用 download_stats.hits（零迁移）：只给新事件加 type 字段，
   旧数据没有 type 的按 download 处理，新旧混查兼容。 */
const DB_NAME = 'download_stats';
const COL = 'hits';
const VERSION = '2.0.0';

let cachedClient = null;
let cachedUri = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('未配置 MONGODB_URI 环境变量');
  if (cachedClient && cachedUri === uri) return cachedClient;
  const client = new MongoClient(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 5000 });
  await client.connect();
  cachedClient = client;
  cachedUri = uri;
  return client;
}
const hitsCol = async () => (await getDb()).db(DB_NAME).collection(COL);

/* 校验：通用短 id，字母数字下划线短横线 1~48 位 */
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(id);
/* 类型：字母数字下划线短横线 1~24 位，默认 download */
const normType = (t) => (typeof t === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(t)) ? t : 'download';
const normPlatform = (p) => (typeof p === 'string') ? p.slice(0, 12) : '';
const limitOf = (n) => Math.min(50, Math.max(1, Number(n) || 10));

/* 只收 x_ 前缀的附加字段，值限字符串/数字、长度 100，防止有人塞大对象撑爆库 */
function extraFields(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (!/^x_[A-Za-z0-9_]{1,20}$/.test(k)) continue;
    const v = body[k];
    if (typeof v === 'string') out[k] = v.slice(0, 100);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/* 构造查询条件：type / platform / 时间范围 */
function matchOf(body, since) {
  const m = { type: normType(body.type) };
  if (body.platform) m.platform = normPlatform(body.platform);
  if (since) m.at = { $gte: since };
  /* 旧版数据没有 type 字段，默认按 download 算：把 "无 type" 也匹配进来 */
  if (m.type === 'download') return { $or: [{ type: 'download' }, { type: { $exists: false } }], ...(body.platform ? { platform: m.platform } : {}), ...(since ? { at: { $gte: since } } : {}) };
  return m;
}

/* 聚合榜单：按 type+platform+时间过滤，按 id 计数降序 */
async function aggregateTop(body, since) {
  const match = matchOf(body, since);
  const rows = await (await hitsCol()).aggregate([
    { $match: match },
    { $group: { _id: '$id', count: { $sum: 1 } } },
  ]).toArray();
  return rows.map((r) => ({ id: r._id, count: r.count }))
    .sort((x, y) => y.count - x.count || x.id.localeCompare(y.id))
    .slice(0, limitOf(body.limit));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: '只支持 POST' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { ok: false, error: '请求体不是合法 JSON' }); }

  try {
    if (body.event === 'ping') return reply(200, { ok: true, version: VERSION, db: DB_NAME, collection: COL });

    if (body.event === 'hit') {
      if (!validId(body.id)) return reply(400, { ok: false, error: 'id 不合法' });
      const doc = {
        type: normType(body.type),
        id: body.id,
        platform: normPlatform(body.platform),
        at: new Date(),
        ...extraFields(body),
      };
      await (await hitsCol()).insertOne(doc);
      return reply(200, { ok: true });
    }

    if (body.event === 'top') {
      let since = null;
      if (Number(body.days) > 0) since = new Date(Date.now() - Number(body.days) * 86400000);
      else if (body.since) { const d = new Date(body.since); if (!isNaN(d)) since = d; }
      return reply(200, { ok: true, top: await aggregateTop(body, since) });
    }

    if (body.event === 'today') {
      const offsetMs = Number(body.offsetMs) || 0;
      const dayStart = new Date(Date.now() + offsetMs);
      dayStart.setUTCHours(0, 0, 0, 0);
      const since = new Date(dayStart.getTime() - offsetMs);
      return reply(200, { ok: true, top: await aggregateTop(body, since) });
    }

    if (body.event === 'recent') {
      const match = matchOf(body, null);
      const proj = { projection: { _id: 0, id: 1, type: 1, platform: 1, at: 1 } };
      const recent = await (await hitsCol()).find(match, proj).sort({ at: -1 }).limit(limitOf(body.limit)).toArray();
      return reply(200, { ok: true, recent });
    }

    /* 容量自查：总量 + 按类型分布 + 实际字节（collStats 需权限，失败就跳过） */
    if (body.event === 'stats') {
      const col = await hitsCol();
      const total = await col.countDocuments();
      const byType = await col.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $project: { _id: 0, type: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray();
      let dbSizeBytes = null;
      try { const s = await col.stats(); dbSizeBytes = s.size; } catch { }
      return reply(200, { ok: true, total, byType, dbSizeBytes });
    }

    return reply(400, { ok: false, error: '未知 event' });
  } catch (err) {
    console.error('[stats]', err);
    return reply(500, { ok: false, error: String(err && err.message || err).slice(0, 200) });
  }
};
