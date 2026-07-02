const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('oceanic.js');

// --- Konfiguration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Fehlender BOT_TOKEN Umgebungsvariable.');

const WARNUNGEN_CHANNEL = process.env.WARNUNGEN_CHANNEL || '1501843095485022350';
const STATE_FILE = path.join(__dirname, 'wetterState.json');

// Exakte URLs laut Vorgabe
const BRIGHT_SKY_ALERTS_URL = 'https://api.brightsky.dev/alerts';
const DWD_MESOCYCLONES_INDEX = 'https://opendata.dwd.de/weather/radar/mesocyclones/';

const ALERTS_INTERVAL_MS = 60 * 1000; // 60 Sekunden
const MESO_INTERVAL_MS = 5 * 60 * 1000; // 5 Minuten

// Vorhersage-Konfiguration
const VORHERSAGE_CHANNEL = process.env.VORHERSAGE_CHANNEL || '1501635539202216107';
const BRIGHT_SKY_API_BASE = 'https://api.brightsky.dev';
const BRIGHT_SKY_LAT = process.env.BRIGHT_SKY_LAT || '51.1657';
const BRIGHT_SKY_LON = process.env.BRIGHT_SKY_LON || '10.4515';

// In-memory persistent Nachricht für Vorhersage
let vorhersageNachricht = null;

// --- UTF-8 Sicherstellung ---
function ensureFetch() {
  if (typeof fetch !== 'function') {
    try {
      global.fetch = require('undici').fetch;
    } catch (e) {
      throw new Error('Fetch nicht verfügbar. Installiere "undici" oder nutze Node 18+.');
    }
  }
}
ensureFetch();

// --- State-Verwaltung ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (err) {
    console.warn('State konnte nicht geladen werden:', err && err.message ? err.message : err);
  }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('State konnte nicht gespeichert werden:', err && err.message ? err.message : err);
  }
}

// --- Health server (einmalig starten) ---
function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('WetterVorhersage-Bot läuft\n');
  }).listen(port, () => console.log(`Health-Server läuft auf Port ${port}`));
}

// --- Hilfsfunktionen ---
function safeSubstring(s, len) {
  if (!s) return '';
  return String(s).substring(0, len);
}

function buildAlertEmbed(bundesland, list) {
  // list ist ein Array von Alerts für dieses Bundesland; nutze list[0] für Titel/Beschreibung
  const primary = list[0] || {};
  const titel = primary.headline || primary.title || 'Amtliche Unwetterwarnung';
  const beschreibung = primary.description || primary.body || 'Details entnehmen Sie bitte dem Lagebericht.';
  const anweisung = primary.instruction ? `\n\n**Verhalten:** ${primary.instruction}` : '';
  const severity = primary.severity || primary.level || '';
  const stufe = severity === 'extreme' ? '🔴 EXTREM' : severity === 'severe' ? '🟠 SCHWER' : '🟡 MÄSSIG';

  const landkreiseText = list.map(a => (a.regions && Array.isArray(a.regions)) ? a.regions.join(', ') : 'Unbekannt').join(', ');

  return {
    title: `⚠️ Wetterwarnung für ${bundesland}`,
    color: severity === 'extreme' ? 0xFF0000 : severity === 'severe' ? 0xFFA500 : 0xFFD700,
    fields: [
      { name: 'Phänomen / Typ', value: safeSubstring(titel, 1024), inline: false },
      { name: 'Warnstufe', value: stufe, inline: true },
      { name: 'Details & Beschreibung', value: safeSubstring(beschreibung + anweisung, 1024), inline: false },
      { name: 'Betroffene Gebiete / Landkreise', value: safeSubstring(landkreiseText, 1024), inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Quelle: DWD / BrightSky | Ticker aktiv' }
  };
}

function buildMesoEmbed(meso) {
  // meso: { id, intensity, motionDir, motionSpeed, coords, lifetime, raw }
  const measuredIntensity = (meso.intensity !== null && meso.intensity !== undefined) ? `${meso.intensity} m/s` : 'Unbekannt';
  const motion = (meso.motionSpeed !== null && meso.motionSpeed !== undefined) ? `${meso.motionSpeed} m/s ${meso.motionDir ? `(${meso.motionDir})` : ''}` : (meso.motionDir ? `${meso.motionDir}` : 'Unbekannt');
  const coords = meso.coords || 'Unbekannt';

  // Lebensdauer schätzen (meteorologische Heuristik)
  function estimateLifetime(intensity) {
    if (intensity === null || intensity === undefined || Number.isNaN(Number(intensity))) return 'Unbekannt';
    const val = Number(intensity);
    if (val >= 20) return 'Hoch (ca. 20–45 Minuten, solange die Gewitterzelle aktiv bleibt)';
    if (val >= 10) return 'Mittel (ca. 10–30 Minuten)';
    return 'Gering (Auflösung wahrscheinlich innerhalb der nächsten 5–15 Minuten)';
  }

  const estimatedLife = estimateLifetime(meso.intensity);

  return {
    title: `🌪️ DWD Mesocyclone – ${meso.id}`,
    color: 0x990000,
    description: safeSubstring(meso.raw || '', 1900),
    fields: [
      { name: 'Messwerte (gemessen)', value: `Intensität: ${measuredIntensity}\nZugrichtung & Geschwindigkeit: ${motion}\nKoordinaten: ${coords}`, inline: false },
      { name: 'Lebensdauer (geschätzt)', value: `${estimatedLife}\n*Hinweis: Lebensdauer ist eine meteorologische Schätzung basierend auf der Rotationsstärke.*`, inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Quelle: DWD Mesocyclones' }
  };
}

// --- Vorhersage (BrightSky / /weather) ---
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

async function postForecast(client, state) {
  try {
    const date = getTodayDate();
    const url = `${BRIGHT_SKY_API_BASE}/weather?lat=${BRIGHT_SKY_LAT}&lon=${BRIGHT_SKY_LON}&date=${date}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' } });
    if (!res.ok) {
      throw new Error(`Forecast HTTP ${res.status}`);
    }
    const data = await res.json();
    const weather = data && data.weather ? data.weather : (data && data.data && data.data.weather ? data.data.weather : null);
    if (!weather || !Array.isArray(weather) || weather.length === 0) {
      throw new Error('Keine Vorhersagedaten erhalten');
    }

    // Erzeuge kompakten Embed aus stündlichen Daten (Gruppiere stichprobenartig)
    const nextHours = weather.slice(0, 24).map(h => `${h.time || h.datetime || h.hour}: ${h.temperature || h.temp || 'N/A'}°C`).join('\n');
    const embed = {
      title: `📈 Wettervorhersage (${date})`,
      description: safeSubstring(nextHours, 2000),
      color: 0x0066cc,
      timestamp: new Date().toISOString(),
      footer: { text: 'Quelle: BrightSky' }
    };

    // Channel und edit/create Logik
    const channel = await client.rest.channels.get(VORHERSAGE_CHANNEL);
    if (!channel) throw new Error('Vorhersage-Kanal nicht erreichbar');

    // Versuche edit, falls vorhanden
    if (state.vorhersageMessageId) {
      try {
        await client.rest.channels.editMessage(VORHERSAGE_CHANNEL, state.vorhersageMessageId, { embeds: [embed] });
        console.log('Wettervorhersage still aktualisiert.');
        return;
      } catch (err) {
        console.warn('Vorhersage-Edit fehlgeschlagen, sende neu:', err && err.message ? err.message : err);
        // reset und fahre fort, um neu zu senden
        delete state.vorhersageMessageId;
      }
    }

    // Senden
    const msg = await client.rest.channels.createMessage(VORHERSAGE_CHANNEL, { embeds: [embed] });
    state.vorhersageMessageId = msg.id;
    saveState(state);
    console.log('Wettervorhersage gesendet.');
  } catch (err) {
    console.error('Vorhersage konnte nicht gesendet werden:', err && err.message ? err.message : err);
    // Fehler sollen den Intervall nicht stören; einfach zurückkehren
    return;
  }
}

// --- Kernlogik: Alerts (BrightSky) ---
async function checkBrightSkyAlerts(client, state) {
  try {
    const res = await fetch(BRIGHT_SKY_ALERTS_URL, { headers: { 'User-Agent': 'WetterBot/1.0' } });
    if (!res.ok) {
      console.warn(`[BrightSky] HTTP ${res.status} ${res.statusText}`);
      return;
    }
    const data = await res.json();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    // State vorbereiten
    state.alertKnownIds = Array.isArray(state.alertKnownIds) ? state.alertKnownIds : [];
    state.bundeslandEmbedIds = state.bundeslandEmbedIds || {};
    const known = new Set(state.alertKnownIds);

    // Erststart: wenn keine known IDs vorhanden, dann still lernen
    if (!state._brightInitialized && known.size === 0) {
      for (const a of alerts) if (a && a.id) known.add(a.id);
      state.alertKnownIds = Array.from(known);
      state._brightInitialized = true;
      saveState(state);
      console.log('BrightSky: Erster Start – vorhandene Warnungen gelernt. Keine Meldungen gesendet.');
      return;
    }

    // Gruppiere neue Alerts nach Bundesland
    const groups = {};
    for (const alert of alerts) {
      if (!alert || !alert.id) continue;
      if (known.has(alert.id)) continue;
      const bundesland = (alert.regions && Array.isArray(alert.regions) && alert.regions.length > 0)
        ? alert.regions[alert.regions.length - 1]
        : 'Allgemein';
      if (!groups[bundesland]) groups[bundesland] = [];
      groups[bundesland].push(alert);
    }

    if (Object.keys(groups).length === 0) return;

    const channel = await client.rest.channels.get(WARNUNGEN_CHANNEL);
    if (!channel) return;

    // Für jede Gruppe: edit oder create
    for (const [bundesland, list] of Object.entries(groups)) {
      const embed = buildAlertEmbed(bundesland, list);
      const existingId = state.bundeslandEmbedIds[bundesland];
      if (existingId) {
        try {
          await client.rest.channels.editMessage(WARNUNGEN_CHANNEL, existingId, { embeds: [embed] });
          console.log(`Embed für ${bundesland} aktualisiert (edit).`);
          // Markiere IDs nach Erfolg
          for (const a of list) if (a && a.id) known.add(a.id);
          state.alertKnownIds = Array.from(known);
          saveState(state);
          continue;
        } catch (err) {
          console.warn('Edit fehlgeschlagen, versuche neu zu senden:', err && err.message ? err.message : err);
          delete state.bundeslandEmbedIds[bundesland];
        }
      }

      try {
        const msg = await client.rest.channels.createMessage(WARNUNGEN_CHANNEL, { embeds: [embed] });
        state.bundeslandEmbedIds[bundesland] = msg.id;
        for (const a of list) if (a && a.id) known.add(a.id);
        state.alertKnownIds = Array.from(known);
        saveState(state);
        console.log(`Neue Bundesland-Zusammenfassung für ${bundesland} gesendet.`);
      } catch (err) {
        console.warn('Senden des Embeds fehlgeschlagen:', err && err.message ? err.message : err);
      }
    }
  } catch (err) {
    console.error('BrightSky Alerts Fehler:', err && err.message ? err.message : err);
  }
}

// --- DWD Mesocyclones Handling ---
async function fetchLatestMesoIndexHtml() {
  const res = await fetch(DWD_MESOCYCLONES_INDEX, { headers: { 'User-Agent': 'WetterBot/1.0' } });
  if (!res.ok) throw new Error(`DWD Index HTTP ${res.status}`);
  return res.text();
}

function parseLastXmlFilenameFromIndex(html) {
  // Finde alle hrefs auf .xml und nimm die letzte
  const regex = /href="([^"]+\.xml)"/gi;
  let match, last = null;
  while ((match = regex.exec(html)) !== null) last = match[1];
  return last; // null wenn nicht gefunden
}

async function downloadXml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' } });
  if (!res.ok) throw new Error(`XML Download HTTP ${res.status}`);
  return res.text();
}

function parseMesocycloneXml(xmlText) {
  // Parser: extrahiere <mesocyclone>..</mesocyclone> oder <rotation>..</rotation> Blöcke und lese relevante Felder
  const blocks = [];
  const re = /<(?:mesocyclone|rotation)[^>]*>([\s\S]*?)<\/(?:mesocyclone|rotation)>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const block = m[1];

    // Intensität / Geschwindigkeit (präferiere shear/velocity/intensity)
    let intensity = null;
    const intensityTags = block.match(/<(?:max_shear|shear|velocity|intensity)[^>]*>([^<]+)<\/(?:max_shear|shear|velocity|intensity)>/i);
    if (intensityTags && intensityTags[1]) intensity = parseFloat(intensityTags[1]);
    else {
      const intensityAttr = block.match(/(?:max_shear|shear|velocity|intensity)="([^"]+)"/i);
      if (intensityAttr && intensityAttr[1]) intensity = parseFloat(intensityAttr[1]);
    }

    // Storm motion (direction + speed)
    let motionDir = null, motionSpeed = null;
    const smBlock = block.match(/<storm_motion[^>]*>([\s\S]*?)<\/storm_motion>/i);
    if (smBlock && smBlock[1]) {
      const sm = smBlock[1];
      const d = (sm.match(/<direction[^>]*>([^<]+)<\/direction>/i) || [])[1] || (sm.match(/direction="([^"]+)"/i) || [])[1];
      const s = (sm.match(/<speed[^>]*>([^<]+)<\/speed>/i) || [])[1] || (sm.match(/speed="([^"]+)"/i) || [])[1];
      motionDir = d || null;
      motionSpeed = s ? parseFloat(s) : motionSpeed;
    } else {
      const d = (block.match(/<motionDirection[^>]*>([^<]+)<\/motionDirection>/i) || [])[1] || (block.match(/direction="([^"]+)"/i) || [])[1];
      const s = (block.match(/<motionSpeed[^>]*>([^<]+)<\/motionSpeed>/i) || [])[1] || (block.match(/speed="([^"]+)"/i) || [])[1];
      if (d) motionDir = d;
      if (s) motionSpeed = parseFloat(s);
    }

    // Koordinaten: <coordinates>, <pos> (GML) oder separate lat/lon
    let coords = null;
    const coordsMatch = block.match(/<coordinates[^>]*>([^<]+)<\/coordinates>/i);
    if (coordsMatch && coordsMatch[1]) {
      coords = coordsMatch[1].trim();
    } else {
      const posMatch = block.match(/<pos[^>]*>([^<]+)<\/pos>/i);
      if (posMatch && posMatch[1]) {
        coords = posMatch[1].trim().replace(/\s+/, ',');
      } else {
        const lat = (block.match(/<latitude[^>]*>([^<]+)<\/latitude>/i) || [])[1];
        const lon = (block.match(/<longitude[^>]*>([^<]+)<\/longitude>/i) || [])[1];
        if (lat && lon) coords = `${lat},${lon}`;
      }
    }

    const lifetimeTag = (block.match(/<lifetime[^>]*>([^<]+)<\/lifetime>/i) || [])[1] || null;
    const idMatch = block.match(/id="?([^\s">]+)"?/i);
    const id = idMatch ? idMatch[1] : (`meso_${Math.random().toString(36).slice(2,9)}`);

    blocks.push({ id, intensity: intensity !== undefined ? intensity : null, motionDir, motionSpeed: motionSpeed !== undefined ? motionSpeed : null, coords, lifetime: lifetimeTag, raw: block.trim() });
  }
  return blocks;
}

async function processMesocyclones(client, state) {
  try {
    // Lade Index und ermittle letzte XML-Datei
    const indexHtml = await fetchLatestMesoIndexHtml();
    const lastFilename = parseLastXmlFilenameFromIndex(indexHtml);
    if (!lastFilename) return;
    const xmlUrl = DWD_MESOCYCLONES_INDEX + lastFilename;

    // Wenn bereits dieselbe XML wie zuletzt verarbeitet, wir parsen trotzdem (auf Veränderungen)
    const xmlText = await downloadXml(xmlUrl);
    const mesos = parseMesocycloneXml(xmlText);

    state.mesoEmbeds = state.mesoEmbeds || {};
    state.mesoSource = state.mesoSource || null; // zuletzt verarbeitete Datei

    const currentIds = new Set();

    for (const meso of mesos) {
      currentIds.add(meso.id);
      const embed = buildMesoEmbed(meso);
      const existing = state.mesoEmbeds[meso.id];
      try {
        if (existing) {
          // edit existing
          await client.rest.channels.editMessage(WARNUNGEN_CHANNEL, existing, { embeds: [embed] });
        } else {
          const msg = await client.rest.channels.createMessage(WARNUNGEN_CHANNEL, { embeds: [embed] });
          state.mesoEmbeds[meso.id] = msg.id;
        }
      } catch (err) {
        console.warn('Mesocyclone send/edit Fehler:', err && err.message ? err.message : err);
      }
    }

    // Entferne Embeds, die nicht mehr in aktuellen IDs sind
    const knownMesoIds = Object.keys(state.mesoEmbeds || {});
    for (const id of knownMesoIds) {
      if (!currentIds.has(id)) {
        // löschen
        const msgId = state.mesoEmbeds[id];
        try {
          await client.rest.channels.deleteMessage(WARNUNGEN_CHANNEL, msgId);
        } catch (_) {
          // Ignoriere Fehler beim Löschen
        }
        delete state.mesoEmbeds[id];
      }
    }

    state.mesoSource = lastFilename;
    saveState(state);
  } catch (err) {
    console.error('Mesocyclones Verarbeitung Fehler:', err && err.message ? err.message : err);
  }
}

// --- Start Bot ---
async function startBot() {
  const client = new Client({ auth: BOT_TOKEN.startsWith('Bot ') ? BOT_TOKEN : `Bot ${BOT_TOKEN}` });
  const state = loadState();

  client.on('ready', async () => {
    console.log(`Discord verbunden als ${client.user.tag}`);

    // Store client for helper functions if needed
    checkBrightSkyAlerts._client = client;
    processMesocyclones._client = client;

    // Vorhersage einmalig posten und planmäßig aktualisieren (alle 2 Tage)
    try {
      await postForecast(client, state);
    } catch (e) { console.warn('Initial Vorhersage fehlgeschlagen:', e && e.message ? e.message : e); }
    setInterval(() => { postForecast(client, state).catch(err => console.warn('postForecast Fehler:', err && err.message ? err.message : err)); }, 2 * 24 * 60 * 60 * 1000);

    // Sofortstart (jeweils einmal) und feste Intervalle für Alerts
    try {
      await checkBrightSkyAlerts(client, state);
    } catch (e) { console.warn('Initial BrightSky Durchlauf fehlgeschlagen:', e && e.message ? e.message : e); }
    setInterval(() => { checkBrightSkyAlerts(client, state).catch(err => console.warn('checkBrightSkyAlerts Fehler:', err && err.message ? err.message : err)); }, ALERTS_INTERVAL_MS);

    // Mesocyclones: strikt 5min
    try {
      await processMesocyclones(client, state);
    } catch (e) { console.warn('Initial Mesocyclones Durchlauf fehlgeschlagen:', e && e.message ? e.message : e); }
    setInterval(() => { processMesocyclones(client, state).catch(err => console.warn('processMesocyclones Fehler:', err && err.message ? err.message : err)); }, MESO_INTERVAL_MS);
  });

  client.connect();
}

if (require.main === module) {
  startHealthServer();
  startBot().catch(err => { console.error('Start fehlgeschlagen:', err && err.message ? err.message : err); process.exit(1); });
}

module.exports = { startBot };
