<div align="center">

English | **Türkçe**

<img src="Android-APP/design/assets/zcode-app-icon.png" width="88" alt="ZCode Proxy icon" />

# ZCode Proxy

**GLM coding planınızı her AI kodlama aracına bağlayın.**

Kendi bilgisayarınızda çalışan küçük bir araç: Zhipu Z.AI / Bigmodel coding planları (kişisel plan / deneme planı)
normalde yalnız resmi client içinde çalışır. ZCode Proxy bu planları yerel olarak standart OpenAI / Anthropic API'leri
olarak sunar; böylece Claude Code, Codex, Silly Tavern ... plan kotanızı doğrudan kullanabilir.

[Hızlı başlangıç](#-bir-dakikalık-hızlı-başlangıç) · [Kodlama araçlarını bağlayın](#-kodlama-araçlarınızı-bağlayın) · [Mobil](#-mobil-android) · [SSS](#-sss)

</div>

---

## Size ne yapar

- 🧩 **Tek adres, üç format** —— OpenAI, Anthropic ve Responses (yalnız Codex) API'lerinin hepsi yerelde `127.0.0.1:8080` üzerinde servis edilir; aracınız hangi formatı konuşuyorsa onu kullanın.
- 🖥️ **Görsel panel dahil** —— terminalde açtığınızda görsel bir panel gelir (headless mod da var); başlatma, login ve logları okuma tıklamayla olur, ya da telefonunuzdan yönetin.
- 📱 **Android uygulaması** —— proxy'yi telefondan başlatın/durdurun, canlı logları izleyin, provider değiştirin; masaüstünden uzaktayken çok işe yarar.
- 💬 **Yerleşik web sohbeti** —— hızlı model denemesi için `/webui` adresindeki ChatGPT tarzı yerel sohbet sayfasını açın.
- 🌙 **Boş kanal ve anlık plan claim'i** (isteğe bağlı) —— gece yarısı gibi boş saatlerde ücretsiz compute kanalı ve sınırlı deneme planlarının otomatik claim'i, ikisi de içinde.
- 🔀 **Hibrit plan auto-switch** (isteğe bağlı) —— hem deneme start-plan hem kişisel coding-plan mı tutuyorsunuz? Sırayı kendiniz seçin (`planPriority`): önce bitmek üzere olan deneme kredisini harcayın ya da coding-plan'ı başta tutup 5 saatlik / haftalık penceresi bitince deneme planına düşün (`planAutoSwitch`).
- 🔌 **Plan içi MCP relay** —— ZCode resmi plugin MCP'lerini (Tianyancha / Wind / Tonghuashun iFinD ...) yerel `/mcp/*` üzerinden aktarır (coding-plan login'i gerektirir, `GET /mcp` listeyi verir); yerleşik web sohbeti kendi MCP sunucularınızı da model aracı olarak ekleyebilir.
- 🪟 **Tüm platformlar** —— Windows / macOS / Linux tek kod tabanından; ayrıca tek dosyalık binary ya da Docker deployment olarak derlenir.

## 🚀 Bir dakikalık hızlı başlangıç

### Adım 1: Son `exe`yi [GitHub Releases](https://github.com/KilimcininKorOglu/zcode-api/releases) üzerinden indirin

Evet, hepsi bu; gerçekten bu kadar basit.

Açtığınızda terminal kontrol paneline girersiniz (asıl arayüz budur):

<img src="docs/images/tui-annotated.png" alt="ZCode Proxy terminal kontrol paneli" width="980" />

Panelde dört kart vardır: **Login & settings** (provider / plan / login), **Plan usage** (kalan oranı çubuğu + reset geri sayımı, <kbd>r</kbd> ya da Refresh tıklaması), **Proxy service** (başlat/durdur / güncel config), **Logs** (istek başına bir satır, canlı akar; her satır hangi planın servis ettiğini ve `13.0s` / `1m0s` gibi okunabilir süreleri gösterir). Proxy'yi başlatmak için <kbd>s</kbd>ye basın; `Status: running` gördüğünüzde hazırsınız.

> Klavye kısayolu istemiyor musunuz? Paneldeki düğmeler fareyle **tıklanır**. Sessizce arka planda çalışsın mı? `zcode-proxy.exe --cli serve`.

### Panel kısayolları

| Tuş                                                       | İşlem                                                                                        |
|-----------------------------------------------------------|---------------------------------------------------------------------------------------------|
| <kbd>s</kbd>                                              | Proxy'yi başlat / durdur                                                                     |
| <kbd>l</kbd>                                              | Güncel providera login (yetkilendirme için tarayıcıyı açar)                                  |
| <kbd>L</kbd>                                              | bigmodel paste login (yedek mod; `l` login'in kendisi callback istemez, headless çalışır)    |
| <kbd>o</kbd>                                              | Logout                                                                                       |
| <kbd>p</kbd> / <kbd>t</kbd>                               | Provider değiştir (Z.AI ↔ Bigmodel) / plan değiştir (coding-plan ↔ start-plan)               |
| <kbd>r</kbd>                                              | Plan kullanımını yenile                                                                      |
| <kbd>↑</kbd><kbd>↓</kbd> / <kbd>PgUp</kbd> / <kbd>g</kbd> | Logları kaydır / en alta atla                                                                |
| <kbd>c</kbd>                                              | Log ekranını temizle                                                                         |
| <kbd>q</kbd>                                              | Panelden çık                                                                                 |

## 🔌 Kodlama araçlarınızı bağlayın

Proxy çalışırken yerel adres **`http://127.0.0.1:8080`**dür. Aracınızda yalnız iki şeyi değiştirirsiniz: **base URL** ve **model adı**.

"API Key" hakkında: config'te `auth.proxyApiKey` (ya da `ZCODE_PROXY_API_KEY` env'i) ayarladıysanız aracınıza aynı değeri girin; ayarlamadıysanız herhangi bir değer (örn. `sk-1234`) çalışır; yerel kullanımda doğrulama yapılmaz.

<details>
<summary><b>Claude Code</b> (tıklayıp açın)</summary>

Tek shell oturumu için env değişkenleri:

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-1234
export ANTHROPIC_MODEL=glm-4.7
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN = "sk-1234"
$env:ANTHROPIC_MODEL = "glm-4.7"
claude
```

Ya da her Claude Code oturumunda kalıcı olsun diye `~/.claude/settings.json` içine yazın (aynı değişkenler, shell'e gerek yok):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "sk-1234",
    "ANTHROPIC_MODEL": "glm-4.7"
  }
}
```

</details>

<details>
<summary><b>Codex CLI</b> (Responses API üzerinden)</summary>

`~/.codex/config.toml` dosyasını düzenleyin:

```toml
model_provider = "zcode"
model = "glm-5.3"

[model_providers.zcode]
name = "ZCode Proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "ZCODE_API_KEY"   # proxy key set etmediyseniz boş olmayan herhangi bir değer çalışır
```

</details>

<details>
<summary><b>Diğer OpenAI uyumlu araçlar</b> (Cherry Studio, Kilo Code, Cline, LobeChat...)</summary>

Aracın "Custom Provider" ayarlarına şunları girin:

| Ayar                   | Değer                                                         |
|------------------------|---------------------------------------------------------------|
| API adresi (Base URL)  | `http://127.0.0.1:8080/v1`                                    |
| API Key                | Proxy key'iniz (ayarlanmadıysa herhangi bir değer)            |
| Model                  | `glm-4.7`, `glm-5.3`, `glm-4.6v` vb., model tablosuna bakın   |

Anthropic formatını konuşan araçlar için (bazı Claude client'ları gibi) adresi `http://127.0.0.1:8080` yapın; `/v1/messages` yolu otomatik karşılanır.

</details>

Önce elle denemek ister misiniz? Yerleşik sohbet sayfası için **http://127.0.0.1:8080/webui** adresini açın; ya da curl kullanın:

```bash
curl http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "glm-5.3-flash",
  "messages": [{"role": "user", "content": "Hello!"}]
}'
```

## 📱 Mobil (Android)

Son `apk`yı [GitHub Releases](https://github.com/KilimcininKorOglu/zcode-api/releases) üzerinden indirip kurun.
Uygulama masaüstü özelliklerini aynen taşır: tek dokunuşla proxy başlatma, basit kurulum, canlı loglar, provider ve plan değiştirme, açık/koyu tema.

|                                  Ana ekran                             |                               Loglar                             |                                 Ayarlar                                  |                                  Koyu tema                                  |
|:-----------------------------------------------------------------------:|:-----------------------------------------------------------------:|:-------------------------------------------------------------------------:|:----------------------------------------------------------------------------:|
| <img src="docs/images/android/home-light.png" width="210" alt="Ana ekran" /> | <img src="docs/images/android/logs.png" width="210" alt="Loglar" /> | <img src="docs/images/android/settings.png" width="210" alt="Ayarlar" /> | <img src="docs/images/android/home-dark.png" width="210" alt="Koyu tema" /> |

Telefon ve masaüstü aynı çekirdeği çalıştırır: uygulama proxy motorunun tamamını gömer, **telefonun kendisi bağımsız bir proxy sunucusudur** ve aynı LAN'daki masaüstleri de telefonun proxy adresini kullanabilir.

<details>
<summary><b>Docker deployment</b></summary>

**En kolay yol, bu repodaki Compose.** Kalıcı her şey `./docker-data/` içinde (config + credentials), proxy'ye `http://127.0.0.1:8080` üzerinden erişilir, log zaman damgaları Europe/Istanbul saatine göre basılır:

```bash
git clone https://github.com/KilimcininKorOglu/zcode-api && cd zcode-api
mkdir -p docker-data
echo 'ZCODE_PROXY_CREDENTIAL_SECRET=sadece-sizin-bildiginiz-bir-parola' > .env

# Bir kez login olun (sunucuda tarayıcı gerekmez: basılan bağlantıyı herhangi
# bir cihazda açın, login otomatik tamamlanır). Credential docker-data/credentials.json
# içinde saklanır ve container yeniden kurulumunda da kalır.
docker compose run --rm zcode-proxy bun run src/index.ts auth login zai

docker compose up -d --build
```

Çalışan container'ı `docker-data/config.yaml` üzerinden ayarlayın (ilk açılışta otomatik oluşur, tamamen yorumlu): hibrit plan auto-switch için oraya `planAutoSwitch: true` yazın (canlı uygulanır, restart gerekmez). Sonraki güncellemeler `git pull && docker compose up -d --build` (build + recreate tek komutta).

**Ya da klonlamadan hazır image** (multi-arch amd64 / arm64, `bun` kullanıcısıyla çalışır):

```bash
# Host'ta sabit bir şifreleme seed'iyle login olun (iki provider da callback'sizdir:
# bağlantıyı herhangi bir cihazda açın, login otomatik tamamlanır)
ZCODE_PROXY_CREDENTIAL_SECRET="sadece-sizin-bildiginiz-bir-parola" \
  bun run src/index.ts auth login zai

docker run -d --name zcode-proxy -p 8080:8080 \
  -v "$(pwd)/config.yaml:/data/config.yaml:ro" \
  -v "$(HOME)/.zcode-proxy/credentials.json:/home/bun/.zcode-proxy/credentials.json:ro" \
  -e ZCODE_PROXY_CREDENTIAL_SECRET="sadece-sizin-bildiginiz-bir-parola" \
  ghcr.io/kilimcininkoroglu/zcode-proxy:latest
```

```yaml
services:
  zcode-proxy:
    image: ghcr.io/kilimcininkoroglu/zcode-proxy:latest
    ports: ["8080:8080"]
    volumes:
      - ./config.yaml:/data/config.yaml:ro
      - ./credentials.json:/home/bun/.zcode-proxy/credentials.json:ro
    environment:
      ZCODE_PROXY_CREDENTIAL_SECRET: "sadece-sizin-bildiginiz-bir-parola"
    restart: unless-stopped
```

</details>

<details>
<summary><b>Ayarlanabilir config ve env değişkenleri</b> (dokunmadan da çalışır)</summary>

Config dosyası proje kökündeki `config.yaml`dır (ilk açılışta otomatik oluşur, tamamen yorumlu; bkz. [`config.example.yaml`](config.example.yaml)); env değişkenleri önceliklidir. Sık kullanılanlar:

| Env değişkeni                   | Varsayılan       | Açıklama                                                                                                                         |
|---------------------------------|------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `ZCODE_PROXY_PORT`              | `8080`           | Dinleme portu                                                                                                                    |
| `ZCODE_PROXY_API_KEY`           | yok              | Client'ların proxy'ye erişirken kullanacağı key (boş = kontrol yok)                                                              |
| `ZCODE_PROVIDER`                | `zai`            | Provider `zai` / `bigmodel`                                                                                                      |
| `ZCODE_PLAN_AUTO_SWITCH`        | off              | Hibrit plan auto-switch için `1`/`true` (`planAutoSwitch`): watcher trafiği, izlenen sinyallerinde kotası kalan `planPriority` sırasındaki ilk planda tutar; reddedilen istek o istek için sıradaki plana düşer. Flag off = hiçbir fallback yok; plan seçimi tamamen sizin config'iniz |
| `ZCODE_PLAN_PRIORITY`           | `start-plan, coding-plan` | Auto-switch için virgülle ayrılmış plan önceliği (`planPriority`); coding-plan'ı başta tutmak için `coding-plan, start-plan` gibi |
| `ZCODE_PLAN_POLL_INTERVAL_SEC`  | `30`             | Auto-switch poll aralığı, saniye (`planPollIntervalSec`) |
| `ZCODE_BATCH_AS_STREAM`         | on               | `batchAsStream`ı kapatmak için `0`/`false`: batch (stream olmayan) istekler upstream'e stream olarak gider ve tek JSON'a birleştirilir; çünkü upstream gateway ~180 saniyeyi aşan sessiz non-streaming istekleri öldürür (belirti: tam ~3 dakika sonra 502) |
| `ZCODE_PROXY_CONFIG`            | `config.yaml`    | Config dosyası yolu                                                                                                              |
| `ZCODE_PROXY_CREDENTIAL_SECRET` | makineye özel    | Login credential'larının şifreleme seed'i (makine taşımada / Docker'da sabitleyin)                                               |
| `ZCODE_LOG_FORMAT`              | desktop table    | Tek satırlık loglar için `compact` (dar ekranlar)                                                                                |
| `ZCODE_PANEL_ENABLED`           | off              | Headless `serve` modunun (Docker dahil) da yerel web panel başlatması için `1`/`true`                                            |
| `ZCODE_PANEL_TOKEN`             | yok              | Panel erişim tokenı, **panel açıkken zorunlu** (token olmadan panel açılmayı reddeder; kontrol API'sinin açıkta kalmaması için) |
| `ZCODE_PANEL_PORT`              | `8090`           | Panel portu (yalnız `127.0.0.1`e bağlanır)                                                                                       |
| `ZCODE_UPDATE_CHECK`            | on               | "Yeni sürüm var" kontrolünü kapatmak için `off`/`0` (yalnız bildirir, asla otomatik güncellemez)                                 |
| `ZCODE_UPDATE_SKIP`             | yok              | Yok sayılacak sürümler, virgüllü: örn. `v4.7.6,v4.7.7`                                                                          |
| `ZCODE_ERROR_LOG`               | `<config dizini>/errors.log` | Kalıcı JSONL hata logu: client'a görünen her 4xx/5xx için bir satır artı arkasındaki hata-sebep olayları (retry, abort, stream hataları). Satırlar boot başına istek id'sini (`a1b2-#007`) ve client/upstream göndermişse client'ın request/session id'sini ve upstream'in `x-request-id`sini taşır. 5 MB'ı aşınca `errors.log.1`e döner |

Plan türü (`plan`: `coding-plan` kişisel / `start-plan` deneme) panelde <kbd>t</kbd> ile değiştirilir ve config.yaml'a geri yazılır.

**Coding-first auto-switch** ("5 saatlik limitim bitti, beni deneme planına geçir" kurulumu): `planAutoSwitch: true` ile config.yaml'a şunu yazın

```yaml
planPriority:
  - coding-plan
  - start-plan
planSwitchRules:
  coding-plan:
    limits: ["TIME_LIMIT", "WEEK_LIMIT"]   # geçişi tetikleyen 5 saatlik / haftalık pencereler
  start-plan:
    limits: ["BALANCE"]
```

Watcher her iki planın kotasını yoklar (`planPollIntervalSec`, default 30) ve `planPriority` içinde izlenen sinyallerinde kotasi kalan ilk planı servis eder; reddedilen istek o istek için sıradaki plana da düşer. Yukarıdakilerin hepsi (watcher + fallback) yalnız `planAutoSwitch` açıkken çalışır: off demek ne auto-switch ne fallback demektir.

**config.yaml'ı restart olmadan düzenleme**: çalışan proxy dosyayı izler ve değişikliği yerinde uygular (`[config] reloaded: ...` log satırını izleyin). `claim.auto`, `planAutoSwitch` ya da `plan`ı değiştirmek ilgili arka plan işini başlatır/durdurur; `planPollIntervalSec`i değiştirmek watcher'ı yeni ritimle yeniden başlatır; bozuk bir dosya çalışan config'i korur ve izlemeye devam eder. Yalnız `server` (port/host) restart ister.

TUI'siz sunucularda tarayıcıyı kullanın: `ZCODE_PANEL_ENABLED=1` ve `ZCODE_PANEL_TOKEN=<kendi-rastgele-stringiniz>` verip başlatın, sonra `http://127.0.0.1:8090` adresini SSH ile ileriye taşıyın; durum ve kotayı görebilir, provider/plan değiştirebilir, login/logout yapabilir, canlı logları ve MCP listesini izleyebilirsiniz. Panel yalnız loopback'e bağlanır, her API çağrısında token ister ve tokensız asla başlamaz; komutlar in-process dağıtılır, ekstra bir kontrol portu açılmaz. Paneldaki "Stop proxy" yalnız proxy'yi durdurur; sürecin kendisi temiz çıkar (SIGTERM/SIGINT ve panel shutdown çıkıştan önce arka plan zamanlayıcılarını, yani auto-claim'i ve captcha pool'unu temizler); panelden logout çalışan credential'ı da temizler ve proxy'yi durdurur, böylece yeni istekler eski hesabın kotasını harcayamaz.

**Yeni sürüm bildirimi**: `serve` ve TUI açılışta GitHub'ın son sürümünü bir kez asenkron kontrol eder; en fazla bir ek log satırı (TUI'de elle kontrol için <kbd>u</kbd>); açılışı asla bloklamaz, proxy'yi etkilemez; çevrimdışı / engelli / rate-limited / değişmiş yanıt şekilleri sessizce yok sayılır. Elle kontrol her zaman net cevap verir ("already latest" ya da "check unavailable"). Container içinde image değiştirilemez olduğu için ipucu çalışma zamanınıza **pull komutunu** gösterir (Docker: `docker compose pull && docker compose up -d`, Podman: `podman compose pull && podman compose up -d`; aksi hâlde "yeni image'i pull edip container'ı yeniden kurun"); dosyalar yerinde değiştirilmez (release'ler checksum taşımaz, o yüzden otomatik indirme yok). Kontrolleri kapatmak için `ZCODE_UPDATE_CHECK=off`, gürültülü bir sürümü susturmak için `ZCODE_UPDATE_SKIP=v4.7.6`.

**Docker içinde panele erişim**: panel yalnız **container'ın kendi** `127.0.0.1`inde dinler; default bridge ağda `-p 8080:8080` onu dışarı açamaz; tek başına `-p 8090:8090` eklemek de yetmez (port container'ın non-loopback adresine eşlenir). Linux sunucuda host networking kullanın ki container host loopback'ini paylaşsın:

```yaml
services:
  zcode-proxy:
    # mevcut image / volumes / restart vb. kalsın
    network_mode: host        # eski ports: satırını kaldırın; host modunda
    environment:
      ZCODE_PROXY_CREDENTIAL_SECRET: "sadece-sizin-bildiginiz-bir-parola"
      ZCODE_PANEL_ENABLED: "1"
      ZCODE_PANEL_TOKEN: "${ZCODE_PANEL_TOKEN:?önce .env'e panel tokenını yazın}"
      ZCODE_PANEL_PORT: "8090"
```

Sonra lokalde yalnız-ileriye bir tünel açın (`-N` = shell yok):

```bash
ssh -N -L 8090:127.0.0.1:8090 user@host
```

Ve `http://127.0.0.1:8090` adresini açın. Host modunda ana proxy portu da host portunu doğrudan işgal eder; 8080'e güvenlik grubu/firewall iznini eskisi gibi bırakın ve 8090'ı **asla** dışarı açmayın.

</details>

<details>
<summary><b>Gelişmiş özellikler: boş kanal, plan claim'i ve auto-switch</b></summary>

**Boş kanal (`/async/*`)** —— vendor'un gece yarısı gibi boş saatlerde serbest bıraktığı ücretsiz compute. İstekler önce ticket kuyruğuna girer, sıra geldiğinde otomatik modele gönderilir (acelesi olmayan batch işler için iyi). `config.yaml`da `async.enabled: true` ile açılır; dikkat: oturumsuz ve tek seferliktir; çok turlu sohbetlerde geçmişi istekle birlikte gönderin.

**Hafta sonu / deneme planı auto-claim (claim)** —— default açık. Proxy 5 dakikada bir vendor'un sınırlı plan kampanya sayfasını yoklar ve yeni teklif düştüğü an sizin için otomatik claim eder (`claim.enabled: false` kapatır). Elle claim: `bun run src/index.ts claim`.

**Hibrit plan auto-switch (`planAutoSwitch`)** —— claim ile birlikte iyi çalışır. Hesabınız hem deneme start-plan (puan kovası, biter) hem kişisel coding-plan (sıralı pencereler, yenilenir) tutabilir. Off iken statik `plan` config'i olduğu gibi uygulanır, hiçbir fallback yoktur; config'te `planAutoSwitch: true` (ya da `ZCODE_PLAN_AUTO_SWITCH=1`) ile arka planda bir watcher her iki kota düzlemini yoklar (`planPollIntervalSec`, default 30 sn: deneme için `billing/balance`, coding-plan için `/api/monitor/usage/quota/limit` pencereleri), her yoklamadan sonra okunabilir bir kota satırı basar ve istekleri `planPriority` içinde izlenen sinyallerinde kotasi kalan ilk plana yönlendirir (default `start-plan, coding-plan`; coding-first için `ZCODE_PLAN_PRIORITY` ya da config listesiyle çevirin) — `planSwitchRules` hangi sinyallerin sayılacağını daraltır (deneme `BALANCE`, coding-plan `TIME_LIMIT` 5 saatlik / `WEEK_LIMIT` haftalık pencereler). Servis eden planın gateway'i bir isteği reddederse (start-plan: 401/402/403, JSON hata zarfı taşıyan HTTP 200, tükenmenin sahada aldığı şekil, 502/504; coding-plan: boşalan pencereden 429) aynı istek bir kez öncelik listesindeki sıradaki plana tekrar edilir ve reddedilen plan, watcher onu tekrar kullanılabilir görene dek 10 dakika soğutulur; böylece deneme kredileri boşa gitmez ve coding-plan istekleri bozuk bir deneme katmanı tarafından bloklanmaz. İki plan da isteği reddederse client sahte 200 zarfı yerine temiz bir 429 alır. Plan katmanlarından bağımsız olarak, tam bir upstream load-balancer hatası (502/504) client'a ulaşmadan bir kez tekrar denenir. TUI plan kartı isteklerin gerçekte kullandığı katmanı `(auto)` imzasıyla gösterir ve istek log satırı bir Plan kolonu taşır (`start-plan` / `coding-plan`).

**Kota gösterimi (quota)** —— login sonrası panel kotayı bir kez otomatik sorgular, sonra <kbd>r</kbd> ile elle yenilersiniz. Veri iki upstream kota düzleminden gelir: deneme/puanlı planlar için puan kovası (`billing/balance`, kalan / toplam, son kullanma) ve kişisel coding-planlar için kullanım penceresi (`/api/monitor/usage/quota/limit`, resmi kullanım paneliyle aynı kaynak; 5 saatlik / haftalık pencereler için **kalan kota** ve reset zamanı; upstream `number` karşılaştırılabilir bir toplam olmadığından CLI/TUI hep yalnız kalanı gösterir ve oranı çubuğunu yalnız upstream percentage verince çizer). CLI'dan doğrudan sorgu: `bun run src/index.ts quota` (HTTP karşılığı `GET /quota`). Upstream gateway'ler sık sorguyu rate-limit yaptığından panel zamanlı poll yapmaz.

</details>

## 🧮 Kullanılabilir modeller

Proxy `/v1/models` altında bu modelleri listeler (liste temsilidir; diğer model adları olduğu gibi iletilir):

| Model                       | Context | Maks çıktı |
|-----------------------------|---------|------------|
| `glm-4.5-air`               | 131K    | 96K        |
| `glm-4.6`                   | 200K    | 131K       |
| `glm-4.6v` (vision)         | 131K    | 32K        |
| `glm-4.7`                   | 200K    | 131K       |
| `glm-5` / `glm-5-turbo`     | 200K    | 64K        |
| `glm-5v-turbo` (vision)     | 200K    | 131K       |
| `glm-5.1`                   | 200K    | 64K        |
| `glm-5.2`                   | 1M      | 128K       |
| `glm-5.3` / `glm-5.3-flash` | 1M      | 128K       |

## ❓ SSS

**"Not logged in" ile hemen mi kapanıyor?**
Önce login olun: `bun run src/index.ts auth login zai` (ya da bigmodel). Tek login yeter; credential'lar şifreli saklanır.

**8080 portu dolu mu?**
Env ile değiştirin: `ZCODE_PROXY_PORT=8081 bun run src/index.ts`, ya da `config.yaml`da `server.port`u değiştirin.

**Araç bağlanamıyor / 401 mi?**
`ZCODE_PROXY_API_KEY` set ettiyseniz araç aynı değeri kullanmalı; set etmediyseniz parola yoktur. Bir key açıldığında `/webui` dışındaki (dahil `/health`) **tüm yolların** onu istediğini unutmayın.

**Bilgisayar değiştirince / işletim sistemini kurunca tekrar login mi gerek?**
Evet. Credential'lar yerel makineye bağlı şifrelenir. Taşımak için `ZCODE_PROXY_CREDENTIAL_SECRET`i iki tarafta aynı değere sabitleyin, sonra tekrar login olun / `~/.zcode-proxy/credentials.json`u kopyalayın.

**Tarayıcısı olmayan sunucuda nasıl login olurum?**
Doğrudan login olun: `bun run src/index.ts auth login zai` (ya da bigmodel). Login bağlantısını herhangi bir cihazın tarayıcısında açabilirsiniz, lokal makine otomatik tamamlar (callback sayfası gerekmez). Manuel takas için paste modu da var: `auth login bigmodel --paste`; yönlendirilen tam URL'yi geri yapıştırın.

**Arka planda ne yapıyor?**
Sadece bir "çevirmen + kurye": aracınızın standart isteklerini resmi client'ın gönderdiği isteklere çevirir, upstream'e iletir, cevapları aynen geri çevirir. Tüm trafik sizin makinenizle resmi sunucular arasında kalır; arada üçüncü taraf yoktur.

## 🛠️ Katkı

```bash
bun test            # testleri çalıştır
bun x tsc --noEmit  # typecheck
bun run dev         # paneli dev modunda başlat
```

Mimari ve implementasyon detayları [`src/`](src/) altındaki her kaynak dosyanın içindeki yorumlarda belgelenir.

## Gizlilik

Bu proxy tamamen yerel çalışır: **telemetri yok, analytics yok, hiçbir tür dışa raporlama yok**. Kullanım veriniz, cihaz bilginiz ve config'iniz makinenizden çıkmaz; debug/dump logları API key'leri, JWT'leri ve proxy key'leri otomatik gizler.

## Lisans

MIT
