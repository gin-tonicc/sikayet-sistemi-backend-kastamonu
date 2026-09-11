// =====================================================================
// YAPAY ZEKA KATMANI
// Claude'a vatandaşın mesajını + kategori listesini verir, yapılandırılmış
// JSON alır. Kategori listesi veritabanından geldiği için, panelden
// kategori eklendiğinde bu dosyayı DEĞİŞTİRMEK GEREKMEZ.
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export class YapayZekaErisilemedi extends Error {
  constructor(sebep) {
    super('Yapay zeka servisine ulaşılamadı: ' + sebep);
    this.name = 'YapayZekaErisilemedi';
  }
}

const ZAMAN_ASIMI_MS = Number(process.env.AI_ZAMAN_ASIMI_MS ?? 30000);
const DENEME_SAYISI   = Number(process.env.AI_DENEME_SAYISI ?? 3);

// Uzun vatandaş mesajlarında model uzun JSON üretiyor ve eski 1000'lik
// sınırda yanıt YARIDA KESİLİYORDU. Kesilen JSON okunamadığı için sistem
// "anlayamadım" diyordu — model aslında anlamıştı. Sınır yükseltildi.
const AZAMI_JETON = Number(process.env.AI_AZAMI_JETON ?? 2000);

async function guvenliCagri(islev, etiket) {
  let sonHata;

  for (let deneme = 1; deneme <= DENEME_SAYISI; deneme++) {
    try {
      return await Promise.race([
        islev(),
        new Promise((_, ret) =>
          setTimeout(() => ret(new Error(`${etiket}: ${ZAMAN_ASIMI_MS}ms zaman aşımı`)),
            ZAMAN_ASIMI_MS)),
      ]);
    } catch (hata) {
      sonHata = hata;
      const kod = hata?.status ?? hata?.response?.status;
      if (kod === 401 || kod === 403 || kod === 400) break;
      if (deneme < DENEME_SAYISI) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** (deneme - 1)));
      }
    }
  }

  throw new YapayZekaErisilemedi(`${etiket} — ${sonHata?.message ?? 'bilinmeyen hata'}`);
}

/**
 * Vatandaşın mesajını analiz eder.
 */
export async function analizEt({ gecmis, mesaj, kategoriler, mahalleler,
                                 telefonVar = false, telefonSoruldu = false }) {
  const kategoriListesi = kategoriler.map(k =>
    `- ${k.kod}: ${k.ad}${k.aciklama ? ' — ' + k.aciklama : ''}` +
    (k.yetki_disi ? ` [YETKİ DIŞI: ${k.sorumlu_kurum}]` : '')
  ).join('\n');

  const mahalleListesi = mahalleler.map(m => m.ad).join(', ');
  const belediye = process.env.BELEDIYE_ADI ?? 'Kastamonu Belediyesi';

  const telefonTalimati = telefonVar
    ? 'İletişim numarası zaten kayıtlı. Numara isteme.'
    : telefonSoruldu
      ? 'Numara bu konuşmada bir kez istendi. BİR DAHA İSTEME.'
      : 'Kaydı açarken telefon numarasını BİR KEZ, "zorunlu değil" diyerek isteyebilirsin. ' +
        'Vermezse konuyu bir daha açma.';

  const sistemTalimati = `Sen ${belediye}'nin vatandaş hizmetleri dijital asistanısın. Genel amaçlı bir sohbet botu değilsin.

AMACIN
Sohbet etmek değil: vatandaşın talebini mümkün olan en kısa sürede anlayıp doğru müdürlüğe yönlendirmek ve kaydı açmak.

KATEGORİLER
${kategoriListesi}

MAHALLELER
${mahalleListesi}

════ EN ÖNEMLİ KURAL: İLK MESAJDA ANLA ════
Vatandaşın mesajını parçalara bölüp tek tek sorgulama. Mesajdan şunları KENDİN çıkar:
konu, hizmet alanı, sorunun türü, konum, aciliyet, zaman bilgisi.

Vatandaşın ZATEN SÖYLEDİĞİ hiçbir şeyi tekrar sorma. "Aktekke Mahallesi köprünün orada
dut dökülmüş, sinek yapıyor" diyen birine "hangi mahallede?" veya "sorun nedir?" DEME —
ikisi de mesajda var. Geçmiş mesajları da oku; önceki mesajda verilen bilgi hâlâ geçerlidir.

Hedef akış: vatandaş anlatır → (gerekiyorsa tek kritik soru) → kayıt açılır.
Vatandaşı chatbot mülakatına sokma.

════ KONUŞMA DİLİ ════
Kurumsal ama soğuk değil. Kısa, doğal, açık cümleler. Bir belediye çağrı merkezi
görevlisi gibi konuş.

ŞU KALIPLARI KULLANMA:
"Size nasıl yardımcı olabileceğimi anlamak için...", "Elbette, yardımcı olmaktan
mutluluk duyarım", "Talebinizi daha iyi anlayabilmem için...", "Talebiniz alınmıştır",
"İşleminiz gerçekleştirilmektedir", "Belirtilen husus...", "Lütfen aşağıdaki bilgileri
sağlayınız", "Sayın vatandaşımız".

BUNUN YERİNE: "Anladım.", "Adresi de yazarsanız kaydı açayım.", "Konumu alabilirsem
ilgili ekibe iletirim.", "Kaydınızı açtım, Temizlik İşleri'ne ilettim."

Vatandaş doğrudan derdini anlattıysa uzun karşılama yapma, doğrudan konuya gir.
Kayıt açmadan önce "onaylıyor musunuz?" diye sorma — bilgi yeterliyse aç.

════ SINIFLANDIRMA: KARARLI OL ════
Açık talepleri DOĞRUDAN sınıflandır, havuza (triyaj) atma:
- "Çöp konteyneri doldu" / "çöpçüler gelmiyor" / "sokak süpürülmedi" → temizlik
- "Gece yüksek müzik sesi" / "mekândan kafamız şişiyor" → gürültü
- "Yolda kocaman çukur var" / "kaldırım kırık" → yol/fen işleri
- "Parktaki aydınlatma yanmıyor" → aydınlatma
- "Yaralı köpek var" / "sokak hayvanı" → veteriner
- "Ağaçtan dökülen meyveler kirlilik ve sinek yapıyor" → temizlik (cadde/sokak temizliği)

Vatandaş kategorinin resmî adını kullanmaz. Kelimeleri değil, ANLATTIĞI PROBLEMİ
değerlendir. Cümlenin bütününe bak.

Havuz bir kaçış noktası değildir. Havuza yalnızca şu durumlarda bırak:
(a) gerçekten iki farklı müdürlük arasında kaldıysan,
(b) talep belediye hizmetiyle hiç ilgili değilse,
(c) soru sormana rağmen hâlâ sınıflandıramıyorsan.
Bunların dışında bir kategori seç ve "guven" değerini dürüstçe ver.

════ EKSİK BİLGİ ════
Kayıt için gereken: ne olduğu + nerede olduğu.
Konum için şunlardan HERHANGİ BİRİ yeterli: mahalle adı, sokak/cadde adı, belirgin yer
tarifi ("köprünün orası", "Nasrullah Meydanı"), paylaşılan konum. Hepsi birden gerekmez.
Mahalle ve sokak birlikte verildiyse ikisini de kaydet, ekstra soru sorma.

Gerçekten hiçbir yer bilgisi yoksa TEK soru sor, mahalleyi ve sokağı birlikte iste.
"Sokakta bir sorun var" gibi tamamen belirsiz mesajda rastgele atama yapma; kısa sor:
"Sorun temizlik, yol, gürültü, park ya da başka bir konuyla mı ilgili?"

${telefonTalimati}

════ BİRDEN FAZLA SORUN ════
Tek mesajda iki ayrı sorun varsa ("hem çöpler toplanmıyor hem kaldırım kırık"), bunu
tek kayda sıkıştırma. Ana sorunu normal alanlara yaz, ikinciyi "ek_talepler" dizisine
koy. Vatandaşı baştan konuşturma.

════ DİĞER ════
- ACİL (yangın, gaz kokusu, çökme, yaralı insan, elektrik teması): "acil": true yap ve
  hemen 112'yi aramasını söyle. Sadece 112, başka numara verme.
- Teşekkür/bilgi mesajına kayıt açma, kısaca karşılık ver.
- Yetki dışı konuda hangi kuruma başvuracağını net söyle, "bizi ilgilendirmiyor" deme.
- Hakaret varsa sakin kal, kaydı yine aç, "moderasyon": true.
- Süre sözü verme ("yarın çözülür" deme). "İlgili müdürlüğe iletiyorum" de.
- Vatandaş hangi dilde yazdıysa o dilde cevap ver; "ozet" her zaman Türkçe.

════ ÇIKTI ════
SADECE JSON döndür. Açıklama, markdown, kod bloğu yok.
ALAN UZUNLUKLARINA UY — uzun yazarsan yanıt kesilir ve kayıt açılamaz:
vatandasa_mesaj en fazla 400 karakter, ozet en fazla 200, gerekce en fazla 80,
baslik en fazla 8 kelime.

{
  "tip": "sikayet|talep|oneri|bilgi|tesekkur|ilgisiz",
  "acil": false,
  "moderasyon": false,
  "yeterli_bilgi": true,
  "vatandasa_mesaj": "Vatandaşa gidecek kısa metin",
  "kategori_kodu": "KATEGORI_KODU veya null",
  "guven": 0.0,
  "gerekce": "Tek cümle",
  "mahalle": "Mahalle adı veya null",
  "sokak": "Sokak/cadde adı veya null",
  "adres": "Bina no / yer tarifi veya null",
  "telefon": "Verilen telefon veya null",
  "baslik": "Kısa başlık",
  "ozet": "Panelde görünecek özet",
  "oncelik": "dusuk|normal|yuksek|kritik",
  "ek_talepler": []
}

"ek_talepler" yalnızca ikinci bir sorun varsa dolar, her biri şu alanlarla:
{"kategori_kodu": "...", "baslik": "...", "ozet": "...", "guven": 0.0, "oncelik": "normal"}`;

  const mesajlar = [
    ...gecmis.map(g => ({
      role: g.rol === 'vatandas' ? 'user' : 'assistant',
      content: g.metin,
    })),
    { role: 'user', content: mesaj },
  ];

  const cagir = (jeton, ekUyari) => claude.messages.create({
    model: process.env.MODEL_SOHBET ?? 'claude-sonnet-5',
    max_tokens: jeton,
    system: [
      { type: 'text', text: sistemTalimati, cache_control: { type: 'ephemeral' } },
      ...(ekUyari ? [{ type: 'text', text: ekUyari }] : []),
    ],
    messages: mesajlar,
  });

  let yanit = await guvenliCagri(() => cagir(AZAMI_JETON), 'siniflandirma');
  let ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let sonuc = jsonAyikla(ham);

  // Yanıt jeton sınırına dayandıysa JSON yarıda kalmış olabilir.
  // Bu durumda modele "daha kısa yaz" diyip BİR KEZ tekrar soruyoruz —
  // sessizce "anlayamadım" demektense.
  if (!sonuc && yanit.stop_reason === 'max_tokens') {
    console.warn('[AI] Yanıt jeton sınırında kesildi, kısa biçimde tekrar isteniyor.');
    yanit = await guvenliCagri(
      () => cagir(AZAMI_JETON, 'ÇOK ÖNEMLİ: Yanıtın bir önceki denemede uzunluk ' +
        'sınırına takıldı. Bu sefer alanları olabildiğince KISA yaz: vatandasa_mesaj ' +
        'en fazla 2 cümle, ozet tek cümle, gerekce 5 kelime. JSON mutlaka kapansın.'),
      'siniflandirma-kisa');
    ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
    sonuc = jsonAyikla(ham);
  }

  if (!sonuc) console.error('[AI] JSON okunamadı. Ham yanıt:', ham.slice(0, 400));
  return sonuc;
}

export async function sesiMetneCevir(sesBuffer, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([sesBuffer], { type: mimeType }), 'ses.ogg');
  form.append('model', 'whisper-1');
  form.append('language', 'tr');

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(ZAMAN_ASIMI_MS),
  });
  if (!r.ok) throw new Error('Ses çevrilemedi: ' + await r.text());
  const j = await r.json();
  return j.text;
}

export async function mukerrerMi(yeniOzet, adaylar) {
  if (!adaylar.length) return null;

  const yanit = await guvenliCagri(() => claude.messages.create({
    model: process.env.MODEL_SINIFLANDIRMA ?? 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Belediye şikayetlerinde mükerrer tespiti yapıyorsun.
Yeni bildirim, mevcut bildirimlerden biriyle AYNI FİZİKSEL SORUNU mu anlatıyor?
Aynı sokakta farklı iki çukur AYNI DEĞİLDİR. Aynı konteynerin iki kez bildirilmesi AYNIDIR.
Emin değilsen aynı deme — yanlış birleştirme, ayrı kayıttan daha zararlıdır.
Sadece JSON döndür: {"ayni_mi": true|false, "takip_no": "..." veya null, "gerekce": "tek cümle"}`,
    messages: [{
      role: 'user',
      content: `YENİ: ${yeniOzet}\n\nMEVCUT:\n${adaylar.map(a => `${a.takip_no}: ${a.ozet}`).join('\n')}`,
    }],
  }), 'mukerrer');

  const ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const j = jsonAyikla(ham);
  return j?.ayni_mi ? j.takip_no : null;
}

/**
 * Modelin metninden JSON çıkarır.
 * Üç aşama: düz parse → süslü parantez arası → YARIDA KESİLMİŞ JSON onarımı.
 */
function jsonAyikla(metin) {
  const temiz = String(metin ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
  if (!temiz) return null;

  try { return JSON.parse(temiz); } catch { /* devam */ }

  const a = temiz.indexOf('{');
  if (a < 0) return null;

  const b = temiz.lastIndexOf('}');
  if (b > a) {
    try { return JSON.parse(temiz.slice(a, b + 1)); } catch { /* devam */ }
  }

  // Onarım: yanıt kesilmişse açık kalan tırnak/parantezleri kapatıp tekrar dene.
  // Kesilen alan eksik kalır ama kaydı açmaya yetecek bilgi genelde kurtarılır.
  let parca = temiz.slice(a);
  let tirnakAcik = false, kacis = false;
  const yigin = [];
  for (const ch of parca) {
    if (kacis) { kacis = false; continue; }
    if (ch === '\\') { kacis = true; continue; }
    if (ch === '"') { tirnakAcik = !tirnakAcik; continue; }
    if (tirnakAcik) continue;
    if (ch === '{' || ch === '[') yigin.push(ch);
    else if (ch === '}' || ch === ']') yigin.pop();
  }
  if (tirnakAcik) parca += '"';
  parca = parca.replace(/,\s*$/, '');
  while (yigin.length) parca += yigin.pop() === '{' ? '}' : ']';

  try { return JSON.parse(parca); } catch { return null; }
}
