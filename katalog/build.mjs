// Katalog üretici: node build.mjs  ->  katalog.html, katalog.pdf, kaynak-listesi.pdf
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BRAND = process.env.BRAND || 'MARKA ADINIZ';
const TAGLINE = '3D Baskı Hediyelik & Fidget Koleksiyonu';
const YEAR = '2026';

// ---------- Vektör çizimler (ürün fotoğrafı yerine yer tutucu) ----------
const ill = {
  nameTag: (c1, c2) => `
  <svg viewBox="0 0 220 160"><g transform="rotate(-8 110 80)">
    <circle cx="40" cy="80" r="18" fill="none" stroke="#9aa3ad" stroke-width="6"/>
    <rect x="50" y="52" width="150" height="56" rx="28" fill="${c1}"/>
    <rect x="58" y="60" width="134" height="40" rx="20" fill="${c2}"/>
    <circle cx="70" cy="80" r="7" fill="#fff"/>
    <text x="135" y="91" font-family="DejaVu Sans" font-weight="700" font-size="28" fill="#fff" text-anchor="middle">ELİF</text>
  </g></svg>`,
  dragon: (c1, c2) => {
    let seg = '';
    for (let i = 0; i < 9; i++) {
      const x = 150 - i * 13, y = 85 + Math.sin(i / 1.6) * 18, r = 15 - i * 1.1;
      seg += `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.8}" fill="${i % 2 ? c1 : c2}" stroke="#0002" stroke-width="1.5"/>`;
    }
    return `<svg viewBox="0 0 220 160">
      <path d="M140 70 L120 30 L150 55 Z M150 66 L175 28 L168 62 Z" fill="${c2}" opacity=".85"/>
      ${seg}
      <ellipse cx="172" cy="72" rx="24" ry="17" fill="${c1}" stroke="#0002" stroke-width="1.5"/>
      <path d="M160 58 l-6 -14 l12 10 Z M176 56 l2 -15 l6 13 Z" fill="${c2}"/>
      <circle cx="180" cy="68" r="4.5" fill="#fff"/><circle cx="181" cy="68" r="2.2" fill="#222"/>
      <circle cx="32" cy="120" r="10" fill="none" stroke="#9aa3ad" stroke-width="4"/>
    </svg>`;
  },
  pentaJump: (c1, c2) => {
    const pts = r => [0, 1, 2, 3, 4].map(k => {
      const a = -Math.PI / 2 + k * 2 * Math.PI / 5;
      return `${110 + r * Math.cos(a)},${86 + r * Math.sin(a)}`;
    }).join(' ');
    return `<svg viewBox="0 0 220 160">
      <path d="M60 30 q10 -18 20 0 M140 22 q10 -18 20 0" stroke="#bbb" stroke-width="3" fill="none"/>
      <polygon points="${pts(64)}" fill="${c1}"/>
      <polygon points="${pts(48)}" fill="${c2}"/>
      <polygon points="${pts(30)}" fill="${c1}"/>
      <circle cx="110" cy="86" r="10" fill="#fff" opacity=".9"/>
      <path d="M40 145 h140" stroke="#0001" stroke-width="8" stroke-linecap="round"/>
    </svg>`;
  },
  keycap: (c1, c2) => `
  <svg viewBox="0 0 220 160">
    <rect x="50" y="98" width="120" height="34" rx="8" fill="#444"/>
    <path d="M58 100 L72 40 H148 L162 100 Z" fill="${c1}"/>
    <path d="M78 46 H142 L150 88 H70 Z" fill="${c2}"/>
    <text x="110" y="76" font-family="DejaVu Sans" font-weight="700" font-size="20" fill="#fff" text-anchor="middle">CLICK</text>
    <circle cx="185" cy="115" r="10" fill="none" stroke="#9aa3ad" stroke-width="4"/>
  </svg>`,
  gyro: (c1, c2) => {
    const cols = [c1, c2, c1, c2, '#ffffff'];
    let rings = '';
    [62, 50, 38, 26, 14].forEach((r, i) => {
      rings += `<circle cx="110" cy="80" r="${r}" fill="${cols[i]}" stroke="#0003" stroke-width="2"/>`;
    });
    return `<svg viewBox="0 0 220 160">${rings}
      <path d="M30 40 a80 80 0 0 1 40 -25 M190 120 a80 80 0 0 1 -40 25" stroke="#bbb" stroke-width="3" fill="none"/>
    </svg>`;
  },
  sphere: (c1, c2) => `
  <svg viewBox="0 0 220 160"><defs>
    <radialGradient id="g${c1.slice(1)}" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
    <circle cx="110" cy="80" r="64" fill="${c1}"/>
    <ellipse cx="110" cy="80" rx="64" ry="20" fill="none" stroke="#0003" stroke-width="3"/>
    <ellipse cx="110" cy="80" rx="22" ry="64" fill="none" stroke="#0003" stroke-width="3"/>
    <circle cx="86" cy="58" r="16" fill="${c2}"/><circle cx="136" cy="104" r="16" fill="${c2}"/>
    <circle cx="136" cy="56" r="11" fill="${c2}"/><circle cx="84" cy="106" r="11" fill="${c2}"/>
    <circle cx="110" cy="80" r="64" fill="url(#g${c1.slice(1)})"/>
  </svg>`,
  cube: (c1, c2) => {
    const iso = (x, y, z, s, col) => {
      const px = (a, b, c) => [110 + (a - b) * 0.87 * s, 70 + (a + b) * 0.5 * s - c * s];
      const p = (a, b, c) => px(a, b, c).join(',');
      return `<polygon points="${p(x, y, z + 1)} ${p(x + 1, y, z + 1)} ${p(x + 1, y + 1, z + 1)} ${p(x, y + 1, z + 1)}" fill="${col}"/>
        <polygon points="${p(x, y + 1, z)} ${p(x + 1, y + 1, z)} ${p(x + 1, y + 1, z + 1)} ${p(x, y + 1, z + 1)}" fill="${col}" style="filter:brightness(.8)"/>
        <polygon points="${p(x + 1, y, z)} ${p(x + 1, y + 1, z)} ${p(x + 1, y + 1, z + 1)} ${p(x + 1, y, z + 1)}" fill="${col}" style="filter:brightness(.65)"/>`;
    };
    let s = '';
    const cubes = [[-1, -1, 0, c1], [0, -1, 0, c2], [-1, 0, 0, c2], [0, 0, 0, c1], [-1, -1, 1, c2], [0, -1, 1, c1], [-1, 0, 1, c1], [0, 0, 1, c2]];
    cubes.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2])).forEach(([x, y, z, col]) => { s += iso(x, y, z, 30, col); });
    return `<svg viewBox="0 0 220 160">${s}</svg>`;
  },
  lighter: (c1, c2, motif = 'rose') => `
  <svg viewBox="0 0 220 160">
    <rect x="86" y="10" width="48" height="26" rx="5" fill="#c8ccd1"/>
    <rect x="96" y="4" width="28" height="12" rx="3" fill="#888"/>
    <rect x="76" y="30" width="68" height="124" rx="16" fill="${c1}"/>
    ${motif === 'rose'
      ? `<g transform="translate(110 92)"><circle r="20" fill="${c2}"/><path d="M-10 -4 q10 -14 20 0 q-10 14 -20 0 M-14 6 q14 10 28 0" stroke="#0004" stroke-width="2.5" fill="none"/>
         <path d="M0 20 v26 M0 34 q-12 -6 -16 4 M0 30 q12 -6 16 4" stroke="#2f8f5b" stroke-width="3.5" fill="none"/></g>`
      : `<g fill="${c2}">${Array.from({ length: 6 }, (_, r) => Array.from({ length: 3 }, (_, c) => `<rect x="${86 + c * 18}" y="${46 + r * 17}" width="12" height="10" rx="2"/>`).join('')).join('')}</g>`}
  </svg>`,
};

// ---------- Ürün verisi ----------
const categories = [
  {
    id: 'anahtarlik', title: 'Anahtarlıklar', color: '#ff6b4a',
    intro: 'En çok satan hediyelik ürün. Kişiye özel isim, logo veya yazı ile her siparişe özel üretilir.',
    items: [
      { code: 'AN-01', name: 'İsimli Anahtarlık', art: ill.nameTag('#1f2a44', '#ff6b4a'),
        desc: 'Çift renkli, istediğiniz isim veya kısa yazı ile kişiselleştirilir. Okul çantası, araba anahtarı, düğün/nişan hediyeliği için ideal.',
        specs: [['Boyut', '~ 60 × 20 × 4 mm'], ['Malzeme', 'PLA (çift renk)'], ['Kişiselleştirme', 'İsim / yazı / tarih'], ['Toplu sipariş', 'Etkinlik & kurumsal']],
        colors: ['#1f2a44', '#ff6b4a', '#ffffff', '#f6c343', '#3aa6a0', '#d94f8a'], tag: 'ÇOK SATAN' },
      { code: 'AN-02', name: 'Esnek Ejderha Anahtarlık', art: ill.dragon('#7b5cff', '#3dd6c4'),
        desc: 'Eklemli gövde tek parça basılır, montaj gerektirmez. Kıvrılır, oynar; çocukların ve gençlerin favorisi.',
        specs: [['Boyut', '~ 80 – 120 mm'], ['Malzeme', 'PLA / Silk PLA'], ['Özellik', 'Tek parça, hareketli'], ['Seçenek', 'Mini / Standart']],
        colors: ['#7b5cff', '#3dd6c4', '#ff6b4a', '#f6c343', '#2b2b2b', 'linear-gradient(90deg,#ff6b4a,#f6c343,#3dd6c4,#7b5cff)'], tag: 'TREND' },
    ],
  },
  {
    id: 'zipzip', title: 'Zıplaç & Klik Oyuncaklar', color: '#f6c343',
    intro: 'Bastır, bırak, zıplasın! Sosyal medyada en çok paylaşılan "tatmin edici" fidget ürünleri.',
    items: [
      { code: 'ZP-01', name: 'Zıplaç (Penta Jump)', art: ill.pentaJump('#ff6b4a', '#f6c343'),
        desc: 'Düz bastırılıp bırakıldığında havaya zıplar. Lastik gerdirmeli mekanizma; lastik sayısıyla zıplama gücü ayarlanır.',
        specs: [['Boyut', '~ 60 mm'], ['Malzeme', 'PLA + lastik'], ['Mekanizma', 'Lastik gerdirmeli'], ['Yaş', '6+']],
        colors: ['#ff6b4a', '#f6c343', '#3aa6a0', '#7b5cff', '#1f2a44'], tag: 'YENİ' },
      { code: 'ZP-02', name: 'Klik Tuş Anahtarlık', art: ill.keycap('#1f2a44', '#ff6b4a'),
        desc: 'Mekanik klavye tuşu hissi veren tıklama sesi. Anahtarlık halkasıyla cepte taşınır; stres atmak için birebir.',
        specs: [['Boyut', '~ 30 × 30 × 25 mm'], ['Malzeme', 'PLA + mekanik switch'], ['Ses', 'Net tık sesi'], ['Kişiselleştirme', 'Tuş üzerine harf']],
        colors: ['#1f2a44', '#ff6b4a', '#ffffff', '#3aa6a0', '#d94f8a'] },
    ],
  },
  {
    id: 'spinner', title: 'Spinner & Spinner Ball', color: '#3aa6a0',
    intro: 'Parmak ucunda dakikalarca dönen jiroskopik halkalar ve küre içinde küre tasarımlar.',
    items: [
      { code: 'SP-01', name: 'Jiroskop Spinner', art: ill.gyro('#3aa6a0', '#1f2a44'),
        desc: 'İç içe geçmiş halkalar birbirinden bağımsız döner. Tek parça basılır, rulman veya montaj gerekmez.',
        specs: [['Çap', '~ 46 – 60 mm'], ['Malzeme', 'PLA / Silk PLA'], ['Halka sayısı', '4 – 5'], ['Özellik', 'Tek parça, montajsız']],
        colors: ['#3aa6a0', '#1f2a44', '#f6c343', '#ff6b4a', 'linear-gradient(90deg,#c0c0c0,#f6c343)'], tag: 'ÇOK SATAN' },
      { code: 'SP-02', name: 'Spinner Ball (Küre içinde Küre)', art: ill.sphere('#1f2a44', '#3dd6c4'),
        desc: 'Pencereli dış kürenin içinde serbestçe dönen ikinci bir küre. Masa üstü süs ve fidget olarak iki işlevli.',
        specs: [['Çap', '~ 40 – 50 mm'], ['Malzeme', 'PLA'], ['Hareket', 'Serbest dönüş'], ['Seçenek', 'Anahtarlık halkalı']],
        colors: ['#1f2a44', '#3dd6c4', '#7b5cff', '#ff6b4a', '#ffffff'] },
    ],
  },
  {
    id: 'kup', title: 'Sonsuzluk Küpü', color: '#7b5cff',
    intro: 'Sonsuza kadar katlanıp açılan 8 küp. Ofis masalarının ve öğrencilerin vazgeçilmezi.',
    items: [
      { code: 'KP-01', name: 'Sonsuzluk Küpü – Standart', art: ill.cube('#7b5cff', '#f6c343'),
        desc: 'Tek parça basılan menteşeli tasarım; yapıştırma veya montaj yok. Pürüzsüz, sessiz hareket.',
        specs: [['Boyut', '~ 40 × 40 × 40 mm'], ['Malzeme', 'PLA'], ['Ağırlık', '~ 30 g'], ['Özellik', 'Tek parça, montajsız']],
        colors: ['#7b5cff', '#f6c343', '#1f2a44', '#ff6b4a', '#3aa6a0'], tag: 'ÇOK SATAN' },
      { code: 'KP-02', name: 'Mini Sonsuzluk Küpü Anahtarlık', art: ill.cube('#ff6b4a', '#1f2a44'),
        desc: 'Cebe ve anahtarlığa sığan mini versiyon. İsterseniz koruyucu kılıflı anahtarlık olarak hazırlanır.',
        specs: [['Boyut', '~ 25 × 25 × 25 mm'], ['Malzeme', 'PLA'], ['Ağırlık', '~ 10 g'], ['Seçenek', 'Kılıflı / kılıfsız']],
        colors: ['#ff6b4a', '#1f2a44', '#3aa6a0', '#d94f8a', '#ffffff'] },
    ],
  },
  {
    id: 'cakmak', title: 'Çakmak Kılıfları', color: '#d94f8a',
    intro: 'Standart ve mini boy çakmaklara birebir oturan, korumalı ve şık kılıflar.',
    items: [
      { code: 'CK-01', name: 'Desenli Çakmak Kılıfı', art: ill.lighter('#1f2a44', '#d94f8a', 'rose'),
        desc: 'Gül, geometrik ya da isim motifli kılıf. Çakmağı korur, kaymayı önler, kaybolmasını zorlaştırır.',
        specs: [['Uyum', 'Standart boy çakmak'], ['Malzeme', 'PLA / PETG'], ['Motif', 'Gül / geometrik / isim'], ['Baskı', 'Tek veya çift renk']],
        colors: ['#1f2a44', '#d94f8a', '#ffffff', '#f6c343', '#2b2b2b'], tag: 'ÇOK SATAN' },
      { code: 'CK-02', name: 'Kapaklı / Su Geçirmez Kılıf', art: ill.lighter('#3a4a3a', '#6b7f5a', 'grip'),
        desc: 'Kapaklı, sıkı geçmeli kutu tipi kılıf. Kamp, outdoor ve araç içi kullanım için dayanıklı tasarım.',
        specs: [['Uyum', 'Mini / standart boy'], ['Malzeme', 'PETG'], ['Kapak', 'Geçmeli, contalı'], ['Yüzey', 'Kaymaz doku']],
        colors: ['#3a4a3a', '#6b7f5a', '#2b2b2b', '#c2a878', '#ff6b4a'] },
    ],
  },
];

// ---------- HTML ----------
const swatch = c => `<span class="sw" style="background:${c}"></span>`;
const card = (it, accent) => `
  <div class="card">
    <div class="art" style="--a:${accent}">${it.tag ? `<span class="tag">${it.tag}</span>` : ''}${it.art}
      <span class="ph">Görsel temsilidir – gerçek ürün fotoğrafı eklenecek</span></div>
    <div class="body">
      <div class="code">${it.code}</div>
      <h3>${it.name}</h3>
      <p>${it.desc}</p>
      <table>${it.specs.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <div class="foot">
        <div><small>Renk seçenekleri</small><div>${it.colors.map(swatch).join('')}</div></div>
        <div class="price"><small>Fiyat</small><b>₺ ______</b></div>
      </div>
    </div>
  </div>`;

let pageNo = 1;
const footer = () => `<div class="pf"><span>${BRAND} · ${TAGLINE}</span><span>${++pageNo}</span></div>`;

const css = `
@page { size: A4; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: 'DejaVu Sans', sans-serif; color: #1f2a44; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.page { width: 210mm; height: 297mm; position: relative; overflow: hidden; page-break-after: always; padding: 16mm 15mm 18mm; background: #fbf8f3 }
.pf { position: absolute; bottom: 8mm; left: 15mm; right: 15mm; display: flex; justify-content: space-between; font-size: 8pt; color: #8a8f99; border-top: 1px solid #e6e1d8; padding-top: 3mm }
/* kapak */
.cover { background: #1f2a44; color: #fff; padding: 0 }
.cover .blob { position: absolute; border-radius: 50% }
.cover .inner { position: absolute; left: 18mm; right: 18mm; bottom: 30mm }
.cover .brand { position: absolute; top: 18mm; left: 18mm; font-size: 13pt; letter-spacing: 3px; font-weight: 700 }
.cover .yr { position: absolute; top: 18mm; right: 18mm; font-size: 11pt; opacity: .7 }
.cover h1 { font-size: 46pt; line-height: 1.02; letter-spacing: -1px }
.cover h1 em { font-style: normal; color: #f6c343 }
.cover p { font-size: 13pt; opacity: .85; margin-top: 6mm; max-width: 140mm; line-height: 1.5 }
.cover .chips { margin-top: 8mm; display: flex; gap: 3mm; flex-wrap: wrap }
.cover .chips span { border: 1.5px solid #ffffff55; border-radius: 30px; padding: 2mm 5mm; font-size: 10pt }
.cover .arts { position: absolute; top: 40mm; left: 0; right: 0; height: 130mm }
.cover .arts svg { position: absolute; width: 70mm }
/* iç sayfa */
h2 { font-size: 26pt; letter-spacing: -.5px }
.kicker { font-size: 9pt; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase }
.lead { font-size: 11pt; line-height: 1.55; color: #4a5468; margin: 3mm 0 7mm; max-width: 165mm }
.bar { width: 18mm; height: 2.2mm; border-radius: 2mm; margin-bottom: 4mm }
.card { display: flex; gap: 7mm; background: #fff; border-radius: 5mm; padding: 6mm; margin-bottom: 6mm; box-shadow: 0 1px 0 #e6e1d8, 0 6px 18px #1f2a440d }
.art { flex: 0 0 72mm; height: 92mm; border-radius: 4mm; background: color-mix(in srgb, var(--a) 14%, #fff); position: relative; display: flex; align-items: center; justify-content: center }
.art svg { width: 64mm; height: 50mm }
.art .ph { position: absolute; bottom: 3mm; left: 3mm; right: 3mm; text-align: center; font-size: 6.5pt; color: #8a8f99 }
.tag { position: absolute; top: 3mm; left: 3mm; background: #1f2a44; color: #fff; font-size: 7pt; font-weight: 700; letter-spacing: 1px; padding: 1.2mm 2.5mm; border-radius: 2mm }
.body { flex: 1; display: flex; flex-direction: column }
.code { font-size: 8pt; color: #8a8f99; font-weight: 700; letter-spacing: 1.5px }
h3 { font-size: 16pt; margin: 1mm 0 2.5mm }
.body p { font-size: 9.5pt; line-height: 1.5; color: #4a5468 }
table { width: 100%; border-collapse: collapse; margin: 4mm 0; font-size: 8.8pt }
th { text-align: left; color: #8a8f99; font-weight: 400; width: 38%; padding: 1.4mm 0; border-bottom: 1px solid #f0ebe3 }
td { font-weight: 700; padding: 1.4mm 0; border-bottom: 1px solid #f0ebe3 }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end }
.foot small { display: block; font-size: 7.5pt; color: #8a8f99; margin-bottom: 1.5mm }
.sw { display: inline-block; width: 5mm; height: 5mm; border-radius: 50%; margin-right: 1.3mm; border: 1px solid #0002 }
.price { text-align: right } .price b { font-size: 13pt }
/* içindekiler / bilgi */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm }
.tile { background: #fff; border-radius: 4mm; padding: 6mm; box-shadow: 0 1px 0 #e6e1d8 }
.tile h4 { font-size: 12pt; margin-bottom: 2mm } .tile p { font-size: 9.5pt; line-height: 1.5; color: #4a5468 }
.toc a { display: flex; align-items: center; gap: 4mm; padding: 4.2mm 0; border-bottom: 1px solid #e6e1d8; color: inherit; text-decoration: none; font-size: 13pt; font-weight: 700 }
.toc .dot { width: 4mm; height: 4mm; border-radius: 50% } .toc .n { margin-left: auto; color: #8a8f99; font-weight: 400; font-size: 10pt }
.pl { width: 100%; font-size: 9.5pt; margin-top: 4mm }
.pl th, .pl td { padding: 2.6mm 2mm; border-bottom: 1px solid #e6e1d8 } .pl thead th { color: #1f2a44; font-weight: 700; border-bottom: 2px solid #1f2a44 }
.pl td.r, .pl th.r { text-align: right; width: 26mm; white-space: nowrap } .pl td:first-child { width: 18mm; white-space: nowrap }
.steps { counter-reset: s; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-top: 5mm }
.steps div { background: #fff; border-radius: 4mm; padding: 5mm; font-size: 9pt; line-height: 1.45; color: #4a5468 }
.steps div::before { counter-increment: s; content: counter(s); display: block; font-size: 20pt; font-weight: 700; color: #ff6b4a; margin-bottom: 1mm }
.steps b { color: #1f2a44; display: block; margin-bottom: 1mm }
.back { background: #ff6b4a; color: #fff }
.back h2 { font-size: 34pt; line-height: 1.1 } .back .ct { margin-top: 12mm; font-size: 13pt; line-height: 2.1 }
.back .ct b { display: inline-block; width: 62mm; opacity: .8; font-weight: 400 }
`;

const coverArts = [
  [ill.cube('#7b5cff', '#f6c343'), 'left:8mm;top:0;transform:rotate(-8deg)'],
  [ill.gyro('#3aa6a0', '#f6c343'), 'right:10mm;top:6mm'],
  [ill.dragon('#ff6b4a', '#f6c343'), 'left:62mm;top:46mm;width:86mm'],
  [ill.pentaJump('#d94f8a', '#f6c343'), 'left:4mm;top:78mm;transform:rotate(10deg)'],
  [ill.lighter('#3aa6a0', '#f6c343', 'rose'), 'right:4mm;top:70mm;width:56mm;transform:rotate(12deg)'],
];

let pages = [];
pages.push(`<section class="page cover">
  <div class="blob" style="width:160mm;height:160mm;background:#ff6b4a;opacity:.18;right:-50mm;top:-40mm"></div>
  <div class="blob" style="width:120mm;height:120mm;background:#3aa6a0;opacity:.18;left:-40mm;top:110mm"></div>
  <div class="brand">${BRAND}</div><div class="yr">KATALOG ${YEAR}</div>
  <div class="arts">${coverArts.map(([s, st]) => s.replace('<svg', `<svg style="${st}"`)).join('')}</div>
  <div class="inner">
    <h1>Elde dönen,<br>cepte taşınan,<br><em>akılda kalan.</em></h1>
    <p>${TAGLINE}. Anahtarlıklar, zıplaçlar, spinner'lar, sonsuzluk küpleri ve çakmak kılıfları — yüksek kaliteli 3D baskıyla, istediğiniz renkte.</p>
    <div class="chips">${categories.map(c => `<span>${c.title}</span>`).join('')}</div>
  </div>
</section>`);

// içindekiler + neden biz
let start = 3;
pages.push(`<section class="page">
  <div class="kicker" style="color:#ff6b4a">Hoş geldiniz</div>
  <h2 style="margin:2mm 0 6mm">Koleksiyon</h2>
  <div class="toc">${categories.map((c, i) => `<a><span class="dot" style="background:${c.color}"></span>${c.title}<span class="n">${c.items.map(x => x.code).join(' · ')} — s. ${start + i}</span></a>`).join('')}
    <a><span class="dot" style="background:#1f2a44"></span>Fiyat Listesi & Sipariş<span class="n">s. ${start + categories.length}</span></a></div>
  <h2 style="margin:14mm 0 6mm;font-size:18pt">Neden bizim ürünlerimiz?</h2>
  <div class="grid">
    <div class="tile"><h4>Montajsız, tek parça</h4><p>Ürünlerin çoğu tek parça basılır; kırılacak yapıştırma ya da vida yoktur.</p></div>
    <div class="tile"><h4>İstediğiniz renk</h4><p>Geniş filament paletiyle tek, çift veya gökkuşağı renkli üretim.</p></div>
    <div class="tile"><h4>Kişiye & firmaya özel</h4><p>İsim, logo, tarih ekleyerek hediyelik, düğün, okul ve kurumsal promosyon.</p></div>
    <div class="tile"><h4>Toptan & perakende</h4><p>Tekli siparişten mağaza/kantin toplu alımına kadar esnek adetler.</p></div>
  </div>
  ${footer()}
</section>`);

for (const c of categories) {
  pages.push(`<section class="page">
    <div class="bar" style="background:${c.color}"></div>
    <div class="kicker" style="color:${c.color}">Kategori</div>
    <h2>${c.title}</h2>
    <p class="lead">${c.intro}</p>
    ${c.items.map(it => card(it, c.color)).join('')}
    ${footer()}
  </section>`);
}

const all = categories.flatMap(c => c.items);
pages.push(`<section class="page">
  <div class="bar" style="background:#1f2a44"></div>
  <div class="kicker">Bayi / Mağaza</div>
  <h2>Fiyat Listesi & Sipariş</h2>
  <table class="pl"><thead><tr><th>Kod</th><th>Ürün</th><th class="r">Perakende</th><th class="r">10+ adet</th><th class="r">50+ adet</th></tr></thead>
  <tbody>${all.map(it => `<tr><td>${it.code}</td><td>${it.name}</td><td class="r">₺ ____</td><td class="r">₺ ____</td><td class="r">₺ ____</td></tr>`).join('')}</tbody></table>
  <div class="steps">
    <div><b>Seçin</b>Ürün kodunu ve adedi belirleyin.</div>
    <div><b>Renk & yazı</b>Renkleri ve varsa kişisel yazıyı iletin.</div>
    <div><b>Onay</b>Örnek görsel / numune onayı alınır.</div>
    <div><b>Teslim</b>Üretim sonrası kargo veya elden teslim.</div>
  </div>
  <p class="lead" style="margin-top:8mm;font-size:9pt">Ölçüler yaklaşıktır, üretim partisine göre ±%5 değişebilir. Küçük parça içerir; 3 yaş altı çocuklar için uygun değildir. Çakmak kılıflarına çakmak dahil değildir.</p>
  ${footer()}
</section>`);

pages.push(`<section class="page back">
  <div class="blob" style="position:absolute;border-radius:50%;width:180mm;height:180mm;background:#fff;opacity:.08;right:-60mm;bottom:-60mm"></div>
  <div style="position:absolute;left:18mm;right:18mm;top:70mm">
    <div class="kicker" style="color:#fff;opacity:.8">İletişim</div>
    <h2 style="margin-top:3mm">Numune ve toplu sipariş<br>için bize yazın.</h2>
    <div class="ct"><b>Telefon / WhatsApp</b>+90 ___ ___ __ __<br><b>Instagram</b>@__________<br><b>E-posta</b>__________@______<br><b>Adres</b>________________________</div>
  </div>
  <div style="position:absolute;bottom:18mm;left:18mm;font-weight:700;letter-spacing:3px">${BRAND}</div>
</section>`);

const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${BRAND} Katalog ${YEAR}</title><style>${css}</style></head><body>${pages.join('')}</body></html>`;
writeFileSync('katalog.html', html);

// ---------- İç kullanım: kaynak & lisans listesi ----------
const sources = [
  ['Anahtarlık – İsimli', 'Name Keychain Generator / Custom Keychain – Name Tag', 'https://makerworld.com/en/models/476266-custom-keychain-name-tag'],
  ['Anahtarlık – İsimli', 'Customizable name keychain with border', 'https://makerworld.com/en/models/1306053-customizable-name-keychain-with-border'],
  ['Anahtarlık – Ejderha', 'Flexi Buddy the Dragon & Keychain (3DeepDesigns)', 'https://makerworld.com/en/models/725496-flexi-buddy-the-dragon-keychain-no-supports'],
  ['Anahtarlık – Ejderha', 'Cute Dragon Mini Flexi Keychain', 'https://makerworld.com/en/models/2181821-cute-dragon-mini-flexi-keychain'],
  ['Zıplaç', 'PentaJump – The Jumping Fidget Clicker (YosaNatural)', 'https://makerworld.com/en/models/3353063-pentajump-the-jumping-fidget-clicker'],
  ['Zıplaç / Klik', 'PentaClick – Rubber Band Clicker (YosaNatural)', 'https://makerworld.com/en/models/2661039-pentaclick-the-ultimate-rubber-band-clicker'],
  ['Klik Anahtarlık', 'Keycaps Clicker – Satisfying Fidget Toy', 'https://makerworld.com/en/models/2460021-keycaps-clicker-satisfying-fidget-toy'],
  ['Klik Anahtarlık', 'Brick Fidget and Keychain', 'https://makerworld.com/en/models/2242060-brick-fidget-and-keychain-simple-clicky-cute'],
  ['Spinner', 'GYRO Fidget Spinner (XTRUD3D)', 'https://makerworld.com/en/models/254958-gyro-fidget-spinner'],
  ['Spinner', 'Gyro Fidget Spinner 5 halka (Lokkas)', 'https://makerworld.com/en/models/549353-gyro-fidget-spinner'],
  ['Spinner', 'Textured Gyro Fidget Spinner (MalcTheOracle)', 'https://makerworld.com/en/models/465935-textured-gyro-fidget-spinner'],
  ['Spinner Ball', 'Spinning Sphere Inside Sphere Fidget Toy', 'https://makerworld.com/en/models/1624871-spinning-sphere-inside-sphere-fidget-toy'],
  ['Spinner Ball', 'Orbix – Triple-Motion EDC Fidget', 'https://makerworld.com/en/models/2555729-orbix-triple-motion-edc-fidget-collection'],
  ['Spinner Ball', 'Twisty Fidget Ball', 'https://makerworld.com/en/models/2658901-twisty-fidget-ball'],
  ['Sonsuzluk Küpü', 'Infinity Cube Fidget Print-in-place (Nshark3d) – ~43k beğeni', 'https://makerworld.com/en/models/1084160-infinity-cube-fidget-print-in-place'],
  ['Sonsuzluk Küpü', 'Bambu Infinity Cube Fidget (Mr_Andre)', 'https://makerworld.com/en/models/1243829-bambu-infinity-cube-fidget-print-in-place'],
  ['Sonsuzluk Küpü', 'Mini Fidget Infinity Cube With Keychain Case (Whippi3D)', 'https://makerworld.com/en/models/499566-mini-fidget-infinity-cube-with-keychain-case'],
  ['Çakmak Kılıfı', 'BIC lighter Cover "ROSE"', 'https://makerworld.com/en/models/1063259-bic-lighter-cover-rose'],
  ['Çakmak Kılıfı', 'Bic Lighter Case – Slim Protective Sleeve', 'https://makerworld.com/en/models/961388-bic-lighter-case-slim-protective-sleeve'],
  ['Çakmak Kılıfı', 'Bic lighter waterproof case, six styles', 'https://makerworld.com/en/models/1027781-bic-lighter-waterproof-case-six-styles'],
  ['Çakmak Kılıfı', 'Bic lighter case / flip lid case', 'https://makerworld.com/en/models/839958-bic-lighter-case-flip-lid-case-for-bic-lighter'],
];
const srcHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Kaynak Listesi</title><style>
@page{size:A4;margin:14mm} body{font-family:'DejaVu Sans',sans-serif;color:#1f2a44;font-size:9pt}
h1{font-size:18pt;margin-bottom:2mm} .warn{background:#fff3cd;border-left:4px solid #f6c343;padding:4mm;margin:5mm 0;line-height:1.55}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:2mm;border-bottom:1px solid #ddd;vertical-align:top} th{border-bottom:2px solid #1f2a44}
a{color:#2563eb;word-break:break-all} td.chk{width:22mm;color:#999}
</style></head><body>
<h1>Kaynak Model Listesi (İÇ KULLANIM – müşteriye verilmez)</h1>
<p>Katalogdaki ürünlerin MakerWorld'deki örnek kaynak modelleri. Linkler ${YEAR} Ekim itibarıyla web aramasından derlenmiştir.</p>
<div class="warn"><b>Satıştan önce lisans kontrolü şart.</b> MakerWorld'deki modellerin çoğu "Standard Digital File License" ile paylaşılır: bu lisans yalnızca kişisel baskıya izin verir, <b>baskıyı satmayı yasaklar</b>. Satış için ya (1) tasarımcının MakerWorld "Commercial License" üyeliğini almalı, ya (2) lisansı ticari kullanıma açık (ör. CC BY / CC BY-SA) modelleri seçmeli, ya da (3) kendi tasarımınızı/özgün remix'inizi yapmalısınız. Her modelin sayfasındaki lisans alanını tek tek kontrol edip aşağıdaki "Lisans" sütununa not edin.</div>
<table><thead><tr><th>Kategori</th><th>Model</th><th>Link</th><th>Lisans</th></tr></thead><tbody>
${sources.map(([c, m, u]) => `<tr><td>${c}</td><td>${m}</td><td><a href="${u}">${u}</a></td><td class="chk">☐ ______</td></tr>`).join('')}
</tbody></table></body></html>`;
writeFileSync('kaynak-listesi.html', srcHtml);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const f of ['katalog', 'kaynak-listesi']) {
  await page.goto('file://' + process.cwd() + `/${f}.html`);
  await page.pdf({ path: `${f}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
}
await page.goto('file://' + process.cwd() + '/katalog.html');
await page.setViewportSize({ width: 794, height: 1123 });

await browser.close();
console.log('ok');
