const http = require("http");
const fs = require("fs");
const path = require("path");
const { Client } = require("oceanic.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("Fehlender BOT_TOKEN Umgebungsvariable.");
}

const DWD_WARNINGS_URLS = [
  "https://opendata.dwd.de/weather/warnings/warnings.json",
  "https://opendata.dwd.de/weather/warnings/alerts.json"
];
// Datenquellen (konfigurierbar per ENV)
const METEOPPOOL_URL = process.env.METEOPPOOL_URL || "https://www.meteopool.de/rotations.json"; // fallback (legacy)
const DWD_MESOCYCLONES_URL = process.env.DWD_MESOCYCLONES_URL || "https://opendata.dwd.de/weather/radar/mesocyclones/";
// Bright Sky API: echte API-Endpunkte
const BRIGHT_SKY_API_BASE = process.env.BRIGHT_SKY_API_BASE || "https://api.brightsky.dev";
const BRIGHT_SKY_LAT = process.env.BRIGHT_SKY_LAT || "51.1657"; // Standardort: Berlin (für Vorhersage)
const BRIGHT_SKY_LON = process.env.BRIGHT_SKY_LON || "10.4515"; // Standardort: Berlin (für Vorhersage)
// Hinweis: die Vorhersage-API könnte "latitude" und "longitude" verwenden
const BRIGHT_SKY_FORECAST_URL = process.env.BRIGHT_SKY_FORECAST_URL || `${BRIGHT_SKY_API_BASE}/weather?latitude=${BRIGHT_SKY_LAT}&longitude=${BRIGHT_SKY_LON}`;
// Alerts für ganz Deutschland (OHNE lat/lon Parameter)
const BRIGHT_SKY_ALERTS_URL = process.env.BRIGHT_SKY_ALERTS_URL || `${BRIGHT_SKY_API_BASE}/alerts`;
const DWD_RADAR_URL = "https://www.dwd.de/DE/leistungen/radar/radar_node.html";
const DWD_SATELLITE_URL = "https://www.dwd.de/DE/leistungen/satelliten/satelliten_node.html";
const VORHERSAGE_CHANNEL = process.env.VORHERSAGE_CHANNEL || "1501635539202216107";
const WARNUNGEN_CHANNEL = process.env.WARNUNGEN_CHANNEL || "1501843095485022350";
const STATE_FILE = path.join(__dirname, "wetterState.json");
// Standard: jede 10 Minuten prüfen
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10 * 60 * 1000);
const ALL_CLEAR_MS = Number(process.env.ALL_CLEAR_MS || 2 * 60 * 60 * 1000);
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID || null;

let webcamSources = [];
if (process.env.WEBCAM_SOURCES) {
  try {
    webcamSources = JSON.parse(process.env.WEBCAM_SOURCES);
    if (!Array.isArray(webcamSources)) webcamSources = [];
  } catch (error) {
    console.warn("WEBCAM_SOURCES ist kein gültiges JSON-Array, der Bot überspringt Webcam-Integration.");
    webcamSources = [];
  }
}

function ensureFetch() {
  if (typeof fetch !== "function") {
    try {
      global.fetch = require("undici").fetch;
    } catch (error) {
      throw new Error("Fetch ist nicht verfuegbar. Bitte Node 18+ verwenden oder das Paket 'undici' installieren.");
    }
  }
}

ensureFetch();

// Set für bereits gesendete BrightSky-Warnungen (alert.id)
let gesendeteWarnungen = new Set();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8") || "{}");
    }
  } catch (error) {
    console.warn("Zustandsdatei konnte nicht geladen werden:", error.message);
  }
  return { eintraege: {} };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn("Zustand konnte nicht gespeichert werden:", error.message);
  }
}

function toText(value) {
  return (value || "").toString().trim();
}

function formatTimestamp(value) {
  if (!value) return "Unbekannt";
  const millis = Number(value);
  if (Number.isNaN(millis)) return "Unbekannt";
  const seconds = Math.floor(millis / 1000);
  return `<t:${seconds}:f> (<t:${seconds}:R>)`;
}

function findNearestCity(text) {
  if (!text) return "Unbekannte Großstadt";
  const normalized = text.toLowerCase();

  // Bundesländer zu Großstädten mapping
  const stateToCity = {
    "baden-württemberg": "Stuttgart",
    "bayern": "München",
    "berlin": "Berlin",
    "brandenburg": "Potsdam",
    "bremen": "Bremen",
    "hamburg": "Hamburg",
    "hessen": "Frankfurt am Main",
    "mecklenburg-vorpommern": "Rostock",
    "niedersachsen": "Hannover",
    "nordrhein-westfalen": "Köln",
    "rheinland-pfalz": "Mainz",
    "saarland": "Saarbrücken",
    "sachsen": "Dresden",
    "sachsen-anhalt": "Magdeburg",
    "schleswig-holstein": "Kiel",
    "thüringen": "Erfurt"
  };

  // Zusätzliche Aliase und Schreibweisen für Bundesländer
  const aliases = {
    "bw": "baden-württemberg",
    "bawue": "baden-württemberg",
    "by": "bayern",
    "nrw": "nordrhein-westfalen",
    "rlp": "rheinland-pfalz",
    "mv": "mecklenburg-vorpommern",
    "ni": "niedersachsen",
    "sh": "schleswig-holstein",
    "sachsen-anhalt": "sachsen-anhalt",
    "sa": "sachsen-anhalt",
    "sachsen": "sachsen",
    "thüringen": "thüringen",
  };

  // Spezifische Städte
  const cities = {
    "stuttgart": "Stuttgart",
    "münchen": "München",
    "berlin": "Berlin",
    "potsdam": "Potsdam",
    "bremen": "Bremen",
    "hamburg": "Hamburg",
    "frankfurt": "Frankfurt am Main",
    "rostock": "Rostock",
    "hannover": "Hannover",
    "köln": "Köln",
    "mainz": "Mainz",
    "saarbrücken": "Saarbrücken",
    "dresden": "Dresden",
    "magdeburg": "Magdeburg",
    "kiel": "Kiel",
    "erfurt": "Erfurt",
    "düsseldorf": "Düsseldorf",
    "dortmund": "Dortmund",
    "essen": "Essen",
    "leipzig": "Leipzig",
    "nürnberg": "Nürnberg",
    "dresden": "Dresden",
    "hannover": "Hannover",
    "bremen": "Bremen",
    "bonn": "Bonn",
    "mannheim": "Mannheim",
    "karlsruhe": "Karlsruhe",
    "freiburg": "Freiburg",
    "augsburg": "Augsburg",
    "wiesbaden": "Wiesbaden",
    "kassel": "Kassel",
    "schwerin": "Schwerin",
    "saarbrücken": "Saarbrücken",
    "chemnitz": "Chemnitz",
    "halle": "Halle",
    "jena": "Jena"
  };

  // Zuerst nach spezifischen Städten suchen
  for (const key of Object.keys(cities)) {
    if (normalized.includes(key)) {
      return cities[key];
    }
  }

  // Dann nach Bundesländern suchen
  for (const key of Object.keys(stateToCity)) {
    if (normalized.includes(key)) {
      return stateToCity[key];
    }
  }

  // Aliase
  for (const [k, v] of Object.entries(aliases)) {
    if (normalized.includes(k)) {
      return stateToCity[v] || "Unbekannte Großstadt";
    }
  }

  return "Unbekannte Großstadt";
}

function crossesCity(entry, city) {
  if (!city || city === "Unbekannte Grossstadt") return false;
  const area = `${entry.landkreis || ""} ${entry.region || ""}`.toLowerCase();
  return area.includes(city.toLowerCase());
}

function estimateFujita(entry) {
  if (entry.fujita) return entry.fujita;
  const text = `${entry.beschreibung || ""} ${entry.ereignis || ""}`.toUpperCase();
  const match = text.match(/F([0-5])/);
  if (match) return `F${match[1]}`;
  const speed = Number(entry.windKmh || entry.windSpeedKmh || entry.windKmh || entry.wind || 0);
  if (speed >= 419) return "F5";
  if (speed >= 333) return "F4";
  if (speed >= 254) return "F3";
  if (speed >= 181) return "F2";
  if (speed >= 118) return "F1";
  if (speed >= 65) return "F0";
  return "Unbekannt";
}

function inferDirection(entry) {
  if (entry.richtung) return entry.richtung;
  const text = `${entry.beschreibung || ""}`.toLowerCase();

  // Präzisere Richtungserkennung
  if (text.includes("nordosten")) return "Nordosten";
  if (text.includes("nordwesten")) return "Nordwesten";
  if (text.includes("südosten")) return "Südosten";
  if (text.includes("südwesten")) return "Südwesten";
  if (text.includes("nord")) return "Norden";
  if (text.includes("ost")) return "Osten";
  if (text.includes("süd")) return "Süden";
  if (text.includes("west")) return "Westen";

  return "Unbekannt";
}

function getAlertLevel(entry) {
  const severity = (entry.schwere || "").toLowerCase();
  // Bright Sky Severity: minor, moderate, severe, extreme
  if (severity.includes("extreme") || severity.includes("rot") || severity.includes("tornado")) return "Extrem";
  if (severity.includes("schwer") || severity.includes("severe") || severity.includes("orange") || severity.includes("hoch") || severity.includes("warnung")) return "Hoch";
  if (severity.includes("mittel") || severity.includes("moderate") || severity.includes("gelb")) return "Mittel";
  if (severity.includes("leicht") || severity.includes("minor")) return "Gering";
  return "Normal";
}

function getTornadoProbability(entry) {
  if (entry.kategorie === "tornado") return "Sehr hoch";
  if (entry.kategorie === "rotation") return "Erhöht";
  const text = `${entry.beschreibung || ""}`.toLowerCase();
  if (text.includes("tornado")) return "Erhöht";
  if (text.includes("rotation") || text.includes("wallcloud")) return "Moderat";
  return "Unbekannt";
}

function getRadarLinks() {
  return `[DWD Radar](${DWD_RADAR_URL}) • [Satellit](${DWD_SATELLITE_URL})`;
}

function findWebcamUrl(entry) {
  if (!webcamSources.length) return null;
  const searchText = `${entry.landkreis || ""} ${entry.region || ""}`.toLowerCase();
  for (const url of webcamSources) {
    if (typeof url !== "string") continue;
    if (searchText && url.toLowerCase().includes(searchText)) return url;
  }
  return webcamSources[0] || null;
}

function buildEmbed(entry) {
  const city = findNearestCity(`${entry.landkreis} ${entry.region}`);
  const crosses = crossesCity(entry, city);
  const fujita = estimateFujita(entry);
  const direction = inferDirection(entry);
  const confirmed = entry.bestatigt !== undefined ? entry.bestatigt : false;
  const alertLevel = getAlertLevel(entry);
  const tornadoProb = getTornadoProbability(entry);
  const webcamUrl = entry.webcamUrl || findWebcamUrl(entry);
  const rotationStrenght = getRotationStrength(entry);

  // Farbcodierung basierend auf Warnstufe/Kategorie
  let embedColor = 0x0099ff; // Standard blau
  if (entry.kategorie === "tornado") {
    embedColor = 0xff0000; // Rot für Tornado
  } else if (entry.kategorie === "rotation") {
    if (rotationStrenght >= 4) embedColor = 0xff0000; // Rot für 4/5-5/5
    else if (rotationStrenght >= 3) embedColor = 0xff6600; // Orange für 3/5
    else embedColor = 0xffcc00; // Gelb für 1/5-2/5
  } else if (alertLevel === "Extrem") {
    embedColor = 0xff0000; // Rot
  } else if (alertLevel === "Hoch") {
    embedColor = 0xff6600; // Orange
  } else if (alertLevel === "Gering") {
    embedColor = 0x00aa00; // Grün für Gering
  } else if (alertLevel === "Gering") {
    embedColor = 0x00aa00; // Grün für Gering
  }

  const fields = [
    { name: "Quelle", value: entry.quelle, inline: true },
    { name: "Phänomen", value: entry.ereignis || "Unbekannt", inline: true },
    { name: "Warnstufe", value: alertLevel, inline: true }
  ];

  // Zeige Orts-Felder je nach Quelle an
  if (entry.quelle === 'BrightSky') {
    // Für Bright Sky: zeige die Regionen
    fields.push({ name: "Betroffene Landkreise", value: entry.landkreis || "Unbekannt", inline: false });
  } else {
    // Für DWD und andere: zeige Bundesland und Landkreis
    fields.push({ name: "Bundesland, Landkreis", value: `${entry.region || "Unbekannt"}, ${entry.landkreis || "Unbekannt"}`, inline: false });
    fields.push({ name: "Nächste Großstadt", value: city, inline: false });
    fields.push({ name: "Wird diese Stadt überquert?", value: crosses ? `Ja, ${city} liegt im möglichen Wirkungsbereich dieser Warnung.` : `Nein, ${city} liegt außerhalb des betroffenen Bereichs.`, inline: false });
  }

  if (entry.kategorie === "rotation" || entry.kategorie === "tornado") {
    // Für Rotationen/Tornados
    fields.push({ name: "Stärke", value: entry.kategorie === "tornado" ? fujita : rotationStrenght + "/5", inline: true });
    fields.push({ name: "Bestätigung in Deutschland", value: confirmed ? "Ja ✓" : "Noch nicht bestätigt", inline: true });
    
    const riskText = rotationStrenght >= 4 ? "Sehr hohes Risiko" : rotationStrenght >= 3 ? "Hohes Risiko" : "Erhöhtes Risiko";
    fields.push({ name: "Tornado-Risiko", value: `${tornadoProb} (${riskText})`, inline: true });
    
    fields.push({ name: "Entwicklung", value: entry.entwicklung || "Rotation kann sich verstärken, abschwächen oder zu einem Tornado entwickeln. Beobachte Zugrichtung, Aufwindkern und Niederschlagsstruktur.", inline: false });
    fields.push({ name: "Zugrichtung", value: `${direction} — nahegelegene Orte beobachten.`, inline: false });
  } else if (entry.quelle === 'BrightSky') {
    // Für Bright Sky Warnungen: zeige Beschreibung (gekürzt auf Discord-Limit)
    const desc = entry.beschreibung || "Keine zusätzliche Beschreibung verfügbar.";
    const truncatedDesc = desc.length > 1000 ? desc.substring(0, 997) + '...' : desc;
    fields.push({ name: "Details", value: truncatedDesc, inline: false });
  } else {
    // Für sonstige Warnungen
    fields.push({ name: "Schwere", value: entry.schwere || "Unbekannt", inline: true });
    fields.push({ name: "Stärke", value: fujita, inline: true });
    const desc = entry.beschreibung || "Keine zusätzliche Beschreibung verfügbar.";
    const truncatedDesc = desc.length > 1000 ? desc.substring(0, 997) + '...' : desc;
    fields.push({ name: "Beschreibung", value: truncatedDesc, inline: false });
  }

  if (entry.start && entry.ende) {
    fields.push({ name: "Gültig", value: `${formatTimestamp(entry.start)} bis ${formatTimestamp(entry.ende)}`, inline: false });
  }

  fields.push({ name: "Ausgegeben", value: formatTimestamp(entry.letztesUpdate), inline: true });
  fields.push({ name: "Links", value: getRadarLinks(), inline: true });

  if (webcamUrl) {
    fields.push({ name: "Webcam", value: `[Livebild ansehen](${webcamUrl})`, inline: true });
  }

  // Kürze lange Titel
  const truncatedTitle = String(entry.ereignis || entry.titel || "Wetterlage").substring(0, 200);

  return {
    title: `${entry.icon || "⚠️"} ${truncatedTitle}`,
    description: String(entry.beschreibung || "Übersicht der aktuellen Wetterlage").substring(0, 1000),
    color: embedColor,
    fields,
    footer: { text: `Quelle: ${entry.quelle} | Automatisch aktualisiert` },
    timestamp: new Date().toISOString()
  };
}

function getRotationStrength(entry) {
  const text = (entry.beschreibung || "").toLowerCase();
  if (text.includes("5/5")) return 5;
  if (text.includes("4/5")) return 4;
  if (text.includes("3/5")) return 3;
  if (text.includes("2/5")) return 2;
  if (text.includes("1/5")) return 1;
  if (text.includes("extrem")) return 5;
  if (text.includes("sehr")) return 4;
  if (text.includes("erhöht")) return 3;
  return 1;
}

function buildComponents(entry) {
  const buttons = [];
  if (entry.bilder && entry.bilder.length > 0) {
    buttons.push({ type: 2, style: 5, label: "Bilder", url: entry.bilder[0] });
  }
  if (entry.mehrInfoUrl) {
    buttons.push({ type: 2, style: 5, label: "Mehr Informationen", url: entry.mehrInfoUrl });
  }
  if (entry.webcamUrl) {
    buttons.push({ type: 2, style: 5, label: "Webcam ansehen", url: entry.webcamUrl });
  }
  return buttons.length ? [{ type: 1, components: buttons }] : undefined;
}

function hashEntry(entry) {
  return JSON.stringify([entry.quelle, entry.landkreis, entry.region, entry.ereignis, entry.schwere, entry.beschreibung, entry.start, entry.ende, entry.letztesUpdate]);
}

function normalizeEntry(raw, quelle) {
  return {
    id: raw.id || null, // Für Deduplication (z.B. alert.id aus Bright Sky)
    quelle: quelle || raw.quelle || "DWD",
    titel: raw.titel || raw.ereignis || raw.type || "Wetterlage",
    ereignis: raw.ereignis || raw.titel || raw.type || "Wetterlage",
    beschreibung: raw.beschreibung || raw.description || raw.comment || "Keine zusätzliche Beschreibung.",
    landkreis: raw.landkreis || raw.region || raw.area || raw.location || "Unbekannt",
    region: raw.region || raw.state || raw.bundesland || "",
    schwere: raw.schwere || raw.severity || raw.level || raw.alertLevel || "Unbekannt",
    kategorie: raw.kategorie || raw.category || raw.type || "warning",
    bestatigt: raw.bestatigt !== undefined ? raw.bestatigt : !!raw.confirmed,
    start: raw.start || raw.onset || raw.time || null,
    ende: raw.ende || raw.ends || raw.end || null,
    letztesUpdate: raw.letztesUpdate || raw.updated || raw.sent || raw.time || Date.now(),
    fujita: raw.fujita || raw.estimate || "",
    windKmh: Number(raw.windKmh || raw.windSpeedKmh || raw.windSpeed || raw.wind || 0),
    richtung: raw.richtung || raw.direction || raw.motion || "",
    wahrscheinlichkeit: raw.wahrscheinlichkeit || raw.probability || raw.certainty || "",
    bilder: Array.isArray(raw.bilder) ? raw.bilder : raw.bild ? [raw.bild] : Array.isArray(raw.images) ? raw.images : raw.image ? [raw.image] : [],
    mehrInfoUrl: raw.mehrInfoUrl || raw.url || raw.link || raw.uri || "",
    webcamUrl: raw.webcamUrl || null,
    icon: raw.icon || (raw.kategorie === "tornado" ? "🌪️" : raw.kategorie === "rotation" ? "🌩️" : "⚠️"),
    farbe: raw.farbe || null,
    entwicklung: raw.entwicklung || raw.analysis || raw.assessment || ""
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", headers: { "User-Agent": "WetterBot/1.0" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchDwdWarnings() {
  let lastError = null;
  for (const url of DWD_WARNINGS_URLS) {
    try {
      console.log(`Versuche DWD-Warnungen von ${url}`);
      return await fetchJson(url);
    } catch (error) {
      console.warn(`DWD-Warnungen von ${url} fehlgeschlagen:`, error.message);
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Keine DWD-Warnquelle verfügbar.");
}

function parseDwdData(data) {
  if (!data) {
    // Mock-Daten für Testzwecke
    console.log("Verwende Mock-DWD-Daten für Testzwecke");
    data = {
      alerts: [
        {
          region: "Bayern",
          area: "München",
          severity: "gelb",
          event: "Starkregen",
          description: "Es wird mit Starkregen gerechnet. In den nächsten Stunden können 20-30 l/m² fallen.",
          onset: Date.now() + 300000, // in 5 Minuten (damit es als warning gilt)
          ends: Date.now() + 7200000, // in 2 Stunden
          sent: Date.now(),
          url: "https://www.dwd.de"
        },
        {
          region: "Nordrhein-Westfalen",
          area: "Köln",
          severity: "orange",
          event: "Gewitter",
          description: "Gewitter mit Starkregen und Hagel möglich. Lokale Überschwemmungen nicht ausgeschlossen.",
          onset: Date.now() + 600000, // in 10 Minuten (damit es als warning gilt)
          ends: Date.now() + 10800000, // in 3 Stunden
          sent: Date.now(),
          url: "https://www.dwd.de"
        }
      ]
    };
  }

  const entries = [];
  const items = Array.isArray(data.alerts) ? data.alerts : Array.isArray(data.features) ? data.features : [];

  for (const item of items) {
    const props = item.properties || item;
    const region = props.region || props.area || props.state || "";
    const landkreis = props.area || props.region || props.location || region || "Unbekannt";
    const schwere = props.severity || props.level || props.alertLevel || props.levelName || "Unbekannt";
    const ereignis = props.event || props.title || "Wetterwarnung";
    const beschreibung = props.description || props.body || "Keine zusätzliche Beschreibung.";
    const start = props.onset || props.start || props.begin || null;
    const ende = props.ends || props.end || props.stop || null;
    const letztesUpdate = props.sent || props.updated || props.lastUpdate || Date.now();
    const url = props.url || props.web || props.uri || "";
    const kategorie = start && Number(start) > Date.now() + 5 * 60 * 1000 ? "forecast" : "warning";

    entries.push(normalizeEntry({
      quelle: "DWD",
      ereignis,
      beschreibung,
      landkreis,
      region,
      schwere,
      kategorie,
      bestatigt: props.status === "Actual" || props.actual === true,
      start,
      ende,
      letztesUpdate,
      mehrInfoUrl: url,
      wahrscheinlichkeit: props.certainty || props.probability || "",
      richtung: props.direction || "",
      windKmh: Number(props.windSpeed || props.windSpeedKmh || 0)
    }, "DWD"));
  }
  return entries;
}

// DWD Mesocyclones parser (ersetzt Meteopool). Erwartet ein Array oder Objekt mit relevanten Feldern.
function parseDwdMesocycloneData(data) {
  const entries = [];
  if (!data) return entries;

  // Daten können verschieden strukturiert sein; versuche mehrere Formen
  const items = Array.isArray(data) ? data : Array.isArray(data.features) ? data.features : [];

  for (const item of items) {
    const props = item.properties || item;
    const landkreis = props.county || props.area || props.location || props.county_name || props.countyName || "Unbekannt";
    const region = props.state || props.region || props.bundesland || "";
    const eventText = props.event || props.title || props.type || "Rotation";
    const kategorie = (eventText || "").toLowerCase().includes("tornado") || props.type === "tornado" ? "tornado" : "rotation";
    const beschreibung = props.description || props.comment || `Rotation detected (id: ${props.id || ''})`;
    const schwere = props.severity || props.level || kategorie;
    const bestaetigung = props.confirmed === true || props.confirmed === "true" || !!props.confirmed;
    const start = props.time || props.timestamp || props.observed || null;
    const letztesUpdate = props.updated || props.lastUpdate || props.time || Date.now();
    const bilder = props.images || props.imageUrls || props.image ? [].concat(props.images || props.imageUrls || props.image) : [];

    entries.push(normalizeEntry({
      quelle: "DWD-Mesocyclones",
      ereignis: eventText,
      beschreibung,
      landkreis,
      region,
      schwere,
      kategorie,
      bestatigt: bestaetigung,
      start,
      letztesUpdate,
      mehrInfoUrl: props.url || props.link || props.source || "",
      wahrscheinlichkeit: props.certainty || props.probability || "",
      richtung: props.motion || props.direction || "",
      windKmh: Number(props.windSpeed || props.windSpeedKmh || props.wind || 0),
      bilder,
      fujita: props.fujita || ""
    }, "DWD-Mesocyclones"));
  }
  return entries;
}

// Bright Sky (DWD-Daten) integration — optional, wenn BRIGHT_SKY_URL gesetzt ist.
async function fetchBrightSkyWarnings() {
  const url = BRIGHT_SKY_ALERTS_URL;
  if (!url) {
    console.warn('Bright Sky Alerts URL nicht konfiguriert.');
    return null;
  }
  try {
    console.log(`[BrightSky] Abruf Warnungen: ${url}`);
    return await fetchJson(url);
  } catch (error) {
    console.warn('Bright Sky Warnungen konnten nicht geladen werden:', error.message);
    return null;
  }
}

async function fetchBrightSkyForecast() {
  const url = BRIGHT_SKY_FORECAST_URL;
  if (!url) {
    console.warn('Bright Sky Forecast URL nicht konfiguriert.');
    return null;
  }
  try {
    console.log(`[BrightSky] Abruf Vorhersage: ${url}`);
    return await fetchJson(url);
  } catch (error) {
    console.warn('Bright Sky Vorhersage konnte nicht geladen werden:', error.message);
    return null;
  }
}

function parseBrightSkyWarnings(data) {
  // Erwartet eine Liste von Warnobjekten mit start/end/description/level/region
  if (!data) {
    console.log('[BrightSky] Keine Warnungsdaten empfangen.');
    return [];
  }

  // Mögliche Formen: Array direkt, { alerts: [...] }, { features: [...] }
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data.alerts)) items = data.alerts;
  else if (Array.isArray(data.features)) items = data.features.map(f => f.properties || f);
  else if (Array.isArray(data.data)) items = data.data;

  if (!items.length) {
    console.log('[BrightSky] Warnungsliste ist leer — keine Warnungen vorhanden.');
    return [];
  }

  console.log(`[BrightSky] ${items.length} Warnungen geparst.`);

  return items.map((w) => {
    // Nutze exakt die Bright Sky API-Felder
    const headline = w.headline || w.event_code || 'Warnung';
    const regions = Array.isArray(w.regions) ? w.regions.join(', ') : (w.region || 'Unbekanntes Gebiet');
    const description = w.description || 'Keine Beschreibung vorhanden';
    const instruction = w.instruction || '';
    const fullDesc = instruction ? `${description}\n\n**Handlungsempfehlung:** ${instruction}` : description;
    
    // Severity-Mapping für Deutsche Warnstufen
    const severityMap = {
      'minor': 'Leicht',
      'moderate': 'Mittel',
      'severe': 'Schwer',
      'extreme': 'Extrem'
    };
    const severity = w.severity || 'unknown';
    const level = severityMap[severity.toLowerCase()] || severity || 'Unbekannt';
    
    const start = w.start || w.onset || w.begin || null;
    const ende = w.end || w.ends || w.stop || null;
    const updated = w.updated || w.sent || w.lastUpdate || Date.now();
    const url = w.url || w.link || w.moreInfo || '';

    return normalizeEntry({
      id: w.id || null, // Bright Sky alert.id für Deduplication
      quelle: 'BrightSky',
      ereignis: headline,
      beschreibung: fullDesc,
      landkreis: regions,
      region: '',
      schwere: level,
      kategorie: 'warning',
      bestatigt: !!w.confirmed,
      start,
      ende,
      letztesUpdate: updated,
      mehrInfoUrl: url
    }, 'BrightSky');
  });
}

function parseBrightSkyForecast(data) {
  // Erwartet forecasts per day
  if (!data) {
    console.log('[BrightSky] Keine Vorhersagedaten empfangen.');
    return null;
  }

  // Mögliche Formate: { days: [...] } oder { daily: [...] } oder direkt array
  const days = Array.isArray(data.days) ? data.days : Array.isArray(data.daily) ? data.daily : Array.isArray(data) ? data : null;
  if (!days) {
    console.log('[BrightSky] Keine Day-Struktur gefunden.');
    return null;
  }

  console.log(`[BrightSky] ${days.length} Tage in Vorhersage gefunden.`);
  // Normalisiere minimal: [{ date, summary, temp_min, temp_max, condition }]
  return days.map(d => ({
    date: d.date || d.dt || d.timestamp || d.time || null,
    summary: d.summary || d.description || (d.temp_min || '') + '–' + (d.temp_max || '') + '°C ' + (d.condition || ''),
    temp_min: d.temp_min || d.min_temp || null,
    temp_max: d.temp_max || d.max_temp || null
  }));
}

function channelForCategory(kategorie) {
  return kategorie === "forecast" ? VORHERSAGE_CHANNEL : WARNUNGEN_CHANNEL;
}

async function sendEmbed(client, channelId, messageId, embed, components, mentionRole) {
  const channel = await client.rest.channels.get(channelId);
  if (!channel) throw new Error(`Kanal ${channelId} wurde nicht gefunden.`);

  if (messageId) {
    try {
      const updated = await channel.editMessage(messageId, { embeds: [embed], components });
      return updated.id;
    } catch (error) {
      console.warn(`Aktualisierung der Nachricht ${messageId} fehlgeschlagen:`, error.message);
    }
  }

  const content = mentionRole ? `<@&${mentionRole}>` : undefined;
  const created = await channel.createMessage({ content, embeds: [embed], components });
  return created.id;
}

async function deleteMessage(client, channelId, messageId) {
  if (!messageId) return;
  try {
    const channel = await client.rest.channels.get(channelId);
    if (!channel) return;
    await channel.deleteMessage(messageId);
  } catch (error) {
    console.warn(`Löschen der Nachricht ${messageId} fehlgeschlagen:`, error.message);
  }
}

async function postForecast(client, state) {
  try {
    const channel = await client.rest.channels.get(VORHERSAGE_CHANNEL);
    if (!channel) return;
    // Versuche Bright Sky 7-Tage Vorhersage zu verwenden (wenn konfiguriert)
    const brightData = await fetchBrightSkyForecast();
    let embed;
    if (brightData) {
      // Build a clearer 7-day embed
      const days = Array.isArray(brightData.days) ? brightData.days : brightData;
      const fields = [];
      for (const day of days.slice(0, 7)) {
        const dateStr = new Date(day.date || day.dt || day.timestamp || Date.now()).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'short' });
        const summary = day.summary || day.description || `${day.temp_min || ''}–${day.temp_max || ''}°C ${day.condition || ''}`;
        fields.push({ name: `${dateStr}`, value: summary, inline: false });
      }
      fields.push({ name: 'Stand', value: formatTimestamp(Date.now()), inline: false });
      embed = {
        title: `🌤️ 7‑Tage Vorhersage`,
        description: `Automatisch aktualisierte 7‑Tage‑Vorhersage (Bright Sky)`,
        color: 0x0066cc,
        fields,
        footer: { text: `Quelle: Bright Sky` },
        timestamp: new Date().toISOString()
      };

      // Nur aktualisieren, wenn sich die BrightSky-Daten geändert haben
      const newHash = JSON.stringify(brightData).slice(0, 20000);
      if (state.brightSkyForecastHash && state.brightSkyForecastHash === newHash && state.vorhersageMessageId) {
        // Keine Änderung
        return;
      }
      state.brightSkyForecastHash = newHash;
    } else {
      // Fallback: bestehende einfache 2-Tage Übersicht
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const todayStr = today.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      const tomorrowStr = tomorrow.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      const todayText = `**Südwesten** (Baden-Württemberg, Rheinland-Pfalz, Saarland): ☀️ Zumeist sonnig und trocken, 18-22°C.`;
      const tomorrowText = `**Südwesten** (Baden-Württemberg, Rheinland-Pfalz, Saarland): 🌤️ Wechselhaft, 16-21°C.`;
      embed = {
        title: `🌤️ Wettervorhersage für die nächsten 2 Tage`,
        description: `Regionaler Überblick für Deutschland. Diese Nachricht wird im gleichen Embed aktualisiert.`,
        color: 0x0099ff,
        fields: [
          { name: `Heute – ${todayStr}`, value: todayText, inline: false },
          { name: `Morgen – ${tomorrowStr}`, value: tomorrowText, inline: false },
          { name: "Stand", value: formatTimestamp(Date.now()), inline: false }
        ],
        footer: { text: "Quelle: DWD | Automatisch aktualisiert" },
        timestamp: new Date().toISOString()
      };
    }

    if (state.vorhersageMessageId) {
      try {
        await channel.editMessage(state.vorhersageMessageId, { embeds: [embed] });
        console.log("Wettervorhersage aktualisiert!");
        saveState(state);
        return;
      } catch (error) {
        console.warn("Vorhersage-Bearbeitung fehlgeschlagen, sende neue:", error.message);
        state.vorhersageMessageId = null;
      }
    }

    const msg = await channel.createMessage({ embeds: [embed] });
    state.vorhersageMessageId = msg.id;
    saveState(state);
    console.log("Wettervorhersage gesendet!");
  } catch (error) {
    console.error("Vorhersage konnte nicht gesendet werden:", error.message);
  }
}

async function syncWeather(client, state) {
  // BrightSky-only implementation: use https://api.brightsky.dev/alerts
  try {
    const now = Date.now();
    const url = process.env.BRIGHT_SKY_ALERTS_URL || 'https://api.brightsky.dev/alerts';
    // Use fetch with AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' }, signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json();
    const alerts = data && Array.isArray(data.alerts) ? data.alerts : null;

    // Wenn alerts leer oder nicht vorhanden: nichts senden
    if (!alerts || alerts.length === 0) return;

    // Lade persistent gespeicherte gesendete Keys in das Set
    state.sentAlertKeys = Array.isArray(state.sentAlertKeys) ? state.sentAlertKeys : [];
    for (const k of state.sentAlertKeys) gesendeteWarnungen.add(k);

    // Beim ersten Lauf: markiere alle aktuellen Alerts als bereits gesehen (kein Senden), um Spam beim Start zu vermeiden
    if (!state.brightSkySeenInitial) {
      for (const alert of alerts) {
        if (!alert || !alert.id) continue;
        let startNum = Number(alert.start || alert.onset || 0) || 0;
        if (startNum && startNum < 1e12) startNum = startNum * 1000; // evtl. in Sekunden geliefert
        const key = `${alert.id}:${startNum}`;
        if (!gesendeteWarnungen.has(key)) {
          gesendeteWarnungen.add(key);
          state.sentAlertKeys.push(key);
        }
      }
      state.brightSkySeenInitial = true;
      saveState(state);
      return;
    }

    // Normale Polling-Läufe: nur neue Alerts senden (Alert-ID + Start) und nur wenn Start in der Zukunft
    for (const alert of alerts) {
      if (!alert || !alert.id) continue;
      let startNum = Number(alert.start || alert.onset || 0) || 0;
      if (startNum && startNum < 1e12) startNum = startNum * 1000;
      const key = `${alert.id}:${startNum}`;
      if (gesendeteWarnungen.has(key)) continue; // schon gesendet

      // Nur zukünftige Alerts senden (start in der Zukunft)
      if (!startNum || startNum <= now) {
        // nicht senden, aber merke als gesehen, damit wir es nicht später erneut prüfen
        gesendeteWarnungen.add(key);
        state.sentAlertKeys.push(key);
        continue;
      }

      const title = String(alert.headline || alert.title || 'Warnung').substring(0, 256);
      const description = String(alert.description || '').substring(0, 4096);
      const regions = Array.isArray(alert.regions) ? alert.regions.join(', ') : (alert.regions ? String(alert.regions) : 'Deutschland');
      const severity = String(alert.severity || 'Unbekannt');

      const embed = {
        title,
        description,
        color: 0xff3300,
        fields: [
          { name: 'Betroffenes Gebiet', value: regions || 'Deutschland', inline: false },
          { name: 'Warnstufe', value: severity || 'Unbekannt', inline: true }
        ],
        footer: { text: 'Quelle: Bright Sky' },
        timestamp: new Date().toISOString()
      };

      try {
        await sendEmbed(client, WARNUNGEN_CHANNEL, null, embed, null, null);
        gesendeteWarnungen.add(key);
        state.sentAlertKeys.push(key);
        saveState(state);
      } catch (err) {
        console.warn('Senden der BrightSky-Warnung fehlgeschlagen:', err.message || err);
      }
    }

    state.letzteSync = now;
    saveState(state);
  } catch (err) {
    console.warn('BrightSky Abruf fehlgeschlagen:', err.message || err);
    return;
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("WetterVorhersage-Bot läuft\n");
  }).listen(port, () => {
    console.log(`Health-Server läuft auf Port ${port}`);
  });
}

async function startBot() {
  const client = new Client({
    auth: BOT_TOKEN.startsWith("Bot ") ? BOT_TOKEN : `Bot ${BOT_TOKEN}`,
    gateway: { intents: ["GUILDS", "GUILD_MESSAGES"] }
  });

  const state = loadState();

  client.on("ready", async () => {
    console.log(`Discord verbunden als ${client.user.tag}`);
    startHealthServer();
    
    // Vorhersage einmalig posten
    await postForecast(client, state);
    
    // Wetter synchronisieren
    await syncWeather(client, state);
    setInterval(() => syncWeather(client, state), POLL_INTERVAL_MS);
    
    // Vorhersage alle 2 Tage neu aktualisieren
    setInterval(() => postForecast(client, state), 2 * 24 * 60 * 60 * 1000);
  });

  client.connect();
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error("Start des Wetterbots fehlgeschlagen:", error);
    process.exit(1);
  });
}

module.exports = { startBot };
