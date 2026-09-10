// =====================================================================
// KONUŞMA AKIŞI
// Gelen bir mesajın (WhatsApp veya Telegram, hangisi olursa) baştan
// sona ne olduğunu yöneten dosya. Sistemin "beyni" burada — kanaldan
// tamamen bağımsızdır, sadece gelen.kanal alanına bakar.
// =====================================================================

import { db } from './db.js';
import { analizEt, sesiMetneCevir, mukerrerMi, YapayZekaErisilemedi } from './ai.js';
import * as whatsapp from './whatsapp.js';
import * as telegram from './telegram.js';
import { birimeBildir } from './bildirim.js';

const BELEDIYE = process.env.BELEDIYE_ADI ?? 'Kastamonu Belediyesi';
const CAGRI_MERKEZI = process.env.CAGRI_MERKEZI ?? 'belediye çağrı merkezimizi';

/**
 * KISA ARALIKLI SEL KORUMASI
 * Aynı kişiden dakikada N mesajdan fazlası sessizce yok sayılır.
 * Sunucu yeniden başlarsa sıfırlanır; bu ölçekte yeterli.
 */
const DAKIKA_LIMITI = Number(process.env.DAKIKA_MESAJ_LIMITI ?? 12);
const selSayaci = new Map();   // telefon -> { adet, pencereBaslangic, uyarildi }

function selKontrol(telefon) {
  const simdi = Date.now();
  const kayit = selSayaci.get(telefon);

  if (!kayit || simdi - kayit.pencereBaslangic > 60000) {
    selSayaci.set(telefon, { adet: 1, pencereBaslangic: simdi, uyarildi: false });
    return { engelle: false, uyar: false };
  }

  kayit.adet++;
  if (kayit.adet > DAKIKA_LIMITI) {
    const uyar = !kayit.uyarildi;
    kayit.uyarildi = true;
    return { engelle: true, uyar };
  }
  return { engelle: false, uyar: false };
}

// Hafıza sızıntısı olmasın: 10 dakikada bir eski kayıtları temizle
setInterval(() => {
  const simdi = Date.now();
  for (const [anahtar, kayit] of selSayaci) {
    if (simdi - kayit.pencereBaslangic > 300000) selSayaci.delete(anahtar);
  }
}, 600000).unref?.();

const KANALLAR = {
  whatsapp: { gonder: whatsapp.mesajGonder, medyaIndir: whatsapp.medyaIndir },
  telegram: { gonder: telegram.mesajGonder, medyaIndir: telegram.medyaIndir },
};

// Takip numarası deseni: K26-000123 (büyük/küçük harf ve boşluk toleranslı)
const TAKIP_NO_DESENI = /\b([A-ZĞÜŞİÖÇ]{1,3}\s?\d{2}\s?[-–]\s?\d{4,8})\b/i;

// Telefon numarası deseni: 05XX XXX XX XX ve varyasyonları
const TELEFON_DESENI = /(?:\+?90[\s.-]?)?0?\s?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/;

export async function mesajIsle(gelen) {
  // ---- 0. Sel koruması ----------------------------------------------
  const sel = selKontrol(gelen.telefon);
  if (sel.engelle) {
    if (sel.uyar) {
      await KANALLAR[gelen.kanal].gonder(gelen.hedefId,
        'Çok sayıda mesaj aldık, biraz bekleyip tekrar yazar mısınız? ' +
        'Acil bir durum varsa 112\'yi arayın.');
    }
    return;
  }

  const ayarlar = await db.ayarlariGetir();

  // ---- 1. Vatandaşı bul veya oluştur -------------------------------
  const vatandas = await db.vatandasBulVeyaOlustur(gelen.telefon, gelen.ad);

  if (vatandas.kara_liste) {
    return; // sessizce yok say
  }

  // ---- 1b. Karşılama (Telegram /start) -----------------------------
  // Telegram, kullanıcı botu ilk açtığında otomatik "/start" gönderir.
  // Yapay zekaya hiç göndermiyoruz — boşuna maliyet.
  if ((gelen.metin ?? '').trim().toLowerCase() === '/start') {
    await yanitla(vatandas, gelen,
      `Merhaba, ${BELEDIYE} Çözüm Merkezi'ne hoş geldiniz.\n\n` +
      `Şehirle ilgili bir sorunu buradan bildirebilirsiniz. Ne olduğunu ve nerede ` +
      `olduğunu yazmanız yeterli — varsa bir fotoğraf da gönderebilirsiniz.\n\n` +
      `Örnek: "Kırangıç Sokak'ta çöp konteyneri devrilmiş."\n\n` +
      `Daha önce bildirim yaptıysanız takip numaranızı yazarak durumunu öğrenebilirsiniz.\n\n` +
      `Acil durumlarda lütfen 112'yi arayın.`);
    return;
  }

  // ---- 2. Günlük kayıt sınırı ---------------------------------------
  const bugunkuKayit = await db.bugunkuKayitSayisi(vatandas.id);
  if (bugunkuKayit >= Number(ayarlar.gunluk_bildirim_limiti ?? 10)) {
    await yanitla(vatandas, gelen,
      `Bugün için bildirim sınırınıza ulaştınız, mevcut bildirimleriniz işleme alındı. ` +
      `Yeni bir konu için ${CAGRI_MERKEZI} arayabilirsiniz. Acil bir durum varsa 112.`);
    return;
  }

  // ---- 3. Medyayı metne çevir --------------------------------------
  let metin = gelen.metin;
  let medyaYolu = null;

  if (gelen.tip === 'audio' && gelen.medyaId) {
    const { buffer, mime } = await KANALLAR[gelen.kanal].medyaIndir(gelen.medyaId);
    metin = await sesiMetneCevir(buffer, mime);
    medyaYolu = await db.medyaYukle(buffer, mime, 'ses');
  } else if (gelen.tip === 'image' && gelen.medyaId) {
    const { buffer, mime } = await KANALLAR[gelen.kanal].medyaIndir(gelen.medyaId);
    medyaYolu = await db.medyaYukle(buffer, mime, 'foto');
    metin = metin || '[Fotoğraf gönderildi]';
  } else if (gelen.tip === 'location') {
    metin = `[Konum paylaşıldı: ${gelen.konum.lat}, ${gelen.konum.lng}]`;
  }

  await db.konusmaKaydet({
    vatandas_id: vatandas.id, yon: 'gelen', rol: 'vatandas',
    mesaj: metin, medya_yolu: medyaYolu, wa_mesaj_id: gelen.waMesajId,
  });

  // ---- 4. Takip numarası sorgusu ------------------------------------
  // ÖNEMLİ: Bot vatandaşa "takip numaranızı yazın" diyor. Bu blok olmadan
  // yazılan takip numarası YENİ BİR ŞİKAYET olarak işleniyordu.
  // Yapay zekaya hiç gitmez — hem hızlı hem bedava.
  const takipEslesme = (metin ?? '').match(TAKIP_NO_DESENI);
  if (takipEslesme) {
    const takipNo = takipEslesme[1].replace(/\s/g, '').toUpperCase().replace('–', '-');
    const kayit = await db.sikayetGetirTakipNo(takipNo);

    if (kayit) {
      // Başkasının kaydını gösterme — sadece kendi bildirimlerini sorgulayabilir
      if (kayit.vatandas_id !== vatandas.id) {
        await yanitla(vatandas, gelen,
          `${takipNo} numaralı bir kayıt var ama sizin bildiriminiz olarak görünmüyor. ` +
          `Numarayı kontrol eder misiniz?`);
        return;
      }
      await yanitla(vatandas, gelen,
        `${takipNo} numaralı bildiriminiz:\n\n` +
        `Konu: ${kayit.baslik ?? kayit.ozet ?? '—'}\n` +
        `Durum: ${durumMetni(kayit.durum)}\n` +
        (kayit.cozum_tarihi
          ? `Çözüm tarihi: ${new Date(kayit.cozum_tarihi).toLocaleDateString('tr-TR')}`
          : `Kayıt tarihi: ${new Date(kayit.olusturma).toLocaleDateString('tr-TR')}`));
      return;
    }
    // Eşleşme deseni tuttu ama kayıt yoksa: yanlış numara olabilir de,
    // metnin içinde tesadüfen benzer bir şey geçiyor olabilir. Mesajı
    // yapay zekaya bırakıyoruz — akış aşağıdan devam eder.
  }

  // ---- 5. Yapay zeka analizi ---------------------------------------
  const [kategoriler, mahalleler, gecmis] = await Promise.all([
    db.aktifKategoriler(),
    db.mahalleler(),
    db.sonKonusmalar(vatandas.id, 10),
  ]);

  // Numara bu konuşmada daha önce istendi mi? (ısrar etmemek için)
  const telefonSoruldu = gecmis.some(g =>
    g.rol === 'ai' && /telefon numaran/i.test(g.metin ?? ''));

  let analiz;
  try {
    analiz = await analizEt({
      gecmis, mesaj: metin, kategoriler, mahalleler,
      telefonVar: Boolean(vatandas.iletisim_telefon),
      telefonSoruldu,
    });
  } catch (hata) {
    if (!(hata instanceof YapayZekaErisilemedi)) throw hata;

    // YAPAY ZEKA SERVİSİ ÇALIŞMIYOR.
    // Kaydı yine de açıyoruz: sınıflandırılmamış olarak triyaja düşer.
    // İlke: DOĞRU SINIFLANDIRMAK, KAYDI HİÇ AÇMAMAKTAN daha az önemlidir.
    console.error('[YEDEK MOD] Yapay zeka devre dışı, kayıt triyaja açılıyor:', hata.message);

    const yedek = await kayitOlustur({
      vatandas, metin, medyaYolu, gelen, kategoriler, mahalleler,
      analiz: {
        tip: 'sikayet',
        acil: false,
        guven: 0,
        gerekce: 'Yapay zeka servisine ulaşılamadı — insan sınıflandırması bekliyor.',
        ozet: (metin ?? '').slice(0, 300),
        baslik: (metin ?? '').slice(0, 80),
        kategori_kodu: null,
        mahalle: null,
        sokak: null,
        adres: null,
        oncelik: 'normal',
      },
    });

    await yanitla(vatandas, gelen,
      `Bildiriminizi aldım, takip numaranız ${yedek.takip_no}.\n\n` +
      `Sistemde şu an geçici bir yoğunluk var; kaydınız açıldı, en kısa sürede ` +
      `ilgili müdürlüğe yönlendirilecek.`);
    return;
  }

  if (!analiz) {
    await yanitla(vatandas, gelen,
      'Mesajınızı tam anlayamadım, tekrar yazar mısınız? Sorunun ne olduğunu ve ' +
      'nerede olduğunu yazmanız yeterli.');
    return;
  }

  // ---- 5b. Telefon numarası yakalandıysa kaydet ---------------------
  // Hem yapay zekanın çıkardığı numarayı hem de metindeki ham deseni dener.
  if (!vatandas.iletisim_telefon) {
    const bulunan = analiz.telefon || (metin ?? '').match(TELEFON_DESENI)?.[0];
    if (bulunan) {
      const temiz = String(bulunan).replace(/\D/g, '').slice(-10); // son 10 hane
      if (temiz.length === 10) {
        try {
          await db.iletisimTelefonuKaydet(vatandas.id, '0' + temiz);
          vatandas.iletisim_telefon = '0' + temiz;
        } catch (hata) {
          console.error('[UYARI] İletişim telefonu kaydedilemedi:', hata.message);
        }
      }
    }
  }

  // ---- 6. ACİL DURUM ------------------------------------------------
  if (analiz.acil) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    const kayit = await kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                                       kategoriler, mahalleler, acil: true });
    await birimeBildir(kayit, { acil: true });
    return;
  }

  // ---- 7. Şikayet değilse -------------------------------------------
  if (['bilgi', 'tesekkur', 'ilgisiz'].includes(analiz.tip)) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    return;   // iş emri açılmaz — panel sahte sayıyla dolmasın
  }

  // ---- 8. Bilgi eksikse sor -----------------------------------------
  if (!analiz.yeterli_bilgi) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    return;   // konuşma devam eder, bir sonraki mesajda tekrar analiz
  }

  // ---- 9. Mükerrer kontrolü -----------------------------------------
  const kategori = kategoriler.find(k => k.kod === analiz.kategori_kodu);
  const mahalle = await mahalleCoz(analiz, mahalleler);

  if (kategori) {
    const adaylar = await db.benzerSikayetler({
      kategori_id: kategori.id,
      mahalle_id: mahalle?.id ?? null,
      ozet: analiz.ozet ?? metin ?? '',
      gun: Number(ayarlar.mukerrer_gun ?? 15),
      esik: Number(ayarlar.mukerrer_benzerlik ?? 0.35),
    });

    // Mükerrer kontrolü başarısız olursa akışı durdurmuyoruz: ayrı bir kayıt
    // açmak, talebi tamamen kaybetmekten iyidir.
    let ayniTakipNo = null;
    try {
      ayniTakipNo = await mukerrerMi(analiz.ozet, adaylar);
    } catch (hata) {
      console.error('[UYARI] Mükerrer kontrolü yapılamadı, ayrı kayıt açılıyor:', hata.message);
    }

    if (ayniTakipNo) {
      const ana = await db.sikayetGetirTakipNo(ayniTakipNo);
      await db.destekleyenEkle(ana.id, vatandas.id, analiz.ozet, gelen.kanal);
      await yanitla(vatandas, gelen,
        `Bu sorun daha önce bildirilmiş, ${ana.takip_no} numarasıyla takip ediliyor. ` +
        `Sizin bildiriminizi de aynı kayda ekledim — aynı sorunu bildiren kişi sayısı ` +
        `arttıkça önceliği yükseliyor.\n\nDurum: ${durumMetni(ana.durum)}`);
      return;
    }
  }

  // ---- 10. Kaydı oluştur ---------------------------------------------
  const kayit = await kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                                     kategoriler, mahalleler, mahalle });

  // ---- 11. Vatandaşa dön ---------------------------------------------
  if (kategori?.yetki_disi) {
    await yanitla(vatandas, gelen,
      `${kategori.yonlendirme_metni}\n\nKaydınızı yine de açtım, takip numaranız ${kayit.takip_no}.`);
  } else {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj?.trim()
      ? `${analiz.vatandasa_mesaj}\n\nTakip numaranız: ${kayit.takip_no}`
      : `Bildiriminizi aldım, ${kayit.birim_adi ?? 'ilgili müdürlüğe'} iletiyorum.\n\n` +
        `Takip numaranız: ${kayit.takip_no}\n` +
        `Durumunu öğrenmek için bu numarayı bana yazmanız yeterli.`);
    await birimeBildir(kayit);
  }
}

// ---------------------------------------------------------------------

/**
 * Mahalleyi çözer. Vatandaş mahalle söylemediyse ama sokak söylediyse,
 * sokak tablosundan mahalleyi bulmaya çalışır.
 * Sokak tablosu boşsa sessizce null döner — sistem yine çalışır.
 */
async function mahalleCoz(analiz, mahalleler) {
  const dogrudan = mahalleler.find(m =>
    m.ad === analiz.mahalle || (m.esanlamlar ?? []).includes(analiz.mahalle));
  if (dogrudan) return dogrudan;

  if (analiz.sokak && typeof db.sokaktanMahalleBul === 'function') {
    try {
      const mahalleId = await db.sokaktanMahalleBul(analiz.sokak);
      if (mahalleId) return mahalleler.find(m => m.id === mahalleId) ?? null;
    } catch (hata) {
      console.error('[UYARI] Sokaktan mahalle bulunamadı:', hata.message);
    }
  }
  return null;
}

async function kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                              kategoriler, mahalleler, mahalle, acil = false }) {
  const ayarlar = await db.ayarlariGetir();
  const kategori = kategoriler.find(k => k.kod === analiz.kategori_kodu);
  const cozulmusMahalle = mahalle !== undefined
    ? mahalle
    : await mahalleCoz(analiz, mahalleler);

  const guvenEsigi = Number(ayarlar.ai_guven_esigi ?? 0.75);
  const guvenliMi = kategori && (analiz.guven ?? 0) >= guvenEsigi;

  // Güven düşükse otomatik atama YOK — triyaj havuzuna
  const durum = acil ? 'yeni'
              : kategori?.yetki_disi ? 'havale'
              : guvenliMi ? 'yeni'
              : 'triyaj';

  // Sokak bilgisi adres alanına da yazılır ki panelde kaybolmasın
  const adresMetni = [analiz.sokak, analiz.adres].filter(Boolean).join(', ') || null;

  const kayit = await db.sikayetOlustur({
    kanal: gelen.kanal,
    tip: analiz.tip,
    vatandas_id: vatandas.id,
    ham_metin: metin,
    ozet: analiz.ozet,
    baslik: analiz.baslik,
    kategori_id: guvenliMi ? kategori.id : null,
    birim_id: guvenliMi ? kategori.birim_id : null,
    oncelik: acil ? 'kritik' : (analiz.oncelik ?? 'normal'),
    acil,
    ai_guven: analiz.guven,
    ai_gerekce: analiz.gerekce,
    ai_model: process.env.MODEL_SOHBET,
    mahalle_id: cozulmusMahalle?.id ?? null,
    mahalle_metin: analiz.mahalle ?? cozulmusMahalle?.ad ?? null,
    adres: adresMetni,
    konum_lat: gelen.konum?.lat ?? null,
    konum_lng: gelen.konum?.lng ?? null,
    durum,
    moderasyon: analiz.moderasyon ?? false,
    havale_kurum: kategori?.yetki_disi ? kategori.sorumlu_kurum : null,
    havale_tarih: kategori?.yetki_disi ? new Date().toISOString() : null,
  });

  if (medyaYolu) {
    await db.ekEkle(kayit.id, medyaYolu, gelen.tip === 'audio' ? 'ses' : 'foto', metin);
  }
  await db.hareketEkle(kayit.id, 'ai', 'olusturuldu',
    `Kategori: ${analiz.kategori_kodu ?? 'belirsiz'} (güven ${analiz.guven}) — ${analiz.gerekce}`);

  return kayit;
}

async function yanitla(vatandas, gelen, metin) {
  await KANALLAR[gelen.kanal].gonder(gelen.hedefId, metin);
  await db.konusmaKaydet({
    vatandas_id: vatandas.id, yon: 'giden', rol: 'ai', mesaj: metin,
  });
}

function durumMetni(d) {
  return ({
    triyaj: 'Değerlendiriliyor', yeni: 'İlgili müdürlüğe iletildi',
    atandi: 'Müdürlüğe atandı', islemde: 'İşleme alındı',
    beklemede: 'Beklemede', havale: 'İlgili kuruma havale edildi',
    cozuldu: 'Çözüldü, onayınız bekleniyor', kapandi: 'Kapandı',
    tekrar_acildi: 'Yeniden açıldı', reddedildi: 'İşleme alınamadı',
  })[d] ?? d;
}
