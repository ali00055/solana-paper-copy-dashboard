// Katalog üretici: node build.mjs  ->  katalog.pdf, kaynak-listesi.pdf
// Veri: models.json (fetch.py ile MakerWorld'den çekilir), names.json (Türkçe ürün adları)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BRAND = process.env.BRAND || 'MARKA ADINIZ';
const YEAR = '2026';
const names = JSON.parse(readFileSync('names.json', 'utf8'));
const models = JSON.parse(readFileSync('models.json', 'utf8')).filter(m => names[m.id] && m.img);

const CATS = [
  ['isimli', 'İsimli Anahtarlıklar', 'AN', '#ff6b4a', 'Kişiye özel isim ve yazılı, tek ya da çok renkli anahtarlıklar.'],
  ['flexi', 'Esnek Hayvan Anahtarlıkları', 'FL', '#7b5cff', 'Kıvrılan, oynayan, eklemli sevimli hayvanlar — tek parça.'],
  ['zipzip', 'Zıplaçlar & Pop Oyuncaklar', 'ZP', '#f6a623', 'Bastır, bırak, zıplasın! Masa üstünün en eğlenceli oyuncakları.'],
  ['klik', 'Klik Anahtarlıklar', 'KL', '#e0457b', 'Tık sesiyle stres atan, cepte taşınan klik fidget\'lar.'],
  ['spinner', 'Spinner\'lar', 'SP', '#2a9d8f', 'Jiroskop halkalı, dişli ve rulmanlı dakikalarca dönen spinner\'lar.'],
  ['ball', 'Spinner Ball & Twist Toplar', 'SB', '#3a86ff', 'Elde dönen, burulan, küre içinde küre fidget toplar.'],
  ['kup', 'Sonsuzluk Küpleri', 'SK', '#8e44ad', 'Sonsuza kadar katlanıp açılan küpler ve anahtarlık versiyonları.'],
  ['cakmak', 'Çakmak Kılıfları', 'CK', '#c0392b', 'Ejderha, yılan, kurukafa, uzaylı gibi figürlü; gül, petek ve isimli desenli; anahtarlıklı çakmak kılıfları.'],
];

const fmtK = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + 'B' : String(n);
let pageNo = 1;
const footer = () => `<div class="pf"><span>${BRAND} · Katalog ${YEAR}</span><span>${++pageNo}</span></div>`;

const card = (m, code, color) => `
  <div class="card">
    <div class="ph"><img src="${m.img}">${m.downloads >= 10000 ? `<span class="hot" style="background:${color}">POPÜLER</span>` : ''}</div>
    <div class="meta"><span class="code" style="color:${color}">${code}</span><h3>${names[m.id]}</h3></div>
  </div>`;

const pages = [];
// kapak: en popüler 9 ürünün görselinden kolaj
const top = [...models].sort((a, b) => b.downloads - a.downloads).slice(0, 9);
pages.push(`<section class="page cover">
  <div class="collage">${top.map(m => `<img src="${m.img}">`).join('')}</div>
  <div class="shade"></div>
  <div class="brand">${BRAND}</div><div class="yr">KATALOG ${YEAR}</div>
  <div class="inner">
    <h1>Fidget &amp; Hediyelik<br><em>Ürün Kataloğu</em></h1>
    <p>Anahtarlıklar · Zıplaçlar · Spinner'lar · Spinner Ball · Sonsuzluk Küpleri · Çakmak Kılıfları</p>
    <div class="count"><b>${models.length}</b> model &nbsp;·&nbsp; <b>${CATS.length}</b> kategori &nbsp;·&nbsp; istediğiniz renkte</div>
  </div>
</section>`);

// içindekiler
const plan = [];
let p = 3;
for (const [id, title, , color] of CATS) {
  const n = models.filter(m => m.cat === id).length;
  plan.push([title, color, n, p]);
  p += Math.ceil(n / 12);
}
pages.push(`<section class="page">
  <div class="kicker" style="color:#ff6b4a">İçindekiler</div>
  <h2 style="margin:2mm 0 8mm">Koleksiyon</h2>
  <div class="toc">${plan.map(([t, c, n, pg]) => `<div><span class="dot" style="background:${c}"></span>${t}<span class="n">${n} model · s. ${pg}</span></div>`).join('')}</div>
  <div class="note">Tüm ürünler 3D baskı ile üretilir ve istediğiniz renkte hazırlanabilir. Görseller örnek modellere aittir; sipariş öncesi numune gösterilir.</div>
  ${footer()}
</section>`);

for (const [id, title, prefix, color, intro] of CATS) {
  const items = models.filter(m => m.cat === id).sort((a, b) => b.downloads - a.downloads);
  const coded = items.map((m, i) => [m, `${prefix}-${String(i + 1).padStart(2, '0')}`]);
  const per = Math.ceil(coded.length / Math.ceil(coded.length / 12)); // sayfalara dengeli dağıt
  const chunks = [];
  for (let i = 0; i < coded.length; i += per) chunks.push(coded.slice(i, i + per));
  chunks.forEach((ch, k) => pages.push(`<section class="page">
    ${k === 0
      ? `<div class="head" style="--c:${color}"><div><div class="kicker" style="color:${color}">Kategori</div><h2>${title}</h2><p class="lead">${intro}</p></div><div class="num" style="color:${color}">${items.length}<small>model</small></div></div>`
      : `<div class="subhead" style="color:${color}">${title} <span>— devam</span></div>`}
    <div class="grid">${ch.map(([m, c]) => card(m, c, color)).join('')}</div>
    ${footer()}
  </section>`));
}

pages.push(`<section class="page back">
  <div style="position:absolute;left:18mm;right:18mm;top:80mm">
    <div class="kicker" style="color:#fff;opacity:.8">İletişim</div>
    <h2 style="margin-top:3mm;font-size:34pt;line-height:1.1">Numune ve toplu sipariş<br>için bize yazın.</h2>
    <div class="ct"><b>Telefon / WhatsApp</b>+90 ___ ___ __ __<br><b>Instagram</b>@__________<br><b>E-posta</b>__________@______</div>
  </div>
  <div style="position:absolute;bottom:18mm;left:18mm;font-weight:700;letter-spacing:3px">${BRAND}</div>
</section>`);

const css = `
@page { size: A4; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: 'DejaVu Sans', sans-serif; color: #1f2a44; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.page { width: 210mm; height: 297mm; position: relative; overflow: hidden; page-break-after: always; padding: 14mm 13mm 16mm; background: #fbf8f3 }
.pf { position: absolute; bottom: 7mm; left: 13mm; right: 13mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #8a8f99; border-top: 1px solid #e6e1d8; padding-top: 2.5mm }
.cover { padding: 0; background: #111 }
.collage { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr) }
.collage img { width: 100%; height: 100%; object-fit: cover }
.shade { position: absolute; inset: 0; background: linear-gradient(180deg, #11182788 0%, #11182722 35%, #111827ee 70%, #111827 100%) }
.cover .brand { position: absolute; top: 16mm; left: 16mm; color: #fff; font-size: 13pt; letter-spacing: 3px; font-weight: 700 }
.cover .yr { position: absolute; top: 16mm; right: 16mm; color: #fff; font-size: 11pt; opacity: .85 }
.cover .inner { position: absolute; left: 16mm; right: 16mm; bottom: 22mm; color: #fff }
.cover h1 { font-size: 44pt; line-height: 1.05; letter-spacing: -1px } .cover h1 em { font-style: normal; color: #f6c343 }
.cover p { font-size: 12pt; margin-top: 5mm; opacity: .9 }
.cover .count { margin-top: 6mm; display: inline-block; background: #ff6b4a; padding: 2.5mm 5mm; border-radius: 30px; font-size: 10.5pt }
h2 { font-size: 24pt; letter-spacing: -.5px }
.kicker { font-size: 8.5pt; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase }
.lead { font-size: 10pt; line-height: 1.5; color: #4a5468; margin-top: 2mm }
.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid var(--c); padding-bottom: 3mm; margin-bottom: 5mm }
.head .num { font-size: 34pt; font-weight: 700; line-height: 1; text-align: right } .head .num small { display: block; font-size: 8pt; letter-spacing: 2px; text-transform: uppercase }
.subhead { font-size: 13pt; font-weight: 700; margin-bottom: 5mm } .subhead span { color: #8a8f99; font-weight: 400 }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4.5mm }
.card { background: #fff; border-radius: 3.5mm; overflow: hidden; box-shadow: 0 1px 0 #e6e1d8, 0 4px 12px #1f2a440d; break-inside: avoid }
.ph { position: relative; aspect-ratio: 16 / 10; background: #eee }
.ph img { width: 100%; height: 100%; object-fit: cover; display: block }
.hot { position: absolute; top: 2mm; left: 2mm; color: #fff; font-size: 6.5pt; font-weight: 700; letter-spacing: 1px; padding: 1mm 2.2mm; border-radius: 1.5mm }
.meta { padding: 2.6mm 3mm 3.2mm }
.code { font-size: 7.5pt; font-weight: 700; letter-spacing: 1.5px }
.card h3 { font-size: 9.5pt; margin-top: .8mm; line-height: 1.25; height: 2.5em; overflow: hidden }
.toc div { display: flex; align-items: center; gap: 4mm; padding: 4.6mm 0; border-bottom: 1px solid #e6e1d8; font-size: 13pt; font-weight: 700 }
.toc .dot { width: 4mm; height: 4mm; border-radius: 50% } .toc .n { margin-left: auto; color: #8a8f99; font-weight: 400; font-size: 10pt }
.note { margin-top: 12mm; background: #fff; border-radius: 4mm; padding: 6mm; font-size: 10pt; line-height: 1.55; color: #4a5468 }
.back { background: #ff6b4a; color: #fff }
.back .ct { margin-top: 12mm; font-size: 13pt; line-height: 2.1 } .back .ct b { display: inline-block; width: 62mm; opacity: .8; font-weight: 400 }
`;
writeFileSync('katalog.html', `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${BRAND} Katalog ${YEAR}</title><style>${css}</style></head><body>${pages.join('')}</body></html>`);

// ---------- İç kullanım: kaynak & lisans listesi ----------
const codeOf = {};
for (const [id, , prefix] of CATS)
  models.filter(m => m.cat === id).sort((a, b) => b.downloads - a.downloads).forEach((m, i) => { codeOf[m.id] = `${prefix}-${String(i + 1).padStart(2, '0')}`; });
const lic = l => /Standard/.test(l) ? '<span class="no">Standart – satış yok</span>' : /NC/.test(l) ? `<span class="no">${l} – ticari yok</span>` : /^BY/.test(l) ? `<span class="ok">${l} – ticari OK (atıf)</span>` : l;
const rows = CATS.flatMap(([id]) => models.filter(m => m.cat === id).sort((a, b) => b.downloads - a.downloads))
  .map(m => `<tr><td><b>${codeOf[m.id]}</b></td><td>${names[m.id]}<br><small>${m.title} — ${m.designer}</small></td><td class="r">${fmtK(m.downloads)}</td><td>${lic(m.license || '')}</td><td><a href="${m.url}">${m.url.replace('https://', '')}</a></td></tr>`).join('');
writeFileSync('kaynak-listesi.html', `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Kaynak Listesi</title><style>
@page{size:A4;margin:12mm} body{font-family:'DejaVu Sans',sans-serif;color:#1f2a44;font-size:7.8pt}
h1{font-size:16pt;margin-bottom:2mm} .warn{background:#fff3cd;border-left:4px solid #f6c343;padding:3.5mm;margin:4mm 0;line-height:1.5;font-size:8.5pt}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:1.6mm;border-bottom:1px solid #ddd;vertical-align:top} th{border-bottom:2px solid #1f2a44}
small{color:#777} a{color:#2563eb} .r{text-align:right} .no{color:#b42318} .ok{color:#067647;font-weight:700} tr{break-inside:avoid}
</style></head><body>
<h1>Kaynak Model Listesi — İÇ KULLANIM (müşteriye verilmez)</h1>
<p>Katalogdaki ${models.length} ürünün MakerWorld kaynağı, tasarımcısı, indirme sayısı ve lisansı (MakerWorld API, ${YEAR} Ekim).</p>
<div class="warn"><b>Önemli:</b> "Standart" (Standard Digital File License) ve "NC" lisanslı modellerin baskısı <b>satılamaz</b>; satış için tasarımcının MakerWorld Commercial License üyeliği gerekir. Yalnızca CC BY / BY-SA / BY-ND lisanslılar atıf vererek ticari kullanılabilir. Katalogdaki görseller tasarımcılara aittir; katalog sadece gösterim amaçlıdır.</div>
<table><thead><tr><th>Kod</th><th>Ürün / Orijinal ad — Tasarımcı</th><th class="r">İndirme</th><th>Lisans</th><th>Link</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const f of ['katalog', 'kaynak-listesi']) {
  await page.goto('file://' + process.cwd() + `/${f}.html`, { waitUntil: 'load' });
  await page.pdf({ path: `${f}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
}
await browser.close();
console.log('ok', models.length);
