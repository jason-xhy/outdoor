#!/usr/bin/env python3
"""build.py — 把 leaflet + track-core + app 内联进 shell.html，产出单文件 track-splice.html
用法: python3 build.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))

def read(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f:
        return f.read()

def safe_js(js):
    # 防止内联 JS 中出现 </script> 提前终止脚本块
    return js.replace('</script', '<\\/script')

shell = read('src/shell.html')
shell = shell.replace('/*INLINE:LEAFLET_CSS*/', read('vendor/leaflet.css'))
shell = shell.replace('/*INLINE:LEAFLET_JS*/', safe_js(read('vendor/leaflet.js')))
shell = shell.replace('/*INLINE:CORE*/', safe_js(read('src/track-core.js')))
shell = shell.replace('/*INLINE:APP*/', safe_js(read('src/app.js')))

# 自检：占位符必须全部被替换
leftover = re.findall(r'/\*INLINE:[A-Z_]+\*/', shell)
assert not leftover, '未替换的占位符: %s' % leftover

out = os.path.join(ROOT, 'track-splice.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(shell)
print('built %s (%.1f KB)' % (out, os.path.getsize(out) / 1024))

# 构建自检：提取各 script 块做 node --check 语法校验
import subprocess, tempfile
blocks = re.findall(r'<script>([\s\S]*?)</script>', shell)
print('script blocks:', len(blocks))
for i, b in enumerate(blocks):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
        tf.write(b)
        path = tf.name
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    if r.returncode != 0:
        print('SYNTAX FAIL block%d:\n%s' % (i, r.stderr))
        sys.exit(1)
    print('block%d syntax OK' % i)

