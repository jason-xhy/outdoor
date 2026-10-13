// test-core.mjs — track-core 逻辑测试（Node）
// 用法: node test/test-core.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const TC = require('../src/track-core.js');
const dir = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 实得 ' + a); }
function ok(v, msg) { if (!v) throw new Error(msg || '应为真'); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error((msg || '') + ' 期望≈' + b + ' 实得 ' + a); }

/* ---------- 单元 ---------- */
t('haversine: 1°纬度 ≈ 111.2km', () => {
  near(TC.haversine({ lon: 114, lat: 27 }, { lon: 114, lat: 28 }), 111190, 500);
});
t('dist3: 含海拔三维距离', () => {
  near(TC.dist3({ lon: 114, lat: 27, ele: 0 }, { lon: 114, lat: 27.001, ele: 0 }), TC.haversine({ lon: 114, lat: 27 }, { lon: 114, lat: 27.001 }), 0.01);
});
t('xmlEscape', () => {
  eq(TC.xmlEscape('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
});
t('statsFor: 爬升/下降', () => {
  const pts = [];
  for (let i = 0; i < 6; i++) pts.push({ lon: 0, lat: i * 0.0001, ele: i * 20 });       // 爬 0→100
  for (let i = 0; i < 6; i++) pts.push({ lon: 0, lat: 0.0006 + i * 0.0001, ele: 100 - i * 15 }); // 降 100→25
  const s = TC.statsFor(pts);
  ok(s.ascentM > 50 && s.ascentM < 120, '爬升应≈100(含平滑边界损失), 实得 ' + s.ascentM);
  ok(s.descentM > 45 && s.descentM < 95, '下降应≈75, 实得 ' + s.descentM);
});
t('parseGpx: 合成 GPX', () => {
  const gpx = `<?xml version="1.0"?><gpx><trk><name>t</name><trkseg>
    <trkpt lat="27.1" lon="114.1"><ele>100</ele></trkpt>
    <trkpt lat="27.2" lon="114.2"><ele>200</ele></trkpt>
    <trkpt lat="27.3" lon="114.3"/></trkseg></trk></gpx>`;
  const tr = TC.parseGpx(gpx, 'x.gpx');
  eq(tr.length, 1); eq(tr[0].points.length, 3); eq(tr[0].points[2].ele, null);
});
t('dijkstra: 小图最短路', () => {
  const tracks = [
    { name: 'A', points: [{ lon: 0, lat: 0 }, { lon: 0, lat: 0.002 }] },
    { name: 'B', points: [{ lon: 0, lat: 0.001 }, { lon: 0.01, lat: 0.001 }] },
  ];
  const g = TC.buildGraph(tracks, 150);
  eq(g.nComponents, 1, '应连通');
  const r = TC.dijkstra(g, g.pointNode[0][0], g.pointNode[1][1]);
  ok(r && r.path.length >= 2 && r.distM > 0, '应存在路径');
});

/* ---------- 真实轨迹 ---------- */
const kml1 = readFileSync(path.join(dir, 'data/track1-xuxiake.kml'), 'utf8');
const kml2 = readFileSync(path.join(dir, 'data/track2-xianglufeng.kml'), 'utf8');
const T1 = TC.parseKml(kml1, 'track1.kml');
const T2 = TC.parseKml(kml2, 'track2.kml');

t('解析: 2bulu gx:Track 基本量', () => {
  eq(T1.length, 1); eq(T2.length, 1);
  ok(T1[0].points.length >= 1000, '轨迹1点数=' + T1[0].points.length);
  ok(T2[0].points.length >= 850, '轨迹2点数=' + T2[0].points.length);
  ok(T1[0].name.indexOf('徐霞客') >= 0, '轨迹1名=' + T1[0].name);
});
t('解析: 起终点 Placemark(Point) 不混入轨迹', () => {
  // Point 型 Placemark 无 gx:coord/LineString，不应产出轨迹
  eq(T1.length, 1, '只应有 1 条真实轨迹');
});

const tracks = T1.concat(T2);
let graph;
t('建图: 默认 10m 容差下两轨连通且有跨轨合并', () => {
  graph = TC.buildGraph(tracks, 10);
  eq(graph.nComponents, 1, '连通分量应=1, 实得=' + graph.nComponents);
  ok(graph.crossTrackMerges >= 1, '跨轨合并节点应≥1, 实得=' + graph.crossTrackMerges);
});
t('建图: 容差 0.5m 时两轨断开（错误路径可检）', () => {
  const g0 = TC.buildGraph(tracks, 0.5);
  ok(g0.nComponents >= 2, '容差过小应不连通, 实得分量=' + g0.nComponents);
  const r = TC.routeAnchors(g0, [g0.pointNode[1][0], g0.pointNode[0][600]]);
  ok(!r.ok && /不可达/.test(r.error), '应报不可达: ' + (r.error || ''));
});

// 示例行程（机制等价版）：
// 轨迹2起点(图平坳口) → 轨迹2最高点(香炉峰/鸡婆岩) → 原路返回起点 → 跨轨交汇点 → 轨迹1金顶 → 轨迹1终点(下撤口)
let route, anchors;
t('路由: 示例行程全程可达', () => {
  const start2 = TC.nearestNode(graph, T2[0].points[0]).idx;
  let iMax2 = 0; T2[0].points.forEach((p, i) => { if (p.ele > T2[0].points[iMax2].ele) iMax2 = i; });
  const peak2 = TC.nearestNode(graph, T2[0].points[iMax2]).idx;
  let iMax1 = 0; T1[0].points.forEach((p, i) => { if (p.ele > T1[0].points[iMax1].ele) iMax1 = i; });
  const summit1 = TC.nearestNode(graph, T1[0].points[iMax1]).idx;
  const end1 = TC.nearestNode(graph, T1[0].points[T1[0].points.length - 1]).idx;
  // 跨轨交汇点：合并节点中离轨迹1更近的成员
  const jNode = graph.nodes.findIndex(n => new Set(n.members.map(m => m.t)).size > 1);
  ok(jNode >= 0, '应存在跨轨合并节点');
  anchors = [start2, peak2, start2, jNode, summit1, end1];
  route = TC.routeAnchors(graph, anchors);
  ok(route.ok, route.error || '应成功');
});
t('路由: 原路返回段去程=回程（节点序列镜像）', () => {
  const [a, b, c] = [route.legs[0].nodePath, route.legs[1].nodePath, undefined];
  const back = route.legs[1].nodePath;
  const forth = route.legs[0].nodePath;
  ok(forth.length === back.length && forth.every((n, i) => n === back[back.length - 1 - i]),
    '去程与回程节点序列应互为镜像');
});
t('路由: 途经跨轨交汇（从轨迹2换到轨迹1）', () => {
  const set = new Set(route.nodePath);
  const hasBoth = route.nodePath.some(ni => new Set(graph.nodes[ni].members.map(m => m.t)).size > 1);
  ok(hasBoth, '路线上应含跨轨合并节点');
});
t('硬约束: 输出每点均来自原轨迹原始坐标', () => {
  const orig = new Set();
  tracks.forEach(tk => tk.points.forEach(p => orig.add(p.lon.toFixed(6) + ',' + p.lat.toFixed(6) + ',' + p.ele.toFixed(2))));
  const bad = route.points.filter(p => !orig.has(p.lon.toFixed(6) + ',' + p.lat.toFixed(6) + ',' + p.ele.toFixed(2)));
  eq(bad.length, 0, '发明了 ' + bad.length + ' 个新坐标点: ' + JSON.stringify(bad.slice(0, 2)));
});
t('统计: 总里程量级合理（10–60km）', () => {
  ok(route.stats.distM > 10000 && route.stats.distM < 60000, '总里程=' + (route.stats.distM / 1000).toFixed(2) + 'km');
  ok(route.stats.ascentM > 500, '累计爬升=' + route.stats.ascentM.toFixed(0) + 'm');
});
t('统计: 去回两段里程接近（原路返回）', () => {
  near(route.legs[0].stats.distM, route.legs[1].stats.distM, route.legs[0].stats.distM * 0.05, '去/回程');
});

/* ---------- 导出回环 ---------- */
t('导出: GPX 回环解析点数一致', () => {
  const anchorPts = anchors.map((ni, i) => ({ name: '锚点' + (i + 1), ...graph.nodes[ni] }));
  const gpx = TC.toGpx('测试轨迹', route.points, anchorPts);
  const back = TC.parseGpx(gpx, 'o.gpx');
  eq(back.length, 1); eq(back[0].points.length, route.points.length);
  near(back[0].points[0].lon, route.points[0].lon, 1e-6);
});
t('导出: KML 回环解析点数一致', () => {
  const anchorPts = anchors.map((ni, i) => ({ name: '锚点' + (i + 1), ...graph.nodes[ni] }));
  const kml = TC.toKml('测试轨迹', route.points, anchorPts);
  const back = TC.parseKml(kml, 'o.kml');
  // 1 条 LineString 轨迹（锚点 Point 不产出轨迹）
  const lineTracks = back.filter(tr => tr.points.length >= 2);
  eq(lineTracks.length, 1, '应只有 1 条 LineString 轨迹');
  eq(lineTracks[0].points.length, route.points.length);
});

/* ---------- 锚点多候选（绕大圈 bug 回归：7~8 间有短路但锚点吸附到不连通侧） ---------- */
t('候选: 每轨最近点 <=100m 纳入, >100m 排除并回退最近单点', () => {
  const A = [], B = [];
  for (let i = 0; i <= 10; i++) {
    A.push({ lon: 0, lat: i * 0.001, ele: 0 });
    B.push({ lon: 0.00135, lat: i * 0.001, ele: 0 }); // 与 A 相距 ~150m，超出候选半径
  }
  const g = TC.buildGraph([{ name: 'A', points: A }, { name: 'B', points: B }], 10);
  let cs = TC.candidateNodes(g, { lat: 0.005, lon: 0 });
  eq(cs.length, 1, '150m 外的 B 轨不应纳入候选, 实得 ' + cs.length);
  ok(g.nodes[cs[0].idx].members[0].t === 0, '应吸附 A 轨');
  cs = TC.candidateNodes(g, { lat: 0.005, lon: 0.0006 }); // 距 A ~67m、B ~83m，均在 100m 内
  eq(cs.length, 2, '两轨均在 100m 内应双候选, 实得 ' + cs.length);
  cs = TC.candidateNodes(g, { lat: 0.005, lon: 0.0055 }); // 距所有轨迹 ~500m
  eq(cs.length, 1, '全超 100m 应回退最近单点, 实得 ' + cs.length);
  ok(cs[0].d > 100, '回退候选应保留真实距离, 实得 ' + cs[0].d.toFixed(0) + 'm');
});
t('候选: 两轨端点重叠区(~83m)双候选且路由择短', () => {
  // A 为下撤直线；B 起点离 A 终点 ~83m（容差外），B 尾部与 A 低处容差内合并
  const A = [];
  for (let i = 0; i <= 20; i++) A.push({ lon: 0, lat: i * 0.0005, ele: 1000 - i * 10 });
  const B = [{ lon: 0.00075, lat: 0.01015, ele: 1000 }];
  for (let i = 19; i >= 6; i--) B.push({ lon: 0.00075, lat: i * 0.0005, ele: 900 });
  B.push({ lon: 0.00005, lat: 0.003, ele: 900 }); // 距 A@(0,0.003) ≈5.5m -> 跨轨合并
  const g = TC.buildGraph([{ name: 'A', points: A }, { name: 'B', points: B }], 10);
  ok(g.crossTrackMerges >= 1, '应有跨轨合并');
  const p1 = { lat: 0.006, lon: 0 }, p2 = { lat: 0.01015, lon: 0.00075 }; // 用户点在 B 起点上
  const cs2 = TC.candidateNodes(g, p2);
  eq(cs2.length, 2, '锚点2 应有两轨候选, 实得 ' + cs2.length);
  // 旧行为对照：单点吸附 B 起点 -> 绕合并点 >1km
  const old = TC.routeAnchors(g, [TC.nearestNode(g, p1).idx, TC.nearestNode(g, p2).idx]);
  ok(old.ok && old.stats.distM > 1000, '单点吸附旧行为应绕行 >1km, 实得 ' + (old.ok ? old.stats.distM.toFixed(0) + 'm' : old.error));
  // 新行为：候选择短走 A 直达（~445m）
  const r = TC.routeAnchors(g, [TC.candidateNodes(g, p1).map(c => c.idx), cs2.map(c => c.idx)]);
  ok(r.ok, r.error || '');
  ok(r.stats.distM < 600, '应走 A 直达 ~445m, 实得 ' + r.stats.distM.toFixed(0) + 'm');
  ok(r.anchorUsed.every(ni => r.nodePath.indexOf(ni) >= 0), 'anchorUsed 应全部落在最终路线上');
});
t('路由: 真实 8 锚点场景 7->8 不再绕大圈（走徐霞客尾段 3.6km）', () => {
  const P = [
    [27.445866, 114.188182], [27.430606, 114.189569], [27.442161, 114.190200], [27.441258, 114.185394],
    [27.436808, 114.179532], [27.455145, 114.173223], [27.465908, 114.175516], [27.455068, 114.196612],
  ];
  const spec = P.map(([lat, lon]) => TC.candidateNodes(graph, { lat, lon }).map(c => c.idx));
  const r = TC.routeAnchors(graph, spec);
  ok(r.ok, r.error || '');
  ok(r.legs[6].stats.distM < 5000, '7->8 段应走 track1 尾段 ≈3.6km, 实得 ' + (r.legs[6].stats.distM / 1000).toFixed(2) + 'km');
  ok(r.stats.distM < 29108, '总里程应优于旧 29.108km, 实得 ' + (r.stats.distM / 1000).toFixed(2) + 'km');
  const endNode = graph.nodes[r.anchorUsed[7]];
  ok(endNode.members.some(m => m.t === 0), '锚点8 实际应落在 track1（徐霞客）尾段, members=' + JSON.stringify(endNode.members));
  ok(r.anchorUsed.every(ni => r.nodePath.indexOf(ni) >= 0), 'anchorUsed 应全部落在最终路线上');
});
t('路由: 单轨迹多锚点行为与旧逐点路由完全一致', () => {
  const g1 = TC.buildGraph(T1, 10);
  const pts = [0, 300, 700, g1.pointNode[0].length - 1].map(i => g1.pointNode[0][i]);
  const old = TC.routeAnchors(g1, pts);
  const neu = TC.routeAnchors(g1, pts.map(ni => [ni]));
  ok(old.ok && neu.ok, (old.error || '') + (neu.error || ''));
  near(neu.stats.distM, old.stats.distM, 0.001, '总里程');
  eq(neu.nodePath.join(','), old.nodePath.join(','), '节点序列应一致');
});

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
