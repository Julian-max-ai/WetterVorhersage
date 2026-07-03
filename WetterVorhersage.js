const http = require('http');
const fs = require('fs');
const path = require('path');
const oceanic = require('oceanic.js');

// Polyfill für fetch (Node.js 18+)
if (!global.fetch) {
  const undici = require('undici');
  global.fetch = undici.fetch;
}

// Konstanten
const POLL_INTERVAL_MS = 60 * 1000;
const MESO_INTERVAL_MS = 5 * 60 * 1000;
const FORECAST_INTERVAL_MS = 10 * 60 * 1000;
const DWD_MESOCYCLONES_URL = 'https://opendata.dwd.de/weather/radar/mesocyclones/';
const BRIGHT_SKY_BASE = 'https://api.brightsky.dev';
const WARNUNGEN_CHANNEL = process.env.WARNUNGEN_CHANNEL || '1501843095485022350';
const VORHERSAGE_CHANNEL = process.env.VORHERSAGE_CHANNEL || '1501635539202216107';
const STATE_FILE = 'wetterState.json';

// Globale Variablen
let __mesoClient = null;
let __mesoState = null;
let __intervalsRegistered = false;

// State-Verwaltung
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return data;
    }
  } catch (e) {
    console.warn('Fehler beim Laden von State:', e && e.message ? e.message : e);
  }
  return { sentAlertKeys: [], bundeslandEmbedIds: {}, alertExpiry: {}, mesozyklonMessageIds: {}, _alertsInitialized: false };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('Fehler beim Speichern von State:', e && e.message ? e.message : e);
  }
}

// BrightSky Alerts synchronisieren
async function syncWeather(client, state) {
  try {
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Alerts] Starte Abruf von https://api.brightsky.dev...`);
    
    const now = Date.now();
    const url = process.env.BRIGHT_SKY_ALERTS_URL || (BRIGHT_SKY_BASE + '/alerts');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' }, signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const alerts = Array.isArray(data) ? data : (Array.isArray(data.alerts) ? data.alerts : []);

    const ersterStart = !state._alertsInitialized;
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Alerts] Abruf erfolgreich! ${alerts.length} Warnungen in Deutschland aktiv. Erststart: ${ersterStart}`);
    
    state.sentAlertKeys = Array.isArray(state.sentAlertKeys) ? state.sentAlertKeys : [];
    state.bundeslandEmbedIds = state.bundeslandEmbedIds || {};
    state.alertExpiry = state.alertExpiry || {};
    
    const knownIds = new Set(state.sentAlertKeys);
    const isFirstRun = !state._alertsInitialized;
    
    // Erststart: Stumm alle aktuellen Warnungen lernen
    if (isFirstRun && knownIds.size === 0) {
      for (const alert of alerts) {
        if (!alert || !alert.id) continue;
        knownIds.add(alert.id);
        state.sentAlertKeys.push(alert.id);
      }
      state._alertsInitialized = true;
      saveState(state);
      console.log(`[${new Date().toLocaleTimeString('de-DE')}] Erster Start: ${alerts.length} Warnungen stumm gelernt.`);
      return;
    }
    
    if (!state._alertsInitialized) {
      state._alertsInitialized = true;
      saveState(state);
    }
    
    if (!alerts.length) return;

    // Filtern: Nur neue Warnungen
    const newAlerts = alerts.filter(alert => {
      if (!alert || !alert.id) return false;
      if (knownIds.has(alert.id)) return false;
      if (alert.end && new Date(alert.end).getTime() < now) return false;
      return true;
    });
    
    if (!newAlerts.length) return;

    const grouped = {};
    
    for (const alert of newAlerts) {
      const headline = String(alert.headline || alert.title || 'Warnung').trim();
      const description = String(alert.description || alert.body || '').trim();
      const severity = String(alert.severity || 'moderate').toLowerCase();
      const instruction = String(alert.instruction || '').trim();
      const start = alert.start || null;
      const end = alert.end || null;
      
      let regionsArr = [];
      if (Array.isArray(alert.regions) && alert.regions.length) {
        regionsArr = alert.regions.map(r => String(r).trim()).filter(Boolean);
      } else if (typeof alert.regions === 'string' && alert.regions.trim()) {
        regionsArr = alert.regions.split(',').map(r => r.trim()).filter(Boolean);
      } else if (alert.region) {
        regionsArr = [String(alert.region).trim()];
      } else {
        regionsArr = ['Deutschland'];
      }

      const stateName = regionsArr.length ? regionsArr[regionsArr.length - 1] : 'Deutschland';
      const counties = regionsArr.length > 1 ? regionsArr.slice(0, -1).sort() : (regionsArr.length === 1 ? [regionsArr[0]] : ['Deutschland']);

      grouped[stateName] = grouped[stateName] || { warnings: new Map(), counties: new Set(), ids: [], severity: 'moderate', start, end, instruction };
      
      const severityRank = { extreme: 3, severe: 2, moderate: 1, minor: 0 };
      if ((severityRank[severity] || 0) > (severityRank[grouped[stateName].severity] || 0)) {
        grouped[stateName].severity = severity;
      }
      
      const warnKey = `${headline}||${description}`;
      if (!grouped[stateName].warnings.has(warnKey)) {
        grouped[stateName].warnings.set(warnKey, { headline, description, instruction });
      }
      grouped[stateName].ids.push(alert.id);
      for (const county of counties) {
        grouped[stateName].counties.add(county || 'Gesamtgebiet');
      }
    }

    const channel = await client.rest.channels.get(WARNUNGEN_CHANNEL);
    if (!channel) return;

    for (const [stateName, info] of Object.entries(grouped)) {
      const counties = Array.from(info.counties).sort();
      const countiesText = counties.length > 0 ? counties.join(', ') : 'Gesamtgebiet';
      
      let embedColor = 0xffcc00;
      if (info.severity === 'extreme') embedColor = 0xff0000;
      else if (info.severity === 'severe') embedColor = 0xff6600;
      
      const warnings = Array.from(info.warnings.values());
      const headlineText = warnings.map(w => `**${w.headline}**`).join(', ');
      const detailsList = warnings.map(w => {
        let text = `${w.description}`;
        if (w.instruction) text += `\n📋 *${w.instruction}*`;
        return text;
      }).join('\n\n');
      
      let validText = 'Gültig ab sofort';
      if (info.start && info.end) {
        const startObj = new Date(info.start);
        const endObj = new Date(info.end);
        validText = `<t:${Math.floor(startObj.getTime() / 1000)}:f> bis <t:${Math.floor(endObj.getTime() / 1000)}:f>`;
      }

      const embed = {
        title: `⚠️ Wetterwarnungen für ${stateName}`,
        description: `**Warnung:** ${headlineText}\n\n**Gültig:** ${validText}`,
        color: embedColor,
        fields: [
          { name: '🌍 Betroffene Regionen', value: countiesText.substring(0, 1024) || 'Gesamtgebiet', inline: false },
          { name: '📝 Details und Empfehlungen', value: detailsList.substring(0, 1024) || 'Keine zusätzlichen Details', inline: false },
          { name: '⚠️ Warnstufe', value: info.severity === 'extreme' ? '🔴 EXTREM' : info.severity === 'severe' ? '🟠 SCHWER' : '🟡 MÄSSIG', inline: true }
        ],
        footer: { text: 'Quelle: Bright Sky' },
        timestamp: new Date().toISOString()
      };

      const existingMessageId = state.bundeslandEmbedIds[stateName];
      if (existingMessageId) {
        try {
          await channel.editMessage(existingMessageId, { embeds: [embed] });
          console.log(`[${new Date().toLocaleTimeString('de-DE')}] Embed für ${stateName} aktualisiert.`);
          for (const id of info.ids) {
            if (!knownIds.has(id)) {
              knownIds.add(id);
              state.sentAlertKeys.push(id);
              state.alertExpiry[id] = info.end || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            }
          }
          saveState(state);
          continue;
        } catch (err) {
          console.warn(`Editieren fehlgeschlagen: ${err && err.message ? err.message : err}`);
          delete state.bundeslandEmbedIds[stateName];
        }
      }

      try {
        const msg = await channel.createMessage({ embeds: [embed] });
        state.bundeslandEmbedIds[stateName] = msg.id;
        for (const id of info.ids) {
          if (!knownIds.has(id)) {
            knownIds.add(id);
            state.sentAlertKeys.push(id);
            state.alertExpiry[id] = info.end || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          }
        }
        saveState(state);
        console.log(`[${new Date().toLocaleTimeString('de-DE')}] Neue Warnung für ${stateName} gesendet.`);
      } catch (err) {
        console.warn(`Senden fehlgeschlagen: ${err && err.message ? err.message : err}`);
      }
    }

    state.letzteSync = now;
    saveState(state);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Alerts] FEHLER beim Abruf:`, err && err.message ? err.message : err);
  }
}

// Vorhersage synchronisieren
async function postForecast(client, state) {
  try {
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Vorhersage] Starte Abruf der 3-7 Tage Vorhersage...`);
    
    const lat = process.env.BRIGHT_SKY_LAT || '51.1657';
    const lon = process.env.BRIGHT_SKY_LON || '10.4515';
    const today = new Date().toISOString().split('T')[0];
    const url = BRIGHT_SKY_BASE + `/weather?lat=${lat}&lon=${lon}&date=${today}`;
    
    const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const weather = data.weather || [];
    
    if (!weather.length) return;
    
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Vorhersage] Abruf erfolgreich! Verarbeite stündliche Daten und aktualisiere das Discord-Embed.`);
    
    const temps = weather.filter(e => e.temperature !== undefined).map(e => e.temperature);
    if (!temps.length) return;
    
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    
    const embed = {
      title: `🌡️ Wettervorhersage für heute`,
      color: 0x3498db,
      description: `**Minimum:** ${minTemp}°C  |  **Maximum:** ${maxTemp}°C`,
      footer: { text: 'Quelle: Bright Sky' },
      timestamp: new Date().toISOString()
    };
    
    const channel = await client.rest.channels.get(VORHERSAGE_CHANNEL);
    if (!channel) return;
    
    try {
      await channel.createMessage({ embeds: [embed] });
    } catch (err) {
      console.warn(`Vorhersage-Sende-Fehler: ${err && err.message ? err.message : err}`);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString('de-DE')}] [BrightSky Vorhersage] FEHLER beim Abruf:`, err && err.message ? err.message : err);
  }
}

// Mesozyklonen parsieren
function parseDwdMesocycloneXml(xmlText) {
  const rotations = [];
  const pattern = /<mesocyclone>([\s\S]*?)<\/mesocyclone>/gi;
  let match;
  
  while ((match = pattern.exec(xmlText)) !== null) {
    const block = match[1];
    
    let id = 'unknown';
    const idMatch = /<id>([^<]+)<\/id>/i.exec(block);
    if (idMatch) id = idMatch[1];
    
    let intensity = null;
    const intensityMatch = /<intensity>([^<]+)<\/intensity>/i.exec(block);
    if (intensityMatch) intensity = parseFloat(intensityMatch[1]);
    
    let coords = null;
    const coordMatch = /<pos[^>]*>([^<]+)<\/pos>/i.exec(block);
    if (coordMatch) coords = coordMatch[1].trim();
    
    let motionDir = null;
    const motionDirMatch = /<direction>([^<]+)<\/direction>/i.exec(block);
    if (motionDirMatch) motionDir = motionDirMatch[1].trim();
    
    let motionSpeed = null;
    const motionSpeedMatch = /<speed>([^<]+)<\/speed>/i.exec(block);
    if (motionSpeedMatch) motionSpeed = parseFloat(motionSpeedMatch[1]);
    
    rotations.push({ id, intensity, coords, motionDir, motionSpeed });
  }
  
  return rotations;
}

// DWD XML-Datei finden
function parseLastXmlFilenameFromIndex(html) {
  const matches = [];
  const pattern = /href="([^"]+\.xml)"/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    matches.push(match[1]);
  }
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// Mesozyklonen prüfen
async function checkMesozyklonen() {
  if (!__mesoClient || !__mesoState) return;
  
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] [DWD Radar] Rufe Verzeichnis ab: https://opendata.dwd.de/weather/radar/mesocyclones/`);
  try {
    const res = await fetch(DWD_MESOCYCLONES_URL, { headers: { 'User-Agent': 'WetterBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const html = await res.text();
    const latestFilename = parseLastXmlFilenameFromIndex(html);
    if (!latestFilename) throw new Error('Keine XML-Datei gefunden');
    
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [DWD Radar] Neueste XML-Datei gefunden: ${latestFilename}. Starte Download und Analyse...`);

    const xmlRes = await fetch(DWD_MESOCYCLONES_URL + latestFilename, { headers: { 'User-Agent': 'WetterBot/1.0' } });
    if (!xmlRes.ok) throw new Error(`XML HTTP ${xmlRes.status}`);
    
    const xmlText = await xmlRes.text();
    const rotations = parseDwdMesocycloneXml(xmlText);
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] [DWD Radar] XML erfolgreich analysiert. Gefundene Rotationen: ${rotations.length}.`);

    __mesoState.mesozyklonMessageIds = __mesoState.mesozyklonMessageIds || {};
    const activeIds = new Set();
    const channel = await __mesoClient.rest.channels.get(WARNUNGEN_CHANNEL);
    if (!channel) return;

    for (const rotation of rotations) {
      activeIds.add(rotation.id);
      
      const intensityText = rotation.intensity !== null ? rotation.intensity + ' m/s' : 'unbekannt';
      const coordsText = rotation.coords || 'unbekannt';
      const motionText = (rotation.motionDir || 'unbekannt') + ' ' + (rotation.motionSpeed !== null ? rotation.motionSpeed + ' m/s' : '');
      
      const embed = {
        title: `🌪️ Mesocyclone ${rotation.id}`,
        description: `Rotation in der Radarinfrastruktur des DWD erkannt.`,
        color: 0xff0000,
        fields: [
          { name: 'Intensität', value: intensityText, inline: true },
          { name: 'Koordinaten', value: coordsText, inline: true },
          { name: 'Bewegung', value: motionText, inline: false }
        ],
        timestamp: new Date().toISOString()
      };

      const existingMessageId = __mesoState.mesozyklonMessageIds[rotation.id];
      try {
        if (existingMessageId) {
          await channel.editMessage(existingMessageId, { embeds: [embed] });
        } else {
          const msg = await channel.createMessage({ embeds: [embed] });
          __mesoState.mesozyklonMessageIds[rotation.id] = msg.id;
        }
      } catch (err) {
        console.error(`[DWD] Embed-Fehler: ${err && err.message ? err.message : err}`);
      }
    }

    // Lösche alte Rotationen
    for (const id of Object.keys(__mesoState.mesozyklonMessageIds)) {
      if (!activeIds.has(id)) {
        const msgId = __mesoState.mesozyklonMessageIds[id];
        try {
          await channel.deleteMessage(msgId);
        } catch (_) {}
        delete __mesoState.mesozyklonMessageIds[id];
      }
    }

    saveState(__mesoState);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString('de-DE')}] [DWD Radar] FEHLER bei Mesozyklonen-Analyse:`, err && err.message ? err.message : err);
  }
}

// Health Server
function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  });
  server.listen(3000, () => console.log('[Health] Server läuft auf Port 3000'));
}

// Bot starten
function startBot() {
  const client = new oceanic.Client({ auth: `Bot ${process.env.BOT_TOKEN}` });
  const state = loadState();

  startHealthServer();

  client.on('ready', async () => {
    console.log(`[${new Date().toLocaleTimeString('de-DE')}] Discord verbunden als ${client.user.tag}`);
    
    try { await postForecast(client, state); } catch (e) { console.warn('postForecast:', e && e.message ? e.message : e); }
    try { await syncWeather(client, state); } catch (e) { console.warn('syncWeather:', e && e.message ? e.message : e); }
    
    __mesoClient = client;
    __mesoState = state;
    try { await checkMesozyklonen(); } catch (e) { console.warn('checkMesozyklonen:', e && e.message ? e.message : e); }
    
    if (!__intervalsRegistered) {
      console.log(`[${new Date().toLocaleTimeString('de-DE')}] Registriere globale Intervalle...`);
      setInterval(() => syncWeather(client, state).catch(e => console.warn('[BrightSky]:', e && e.message ? e.message : e)), POLL_INTERVAL_MS);
      setInterval(() => checkMesozyklonen().catch(e => console.warn('[DWD]:', e && e.message ? e.message : e)), MESO_INTERVAL_MS);
      setInterval(() => postForecast(client, state).catch(e => console.warn('[Forecast]:', e && e.message ? e.message : e)), FORECAST_INTERVAL_MS);
      __intervalsRegistered = true;
    }
  });

  client.connect();
}

startBot();
