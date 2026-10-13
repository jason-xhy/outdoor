/* track-core.js — 轨迹拼接核心逻辑（浏览器/Node 双端）
 * 硬约束：输出轨迹的每个坐标点都取自原有轨迹的原始坐标，不发明任何新路段。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TrackCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 几何 ---------- */
  var R_EARTH = 6371000;
  function toRad(d) { return (d * Math.PI) / 180; }
  function haversine(a, b) {
    var la1 = toRad(a.lat), la2 = toRad(b.lat);
    var dla = toRad(b.lat - a.lat), dlo = toRad(b.lon - a.lon);
    var h = Math.sin(dla / 2) * Math.sin(dla / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  }
  function hasEle(p) { return typeof p.ele === 'number' && isFinite(p.ele); }
  function dist3(a, b) {
    var d2 = haversine(a, b);
    if (hasEle(a) && hasEle(b)) {
      var de = a.ele - b.ele;
      return Math.sqrt(d2 * d2 + de * de);
    }
    return d2;
  }

  /* ---------- 解析 ---------- */
  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function tagText(block, tag) {
    var m = block.match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>'));
    return m ? m[1].trim() : '';
  }
  function parseCoordTriple(s) {
    // 兼容 gx:coord 空格分隔与 LineString 逗号分隔
    var f = s.split(/[\s,]+/).map(parseFloat);
    if (!isFinite(f[0]) || !isFinite(f[1])) return null;
    return { lon: f[0], lat: f[1], ele: isFinite(f[2]) ? f[2] : null };
  }
  function dedupeConsecutive(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = out[out.length - 1];
      if (q && p.lon === q.lon && p.lat === q.lat) continue;
      out.push(p);
    }
    return out;
  }

  function parseKml(text, fileName) {
    var tracks = [];
    var docM = text.match(/<Document\b[^>]*>[\s\S]*?<\/Document>/);
    var docName = docM ? tagText(docM[0], 'name') : '';
    var placers = text.match(/<Placemark\b[^>]*>[\s\S]*?<\/Placemark>/g) || [];
    placers.forEach(function (blk, idx) {
      var name = tagText(blk, 'name');
      // 2bulu 的 Placemark 通用名（轨迹片段N）回退用 Document 标题
      if (!name || /^轨迹片段\d*$/.test(name)) name = docName || (fileName || 'KML') + '#' + (idx + 1);
      var coords = [];
      var gx = blk.match(/<gx:coord>[^<]*<\/gx:coord>/g);
      if (gx) {
        gx.forEach(function (c) {
          var body = c.replace(/<\/?gx:coord>/g, '');
          var p = parseCoordTriple(body.trim());
          if (p) coords.push(p);
        });
      } else {
        var ls = blk.match(/<LineString>[\s\S]*?<\/LineString>/);
        if (ls) {
          var cs = ls[0].match(/<coordinates>([\s\S]*?)<\/coordinates>/);
          if (cs) cs[1].trim().split(/\s+/).forEach(function (t) {
            var p = parseCoordTriple(t);
            if (p) coords.push(p);
          });
        }
      }
      var pts = dedupeConsecutive(coords);
      if (pts.length >= 2) tracks.push({ name: name, points: pts });
    });
    if (!tracks.length) {
      // 无 Placemark 的裸 LineString KML
      var cs2 = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
      if (cs2) {
        var pts2 = dedupeConsecutive(cs2[1].trim().split(/\s+/).map(function (t) {
          return parseCoordTriple(t);
        }).filter(Boolean));
        if (pts2.length >= 2) tracks.push({ name: fileName || '轨迹', points: pts2 });
      }
    }
    return tracks;
  }

  function parseGpx(text, fileName) {
    var tracks = [];
    var trks = text.match(/<trk>[\s\S]*?<\/trk>/g) || [];
    trks.forEach(function (blk, idx) {
      var name = tagText(blk, 'name') || (fileName || 'GPX') + '#' + (idx + 1);
      var segs = blk.match(/<trkseg>[\s\S]*?<\/trkseg>/g) || [];
      segs.forEach(function (seg, si) {
        var pts = [];
        var pts_re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
        var m;
        while ((m = pts_re.exec(seg)) !== null) {
          var attrs = m[1], inner = m[2] || '';
          var la = attrs.match(/lat="([-\d.]+)"/), lo = attrs.match(/lon="([-\d.]+)"/);
          if (!la || !lo) continue;
          var el = inner.match(/<ele>([^<]+)<\/ele>/);
          pts.push({ lon: parseFloat(lo[1]), lat: parseFloat(la[1]), ele: el ? parseFloat(el[1]) : null });
        }
        pts = dedupeConsecutive(pts);
        if (pts.length >= 2) tracks.push({ name: si ? name + '/' + (si + 1) : name, points: pts });
      });
    });
    return tracks;
  }

  function parseAuto(text, fileName) {
    var t = text.replace(/^\uFEFF/, '').trim();
    if (/<kml[\s>]/i.test(t) || /<\/kml>/i.test(t)) return parseKml(t, fileName);
    if (/<gpx[\s>]/i.test(t) || /<\/gpx>/i.test(t)) return parseGpx(t, fileName);
    return /<trkpt/i.test(t) ? parseGpx(t, fileName) : parseKml(t, fileName);
  }

  /* ---------- 建图 ---------- */
  var CELL = 0.0005; // 网格边长 ≈ 50m
  function cellKey(lon, lat) {
    return Math.round(lon / CELL) + '_' + Math.round(lat / CELL);
  }
  function buildGraph(tracks, tolM) {
    var nodes = []; // {lon,lat,ele,members:[{t,i}]}
    var grid = new Map(); // cellKey -> [nodeIdx]
    var pointNode = []; // pointNode[t][i] = nodeIdx

    function tryMerge(t, p) {
      // 取最近的异轨节点（而非首个命中的），降低把平行段/之字形错并的风险
      var kl = Math.round(p.lon / CELL), ka = Math.round(p.lat / CELL);
      // 搜索半径随容差放大（格边 ~50m，按最坏情况取 50m/格）
      var ring = Math.max(1, Math.ceil(tolM / 50));
      var best = -1, bestD = Infinity;
      for (var dl = -ring; dl <= ring; dl++) for (var da = -ring; da <= ring; da++) {
        var arr = grid.get((kl + dl) + '_' + (ka + da));
        if (!arr) continue;
        for (var k = 0; k < arr.length; k++) {
          var n = nodes[arr[k]];
          if (n.t === t) continue; // 同轨不合并（防之字形抄近）
          var d = haversine(n, p);
          if (d <= tolM && d < bestD) { bestD = d; best = arr[k]; }
        }
      }
      return best;
    }

    tracks.forEach(function (tk, t) {
      pointNode[t] = [];
      tk.points.forEach(function (p, i) {
        var mid = tryMerge(t, p);
        if (mid >= 0) {
          pointNode[t][i] = mid;
          nodes[mid].members.push({ t: t, i: i });
        } else {
          var idx = nodes.length;
          nodes.push({ lon: p.lon, lat: p.lat, ele: p.ele, t: t, members: [{ t: t, i: i }] });
          pointNode[t][i] = idx;
          var key = cellKey(p.lon, p.lat);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(idx);
        }
      });
    });

    // 邻接表（无向，边权 = 代表点 3D 距离；平行边取最小）
    var adj = nodes.map(function () { return new Map(); }); // adj[a] = Map(b -> w)
    var edgeCount = 0;
    tracks.forEach(function (tk, t) {
      for (var i = 0; i + 1 < tk.points.length; i++) {
        var a = pointNode[t][i], b = pointNode[t][i + 1];
        if (a === b) continue;
        var w = dist3(nodes[a], nodes[b]);
        if (!adj[a].has(b) || adj[a].get(b) > w) { adj[a].set(b, w); adj[b].set(a, w); edgeCount++; }
      }
    });

    // 连通分量（给 UI 报警用）
    var comp = new Array(nodes.length).fill(-1), nComp = 0;
    for (var s = 0; s < nodes.length; s++) {
      if (comp[s] !== -1) continue;
      var stack = [s]; comp[s] = nComp;
      while (stack.length) {
        var u = stack.pop();
        adj[u].forEach(function (_, v) { if (comp[v] === -1) { comp[v] = nComp; stack.push(v); } });
      }
      nComp++;
    }

    return {
      nodes: nodes, adj: adj, pointNode: pointNode, nComponents: nComp, comp: comp,
      nTracks: tracks.length,
      crossTrackMerges: nodes.filter(function (n) {
        return new Set(n.members.map(function (m) { return m.t; })).size > 1;
      }).length
    };
  }

  function nearestNode(graph, p) {
    // 线性扫全部节点（≤ 万级可接受），正确且无网格索引失配风险
    var best = -1, bestD = Infinity;
    for (var i = 0; i < graph.nodes.length; i++) {
      var d = haversine(graph.nodes[i], p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { idx: best, distM: bestD };
  }

  /* ---------- 锚点候选 ----------
   * 锚点是位置意图而非节点意图：同一位置附近多条轨迹各有近点时
   * （如两条轨迹的端点记录同一下撤口，GPS 偏差几十米），只取几何最近
   * 可能把锚点绑到与去向不连通的一侧，导致绕大圈。这里按轨迹各取
   * 最近点组成候选集，交给路由择短；全部超限时回退最近单点。
   */
  var DEFAULT_MAX_SNAP_M = 100; // 与 UI「离轨迹较远」警示阈值一致
  function candidateNodes(graph, p, maxSnapM) {
    var limit = maxSnapM == null ? DEFAULT_MAX_SNAP_M : maxSnapM;
    var bestByTrack = new Map(); // t -> {idx, d}
    for (var i = 0; i < graph.nodes.length; i++) {
      var n = graph.nodes[i];
      var d = haversine(n, p);
      for (var k = 0; k < n.members.length; k++) {
        var t = n.members[k].t;
        var b = bestByTrack.get(t);
        if (!b || d < b.d) bestByTrack.set(t, { idx: i, d: d });
      }
    }
    var out = [];
    bestByTrack.forEach(function (b) {
      if (b.d <= limit && !out.some(function (o) { return o.idx === b.idx; })) out.push(b);
    });
    if (!out.length) {
      var r = nearestNode(graph, p);
      out.push({ idx: r.idx, d: r.distM });
    }
    out.sort(function (a, b) { return a.d - b.d; }); // 首位即最近（含 UI 显示的吸附距离）
    return out;
  }

  /* ---------- Dijkstra ---------- */
  function dijkstra(graph, s, t) {
    var n = graph.nodes.length;
    var dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1);
    dist[s] = 0;
    var heap = [[0, s]];
    function hpush(h, v) {
      h.push(v); var i = h.length - 1;
      while (i > 0) { var p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; var tmp = h[p]; h[p] = h[i]; h[i] = tmp; i = p; }
    }
    function hpop(h) {
      var top = h[0], last = h.pop();
      if (h.length) { h[0] = last; var i = 0;
        for (;;) { var l = 2 * i + 1, r = l + 1, m = i;
          if (l < h.length && h[l][0] < h[m][0]) m = l;
          if (r < h.length && h[r][0] < h[m][0]) m = r;
          if (m === i) break; var tp = h[m]; h[m] = h[i]; h[i] = tp; i = m; } }
      return top;
    }
    var done = new Array(n).fill(false);
    while (heap.length) {
      var top = hpop(heap), d = top[0], u = top[1];
      if (done[u]) continue;
      done[u] = true;
      if (u === t) break;
      graph.adj[u].forEach(function (w, v) {
        var nd = d + w;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; hpush(heap, [nd, v]); }
      });
    }
    if (dist[t] === Infinity) return null;
    var path = [], cur = t;
    while (cur !== -1) { path.push(cur); cur = prev[cur]; }
    path.reverse();
    return { distM: dist[t], path: path };
  }

  /* 多源多汇：任一源到任一汇的最短路（锚点候选集间择短） */
  function dijkstraBetween(graph, sources, targets) {
    var n = graph.nodes.length;
    var dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1);
    var heap = [];
    function hpush(h, v) {
      h.push(v); var i = h.length - 1;
      while (i > 0) { var p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; var tmp = h[p]; h[p] = h[i]; h[i] = tmp; i = p; }
    }
    function hpop(h) {
      var top = h[0], last = h.pop();
      if (h.length) { h[0] = last; var i = 0;
        for (;;) { var l = 2 * i + 1, r = l + 1, m = i;
          if (l < h.length && h[l][0] < h[m][0]) m = l;
          if (r < h.length && h[r][0] < h[m][0]) m = r;
          if (m === i) break; var tp = h[m]; h[m] = h[i]; h[i] = tp; i = m; } }
      return top;
    }
    sources.forEach(function (s) { if (dist[s] !== 0) { dist[s] = 0; hpush(heap, [0, s]); } });
    var done = new Array(n).fill(false), doneTargets = 0;
    var tset = new Set(targets);
    while (heap.length) {
      var top = hpop(heap), d = top[0], u = top[1];
      if (done[u]) continue;
      done[u] = true;
      if (tset.has(u) && ++doneTargets === tset.size) break;
      graph.adj[u].forEach(function (w, v) {
        var nd = d + w;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; hpush(heap, [nd, v]); }
      });
    }
    var bestT = -1, bestD = Infinity;
    targets.forEach(function (t) { if (dist[t] < bestD) { bestD = dist[t]; bestT = t; } });
    if (bestT < 0 || dist[bestT] === Infinity) return null;
    var path = [], cur = bestT;
    while (cur !== -1) { path.push(cur); cur = prev[cur]; }
    path.reverse();
    return { distM: dist[bestT], path: path, source: path[0], target: bestT };
  }

  /* ---------- 路由 + 统计 ---------- */
  function statsFor(pts) {
    var distM = 0;
    for (var i = 0; i + 1 < pts.length; i++) distM += dist3(pts[i], pts[i + 1]);
    var ascent = 0, descent = 0;
    var ele = pts.map(function (p) { return hasEle(p) ? p.ele : null; });
    if (ele.length && ele[0] !== null) {
      // 长序列才做 5 点滑动平均压 GPS 噪声；短序列用原始值（避免整段被平均抹平）
      var src = ele;
      if (ele.length >= 10) {
        src = ele.map(function (_, i) {
          var a = Math.max(0, i - 2), b = Math.min(ele.length, i + 3), s = 0, c = 0;
          for (var k = a; k < b; k++) { if (ele[k] !== null) { s += ele[k]; c++; } }
          return c ? s / c : ele[i];
        });
      }
      for (var j = 0; j + 1 < src.length; j++) {
        var d = src[j + 1] - src[j];
        if (d > 0) ascent += d; else descent -= d;
      }
    }
    return { distM: distM, ascentM: ascent, descentM: descent };
  }

  function routeAnchors(graph, anchorSpec) {
    // anchorSpec 元素：节点下标（单吸附，兼容旧签名）或候选下标数组（candidateNodes.idx）
    if (!anchorSpec || anchorSpec.length < 2) return { ok: false, error: '至少需要 2 个锚点' };
    var cand = anchorSpec.map(function (spec) {
      return (Array.isArray(spec) ? spec : [spec]).filter(function (ni) {
        return ni >= 0 && ni < graph.nodes.length;
      });
    });
    for (var c = 0; c < cand.length; c++) {
      if (!cand[c].length) return { ok: false, error: '锚点 ' + (c + 1) + ' 无有效吸附节点' };
    }
    var legs = [], total = [], used = new Array(cand.length);
    var cur = cand[0]; // 首锚点多源
    for (var k = 0; k + 1 < cand.length; k++) {
      var r = dijkstraBetween(graph, cur, cand[k + 1]);
      if (!r) {
        return {
          ok: false, error: '第 ' + (k + 1) + ' 段不可达：锚点「' + (k + 1) + '」到「' + (k + 2) +
            '」在现有轨迹路网上不连通。请加大合并容差、检查是否缺少中间轨迹，或调整锚点位置。'
        };
      }
      var legPts = r.path.map(function (ni) { return graph.nodes[ni]; });
      var st = statsFor(legPts);
      legs.push({ from: r.source, to: r.target, nodePath: r.path, stats: st });
      used[k] = (k === 0) ? r.source : used[k]; // 中间锚点实际节点 = 上一段的汇
      used[k + 1] = r.target;
      cur = [r.target]; // 段间保持路径连续
      if (k === 0) total = r.path.slice();
      else total = total.concat(r.path.slice(1));
    }
    var pts = total.map(function (ni) { return graph.nodes[ni]; });
    return { ok: true, legs: legs, nodePath: total, points: pts, stats: statsFor(pts), anchorUsed: used };
  }

  /* ---------- 导出 ---------- */
  function fmt6(x) { return x.toFixed(6); }
  function toGpx(name, points, anchors) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="track-splice" xmlns="http://www.topografix.com/GPX/1/1">'];
    (anchors || []).forEach(function (a) {
      out.push('  <wpt lat="' + fmt6(a.lat) + '" lon="' + fmt6(a.lon) + '">' +
        (hasEle(a) ? '<ele>' + a.ele.toFixed(2) + '</ele>' : '') +
        '<name>' + xmlEscape(a.name || '') + '</name></wpt>');
    });
    out.push('  <trk><name>' + xmlEscape(name || '拼接轨迹') + '</name><trkseg>');
    points.forEach(function (p) {
      out.push('    <trkpt lat="' + fmt6(p.lat) + '" lon="' + fmt6(p.lon) + '">' +
        (hasEle(p) ? '<ele>' + p.ele.toFixed(2) + '</ele>' : '') + '</trkpt>');
    });
    out.push('  </trkseg></trk></gpx>');
    return out.join('\n');
  }
  function toKml(name, points, anchors) {
    var coords = points.map(function (p) {
      return fmt6(p.lon) + ',' + fmt6(p.lat) + ',' + (hasEle(p) ? p.ele.toFixed(2) : '0');
    }).join(' ');
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
      '<name>' + xmlEscape(name || '拼接轨迹') + '</name>',
      '<Style id="route"><LineStyle><color>ff00a8ff</color><width>5</width></LineStyle></Style>'];
    (anchors || []).forEach(function (a, i) {
      out.push('<Placemark><name>' + xmlEscape((i + 1) + '. ' + (a.name || '')) + '</name>' +
        '<Point><coordinates>' + fmt6(a.lon) + ',' + fmt6(a.lat) + ',' +
        (hasEle(a) ? a.ele.toFixed(2) : '0') + '</coordinates></Point></Placemark>');
    });
    out.push('<Placemark><name>' + xmlEscape(name || '拼接轨迹') + '</name><styleUrl>#route</styleUrl>' +
      '<LineString><tessellate>1</tessellate><coordinates>' + coords + '</coordinates></LineString></Placemark>');
    out.push('</Document></kml>');
    return out.join('\n');
  }

  return {
    haversine: haversine, dist3: dist3,
    parseKml: parseKml, parseGpx: parseGpx, parseAuto: parseAuto,
    buildGraph: buildGraph, nearestNode: nearestNode, candidateNodes: candidateNodes,
    dijkstra: dijkstra, routeAnchors: routeAnchors, statsFor: statsFor,
    toGpx: toGpx, toKml: toKml, xmlEscape: xmlEscape
  };
});
