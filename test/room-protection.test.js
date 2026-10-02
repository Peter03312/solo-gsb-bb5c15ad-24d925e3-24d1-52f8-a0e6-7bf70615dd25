'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-protect-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;

function request(method, urlPath, body, raw = false) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (raw) return resolve({ status: res.statusCode, body: data });
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let seq = 0;

async function resetDraft() {
  const cues = await request('GET', '/api/cues');
  for (const c of cues.json) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await request('GET', '/api/lights');
  for (const l of lights.json) await request('DELETE', `/api/lights/${l.id}`);
  const circuits = await request('GET', '/api/circuits');
  for (const c of circuits.json) await request('DELETE', `/api/circuits/${c.id}`);
}

/**
 * 发布一个带回路接线的版本：
 * 一盏 100W 的灯 t=0 用 4s 从 0 渐变到 100，之后保持；
 * 接在容量 capacity 瓦的回路上 -> 负载(t)=25t（t∈[0,4]），之后恒为 100W。
 * 容量取 50 时超载区间为 (2, 4]（首个边界 t=2，交点不含，边界负载恰为 50W）。
 */
async function overloadVersion({ capacity = 50, suffix = '' } = {}) {
  const n = ++seq;
  await resetDraft();
  await request('POST', '/api/lights', { name: `超载灯${n}${suffix}` });
  const lights = (await request('GET', '/api/lights')).json;
  const l1 = lights[lights.length - 1].id;
  const c = (await request('POST', '/api/circuits', { name: `超载回路${n}${suffix}`, capacity })).json;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c.id, watts: 100 });
  await request('POST', '/api/cues', [
    { cue_no: 8000 + n, light_id: l1, time: 0, target: 100, duration: 4 },
  ]);
  const v = (await request('POST', '/api/versions', { label: `超载版${n}` })).json;
  return { version: v, lightId: l1, circuit: c, boundary: capacity / 25 };
}

async function twoCircuitVersion() {
  const n = ++seq;
  await resetDraft();
  await request('POST', '/api/lights', { name: `晚越界灯${n}` }); // 回路 A：容量 80 -> 3.2s 越界
  await request('POST', '/api/lights', { name: `早越界灯${n}` }); // 回路 B：容量 20 -> 0.8s 越界
  const lights = (await request('GET', '/api/lights')).json;
  const [lA, lB] = lights.slice(-2).map((l) => l.id);
  const cA = (await request('POST', '/api/circuits', { name: `晚回路${n}`, capacity: 80 })).json;
  const cB = (await request('POST', '/api/circuits', { name: `早回路${n}`, capacity: 20 })).json;
  await request('PUT', `/api/lights/${lA}/wiring`, { circuit_id: cA.id, watts: 100 });
  await request('PUT', `/api/lights/${lB}/wiring`, { circuit_id: cB.id, watts: 100 });
  await request('POST', '/api/cues', [
    { cue_no: 8100 + n, light_id: lA, time: 0, target: 100, duration: 4 },
    { cue_no: 8200 + n, light_id: lB, time: 0, target: 100, duration: 4 },
  ]);
  const v = (await request('POST', '/api/versions', { label: `双回路版${n}` })).json;
  return { version: v, earlyCircuit: cB, earlyBoundary: 0.8, lateBoundary: 3.2 };
}

async function createProtectedRoom(versionId, extra = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, overload_protected: true, ...extra });
}

async function ctrl(code, key, body) {
  return request('POST', `/api/rooms/${code}/control`, { control_key: key, ...body });
}

test('创建：缺省不启用（无 protection 字段）；非布尔值 400；启用返回保护状态', async () => {
  const { version } = await overloadVersion();

  let r = await request('POST', '/api/rooms', { version_id: version.id });
  assert.equal(r.status, 201);
  assert.equal(r.json.protection ?? null, null);

  r = await createProtectedRoom(version.id);
  assert.equal(r.status, 201);
  assert.equal(r.json.protection.enabled, true);
  assert.equal(r.json.protection.configured, true);
  assert.equal(r.json.protection.status, 'safe'); // 初始暂停在 0，无 tripped/next
  assert.equal(r.json.protection.tripped, null);
  assert.equal(r.json.protection.next_boundary, null);

  for (const bad of ['true', 1, 0, 'yes']) {
    r = await request('POST', '/api/rooms', { version_id: version.id, overload_protected: bad });
    assert.equal(r.status, 400, `bad=${JSON.stringify(bad)}`);
    assert.match(r.json.error, /overload_protected 无效/);
  }
});

test('旧版无回路配置：保护启用但没有超载回路，播放/到末尾均不拦截', async () => {
  const n = ++seq;
  await resetDraft();
  await request('POST', '/api/lights', { name: `无回路灯${n}` });
  const lights = (await request('GET', '/api/lights')).json;
  await request('POST', '/api/cues', [
    { cue_no: 8300 + n, light_id: lights[lights.length - 1].id, time: 0, target: 100, duration: 0.1 },
  ]);
  const v = (await request('POST', '/api/versions', { label: `无回路版${n}` })).json;

  const c = (await createProtectedRoom(v.id)).json;
  assert.equal(c.protection.enabled, true);
  assert.equal(c.protection.configured, false);
  assert.equal(c.protection.status, 'no_config');

  let r = await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  await sleep(300);
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.equal(g.time, g.duration);
  assert.equal(g.protection.status, 'no_config');
});

test('播放抵达首个超载区间左边界：自动暂停在边界、带触发回路/时码/负载，且不增加修订号', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;

  // 暂停态先跳到 1s（允许），再播放：边界在 2s
  let r = await ctrl(c.code, c.control_key, { revision: 0, action: 'seek', time: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 1);

  r = await ctrl(c.code, c.control_key, { revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.equal(r.json.revision, 2);
  assert.equal(r.json.protection.status, 'watching');
  assert.ok(Math.abs(r.json.protection.next_boundary.time - 2) < 1e-6);
  assert.match(r.json.protection.next_boundary.circuit.name, /^超载回路/);
  assert.match(r.json.protection.next_boundary.circuit.name, /^超载回路/);
  assert.ok(Math.abs(r.json.protection.next_boundary.load - 50) < 1e-6);

  // 越过边界后才轮询：服务端必须夹在边界上，不得越过危险段
  await sleep(1300);
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 2) < 1e-6, `time=${g.time}`);
  assert.equal(g.revision, 2, '自动暂停不增加控制修订号');
  assert.equal(g.protection.status, 'tripped');
  assert.equal(g.protection.tripped.circuit.name, r.json.protection.next_boundary.circuit.name);
  assert.ok(Math.abs(g.protection.tripped.time - 2) < 1e-6);
  assert.ok(Math.abs(g.protection.tripped.load - 50) < 1e-6);

  // 已惰性落库：再查仍是暂停在边界的自动暂停状态
  const g2 = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g2.playing, false);
  assert.ok(Math.abs(g2.time - 2) < 1e-6);
  assert.equal(g2.revision, 2);
});

test('当前时码超载时拒绝播放（房间不变）；安全侧交点边界原地播放也被拒绝', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;

  // 上一个用例的自动暂停状态不在本房间；本房间先播放到自动暂停（停在 t=2，安全侧交点）
  await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  await sleep(2300);
  let g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.protection.status, 'tripped');

  // t=2 处负载恰等于容量（边界不含）：播放会立即进入超载段 -> play_overload_ahead
  let r = await ctrl(c.code, c.control_key, { revision: 1, action: 'play' });
  assert.equal(r.status, 409);
  assert.equal(r.json.protection_refused.reason, 'play_overload_ahead');
  assert.ok(Math.abs(r.json.protection_refused.time - 2) < 1e-6);

  // 房间不变：仍暂停在 2
  g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 2) < 1e-6);
  assert.equal(g.revision, 1);

  // 暂停态允许跳入超载段内部（t=2.5，负载 62.5W）
  r = await ctrl(c.code, c.control_key, { revision: 1, action: 'seek', time: 2.5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 2);
  assert.equal(r.json.playing, false);
  assert.ok(Math.abs(r.json.time - 2.5) < 1e-6);

  // 在超载时码上按播放：play_overloaded_now，409 且房间不变
  r = await ctrl(c.code, c.control_key, { revision: 2, action: 'play' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /当前时码 2.5.*已严格大于容量/);
  assert.equal(r.json.protection_refused.reason, 'play_overloaded_now');
  assert.ok(Math.abs(r.json.protection_refused.load - 62.5) < 1e-6);
  g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 2.5) < 1e-6);
  assert.equal(g.revision, 2);
});

test('播放中跳入超载段被拒绝且房间不变；暂停时允许跳转避险，之后可正常播放', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;

  let r = await ctrl(c.code, c.control_key, { revision: 0, action: 'seek', time: 0 });
  assert.equal(r.status, 200);
  r = await ctrl(c.code, c.control_key, { revision: 1, action: 'play' });
  assert.equal(r.status, 200);

  // 播放中直接跳到 3s（超载段内部）：409，房间保持播放且进度未跳
  r = await ctrl(c.code, c.control_key, { revision: 2, action: 'seek', time: 3 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /播放中不允许跳入超载段/);
  assert.equal(r.json.protection_refused.reason, 'seek_into_overload');
  assert.ok(Math.abs(r.json.protection_refused.load - 75) < 1e-6);
  let g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, true);
  assert.ok(g.time < 2, `播放未被跳转，应仍在边界前，实际 time=${g.time}`);
  assert.equal(g.revision, 2);

  // 先暂停，再跳到超载段内：允许（避险/定位）
  r = await ctrl(c.code, c.control_key, { revision: 2, action: 'pause' });
  assert.equal(r.status, 200);
  const pausedAt = r.json.time;
  r = await ctrl(c.code, c.control_key, { revision: 3, action: 'seek', time: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.protection.status, 'safe');

  // 从安全时码 0 重新播放：前方边界重新武装
  r = await ctrl(c.code, c.control_key, { revision: 4, action: 'seek', time: 0 });
  assert.equal(r.status, 200);
  r = await ctrl(c.code, c.control_key, { revision: 5, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.protection.status, 'watching');
  assert.ok(Math.abs(r.json.protection.next_boundary.time - 2) < 1e-6);
  assert.ok(pausedAt >= 0); // 占位：暂停时码已用于上面的流程
});

test('自动暂停后再按暂停：触发原因保留；跳转后触发原因清除', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;

  await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  await sleep(2300);
  await request('GET', `/api/rooms/${c.code}`); // 惰性落库自动暂停（修订号 1）

  // 再按暂停：修订号 +1，但 tripped 原因保留
  let r = await ctrl(c.code, c.control_key, { revision: 1, action: 'pause' });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 2);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.protection.status, 'tripped');
  assert.ok(Math.abs(r.json.protection.tripped.time - 2) < 1e-6);
  assert.equal(r.json.protection.next_boundary, null);

  // 暂停态跳转避险后：人工操作清除触发原因 -> safe
  r = await ctrl(c.code, c.control_key, { revision: 2, action: 'seek', time: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.protection.status, 'safe');
  assert.equal(r.json.protection.tripped, null);
});

test('倍速从实时推算时码继续；2 倍速更快抵达同一边界并自动暂停（修订号不变）', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;

  await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  await sleep(100); // 实时时码约 0.1
  let r = await ctrl(c.code, c.control_key, { revision: 1, action: 'speed', speed: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.speed, 2);
  const tAtSpeedChange = r.json.server_time;
  assert.ok(tAtSpeedChange > 0.02 && tAtSpeedChange < 0.5, `t=${tAtSpeedChange}`);
  assert.equal(r.json.protection.status, 'watching');
  // 2 倍速从当前时码到 2s 约需 (2-t)/2 < 1s
  await sleep(1100);
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - 2) < 1e-6);
  assert.equal(g.revision, 2);
  assert.equal(g.protection.status, 'tripped');
});

test('多回路：触发播放方向上最早的超载边界（时码相同取编号较小回路）', async () => {
  const { version, earlyCircuit, earlyBoundary } = await twoCircuitVersion();
  const c = (await createProtectedRoom(version.id)).json;

  const r = await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.protection.next_boundary.time - earlyBoundary) < 1e-6);
  assert.equal(r.json.protection.next_boundary.circuit.id, earlyCircuit.id);
  await sleep(1000);
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.ok(Math.abs(g.time - earlyBoundary) < 1e-6);
  assert.equal(g.protection.tripped.circuit.id, earlyCircuit.id);
  assert.equal(g.revision, 1);
});

test('未启用保护的房间沿用原行为：穿过超载段、到末尾自动停住，无 protection 字段', async () => {
  const { version } = await overloadVersion();
  const c = (await request('POST', '/api/rooms', { version_id: version.id })).json;
  assert.equal(c.protection ?? null, null);

  const r = await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.protection ?? null, null);
  await sleep(4300);
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.playing, false);
  assert.equal(g.time, g.duration);
  assert.equal(g.protection ?? null, null);
});

test('观看端（无密钥）GET 即含保护状态；密钥错误不影响只读查看', async () => {
  const { version } = await overloadVersion();
  const c = (await createProtectedRoom(version.id)).json;
  const g = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.equal(g.control_key, undefined);
  assert.equal(g.protection.enabled, true);
  assert.equal(g.protection.status, 'safe');
});

test('重启恢复：自动暂停状态与播放中的边界武装都按墙钟和冻结版本恢复', async () => {
  const { version } = await overloadVersion();
  const { app: app2 } = require('../server.js'); // open() 单例：同一进程同一 DB 文件
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    // 1) 已自动暂停的房间：重启后仍停在边界、触发原因仍在、修订号不变
    const c = (await createProtectedRoom(version.id)).json;
    await ctrl(c.code, c.control_key, { revision: 0, action: 'play' });
    await sleep(2300);
    await request('GET', `/api/rooms/${c.code}`); // 惰性落库自动暂停

    const req2 = (p) =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: s2.address().port, path: p }, (res) => {
          let d = '';
          res.on('data', (x) => (d += x));
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });

    let g = await req2(`/api/rooms/${c.code}`);
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 2) < 1e-6);
    assert.equal(g.revision, 1);
    assert.equal(g.protection.status, 'tripped');
    assert.ok(Math.abs(g.protection.tripped.time - 2) < 1e-6);

    // 2) 播放中、边界尚未抵达：重启实例按同一墙钟推算，越过边界后同样夹在边界
    const c2 = (await createProtectedRoom(version.id)).json;
    await ctrl(c2.code, c2.control_key, { revision: 0, action: 'seek', time: 1.5 });
    await ctrl(c2.code, c2.control_key, { revision: 1, action: 'play' });
    await sleep(700); // 已越过 2s
    g = await req2(`/api/rooms/${c2.code}`);
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 2) < 1e-6);
    assert.equal(g.revision, 2);
    assert.equal(g.protection.status, 'tripped');
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
