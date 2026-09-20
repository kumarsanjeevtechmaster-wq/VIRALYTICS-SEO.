#!/usr/bin/env python3
"""package.py — turns dist/ into downloadable artefacts.

  dist/viralytics-seo-dashboard.zip   the kit (app + READMEs + ingest tool)
  dist/download-dashboard.html        a page whose button hands that same zip back
                                      (the zip is embedded as base64 — for when a
                                      viewer offers no download for binary files)
  dist/dashboard.b64.txt              the zip as base64, for `base64 -d`
  dist/index.b64.txt                  just the app as base64

Order matters: the zip is written first, the saver page embeds it, and the page is
deliberately NOT inside the zip (a file cannot contain itself).
"""
import base64, io, pathlib, sys, zipfile

root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('dist')
contents = ['index.html', 'README.md', 'HOW-TO-DOWNLOAD.md', 'ingest.js', 'data/README.md']
present = [n for n in contents if (root / n).exists()]
missing = [n for n in contents if n not in present]
if not present:
    sys.exit(f'nothing to package in {root} — run ./build.sh first')

buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for n in present:
        z.write(root / n, n)
zipb = buf.getvalue()
(root / 'viralytics-seo-dashboard.zip').write_bytes(zipb)

PAGE = """<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Viralytics dashboard — zip saver</title>
<style>
body{font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0a0b0d;
     color:#e6e8ea;padding:42px 22px;max-width:760px;margin:auto}
h3{font-size:17px;margin:0 0 10px;letter-spacing:-.2px}
button{font:inherit;background:#b7f24a;color:#0a0b0d;border:0;border-radius:9px;
       padding:11px 18px;cursor:pointer;font-weight:700;margin:14px 0 4px}
button:hover{filter:brightness(1.06)}
p{margin:8px 0}code{background:#15181d;padding:2px 6px;border-radius:5px}
.small{opacity:.6;font-size:12px;margin-top:20px;border-top:1px solid #21262d;padding-top:14px}
.ok{color:#22c55e}.bad{color:#ef4444}
</style></head><body>
<h3>Viralytics SEO dashboard — zip saver</h3>
<p>Agar viewer ka download button zip nahi de raha, ye page kholein aur button dabayein —
browser wahi <b>viralytics-seo-dashboard.zip</b> save kar dega. Zip ka poora data isi file ke
andar base64 mein hai: koi network call, koi install, koi extra permission nahi.</p>
<button onclick="go()">Download viralytics-seo-dashboard.zip (%(kb)s KB)</button>
<span id=s></span>
<div class=small>
  <p>Andar kya hai: %(files)s</p>
  <p>Terminal route (kisi bhi machine pe): <code>base64 -d dashboard.b64.txt &gt; dash.zip &amp;&amp; unzip dash.zip</code></p>
  <p>Sirf app chahiye: <code>base64 -d index.b64.txt &gt; dashboard.html</code> — ye ek hi file hai, double-click chalega.</p>
</div>
<script>const B64="%(b64)s";
function go(){try{
  const bin=atob(B64),u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  const b=new Blob([u],{type:'application/zip'}),a=document.createElement('a');
  a.href=URL.createObjectURL(b);a.download='viralytics-seo-dashboard.zip';
  document.body.append(a);a.click();
  document.getElementById('s').innerHTML='<span class=ok>saved ✓</span>';
  setTimeout(function(){a.remove();URL.revokeObjectURL(a.href)},4000);
}catch(e){document.getElementById('s').innerHTML='<span class=bad>'+e.message+'</span>'}}</script>
</body></html>
"""
(root / 'download-dashboard.html').write_text(PAGE % {
    'b64': base64.b64encode(zipb).decode(),
    'kb': len(zipb) // 1024,
    'files': ', '.join(present),
})
(root / 'dashboard.b64.txt').write_text(base64.b64encode(zipb).decode())
(root / 'index.b64.txt').write_text(base64.b64encode((root / 'index.html').read_bytes()).decode())

print('zip      %s (%d KB) ← %s' % (root / 'viralytics-seo-dashboard.zip', len(zipb) // 1024, ', '.join(present)))
if missing:
    print('skipped (not in dist/):', ', '.join(missing))
print('saver    %s' % (root / 'download-dashboard.html'))
print('base64   dashboard.b64.txt · index.b64.txt')
