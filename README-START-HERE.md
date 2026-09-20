# Viralytics — Live SEO Dashboard

Aapke paas poora dashboard hai: **kisi bhi website ka naam likho → detail turant aa jayegi.**

## 3 kadam mein chalu karo

**Kadam 1 — Ye folder kahin bhi unpack karo** (jaise Desktop par).

**Kadam 2 — Do cheezein machine pe honi chahiye (ek baar, ₹0):**
- **Node.js** → https://nodejs.org (latest, "LTS" wala button) — installer chala do
- **Python** → Mac pe pehle se milta hai; Windows pe https://www.python.org (install karte time "Add to PATH" ka box tick zaroor karo)

**Kadam 3 — Terminal kholo, is folder mein jao, ek line chalao:**

```
node tools/go.js
```

Ek link dikhega — `http://localhost:8420` — usse browser mein kholo. Upar **🔎 Website daalo** button dabao, kisi bhi website ka naam likho (jaise `sharmaclinic.in`), **Dekho** dabao. 3 second mein detail aa jaayegi.

> Band karne ke liye terminal mein Ctrl+C. Bas.

## Folder mein kya-kya hai

| File | Kaam |
|---|---|
| `index.html` | Dashboard (domain box andar hi hai — seedha kholo toh bhi chalega, live detail ke liye kadam 3 ki line chahiye) |
| `USER-GUIDE.html` | **Booklet** — poori padho, Ctrl+P se PDF banao |
| `HOW-TO-USE-HINDI.md` | Wahi booklet, text mein |
| `sample-baremetrics-report.html` | Ek asli sample report — kholo, dekho client ko kya milegi |
| `tools/go.js` | Wo chhota local server jo naam-type-karke-detail dikhata hai |
| `tools/live.js` · `bake.py` · `report-md.js` · `smoke.js` | Crawler, report-banane wali cheezein (box ke andar hi chalti hain, aapko haath se nahi chalani) |
| `tools/gsc-token.js` · `ingest.js` | Baad mein, jab client aapko Google ka access de — asli numbers laane ke liye |

## Box mein kya-kya dikhta hai

- **Jaldi mode** (default): 12 pages, 3 second — site theek hai ya kaam hai, kitne toote/khaali pages hain
- **Keywords line**: comma se 2-3 keywords likho → site search mein kahan hai (sample check, Google ki ranking nahi)
- **Poori jaanch**: 180 pages, 3-4 minute → `live-<domain>.html` report file + action plan, dono download link milte hain — client ko bhej do

## Yaad rakho

- Ye sab **sirf padhta hai** — kisi site par likhta hi nahi, aur jo suggest karta hai wo client ki manzoori ke bina nahi jaata
- Koi account nahi, koi API key nahi, koi subscription nahi — **₹0**
- Google ke asli numbers (impressions/clicks) sirf site ke **malik** ke paas hote hain — 2 minute ka Search Console export, baaki main samajhaunga
