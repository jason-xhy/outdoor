#!/usr/bin/env python3
"""用 Node 生成示例行程导出样本，再用 minidom 验 XML 良构性"""
import subprocess, sys, xml.dom.minidom, os

NODE_SCRIPT = r'''
const { createRequire } = require("module");
const { readFileSync, writeFileSync } = require("fs");
const TC = require("/Users/jason/ZCodeProject/track-splice/src/track-core.js");
const T1 = TC.parseKml(readFileSync("/Users/jason/ZCodeProject/track-splice/test/data/track1-xuxiake.kml","utf8"));
const T2 = TC.parseKml(readFileSync("/Users/jason/ZCodeProject/track-splice/test/data/track2-xianglufeng.kml","utf8"));
const g = TC.buildGraph(T1.concat(T2), 10);
const a1 = TC.nearestNode(g, T2[0].points[0]).idx;
let im=0; T2[0].points.forEach((p,i)=>{if(p.ele>T2[0].points[im].ele)im=i;});
const a2 = TC.nearestNode(g, T2[0].points[im]).idx;
let jm=0; T1[0].points.forEach((p,i)=>{if(p.ele>T1[0].points[jm].ele)jm=i;});
const a3 = TC.nearestNode(g, T1[0].points[jm]).idx;
const a4 = TC.nearestNode(g, T1[0].points[T1[0].points.length-1]).idx;
const r = TC.routeAnchors(g, [a1,a2,a1,a3,a4]);
const anchors = [a1,a2,a1,a3,a4].map((ni,i)=>({name:"锚点"+(i+1), ...g.nodes[ni]}));
writeFileSync("/tmp/route.gpx", TC.toGpx("武功山示例行程", r.points, anchors));
writeFileSync("/tmp/route.kml", TC.toKml("武功山示例行程", r.points, anchors));
console.log("导出样本: " + r.points.length + " 点, 总里程 " + (r.stats.distM/1000).toFixed(2) +
  "km, 爬升 " + r.stats.ascentM.toFixed(0) + "m, 下降 " + r.stats.descentM.toFixed(0) + "m");
'''
with open('/tmp/export_sample.js', 'w') as f:
    f.write(NODE_SCRIPT)
r = subprocess.run(['node', '/tmp/export_sample.js'], capture_output=True, text=True)
print(r.stdout.strip())
if r.returncode != 0:
    print(r.stderr); sys.exit(1)
for f in ['/tmp/route.gpx', '/tmp/route.kml']:
    xml.dom.minidom.parse(f)
    print('WELLFORMED', f)
