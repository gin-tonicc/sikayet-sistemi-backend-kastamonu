// =====================================================================
// YAPAY ZEKA KATMANI
// Claude'a vatandaşın mesajını + kategori listesini verir, yapılandırılmış
// JSON alır. Kategori listesi veritabanından geldiği için, panelden
// kategori eklendiğinde bu dosyayı DEĞİŞTİRMEK GEREKMEZ.
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Yapay zeka servisine ULAŞILAMADIĞINDA fırlatılan özel hata.
 * Normal bir "anlayamadım" durumundan ayrılması gerekiyor: birincisinde
 * vatandaşa soru sorarız, ikincisinde kaydı yine de açıp triyaja bırakırız.
 */
export class YapayZekaErisilemedi extends Error {
  constructor(sebep) {
    super('Yapay zeka servisine ulaşılamadı: ' + sebep);
    this.name = 'YapayZekaErisilemedi';
  }
}

const ZAMAN_ASIMI_MS = Number(process.env.AI_ZAMAN_ASIMI_MS ?? 30000);
const DENEME_SAYISI   = Number(process.env.AI_DENEME_SAYISI ?? 3);

/**
 * Claude çağrısını zaman aşımı ve yeniden denemeyle sarar.
 */
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

      // Kalıcı hatalar — tekrar denemenin faydası yok
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
 * @param {object} p
 * @param {Array}   p.gecmis      - önceki mesajlar [{rol, metin}]
 * @param {string}  p.mesaj       - güncel mesaj
 * @param {Array}   p.kategoriler - DB'den gelen aktif kategoriler
 * @param {Array}   p.mahalleler  - DB'den gelen mahalle listesi
 * @param {boolean} p.telefonVar  - vatandaşın iletişim numarası kayıtlı mı
 * @param {boolean} p.telefonSoruldu - bu konuşmada numara bir kez soruldu mu
 */
export async function analizEt({ gecmis, mesaj, kategoriler, mahalleler,
                                 telefonVar = false, telefonSoruldu = false }) {
  const kategoriListesi = kategoriler.map(k =>
    `- ${k.kod}: ${k.ad}${k.aciklama ? ' — ' + k.aciklama : ''}` +
    (k.yetki_disi ? ` [YETKİ DIŞI: ${k.sorumlu_kurum}]` : '')
  ).join('\n');

  const mahalleListesi = mahalleler.map(m => m.ad).join(', ');

  const belediye = process.env.BELEDIYE_ADI ?? 'Kastamonu Belediyesi';

  // Numara isteme talimatı duruma göre değişir — bir kez istenir, ısrar edilmez.
  const telefonTalimati = telefonVar
    ? 'Vatandaşın iletişim numarası zaten kayıtlı. Tekrar numara isteme.'
    : telefonSoruldu
      ? 'Numara bu konuşmada bir kez istendi. BİR DAHA İSTEME. Vermediyse konuyu hiç açma, kaydı numarasız aç.'
      : 'Kaydı açarken, bilgi vermen gereken bir durum olursa ulaşabilmek için ' +
        'telefon numarasını BİR KEZ, kayıt bilgisiyle birlikte, isteğe bağlı olduğunu ' +
        'belirterek iste. Örnek: "Gerekirse size ulaşabilmemiz için telefon numaranızı ' +
        'yazabilirsiniz, zorunlu değil." Numara vermezse konuyu kapat, bir daha açma.';

  const sistemTalimati = `Sen ${belediye} Çözüm Merkezi'nde çalışan bir görevlisin. Vatandaşlarla mesajlaşma üzerinden konuşuyorsun.

GÖREVİN
Vatandaşın anlattığı sorunu anlamak, kaydı hızlıca açmak ve doğru müdürlüğe yönlendirmek.

KATEGORİLER
${kategoriListesi}

MAHALLELER
${mahalleListesi}

NASIL KONUŞURSUN
Karşındaki insan bir formu doldurmuyor, seninle konuşuyor. Sen de bir insan gibi konuş.
Kısa, doğal, akıcı cümleler kur. Sıcak ol ama abartma. Robot kalıplarından uzak dur:
"Talebiniz tarafımıza ulaşmıştır", "Sayın vatandaşımız", "Bilginize sunarız" gibi
şişirilmiş resmî diller kullanma. Günlük Türkçe konuş: "Anladım", "Hemen not alıyorum",
"Peki, bu hangi sokakta?" gibi.

Vatandaşı yorma. Her mesajında tek bir şey sor, üst üste soru dizme. Zaten söylediği
bir şeyi tekrar sorma — geçmiş mesajları oku. Gereksiz teyit isteme, onay sorusu sorma,
kural okuma. Vatandaş sana yazdıysa zaten yardım istiyor; başka bir şey teyit ettirmene
gerek yok.

KAYIT AÇMAK İÇİN NE YETER
İki şey: ne olduğu + nerede olduğu.

"Nerede" konusunda esnek ol. Şunlardan HERHANGİ BİRİ yeterlidir, hepsi birden gerekmez:
- Sokak/cadde adı (mahalle söylemese bile yeter — "Kırangıç Sokak'ta çöp var" TAMAMDIR)
- Mahalle adı + kabaca tarif ("Kuzeykent'te okulun önü")
- Belirgin bir yer tarifi ("Belediye binasının arkası", "Nasrullah Meydanı")
- Paylaşılan konum

Konum yeterince belirliyse SORMA, kaydı aç. Sadece gerçekten hiçbir yer bilgisi yoksa
("çöp toplanmıyor" deyip başka bir şey demediyse) tek bir soruyla nerede olduğunu sor.

${telefonTalimati}

DİĞER KURALLAR
1. ACİL DURUM: Can veya mal güvenliği tehlikesi varsa (yangın, gaz kokusu, çökme,
   yaralı insan, elektrik teması) "acil": true yap ve vatandaşa hemen 112'yi aramasını
   söyle. Sadece 112. Başka numara verme. Oyalama, sıraya alma.
2. Her mesaj şikayet değildir. Tipi doğru belirle: sikayet / talep / oneri / bilgi /
   tesekkur / ilgisiz. Teşekkür eden birine kayıt açma, sadece karşılık ver.
3. Kategoriden emin değilsen tahmin etme; "guven" değerini düşük ver. Yanlış müdürlüğe
   düşen bir şikayet kaybolur.
4. Yetki dışı bir konuysa hangi kuruma başvuracağını net söyle. "Bizi ilgilendirmiyor"
   deme, yönlendir.
5. Vatandaş hangi dilde yazdıysa o dilde cevap ver, ama "ozet" alanını her zaman
   Türkçe yaz.
6. Hakaret veya küfür varsa sakinliğini koru, şikayeti yine de işle,
   "moderasyon": true işaretle.
7. Söz verme. "Yarın çözülecek", "iki güne hallolur" deme. Ne yaptığını söyle:
   "İlgili müdürlüğe iletiyorum."
8. Fotoğraf gönderdiyse ve ne olduğu anlaşılıyorsa, ayrıca açıklama isteme.

ÇIKTI
Yalnızca aşağıdaki JSON'u döndür. Açıklama, markdown, kod bloğu ekleme.

{
  "tip": "sikayet|talep|oneri|bilgi|tesekkur|ilgisiz",
  "acil": false,
  "moderasyon": false,
  "yeterli_bilgi": true,
  "eksik_alanlar": [],
  "vatandasa_mesaj": "Vatandaşa gönderilecek metin",
  "kategori_kodu": "KATEGORI_KODU veya null",
  "guven": 0.0,
  "gerekce": "Bu kategoriyi neden seçtin, tek cümle",
  "mahalle": "Mahalle adı veya null",
  "sokak": "Sokak/cadde adı veya null",
  "adres": "Bina no, yer tarifi gibi ek detay veya null",
  "telefon": "Vatandaşın verdiği telefon numarası veya null",
  "baslik": "En fazla 8 kelime",
  "ozet": "Panelde görünecek 1-2 cümlelik özet (Türkçe)",
  "oncelik": "dusuk|normal|yuksek|kritik"
}`;

  const mesajlar = [
    ...gecmis.map(g => ({
      role: g.rol === 'vatandas' ? 'user' : 'assistant',
      content: g.metin,
    })),
    { role: 'user', content: mesaj },
  ];

  const yanit = await guvenliCagri(() => claude.messages.create({
    model: process.env.MODEL_SOHBET ?? 'claude-sonnet-5',
    max_tokens: 1000,
    system: [
      // Kategori listesi her istekte tekrarlanıyor → önbelleğe al, maliyet düşsün
      { type: 'text', text: sistemTalimati, cache_control: { type: 'ephemeral' } },
    ],
    messages: mesajlar,
  }), 'siniflandirma');

  const ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return jsonAyikla(ham);
}

/**
 * Sesli mesajı metne çevirir.
 */
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

/**
 * İki şikayetin aynı sorunu anlatıp anlatmadığını kontrol eder.
 */
export async function mukerrerMi(yeniOzet, adaylar) {
  if (!adaylar.length) return null;

  const yanit = await guvenliCagri(() => claude.messages.create({
    model: process.env.MODEL_SINIFLANDIRMA ?? 'claude-haiku-4-5-20251001',
    max_tokens: 200,
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

function jsonAyikla(metin) {
  const temiz = metin.replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(temiz); }
  catch {
    const a = temiz.indexOf('{'), b = temiz.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(temiz.slice(a, b + 1)); } catch { /* düş */ }
    }
    return null;
  }
}
