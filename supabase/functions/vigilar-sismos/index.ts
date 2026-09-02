// ============================================================
//  EDGE FUNCTION SUPABASE: vigilar-sismos
// ============================================================
//  Ingesta 24/7 de FUNVISIS + USGS + EMSC, archivo en PostgreSQL
//  y alertas inteligentes con deduplicación en Telegram.
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

interface SismoItem {
  id: string;
  fuente: string;
  fecha_hora_utc: string;
  t_epoch: number;
  magnitud: number;
  lat: number;
  lon: number;
  profundidad_km: number;
  lugar: string;
  pais: string;
  tsunami?: boolean;
  pager?: string | null;
  felt?: number | null;
  url?: string;
}

// Configuración y criterios de alerta
const CONFIG = {
  CANAL_VEN_MAG_MIN: 2.6,
  CANAL_MUNDO_MAG_MIN: 7.0,
  CANAL_CON_IMAGEN: true,
  CANAL_CON_MAPA: true,
  WEB_URL: Deno.env.get("WEB_URL") || "https://ehyenmanft.github.io/monitor-sismico/",
};

// Zona de cobertura regional (Venezuela, Caribe, Antillas)
const ZONA_LOCAL = { minlat: 0.5, maxlat: 14.5, minlon: -73.5, maxlon: -59.0 };
const EXCLUIR_NIDO = { minlat: 6.0, maxlat: 7.6, minlon: -74.2, maxlon: -72.4 };
const EXCLUIR_NIDO_BAJO = 4.5;

const REF_PAIS: Record<string, string> = {
  bucaramanga: "Colombia", "santa marta": "Colombia", cucuta: "Colombia",
  valledupar: "Colombia", riohacha: "Colombia", maicao: "Colombia",
  arauca: "Colombia", barranquilla: "Colombia",
  barbados: "Barbados", bonaire: "Países Bajos", curazao: "Países Bajos",
  aruba: "Países Bajos", trinidad: "Trinidad y Tobago",
  tobago: "Trinidad y Tobago", scarborough: "Trinidad y Tobago",
  granada: "Granada", georgetown: "Guyana",
};

function paisDeLugar(txt: string): string {
  const t = (txt || "").toLowerCase();
  for (const ref in REF_PAIS) {
    if (t.includes(ref)) return REF_PAIS[ref];
  }
  return "Venezuela";
}

function esParaCanal(e: SismoItem): boolean {
  if (
    e.magnitud < EXCLUIR_NIDO_BAJO &&
    e.lat >= EXCLUIR_NIDO.minlat && e.lat <= EXCLUIR_NIDO.maxlat &&
    e.lon >= EXCLUIR_NIDO.minlon && e.lon <= EXCLUIR_NIDO.maxlon
  ) {
    return false;
  }
  const local =
    e.lat >= ZONA_LOCAL.minlat && e.lat <= ZONA_LOCAL.maxlat &&
    e.lon >= ZONA_LOCAL.minlon && e.lon <= ZONA_LOCAL.maxlon;
  return e.magnitud >= (local ? CONFIG.CANAL_VEN_MAG_MIN : CONFIG.CANAL_MUNDO_MAG_MIN);
}

function cruzarFuentes(e: SismoItem, todos: SismoItem[]): SismoItem | null {
  for (const o of todos) {
    if (o.fuente === e.fuente) continue;
    if (
      Math.abs(o.t_epoch - e.t_epoch) < 15 * 60 * 1000 &&
      Math.abs(o.lat - e.lat) < 0.6 &&
      Math.abs(o.lon - e.lon) < 0.6
    ) {
      return o;
    }
  }
  return null;
}

// Parseo robusto de fechas
function parsearFechaVE(fecha: string, hora: string): Date | null {
  if (!fecha) return null;
  const str = String(fecha).trim();
  let horaStr = (hora ? String(hora).trim() : "00:00");
  if (horaStr.length === 5) horaStr += ":00";

  if (str.includes("T")) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const matchISO = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (matchISO) {
    const m = matchISO[2].padStart(2, "0");
    const d = matchISO[3].padStart(2, "0");
    const res = new Date(`${matchISO[1]}-${m}-${d}T${horaStr}-04:00`);
    return isNaN(res.getTime()) ? null : res;
  }
  const matchVE = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (matchVE) {
    const d = matchVE[1].padStart(2, "0");
    const m = matchVE[2].padStart(2, "0");
    const res = new Date(`${matchVE[3]}-${m}-${d}T${horaStr}-04:00`);
    return isNaN(res.getTime()) ? null : res;
  }
  const fallback = new Date(`${str} ${horaStr} GMT-0400`);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// Fetch FUNVISIS
async function fetchFUNVISIS(): Promise<SismoItem[]> {
  const urls = [
    "http://www.funvisis.gob.ve/maravilla.json",
    "https://sismosve.rafnixg.dev/api/sismos",
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 SismoMonitor/2.0" },
      });
      clearTimeout(timeoutId);

      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !data.features || !data.features.length) continue;

      const items: SismoItem[] = [];
      for (const f of data.features) {
        const p = f.properties || {};
        const g = (f.geometry && f.geometry.coordinates) || [null, null];

        const mag = parseFloat(String(p.value || p.mag || p.magnitude || p.phone || "").replace(",", "."));
        const depth = parseFloat(String(p.depth || p.profundidad || p.state || p.phoneFormatted || "0")) || 0;
        const lugar = String(p.addressFormatted || p.address || p.lugar || p.localizacion || "—");
        const fecha = String(p.date || p.fecha || p.postalCode || "");
        const hora = String(p.time || p.hora || p.city || "");
        let lat = parseFloat(String(p.lat || p.latitude || g[1] || ""));
        let lon = parseFloat(String(p.long || p.lon || p.lng || g[0] || ""));

        if (isNaN(lat) || isNaN(lon) || isNaN(mag) || mag <= 0) continue;

        const d = parsearFechaVE(fecha, hora);
        if (!d) continue;

        items.push({
          id: `fv-${fecha.replace(/[\/\s:]/g, "")}-${hora.replace(/[:\s]/g, "")}-${lat}-${lon}`,
          fuente: "FUNVISIS",
          fecha_hora_utc: d.toISOString(),
          t_epoch: d.getTime(),
          magnitud: mag,
          lat,
          lon,
          profundidad_km: depth,
          lugar: `${lugar}, ${paisDeLugar(lugar)}`,
          pais: paisDeLugar(lugar),
          url: "http://www.funvisis.gob.ve",
        });
      }
      if (items.length) return items;
    } catch (_err) {
      // Intentar el siguiente espejo
    }
  }
  return [];
}

// Fetch USGS
async function fetchUSGS(): Promise<SismoItem[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const data = await res.json();

    return (data.features || [])
      .filter((f: any) => f.properties.mag != null && f.geometry?.coordinates?.length >= 2)
      .map((f: any) => ({
        id: f.id,
        fuente: "USGS",
        fecha_hora_utc: new Date(f.properties.time).toISOString(),
        t_epoch: f.properties.time,
        magnitud: parseFloat(f.properties.mag),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        profundidad_km: parseFloat(f.geometry.coordinates[2] || "0") || 0,
        lugar: f.properties.place || "—",
        pais: paisDeLugar(f.properties.place),
        tsunami: f.properties.tsunami === 1,
        pager: f.properties.alert || null,
        felt: f.properties.felt || null,
        url: f.properties.url || "",
      }));
  } catch (_e) {
    return [];
  }
}

// Fetch EMSC
async function fetchEMSC(): Promise<SismoItem[]> {
  try {
    const desdeIso = new Date(Date.now() - 12 * 3600000).toISOString().slice(0, 19);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=100&starttime=${desdeIso}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const data = await res.json();

    return (data.features || [])
      .filter((f: any) => f.properties?.mag != null && isFinite(f.properties?.lat) && isFinite(f.properties?.lon))
      .map((f: any) => {
        const p = f.properties;
        const d = new Date(p.time);
        return {
          id: `em-${p.unid || p.source_id}`,
          fuente: "EMSC",
          fecha_hora_utc: d.toISOString(),
          t_epoch: d.getTime(),
          magnitud: parseFloat(p.mag),
          lat: parseFloat(p.lat),
          lon: parseFloat(p.lon),
          profundidad_km: parseFloat(p.depth || "0") || 0,
          lugar: p.flynn_region || "—",
          pais: paisDeLugar(p.flynn_region),
          url: `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid || ""}`,
        };
      });
  } catch (_e) {
    return [];
  }
}

// Telegram Helpers
function urlSatelite(lat: number, lon: number): string {
  const d = 0.55;
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lon - d},${lat - d},${lon + d},${lat + d}&bboxSR=4326&size=900,700&format=png&f=image`;
}

function textoTelegram(e: SismoItem, cruce: SismoItem | null): string {
  const emoji = e.magnitud >= 6 ? "🔴" : e.magnitud >= 5 ? "🟠" : e.magnitud >= 4 ? "🟡" : "🟢";
  const fechaObj = new Date(e.t_epoch);
  const horaVE = fechaObj.toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  });

  let txt = `${emoji} *SISMO M ${e.magnitud.toFixed(1)}*\n`
          + `📍 ${e.lugar}\n`
          + `🕐 ${horaVE} (hora de Venezuela)\n`
          + `⬇ Profundidad: ${e.profundidad_km.toFixed(0)} km\n`;

  const tsunami = e.tsunami || (cruce && cruce.tsunami);
  const pager = e.pager || (cruce && cruce.pager);
  const felt = e.felt || (cruce && cruce.felt);

  if (tsunami) {
    txt += `\n🌊 *INFORMACIÓN DE TSUNAMI*\n`
         + `Este sismo ocurrió en una zona donde puede aplicar un aviso de tsunami.\n`
         + `👉 Boletín oficial: https://www.tsunami.gov\n`;
  }
  if (pager) {
    const nivel: Record<string, string> = {
      green: "🟢 Sin impacto significativo esperado",
      yellow: "🟡 Posible impacto local",
      orange: "🟠 Posible impacto regional",
      red: "🔴 Posible impacto extenso",
    };
    if (nivel[pager]) txt += `📉 Impacto estimado (PAGER): ${nivel[pager]}\n`;
  }
  if (felt) {
    txt += `🙋 ${felt} persona(s) reportaron sentirlo\n`;
  }

  if (cruce) {
    txt += `✅ *Confirmado por dos redes:* ${e.fuente} M ${e.magnitud.toFixed(1)} · ${cruce.fuente} M ${cruce.magnitud.toFixed(1)}\n`;
  } else {
    txt += `ℹ️ Reporte preliminar de ${e.fuente} (aún sin confirmación de otra red)\n`;
  }

  txt += `\n🌍 Verlo en SISMO·MONITOR:\n${CONFIG.WEB_URL}#evento=${e.id}`;
  return txt;
}

async function enviarTelegram(token: string, canal: string, e: SismoItem, cruce: SismoItem | null) {
  if (!token || !canal) return;
  const texto = textoTelegram(e, cruce);

  // 1) Enviar Foto Satelital
  let enviado = false;
  if (CONFIG.CANAL_CON_IMAGEN) {
    try {
      const resFoto = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          photo: urlSatelite(e.lat, e.lon),
          caption: texto,
          parse_mode: "Markdown",
        }),
      });
      const dataFoto = await resFoto.json();
      enviado = dataFoto.ok;
    } catch (_e) {}
  }

  // 2) Fallback Texto
  if (!enviado) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          text: texto,
          parse_mode: "Markdown",
        }),
      });
    } catch (_e) {}
  }

  // 3) Pin de Ubicación
  if (CONFIG.CANAL_CON_MAPA) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendLocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: canal,
          latitude: e.lat,
          longitude: e.lon,
        }),
      });
    } catch (_e) {}
  }
}

// Manejador Principal
serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://tjzpvqhzonlajxjhwdnq.supabase.co";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
  const telegramToken = Deno.env.get("TELEGRAM_TOKEN") || "8500009636:AAGncWneX5oVcdQQiLaL90Cjx5BMy97VYYg";
  const telegramCanal = Deno.env.get("TELEGRAM_CANAL") || "@sismomonitorve";
  const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID") || "7425345074";

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Ingesta de fuentes en paralelo
  const [fun, usgs, emsc] = await Promise.all([
    fetchFUNVISIS(),
    fetchUSGS(),
    fetchEMSC(),
  ]);

  const todosEventos = [...fun, ...usgs, ...emsc];

  if (!todosEventos.length) {
    return new Response(JSON.stringify({ status: "sin_datos", count: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Guardar/actualizar en PostgreSQL
  const registrosParaDB = todosEventos.map((e) => ({
    id: e.id,
    fuente: e.fuente,
    fecha_hora_utc: e.fecha_hora_utc,
    magnitud: e.magnitud,
    lat: e.lat,
    lon: e.lon,
    profundidad_km: e.profundidad_km,
    lugar: e.lugar,
    pais: e.pais,
    tsunami: e.tsunami || false,
    pager: e.pager || null,
    felt: e.felt || null,
    url: e.url || null,
  }));

  const { error: errorUpsert } = await supabase
    .from("sismos")
    .upsert(registrosParaDB, { onConflict: "id", ignoreDuplicates: false });

  if (errorUpsert) {
    console.error("Error en upsert:", errorUpsert);
  }

  // Obtener alertas publicadas en las últimas 48 horas para deduplicar
  const hace48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data: yaPublicados } = await supabase
    .from("telegram_publicados")
    .select("id, fecha_hora_utc, lat, lon, magnitud")
    .gte("fecha_hora_utc", hace48h);

  const listaPub = yaPublicados || [];

  function yaFuePublicado(e: SismoItem): boolean {
    const eEpoch = e.t_epoch;
    for (const p of listaPub) {
      if (p.id === e.id) return true;
      const pEpoch = new Date(p.fecha_hora_utc).getTime();
      if (
        Math.abs(pEpoch - eEpoch) <= 20 * 60 * 1000 &&
        Math.abs(p.lat - e.lat) <= 0.6 &&
        Math.abs(p.lon - e.lon) <= 0.6
      ) {
        return true;
      }
    }
    return false;
  }

  // Filtrar candidatos para Telegram (últimas 2.5 horas)
  const ahora = Date.now();
  const candidatosCanal = todosEventos
    .filter((e) => ahora - e.t_epoch <= 2.5 * 3600 * 1000)
    .filter(esParaCanal)
    .filter((e) => !yaFuePublicado(e))
    .sort((a, b) => b.magnitud - a.magnitud);

  let enviados = 0;
  const enviadosEnCiclo: SismoItem[] = [];

  for (const e of candidatosCanal) {
    // Evitar enviar duplicados dentro del mismo ciclo
    const duplicadoLocal = enviadosEnCiclo.some(
      (o) =>
        Math.abs(o.t_epoch - e.t_epoch) <= 20 * 60 * 1000 &&
        Math.abs(o.lat - e.lat) <= 0.6 &&
        Math.abs(o.lon - e.lon) <= 0.6
    );
    if (duplicadoLocal) continue;

    if (enviados < 3 && telegramToken && telegramCanal) {
      const cruce = cruzarFuentes(e, todosEventos);
      await enviarTelegram(telegramToken, telegramCanal, e, cruce);

      // Registrar alerta publicada en base de datos
      await supabase.from("telegram_publicados").insert({
        id: e.id,
        sismo_id: e.id,
        fecha_hora_utc: e.fecha_hora_utc,
        lat: e.lat,
        lon: e.lon,
        magnitud: e.magnitud,
      });

      listaPub.push({
        id: e.id,
        fecha_hora_utc: e.fecha_hora_utc,
        lat: e.lat,
        lon: e.lon,
        magnitud: e.magnitud,
      });

      enviadosEnCiclo.push(e);
      enviados++;
    }
  }

  return new Response(
    JSON.stringify({
      status: "ok",
      total_ingestados: todosEventos.length,
      funvisis: fun.length,
      usgs: usgs.length,
      emsc: emsc.length,
      alertas_telegram_enviadas: enviados,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
