# MakerWorld model bilgisi + kapak görseli indirir -> models.json, img/<id>.webp
import json, subprocess, concurrent.futures as cf, os, time
CATS = {
 "isimli": [476266,1306053,936812,487582,1122800,2115391,465128,2316355],
 "flexi": [725496,2181821,454934,2746766,2620180,954385,2800984,578046,2583729,552097,2459711,1222537,552113,831088,198872,1473250,738687,444711],
 "zipzip": [3353063,2661039,768931,1031969,485045,1556065,2363862,942497,62857,1363334,2629352,1385602],
 "klik": [975256,2856174,1067809,2242060,2460021,67728,707208,485421,2513119,722009,1308881,1652741,1142090,659838,1598240,1128835],
 "spinner": [254958,136262,444433,549353,568279,465935,555424,2027619,604756,2960449,1655976,58691,718662,2931758,663482,198609,465023,1156470,1014473,856977,1569648,502345,398576,1038195],
 "ball": [1624871,2555729,60723,1336055,2658901,2313012,2324767,2131999,2697583],
 "kup": [499566,2015474,800914,859525,572673,1243829,1362645,1084160,1617853,2429789,56759,2329694,961037],
 "cakmak": [1063259,961388,839958,1027781,419959,1246772,650503,2437550,1424092,996608,408533,1232133],
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
def get(cat, i):
    for attempt in range(3):
        try:
            out = subprocess.run(["curl","-sS","-A",UA,f"https://makerworld.com/api/v1/design-service/design/{i}"],capture_output=True,text=True,timeout=40).stdout
            d = json.loads(out)
            img = f"img/{i}.webp"
            if not os.path.exists(img) or os.path.getsize(img) < 2000:
                subprocess.run(["curl","-sS","-A",UA,"-H","Referer: https://makerworld.com/","-o",img,
                    d["coverUrl"]+"?x-oss-process=image/resize,w_700/format,webp"],timeout=60)
            return dict(cat=cat,id=i,title=d["title"],designer=d["designCreator"]["name"],license=d.get("license"),
                        likes=d.get("likeCount",0),downloads=d.get("downloadCount",0),url=f"https://makerworld.com/en/models/{i}",img=img)
        except Exception as e:
            time.sleep(2)
    print("FAIL", cat, i, out[:80] if 'out' in dir() else '')
with cf.ThreadPoolExecutor(6) as ex:
    res = [r for r in ex.map(lambda a: get(*a), [(c,i) for c,ids in CATS.items() for i in ids]) if r]
json.dump(res, open("models.json","w"), ensure_ascii=False, indent=1)
print(len(res))
