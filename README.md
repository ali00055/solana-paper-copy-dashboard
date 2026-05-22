# Solana Copy Paper Bot

Anlik Solana cuzdan takip ve paper-trade sim botu. Gercek emir gondermez.

## Kurulum

```powershell
Copy-Item config.example.json config.json
node bot.mjs
```

## Ne yapar?

- Takip edilen cuzdanlar icin Solana WebSocket `logsSubscribe` acmaya calisir.
- Yeni imza gelince transaction'i RPC'den okur.
- Izlenen cuzdanin SPL token balance degisimlerinden BUY/SELL olayi cikarir.
- `mode: "copy"` olan cuzdanlarda sanal portfoye isler.
- `mode: "alert"` olanlarda sadece loglar.
- TP/SL/trailing kurallarini fiyat guncellemeleriyle uygular.
- State'i `paper-state.json`, eventleri `paper-events.ndjson` dosyasina yazar.

## Telegram

`config.json` icinde `telegram.enabled` true yapip bot token ve chat id girersen bildirim atar.

## Uyari

Bu bir simulatordur. Fiyatlar DexScreener'dan gelir, slippage/fee yaklasik uygulanir. Gercek copy trade sonucunu garanti etmez.
