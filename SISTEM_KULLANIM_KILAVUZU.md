# Solana Paper Copy Sistemi Kullanım Kılavuzu

Bu sistem gerçek emir göndermez. Panel, cüzdanları ve tokenleri izler, paper/simülasyon işlemi açar, sonuçları ölçer ve hangi sinyalin işe yaradığını anlamaya çalışır.

Ana link: http://localhost:8787

Oracle link: http://localhost:8787/oracle

Kontrol linki: http://localhost:8787/control

## 1. Ana Mantık

Sistem üç şeyi aynı anda yapar:

1. Cüzdan takip eder.
2. Token fırsatı arar.
3. Kendi geçmişinden öğrenir.

Amaç tek bir sinyale atlamak değil; cüzdan kalitesi, büyük para izi, sosyal sinyal, token riski, geçmiş PnL ve kaçan fırsatları birleştirmektir.

## 2. Ana Sayfa

Ana sayfada portföy durumu görülür:

- Nakit kasa
- Portföy değeri
- Realized PnL
- Unrealized PnL
- Açık pozisyon sayısı
- Son API yenileme

Buradaki değerler paper/simülasyon değeridir.

## 3. Kontrol Sayfası

Link: http://localhost:8787/control

Burada sistem ayarları yönetilir:

- Cüzdanları copy / alert / off yapma
- Lot miktarı belirleme
- Maksimum açık pozisyon
- Stop loss / take profit
- Cüzdan başı açık pozisyon limiti
- Cüzdan ekleme
- Pozisyon kapatma

Modlar:

- `copy`: Cüzdan alırsa sistem paper alım dener.
- `alert`: Sinyal izlenir ama alım açmaz.
- `off`: Cüzdan takip dışı kalır.

## 4. Oracle Sayfası

Link: http://localhost:8787/oracle

Oracle, sistemin araştırma ve karar merkezidir.

### Token Girişi

Mint adresi, DexScreener linki veya sembol girilip token analiz edilir.

Analiz şunlara bakar:

- Likidite
- Hacim
- Market cap / FDV
- Holder yoğunluğu
- Mint/freeze authority
- RugCheck
- Pump.fun
- GeckoTerminal
- GitHub izi
- Reddit izi
- Sosyal linkler

## 5. Otomatik Token Avı

Bu bölüm yeni veya hareketlenen tokenleri otomatik bulur.

Kaynaklar:

- DexScreener profile
- Boost
- Top boost
- Community takeover
- Ads
- Son paper sinyaller
- Manuel izleme listesi

Kararlar:

- `A`: Derin analiz + scout aday
- `B`: İzle, ikinci onayda scout
- `WATCH`: Radar, acele yok
- `RISK`: Gürültü/riskli

## 6. Büyük Hesap Radar

Büyük hesap ve sosyal kaynaklardan token mention arar.

X API key yoksa X tarafı kapalı kalır; sistem sahte veri üretmez. Reddit/public sosyal kaynaklar çalışır.

Önemli:

- Sadece sembol yakalanırsa otomatik alım yapılmaz.
- CA/mint netleşirse derin analiz yapılabilir.
- Sosyal hype tek başına alım sebebi değildir.

## 7. Ultra Fırsat Merkezi

Bu bölüm farklı kaynakları birleştirir:

- Otomatik token avı
- Büyük hesap radar
- Paper event sinyalleri
- Cüzdan doktoru
- Alım engelleri
- Ayar önerileri

En önemli alt bölüm: `Neden Almıyoruz?`

Burada sistemin neden pozisyon açmadığı görülür:

- `watched`: Cüzdan alert modunda.
- `needs 2 wallet confirm`: İkinci cüzdan onayı bekleniyor.
- `no open paper position`: Satış geldi ama bizde açık pozisyon yok.
- `price pending`: Fiyat bulunamamış.
- `auto demoted`: Cüzdan performans freni yemiş.
- `liquidity low`: Likidite düşük.
- `top holder`: Holder riski yüksek.

## 8. Otomatik Smart Wallet Avcısı

Bu bölüm smart wallet, sniper ve insider-benzeri cüzdan arar.

Sistem şunlara bakar:

- İlk alıcı mı?
- Kaç token yakalamış?
- Ne kadar erken girmiş?
- Toplam kaç SOL harcamış?
- Tek alımda maksimum kaç SOL koymuş?
- Ortalama alımı kaç SOL?
- PnL pozitif mi?
- Win rate iyi mi?
- Büyük zarar izi var mı?
- Her tokene atlayan küçük sniper mı?

Etiketler:

- `SMART WALLET`: PnL, WR, conviction ve zarar kontrolü iyi.
- `SNIPER`: Erken alım davranışı güçlü.
- `INSIDER-BENZERI`: Erken giriş + büyük para + yüksek çarpan izi var.
- `BUYUK PARA`: Anlamlı SOL büyüklüğüyle işlem yapıyor.

Modlar:

- `copy-mini`: Mini paper copy için uygun aday.
- `alert-scout`: Alarmda tut, güçlü sinyalde mini dene.
- `alert`: İzle ama direkt copy yapma.
- `watch-only`: Sadece gözlem.

## 9. Conviction Score

Conviction, cüzdanın gerçekten ciddi para koyup koymadığını ölçer.

Kullanılan metrikler:

- Toplam harcanan SOL
- Son örneklemde toplam alım SOL
- En büyük tek alım SOL
- Ortalama alım SOL
- Medyan alım SOL

Küçük para ile çok token deneyenler `dust sniper` cezası yer.

## 10. Edge Matrix

Edge Matrix sistemin en üst karar kuyruğudur.

Şunları tek yerde birleştirir:

- Cüzdan conviction
- Smart/sniper/insider adayları
- Token fırsatları
- Cluster sinyalleri
- Sosyal sinyaller
- Bizim paper PnL hafızamız
- Kötü cüzdanlar
- Fırsat kaçıran kurallar
- Erken satılan runnerlar

Edge Matrix kararları:

- `scout-copy`: Paper mini copy denenebilir.
- `alert-scout`: Alarm + güçlü sinyalde scout.
- `watch-hot`: Sıcak takip.
- `watch`: İzle.
- `ignore`: Şimdilik boşver.
- `kisitla`: Kötü cüzdanı azalt/pasifleştir.
- `ayar-incele`: Kural fırsat kaçırıyor olabilir.
- `strateji-ogren`: Kaçan fırsatlardan ders çıkar.

## 11. Cüzdan Ekleme

Oracle veya Edge Matrix üzerinde:

- `Alert Ekle`: Cüzdanı izlemeye alır.
- `Mini Copy`: Cüzdanı paper copy moduna alır.

Kontrol sayfasından da manuel eklenebilir.

Öneri:

Yeni cüzdan direkt büyük lotla copy yapılmamalı. Önce mini paper lot ile test edilmeli.

## 12. Pozisyon Yönetimi

Pozisyonlar paper olarak açılır.

Kapanma sebepleri:

- Cüzdan sattı.
- Stop loss.
- Take profit.
- Trailing stop.
- Sell pressure.
- Manuel kapatma.

Moonshot pozisyonları daha geniş stop ve runner mantığıyla takip edilir.

## 13. Satmasaydık Ne Olurdu?

Bu bölüm erken kapatılan işlemlerde sonradan ne olduğunu inceler.

Amaç:

- Erken satıp kaçırdığımız runnerları bulmak.
- TP/trailing stop kurallarını geliştirmek.
- Çok erken çıkan cüzdanları anlamak.

## 14. Kötü Cüzdanları Eleme

Sistem para kaybettiren cüzdanları izler.

Kötüleşme işaretleri:

- Düşük win rate
- Negatif realized PnL
- Çok fazla sinyal
- Çok fazla açık token
- Büyük zarar izi
- Auto-demote

Edge Matrix bu cüzdanları `Negatif alpha` veya `Form riski` olarak gösterir.

## 15. Önemli Uyarılar

Bu sistem kesin para kazandırmaz.

Kripto tokenlerde:

- Rug riski vardır.
- Likidite yok olabilir.
- Fiyat API geç gelebilir.
- Cüzdan geçmişi geleceği garanti etmez.
- Smart görünen cüzdan bir anda kötüleşebilir.
- Büyük para girişi bazen exit liquidity tuzağı olabilir.

Bu yüzden sistem önce paper/simülasyon için tasarlanmıştır.

## 16. Günlük Kullanım Akışı

1. Ana sayfadan bot çalışıyor mu bak.
2. Oracle sayfasında Edge Matrix’i kontrol et.
3. `Negatif alpha` çıkan cüzdanları kontrol sayfasından alert/off yap.
4. `scout-copy` veya `alert-scout` çıkan yeni cüzdanları tartış.
5. Token fırsatlarında önce derin analiz yap.
6. Açık pozisyonları ve satmasaydık bölümünü izle.
7. Gün sonunda hangi cüzdan para kazandırdı, hangisi yedi bak.

## 17. En Önemli Kural

Tek sinyal ile büyük lot yok.

İyi sinyal şu birleşimdir:

- Büyük para conviction
- İyi cüzdan geçmişi
- Erken giriş
- Düşük holder riski
- Yeterli likidite
- Sosyal/dev iz
- Bizim paper sistemde pozitif sonuç

Bu birleşim yoksa sadece izleme veya mini scout.
