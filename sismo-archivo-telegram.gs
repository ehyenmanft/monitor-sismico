/**
 * ============================================================
 *  ARCHIVO SÍSMICO + ALERTAS TELEGRAM — Google Apps Script
 * ============================================================
 *  Vigila cada 5 minutos las fuentes (FUNVISIS + USGS), guarda
 *  todo evento nuevo en una hoja de cálculo (tu catálogo histórico
 *  propio) y PUBLICA EN UN CANAL DE TELEGRAM cada sismo relevante,
 *  con vista satelital del epicentro, pin de mapa interactivo,
 *  enlace directo al evento en la web y validación cruzada entre
 *  redes sismológicas (FUNVISIS vs USGS). Funciona 24/7 en los
 *  servidores de Google, sin depender de tu computadora.
 *
 *  ⚠ IMPORTANTE: este archivo se agrega como SEGUNDO archivo
 *  en el MISMO proyecto donde ya está funvisis-proxy.gs
 *  (reutiliza sus funciones obtenerDatos y normalizar).
 *
 *  INSTALACIÓN:
 *  1. Abre tu proyecto del proxy en script.google.com
 *  2. En el panel izquierdo: Archivos → + → Secuencia de comandos
 *     Nómbralo "archivo-telegram" y pega este contenido
 *  3. Crea tu bot de Telegram:
 *       En Telegram, habla con @BotFather → /newbot → te da un TOKEN
 *  4. Crea el CANAL público:
 *       a. Telegram → menú → Nuevo canal → ponle nombre
 *          (ej. "SISMO·MONITOR Venezuela") y hazlo PÚBLICO
 *       b. Elige un enlace/usuario, por ejemplo @sismomonitorve
 *       c. Canal → Administradores → Agregar administrador → busca tu bot
 *          y dale permiso de "Publicar mensajes"  ← IMPRESCINDIBLE
 *  5. Pega TOKEN y TELEGRAM_CANAL abajo en CONFIG y ajusta los criterios
 *  6. Ejecuta ▶ configurarArchivo  → crea la hoja de cálculo
 *  7. Ejecuta ▶ probarCanal        → debe publicarse un sismo de prueba
 *  8. Ejecuta ▶ instalarTrigger    → activa la vigilancia cada 5 min
 *  9. Comparte t.me/tucanal para que la gente se suscriba
 *
 *  Para detener la vigilancia: ejecuta desinstalarTrigger.
 * ============================================================
 */

var CONFIG = {
  // --- Telegram ---
  TELEGRAM_TOKEN: 'PEGA_AQUI_TU_TOKEN',

  // Canal público: los suscriptores reciben cada sismo relevante.
  // Usa @nombredelcanal (si es público) o el id numérico -100xxxxxxxxxx.
  TELEGRAM_CANAL: '@PEGA_AQUI_TU_CANAL',

  // Chat privado (opcional): alertas personales solo para ti.
  // Déjalo vacío si solo quieres publicar en el canal.
  TELEGRAM_CHAT_ID: '',

  // --- Criterios de publicación en el CANAL ---
  CANAL_VEN_MAG_MIN: 3.0,      // sismos dentro de ZONA_LOCAL (ver abajo)
  CANAL_MUNDO_MAG_MIN: 7.0,    // fuera de la zona: solo grandes terremotos.
                               // Se deja en 7.0 (y no en 99) a propósito: un M7+
                               // en la fosa de Puerto Rico o el Atlántico puede
                               // implicar aviso de tsunami para la costa venezolana.
  CANAL_CON_IMAGEN: true,      // adjuntar vista satelital del epicentro
  CANAL_CON_MAPA: true,        // adjuntar pin de mapa interactivo de Telegram

  // --- Criterios de alerta PRIVADA (solo si TELEGRAM_CHAT_ID está definido) ---
  ALERTA_MAG_MIN: 4.0,
  ALERTA_LAT: 10.48,       // tu ubicación (por defecto: Caracas)
  ALERTA_LON: -66.90,
  ALERTA_RADIO_KM: 500,    // 0 = sin filtro de distancia

  // --- Enlace a la web (para los enlaces profundos de cada evento) ---
  WEB_URL: 'https://ehyenmanft.github.io/monitor-sismico/',

  // --- Archivo ---
  ARCHIVAR_TODO: true      // true: guarda TODOS los eventos en la hoja
};

// Zona de cobertura del canal: Venezuela, su mar Caribe y las Antillas cercanas
// (incluye Aruba–Curazao–Bonaire, Trinidad y Tobago, Granada y Barbados).
// Queda fuera: República Dominicana, Puerto Rico, Colombia y el Caribe occidental.
var ZONA_LOCAL = {minlat: 0.5, maxlat: 14.5, minlon: -73.5, maxlon: -59};

// El nido sísmico de Bucaramanga (Colombia) roza el borde oeste del recuadro y
// produce sismos M3–4 casi a diario. Se omiten del canal salvo que sean
// significativos (M 4.5+), magnitud a la que sí se sienten en Táchira y Zulia.
var EXCLUIR_NIDO = {minlat: 6.0, maxlat: 7.6, minlon: -74.2, maxlon: -72.4};
var EXCLUIR_NIDO_BAJO = 4.5;

var URL_USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

/* ================= función principal (la del trigger) ================= */

function vigilarSismos() {
  var eventos = [];

  // FUNVISIS — reutiliza las funciones del archivo funvisis-proxy.gs
  try {
    var fv = normalizar(obtenerDatos(false));
    (fv.features || []).forEach(function (f) {
      var p = f.properties;
      var t = new Date(convertirFechaVE_(p.date, p.time));
      if (isNaN(t.getTime())) return;
      eventos.push({
        id: 'fv-' + p.date + '-' + p.time + '-' + p.lat + '-' + p.long,
        fuente: 'FUNVISIS',
        t: t,
        mag: parseFloat(p.value),
        lat: parseFloat(p.lat),
        lon: parseFloat(p.long),
        prof: parseFloat(p.depth) || 0,
        lugar: (p.addressFormatted || '—') + ', Venezuela'
      });
    });
  } catch (err) {
    Logger.log('FUNVISIS falló: ' + err);
  }

  // USGS
  try {
    var resp = UrlFetchApp.fetch(URL_USGS, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var gj = JSON.parse(resp.getContentText());
      (gj.features || []).forEach(function (f) {
        if (f.properties.mag == null) return;
        eventos.push({
          id: f.id,
          fuente: 'USGS',
          t: new Date(f.properties.time),
          mag: f.properties.mag,
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          prof: f.geometry.coordinates[2] || 0,
          lugar: f.properties.place || '—',
          tsunami: f.properties.tsunami === 1,   // hay información de tsunami asociada
          pager: f.properties.alert || null,     // impacto estimado: green/yellow/orange/red
          felt: f.properties.felt || null        // reportes de personas que lo sintieron
        });
      });
    }
  } catch (err) {
    Logger.log('USGS falló: ' + err);
  }

  if (!eventos.length) { Logger.log('Sin datos de ninguna fuente.'); return; }

  // detectar eventos no vistos
  var props = PropertiesService.getScriptProperties();
  var vistos = [];
  try { vistos = JSON.parse(props.getProperty('ids_vistos') || '[]'); } catch (e) {}
  var setVistos = {};
  vistos.forEach(function (id) { setVistos[id] = true; });

  var nuevos = eventos.filter(function (e) { return !setVistos[e.id]; });

  // primera ejecución: registrar el histórico sin alertar
  var primeraVez = props.getProperty('inicializado') !== '1';

  if (nuevos.length) {
    // archivar
    var aGuardar = CONFIG.ARCHIVAR_TODO ? nuevos : nuevos.filter(cumpleCriterios_);
    if (aGuardar.length) archivar_(aGuardar);

    // publicar y alertar (nunca en la primera ejecución)
    if (!primeraVez) {
      // 1) CANAL público: sismos relevantes, con validación cruzada entre fuentes
      nuevos.filter(esParaCanal_)
            .sort(function (a, b) { return b.mag - a.mag; })
            .slice(0, 4)
            .forEach(function (e) {
              publicarEnCanal_(e, cruzarFuentes_(e, eventos));
            });

      // 2) Alerta PRIVADA (si configuraste un chat personal)
      if (CONFIG.TELEGRAM_CHAT_ID) {
        nuevos.filter(cumpleCriterios_)
              .sort(function (a, b) { return b.mag - a.mag; })
              .slice(0, 5)
              .forEach(function (e) { enviarTelegram_(e, CONFIG.TELEGRAM_CHAT_ID); });
      }
    }
  }

  // actualizar memoria de ids (mantener los últimos 4000)
  nuevos.forEach(function (e) { vistos.push(e.id); });
  if (vistos.length > 4000) vistos = vistos.slice(vistos.length - 4000);
  props.setProperty('ids_vistos', JSON.stringify(vistos));
  props.setProperty('inicializado', '1');

  Logger.log('Eventos: ' + eventos.length + ' · nuevos: ' + nuevos.length +
             (primeraVez ? ' (primera ejecución: sin alertas)' : ''));
}

/* ================= criterios y utilidades ================= */

/** ¿Este sismo merece publicarse en el canal? */
function esParaCanal_(e) {
  // ruido diario del nido de Bucaramanga: fuera del canal salvo que sea fuerte
  if (e.mag < EXCLUIR_NIDO_BAJO &&
      e.lat >= EXCLUIR_NIDO.minlat && e.lat <= EXCLUIR_NIDO.maxlat &&
      e.lon >= EXCLUIR_NIDO.minlon && e.lon <= EXCLUIR_NIDO.maxlon) return false;

  var local = e.lat >= ZONA_LOCAL.minlat && e.lat <= ZONA_LOCAL.maxlat &&
              e.lon >= ZONA_LOCAL.minlon && e.lon <= ZONA_LOCAL.maxlon;
  return e.mag >= (local ? CONFIG.CANAL_VEN_MAG_MIN : CONFIG.CANAL_MUNDO_MAG_MIN);
}

/**
 * Validación cruzada: busca el mismo sismo reportado por OTRA red
 * (misma ventana de 10 min y menos de 0.5° de separación).
 * Permite publicar "FUNVISIS M 4.0 · USGS M 4.2", que es la mejor
 * señal de fiabilidad que puede dar el canal.
 */
function cruzarFuentes_(e, todos) {
  for (var i = 0; i < todos.length; i++) {
    var o = todos[i];
    if (o.fuente === e.fuente) continue;
    if (Math.abs(o.t.getTime() - e.t.getTime()) < 10 * 60 * 1000 &&
        Math.abs(o.lat - e.lat) < 0.5 &&
        Math.abs(o.lon - e.lon) < 0.5) return o;
  }
  return null;
}

function cumpleCriterios_(e) {
  if (e.mag < CONFIG.ALERTA_MAG_MIN) return false;
  if (!CONFIG.ALERTA_RADIO_KM) return true;
  return distanciaKm_(CONFIG.ALERTA_LAT, CONFIG.ALERTA_LON, e.lat, e.lon) <= CONFIG.ALERTA_RADIO_KM;
}

function distanciaKm_(lat1, lon1, lat2, lon2) {
  var R = 6371, rad = Math.PI / 180;
  var dLa = (lat2 - lat1) * rad, dLo = (lon2 - lon1) * rad;
  var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
          Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function convertirFechaVE_(fecha, hora) {
  // "19-07-2026" + "09:24" (hora de Venezuela, UTC-4) → ISO
  if (!fecha) return 'invalid';
  var p = String(fecha).split('-');
  if (p.length !== 3) return 'invalid';
  return p[2] + '-' + p[1] + '-' + p[0] + 'T' + (hora || '00:00') + ':00-04:00';
}

/* ================= archivo en hoja de cálculo ================= */

function archivar_(eventos) {
  var hoja = obtenerHoja_();
  var filas = eventos.map(function (e) {
    return [
      e.id, e.fuente, e.t.toISOString(), e.mag, e.lat, e.lon, e.prof,
      e.lugar, new Date().toISOString()
    ];
  });
  hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);
}

function obtenerHoja_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('spreadsheet_id');
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Archivo Sísmico — SISMO·MONITOR');
    props.setProperty('spreadsheet_id', ss.getId());
    var h = ss.getActiveSheet();
    h.setName('eventos');
    h.appendRow(['id', 'fuente', 'fecha_hora_utc', 'magnitud', 'lat', 'lon',
                 'profundidad_km', 'lugar', 'registrado_en']);
    h.setFrozenRows(1);
  }
  return ss.getSheetByName('eventos') || ss.getActiveSheet();
}

/* ================= Telegram ================= */

/** Vista satelital del epicentro (Esri World Imagery, sin clave de API). */
function urlSatelite_(lat, lon) {
  var d = 0.55; // ~60 km de lado
  return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'
       + '?bbox=' + (lon - d) + ',' + (lat - d) + ',' + (lon + d) + ',' + (lat + d)
       + '&bboxSR=4326&size=900,700&format=png&f=image';
}

/** Texto del mensaje, con validación cruzada si existe. */
function textoEvento_(e, cruce) {
  var emoji = e.mag >= 6 ? '🔴' : e.mag >= 5 ? '🟠' : e.mag >= 4 ? '🟡' : '🟢';
  var hora = Utilities.formatDate(e.t, 'America/Caracas', 'dd/MM/yyyy HH:mm');

  var txt = emoji + ' *SISMO M ' + e.mag.toFixed(1) + '*\n'
          + '📍 ' + e.lugar + '\n'
          + '🕐 ' + hora + ' (hora de Venezuela)\n'
          + '⬇ Profundidad: ' + e.prof.toFixed(0) + ' km\n';

  // avisos de tsunami e impacto: si el cruce (USGS) los trae, no se pierden
  var tsunami = e.tsunami || (cruce && cruce.tsunami);
  var pager   = e.pager   || (cruce && cruce.pager);
  var felt    = e.felt    || (cruce && cruce.felt);

  if (tsunami) {
    txt += '\n🌊 *INFORMACIÓN DE TSUNAMI*\n'
         + 'Este sismo ocurrió en una zona donde puede aplicar un aviso de tsunami.\n'
         + '👉 Boletín oficial: https://www.tsunami.gov\n'
         + '_Si estás en la costa y el sismo fue fuerte o largo, no esperes avisos: aléjate hacia zonas altas y sigue a Protección Civil._\n';
  }
  if (pager) {
    var nivel = {
      green:  '🟢 Sin impacto significativo esperado',
      yellow: '🟡 Posible impacto local',
      orange: '🟠 Posible impacto regional',
      red:    '🔴 Posible impacto extenso'
    }[pager];
    if (nivel) txt += '📉 Impacto estimado (PAGER): ' + nivel + '\n';
  }
  if (felt) {
    txt += '🙋 ' + felt + ' persona(s) reportaron sentirlo\n';
  }

  // validación cruzada entre redes sismológicas
  if (cruce) {
    txt += '✅ *Confirmado por dos redes:* '
         + e.fuente + ' M ' + e.mag.toFixed(1) + ' · '
         + cruce.fuente + ' M ' + cruce.mag.toFixed(1) + '\n';
    var dif = Math.abs(cruce.mag - e.mag);
    if (dif >= 0.5) {
      txt += '   _(diferencia de ' + dif.toFixed(1) + ' entre redes: las magnitudes se recalculan en las horas siguientes)_\n';
    }
  } else {
    txt += 'ℹ️ Reporte preliminar de ' + e.fuente + ' (aún sin confirmación de otra red)\n';
  }

  txt += '\n🌍 Verlo en SISMO·MONITOR:\n' + CONFIG.WEB_URL + '#evento=' + e.id;
  return txt;
}

/** Publica el evento en el canal: imagen satelital + datos + pin de mapa. */
function publicarEnCanal_(e, cruce) {
  var destino = CONFIG.TELEGRAM_CANAL;
  if (!destino || destino.indexOf('PEGA_AQUI') === 0) return;

  var texto = textoEvento_(e, cruce);
  var enviado = false;

  // 1) intento con foto satelital + pie de foto
  if (CONFIG.CANAL_CON_IMAGEN) {
    var r = apiTelegram_('sendPhoto', {
      chat_id: destino,
      photo: urlSatelite_(e.lat, e.lon),
      caption: texto,
      parse_mode: 'Markdown'
    });
    enviado = r && r.ok;
    if (!enviado) Logger.log('sendPhoto falló, se envía solo texto: ' + JSON.stringify(r));
  }

  // 2) respaldo: mensaje de texto (si la imagen no se pudo adjuntar)
  if (!enviado) {
    apiTelegram_('sendMessage', {
      chat_id: destino, text: texto,
      parse_mode: 'Markdown', disable_web_page_preview: false
    });
  }

  // 3) pin de mapa interactivo: el suscriptor mide su distancia real al epicentro
  if (CONFIG.CANAL_CON_MAPA) {
    apiTelegram_('sendLocation', {
      chat_id: destino, latitude: e.lat, longitude: e.lon
    });
  }
}

/** Alerta privada (chat personal), con distancia a tu ubicación. */
function enviarTelegram_(e, destino) {
  destino = destino || CONFIG.TELEGRAM_CHAT_ID;
  if (!destino) return;
  var dist = CONFIG.ALERTA_RADIO_KM
    ? '\n📏 A ' + Math.round(distanciaKm_(CONFIG.ALERTA_LAT, CONFIG.ALERTA_LON, e.lat, e.lon)) + ' km de tu ubicación'
    : '';
  var texto = textoEvento_(e, null).replace('\n\n🌍', dist + '\n\n🌍');
  apiTelegram_('sendMessage', {
    chat_id: destino, text: texto,
    parse_mode: 'Markdown', disable_web_page_preview: true
  });
}

/** Llamada a la API de Telegram con registro del resultado. */
function apiTelegram_(metodo, cuerpo) {
  if (CONFIG.TELEGRAM_TOKEN.indexOf('PEGA_AQUI') === 0) return null;
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + metodo, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(cuerpo), muteHttpExceptions: true
      });
    var out = JSON.parse(resp.getContentText());
    if (!out.ok) Logger.log('Telegram ' + metodo + ' → ' + resp.getContentText());
    return out;
  } catch (err) {
    Logger.log('Telegram ' + metodo + ' falló: ' + err);
    return null;
  }
}

/* ================= API del archivo histórico ================= */
/**
 * Sirve el catálogo histórico de la hoja de cálculo como JSON.
 * Se invoca desde el doGet de funvisis-proxy.gs con ?archivo=1
 *
 * Parámetros aceptados:
 *   ?archivo=1&dias=30        ventana en días (máximo 90, por defecto 30)
 *   &minmag=2.5               magnitud mínima (opcional)
 *   &fuente=FUNVISIS          filtrar por una fuente (opcional)
 *   &id=<id>                  buscar un evento concreto (para enlaces compartidos)
 *
 * Respuesta compacta (filas como arrays, para reducir el peso):
 *   { source:'archivo', desde:<ISO>, count:n,
 *     cols:['id','fuente','t','mag','lat','lon','prof','lugar'],
 *     rows:[[...], ...] }
 */
function servirArchivo(params) {
  // Envoltorio a prueba de fallos: si algo lanza una excepción, Apps Script
  // devolvería una página HTML de error y el navegador lo reportaría como
  // un problema de CORS. Devolviendo siempre JSON, el fallo es diagnosticable.
  try {
    return servirArchivoInterno_(params);
  } catch (err) {
    return jsonSalida_(JSON.stringify({
      source: 'archivo', error: String(err), count: 0, rows: []
    }));
  }
}

function servirArchivoInterno_(params) {
  var dias   = Math.min(parseInt(params.dias || '30', 10) || 30, 90);
  var minMag = parseFloat(params.minmag || '0') || 0;
  var fuente = (params.fuente || '').toUpperCase();
  var buscarId = params.id || '';

  var clave = 'arch|' + dias + '|' + minMag + '|' + fuente + '|' + buscarId;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(clave);
  if (hit) return jsonSalida_(hit);

  var desde = Date.now() - dias * 86400000;
  var rows = [];

  try {
    var hoja = obtenerHoja_();
    var datos = hoja.getDataRange().getValues();
    // columnas: id, fuente, fecha_hora_utc, magnitud, lat, lon, prof, lugar, registrado_en
    for (var i = 1; i < datos.length; i++) {
      var f = datos[i];
      if (!f[0]) continue;

      if (buscarId) {
        if (String(f[0]) !== buscarId) continue;
      } else {
        var t = new Date(f[2]).getTime();
        if (!t || t < desde) continue;
        if (minMag && Number(f[3]) < minMag) continue;
        if (fuente && String(f[1]).toUpperCase() !== fuente) continue;
      }

      rows.push([
        String(f[0]),                 // id
        String(f[1]),                 // fuente
        new Date(f[2]).getTime(),     // t (epoch ms)
        Number(f[3]),                 // magnitud
        Number(f[4]),                 // lat
        Number(f[5]),                 // lon
        Number(f[6]) || 0,            // profundidad
        String(f[7] || '—')           // lugar
      ]);
      if (rows.length >= 12000) break; // tope de seguridad
    }
  } catch (err) {
    return jsonSalida_(JSON.stringify({
      source: 'archivo', error: String(err), count: 0, rows: []
    }));
  }

  rows.sort(function (a, b) { return b[2] - a[2]; }); // más reciente primero

  var salida = JSON.stringify({
    source: 'archivo',
    desde: new Date(desde).toISOString(),
    count: rows.length,
    cols: ['id', 'fuente', 't', 'mag', 'lat', 'lon', 'prof', 'lugar'],
    rows: rows
  });

  // CacheService admite ~100 KB por clave: cachear solo si cabe
  if (salida.length < 90000) {
    try { cache.put(clave, salida, 300); } catch (e) {}
  }
  return jsonSalida_(salida);
}

function jsonSalida_(texto) {
  return ContentService.createTextOutput(texto)
                       .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Prueba manual del endpoint del archivo (ejecutar desde el editor).
 */
function probarArchivo() {
  var r = JSON.parse(servirArchivo({ dias: '30' }).getContent());
  if (r.error) { Logger.log('❌ ERROR: ' + r.error); return; }
  Logger.log('Eventos en los últimos 30 días: ' + r.count);
  if (r.rows.length) Logger.log('Más reciente: ' + JSON.stringify(r.rows[0]));
  var fv = JSON.parse(servirArchivo({ dias: '30', fuente: 'FUNVISIS' }).getContent());
  Logger.log('De ellos, FUNVISIS: ' + fv.count);

  // salud del sistema: filas totales y estado del activador
  try {
    var hoja = obtenerHoja_();
    Logger.log('Filas totales en la hoja: ' + (hoja.getLastRow() - 1));
  } catch (e) { Logger.log('No se pudo leer la hoja: ' + e); }
  var trg = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'vigilarSismos';
  });
  Logger.log(trg.length ? '✓ Activador instalado (vigilancia activa)'
                        : '❌ SIN ACTIVADOR: ejecuta instalarTrigger');
}

/* ================= configuración y pruebas ================= */

function configurarArchivo() {
  var hoja = obtenerHoja_();
  var url = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('spreadsheet_id')
  ).getUrl();
  Logger.log('✓ Archivo listo. Tu catálogo histórico está en:\n' + url);
}

var EVENTO_PRUEBA = {
  id: 'prueba', mag: 4.3, lugar: '12 km al norte de La Guaira, Venezuela',
  t: new Date(), prof: 8.5, fuente: 'FUNVISIS', lat: 10.71, lon: -66.93
};
var CRUCE_PRUEBA = { fuente: 'USGS', mag: 4.5, t: new Date(), lat: 10.72, lon: -66.95,
                     tsunami: true, pager: 'yellow', felt: 143 };

/** Publica un evento de prueba EN EL CANAL (revisa el registro si falla). */
function probarCanal() {
  publicarEnCanal_(EVENTO_PRUEBA, CRUCE_PRUEBA);
  Logger.log('Publicación de prueba enviada al canal ' + CONFIG.TELEGRAM_CANAL +
             '. Si no aparece, revisa arriba la respuesta de Telegram.');
}

/** Envía una alerta de prueba al chat PRIVADO (si lo configuraste). */
function probarTelegram() {
  if (!CONFIG.TELEGRAM_CHAT_ID) {
    Logger.log('TELEGRAM_CHAT_ID está vacío: solo se publica en el canal. Usa probarCanal.');
    return;
  }
  enviarTelegram_(EVENTO_PRUEBA);
  Logger.log('Mensaje privado de prueba enviado. Revisa tu Telegram.');
}

function instalarTrigger() {
  desinstalarTrigger();
  ScriptApp.newTrigger('vigilarSismos').timeBased().everyMinutes(5).create();
  Logger.log('✓ Vigilancia activa: vigilarSismos se ejecutará cada 5 minutos, 24/7.');
}

function desinstalarTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'vigilarSismos') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Vigilancia detenida.');
}
