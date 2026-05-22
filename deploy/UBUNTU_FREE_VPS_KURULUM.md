# PC Kapalıyken Çalıştırma Kurulumu

En uygun ücretsiz yol: Oracle Cloud Always Free gibi küçük bir Ubuntu VPS.
Bu kurulum paneli ve paper botu aynı anda çalıştırır.

## 1. Sunucuda Node kur

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

## 2. Projeyi sunucuya koy

Projeyi `/opt/solana-paper` klasörüne kopyala. En pratik yol GitHub repo ise:

```bash
sudo mkdir -p /opt/solana-paper /opt/solana-paper-data
sudo chown -R $USER:$USER /opt/solana-paper /opt/solana-paper-data
cd /opt/solana-paper
git clone REPO_URL .
```

GitHub yoksa dosyaları SFTP ile aynı klasöre at.

## 3. Mevcut state/config dosyalarını taşı

Şu dosyaları `/opt/solana-paper-data` içine koy:

- `config.json`
- `paper-state.json`
- `paper-events.ndjson`
- `oracle-watchlist.json`
- `free-alpha-radar-result.json`
- `oracle-discovery-result.json`
- `social-radar-result.json`
- `trend-map-result.json`

## 4. Servisi kur

```bash
sudo cp /opt/solana-paper/deploy/systemd/solana-paper.service /etc/systemd/system/solana-paper.service
sudo systemctl daemon-reload
sudo systemctl enable --now solana-paper
sudo systemctl status solana-paper
```

## 5. Mobil erişim

Sunucunun public IP adresinde:

```text
http://SUNUCU_IP:8787
```

Oracle güvenlik listesinde ve Ubuntu firewall'da `8787/tcp` açılmalı.

Ubuntu firewall açıksa:

```bash
sudo ufw allow 8787/tcp
```

## Kontrol Komutları

```bash
sudo systemctl status solana-paper
sudo journalctl -u solana-paper -f
sudo systemctl restart solana-paper
```

Not: Bu sistem hâlâ paper/simülasyon amaçlıdır. Gerçek emir kapalı kalmalıdır.
