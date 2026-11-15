// ============================================================
//  PVC PERDE RAYI DÖNÜŞ PARÇASI - parametrik model
//  Açı: 45 / 22.5 / 11.25 (veya istediğiniz değer)
//  Kullanım: aşağıdaki ölçüleri gerçek parçadan alıp değiştirin,
//  F6 ile render edip "Export as STL" yapın.
//  Komut satırı: openscad -D aci=22.5 -o donus_22_5.stl perde_donus.scad
// ============================================================

aci        = 22.5;   // dönüş açısı (derece)
R_ic       = 120;    // en içteki kenarın yay yarıçapı (mm)  <-- ÖLÇÜN
$fn        = 360;

// ---- Ray kesit profili (straight rayın ucundan bakınca görünen şekil) ----
// Her nokta: [içten dışa mesafe (mm), yükseklik (mm)]
// Rayın ucunu milimetrik kâğıda bastırıp çizerek bu noktaları çıkarın.
// Aşağıdaki değerler fotoğraftan tahmini, GERÇEK DEĞİL:
profil = [
  [0,   0], [125, 0],           // taban
  [125, 12], [110, 12],         // dış (üst) dudak
  [110, 6],  [104, 6],          // kanal
  [104, 22], [62, 22],          // orta geniş bant (yuvarlak düğmeli)
  [62, 6],   [56, 6],           // kanal
  [56, 20],  [18, 20],          // alt geniş bant
  [18, 6],   [14, 6],           // kanal
  [14, 10],  [0, 10]            // iç (alt) dudak
];

// ---- Uç geçme dilleri (düz rayın içine giren tırnak) ----
dil_var      = true;
dil_boy      = 15;   // raya ne kadar girdiği (mm)       <-- ÖLÇÜN
dil_kalinlik = 2;    // dil et kalınlığı (mm)            <-- ÖLÇÜN
dil_bosluk   = 0.2;  // baskı toleransı (mm), sıkıysa artırın
// Dil, kesitin içine oturan küçültülmüş bir profil şeridi olarak üretilir
dil_profil = [
  [16, 0], [54, 0], [54, 4], [16, 4]   // alt bant altındaki dil
];
dil_profil2 = [
  [58, 0], [102, 0], [102, 4], [58, 4] // orta bant altındaki dil
];

// ---------------- MODEL ----------------
module kesit(p) translate([R_ic,0]) polygon(p);

module govde() rotate_extrude(angle=aci) kesit(profil);

module dil(p) {
  // düz (teğet) doğrultuda uzanan geçme dili
  rotate([90,0,0]) linear_extrude(dil_boy)
    offset(delta=-dil_bosluk) kesit(p);
}

govde();
if (dil_var) {
  // başlangıç ucu (0°)
  for (p=[dil_profil, dil_profil2]) dil(p);
  // bitiş ucu (aci°)
  rotate([0,0,aci]) mirror([0,1,0]) for (p=[dil_profil, dil_profil2]) dil(p);
}
