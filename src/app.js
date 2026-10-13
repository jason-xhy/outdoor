/* app.js — track-splice UI 交互（依赖 Leaflet 与 TrackCore，均由单文件 HTML 内嵌） */
(function () {
  'use strict';
  var TC = window.TrackCore;
  var COLORS = ['#2266cc', '#cc2222', '#22aa44', '#aa22cc', '#cc8822', '#00a3a3', '#777722', '#cc5599'];

  var state = {
    tracks: [],          // {name, points, color, layer}
    graph: null,
    anchors: [],         // {name, lat, lon} —— 存点击坐标，建图后吸附
    anchorMarkers: [],   // L.marker
    route: null,         // routeAnchors 结果
    routeLayer: null,
    addMode: true
  };

  /* ---------- 地图 ---------- */
  var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Esri World Imagery'
  });
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  });
  var map = L.map('map', { layers: [sat] }).setView([27.45, 114.19], 12);
  document.getElementById('bl-sat').onclick = function () { map.removeLayer(osm); map.addLayer(sat); this.classList.add('on'); document.getElementById('bl-osm').classList.remove('on'); };
  document.getElementById('bl-osm').onclick = function () { map.removeLayer(sat); map.addLayer(osm); this.classList.add('on'); document.getElementById('bl-sat').classList.remove('on'); };

  var trackGroup = L.layerGroup().addTo(map);
  var anchorGroup = L.layerGroup().addTo(map);

  function toast(msg, ms) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.style.display = 'none'; }, ms || 2600);
  }

  /* ---------- 文件载入 ---------- */
  function loadFiles(fileList) {
    var arr = Array.prototype.slice.call(fileList);
    var pending = arr.length;
    if (!pending) return;
    arr.forEach(function (f) {
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var tks = TC.parseAuto(rd.result, f.name);
          if (!tks.length) toast('未解析出轨迹：' + f.name);
          tks.forEach(function (tk) {
            tk.color = COLORS[state.tracks.length % COLORS.length];
            state.tracks.push(tk);
            renderTrack(tk);
          });
        } catch (e) {
          toast('解析失败 ' + f.name + '：' + e.message);
        }
        if (--pending === 0) afterTracksChanged(true);
      };
      rd.onerror = function () { toast('读取失败：' + f.name); if (--pending === 0) afterTracksChanged(true); };
      rd.readAsText(f);
    });
  }

  function renderTrack(tk) {
    tk.layer = L.polyline(tk.points.map(function (p) { return [p.lat, p.lon]; }),
      { color: tk.color, weight: 3, opacity: 0.85 });
    trackGroup.addLayer(tk.layer);
  }

  function removeTrack(i) {
    trackGroup.removeLayer(state.tracks[i].layer);
    state.tracks.splice(i, 1);
    state.tracks.forEach(function (tk, j) { tk.color = COLORS[j % COLORS.length]; tk.layer.setStyle({ color: tk.color }); });
    afterTracksChanged(false);
  }

  function fitAll() {
    var all = [];
    state.tracks.forEach(function (tk) { all = all.concat(tk.layer.getLatLngs()); });
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.08));
  }

  /* ---------- 建图 ---------- */
  function rebuildGraph() {
    if (state.tracks.length === 0) {
      state.graph = null;
      document.getElementById('gstatus').textContent = '未建路网';
      renderTrackList();
      return;
    }
    var tol = parseInt(document.getElementById('tolerance').value, 10);
    state.graph = TC.buildGraph(state.tracks, tol);
    var g = state.graph;
    var el = document.getElementById('gstatus');
    var html = '节点 ' + g.nodes.length + ' · 连通分量 ' + g.nComponents + ' · 跨轨合并点 ' + g.crossTrackMerges;
    if (g.nTracks >= 2 && g.nComponents > 1) {
      html += '<br><span style="color:#c62828">⚠ 轨迹未全部连通：拼接可能不可达，可尝试增大容差或补充中间轨迹</span>';
    }
    el.innerHTML = html;
    renderTrackList();
  }

  function afterTracksChanged(fit) {
    rebuildGraph();
    invalidateRoute('路网已变更');
    renderAnchors();
    if (fit) fitAll();
    document.getElementById('btn-route').disabled = state.anchors.length < 2;
  }

  /* ---------- 轨迹列表 ---------- */
  function renderTrackList() {
    var el = document.getElementById('tracklist');
    el.innerHTML = '';
    state.tracks.forEach(function (tk, i) {
      var len = 0;
      for (var k = 0; k + 1 < tk.points.length; k++) len += TC.dist3(tk.points[k], tk.points[k + 1]);
      var div = document.createElement('div');
      div.className = 'track-item';
      var sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = tk.color;
      var nm = document.createElement('span'); nm.className = 'nm'; nm.title = tk.name; nm.textContent = tk.name;
      var meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = tk.points.length + '点 · ' + (len / 1000).toFixed(1) + 'km';
      var del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '删';
      del.onclick = function () { removeTrack(i); };
      div.appendChild(sw); div.appendChild(nm); div.appendChild(meta); div.appendChild(del);
      el.appendChild(div);
    });
  }

  /* ---------- 锚点 ---------- */
  function anchorCandidates(a) {
    var cs = TC.candidateNodes(state.graph, a);
    return cs.map(function (c) { return c.idx; });
  }

  function addAnchor(latlng, name) {
    if (!state.graph) { toast('请先载入轨迹文件'); return null; }
    var a = { lat: latlng.lat, lon: latlng.lng, name: name || ('锚点' + (state.anchors.length + 1)) };
    state.anchors.push(a);
    renderAnchors();
    document.getElementById('btn-route').disabled = state.anchors.length < 2;
    return a;
  }

  function moveAnchor(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= state.anchors.length) return;
    var t = state.anchors[i]; state.anchors[i] = state.anchors[j]; state.anchors[j] = t;
    renderAnchors(); invalidateRoute('锚点顺序已变更');
  }
  function removeAnchor(i) {
    state.anchors.splice(i, 1);
    renderAnchors(); invalidateRoute('锚点已删除');
    document.getElementById('btn-route').disabled = state.anchors.length < 2;
  }

  function renderAnchors() {
    var list = document.getElementById('anchorlist');
    list.innerHTML = '';
    anchorGroup.clearLayers();
    state.anchorMarkers = [];
    state.anchors.forEach(function (a, i) {
      var div = document.createElement('div');
      div.className = 'anchor-item';
      var no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1;
      var inp = document.createElement('input'); inp.value = a.name; inp.title = '锚点名称';
      inp.oninput = function () { a.name = inp.value; };
      var up = document.createElement('button'); up.className = 'mini'; up.textContent = '↑';
      var dn = document.createElement('button'); dn.className = 'mini'; dn.textContent = '↓';
      var del = document.createElement('button'); del.className = 'mini danger'; del.textContent = '✕';
      up.onclick = function () { moveAnchor(i, -1); };
      dn.onclick = function () { moveAnchor(i, 1); };
      del.onclick = function () { removeAnchor(i); };
      div.appendChild(no); div.appendChild(inp); div.appendChild(up); div.appendChild(dn); div.appendChild(del);

      if (state.graph) {
        var cs = TC.candidateNodes(state.graph, a);
        var sd = cs[0].d;
        var info = document.createElement('div');
        info.className = 'snapinfo' + (sd > 100 ? ' warn' : '');
        info.textContent = '吸附距离 ' + sd.toFixed(0) + 'm' +
          (cs.length > 1 ? '（近 ' + cs.length + ' 条轨迹，计算路线时自动择优）' : '') +
          (sd > 100 ? '（离轨迹较远，建议点击轨迹线附近）' : '');
        var wrap = document.createElement('div'); wrap.style.width = '100%'; wrap.appendChild(info);
        div.appendChild(wrap);
      }
      list.appendChild(div);

      var mk = L.marker([a.lat, a.lon], {
        draggable: true,
        icon: L.divIcon({ className: '', html: '<div class="anchor-badge">' + (i + 1) + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] })
      });
      mk.on('dragend', function () {
        var ll = mk.getLatLng();
        a.lat = ll.lat; a.lon = ll.lng;
        invalidateRoute('锚点位置已变更');
        renderAnchors();
      });
      mk.bindTooltip(a.name, { permanent: false });
      anchorGroup.addLayer(mk);
      state.anchorMarkers.push(mk);
    });
  }

  /* ---------- 路线 ---------- */
  function invalidateRoute(reason) {
    state.route = null;
    if (state.routeLayer) { map.removeLayer(state.routeLayer); state.routeLayer = null; }
    var el = document.getElementById('routestat');
    if (state.anchors.length >= 2 && reason) el.innerHTML = '<span class="warn-note">' + reason + '，请重新计算路线</span>';
    else el.innerHTML = '';
    document.getElementById('btn-kml').disabled = true;
    document.getElementById('btn-gpx').disabled = true;
  }

  function computeRoute() {
    if (!state.graph) { toast('请先载入轨迹文件'); return; }
    if (state.anchors.length < 2) { toast('至少需要 2 个锚点'); return; }
    var idxs = state.anchors.map(anchorCandidates);
    var r = TC.routeAnchors(state.graph, idxs);
    var el = document.getElementById('routestat');
    if (!r.ok) {
      el.innerHTML = '<div class="err">' + r.error + '</div>';
      state.route = null;
      return;
    }
    state.route = r;
    if (state.routeLayer) map.removeLayer(state.routeLayer);
    state.routeLayer = L.polyline(r.points.map(function (p) { return [p.lat, p.lon]; }),
      { color: '#ff7f00', weight: 5, opacity: 0.95 });
    state.routeLayer.addTo(map);
    var s = r.stats;
    var html = '<div class="stat-total">总里程 ' + (s.distM / 1000).toFixed(2) +
      'km <small>↑ 爬升 ' + s.ascentM.toFixed(0) + 'm · ↓ 下降 ' + s.descentM.toFixed(0) + 'm</small></div>';
    r.legs.forEach(function (leg, k) {
      html += '<div class="leg-row">' + (k + 1) + '. ' + esc(state.anchors[k].name) + ' → ' + esc(state.anchors[k + 1].name) +
        '：' + (leg.stats.distM / 1000).toFixed(2) + 'km，↑' + leg.stats.ascentM.toFixed(0) + ' ↓' + leg.stats.descentM.toFixed(0) + '</div>';
    });
    html += '<div class="ok-note">✓ 路线全部由原轨迹点构成（' + r.points.length + ' 点）</div>';
    el.innerHTML = html;
    document.getElementById('btn-kml').disabled = false;
    document.getElementById('btn-gpx').disabled = false;
    map.fitBounds(state.routeLayer.getBounds().pad(0.08));
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  /* ---------- 导出 ---------- */
  function download(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function anchorPoints() {
    // 导出坐标取路线实际经过的节点（多候选时可能与点击处最近轨迹不同侧）
    return state.anchors.map(function (a, i) {
      var n = state.graph.nodes[state.route.anchorUsed[i]];
      return { name: (i + 1) + '-' + (a.name || ''), lat: n.lat, lon: n.lon, ele: n.ele };
    });
  }
  function exportAs(kind) {
    if (!state.route) { toast('请先计算路线'); return; }
    var name = (document.getElementById('trackname').value || '').trim() || '拼接轨迹';
    var safe = name.replace(/[\\\/:*?"<>|]/g, '_');
    if (kind === 'kml') download(TC.toKml(name, state.route.points, anchorPoints()), safe + '.kml', 'application/vnd.google-earth.kml+xml');
    else download(TC.toGpx(name, state.route.points, anchorPoints()), safe + '.gpx', 'application/gpx+xml');
    toast('已导出 ' + safe + '.' + kind);
  }

  /* ---------- 事件绑定 ---------- */
  document.getElementById('btn-files').onclick = function () { document.getElementById('files').click(); };
  document.getElementById('files').onchange = function () { loadFiles(this.files); this.value = ''; };
  document.getElementById('tolerance').oninput = function () {
    document.getElementById('tolval').textContent = this.value;
  };
  document.getElementById('tolerance').onchange = function () {
    rebuildGraph(); invalidateRoute('容差已变更'); renderAnchors();
  };
  document.getElementById('btn-addmode').onclick = function () {
    state.addMode = !state.addMode;
    this.textContent = state.addMode ? '📍 地图点选：开' : '📍 地图点选：关';
    this.classList.toggle('primary', state.addMode);
    var c = document.getElementById('map');
    if (state.addMode) c.classList.add('addmode-on'); else c.classList.remove('addmode-on');
  };
  document.getElementById('btn-clear-anchors').onclick = function () {
    state.anchors = []; renderAnchors(); invalidateRoute('');
    document.getElementById('btn-route').disabled = true;
  };
  document.getElementById('btn-route').onclick = computeRoute;
  document.getElementById('btn-kml').onclick = function () { exportAs('kml'); };
  document.getElementById('btn-gpx').onclick = function () { exportAs('gpx'); };

  map.on('click', function (e) {
    if (!state.addMode) return;
    addAnchor(e.latlng);
  });

  /* 拖放 */
  var dropmask = document.getElementById('dropmask');
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; dropmask.style.display = 'block'; });
  window.addEventListener('dragleave', function (e) { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropmask.style.display = 'none'; } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; dropmask.style.display = 'none';
    if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  document.getElementById('btn-route').disabled = true;
  document.getElementById('btn-kml').disabled = true;
  document.getElementById('btn-gpx').disabled = true;

  /* e2e/调试钩子：与 UI 走同一条状态通路 */
  window.__ts = {
    state: state,
    loadTexts: function (nameTextPairs) {  // [{name, text}]
      nameTextPairs.forEach(function (p) {
        var tks = TC.parseAuto(p.text, p.name);
        tks.forEach(function (tk) {
          tk.color = COLORS[state.tracks.length % COLORS.length];
          state.tracks.push(tk); renderTrack(tk);
        });
      });
      afterTracksChanged(true);
    },
    addAnchorAt: function (lat, lon, name) { return addAnchor({ lat: lat, lng: lon }, name); },
    compute: computeRoute,
    kmlString: function () {
      var name = (document.getElementById('trackname').value || '').trim() || '拼接轨迹';
      return state.route ? TC.toKml(name, state.route.points, anchorPoints()) : null;
    },
    gpxString: function () {
      var name = (document.getElementById('trackname').value || '').trim() || '拼接轨迹';
      return state.route ? TC.toGpx(name, state.route.points, anchorPoints()) : null;
    }
  };
})();
