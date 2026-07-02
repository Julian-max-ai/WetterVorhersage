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
const BRIGHT_SKY_LAT = process.env.BRIGHT_SKY_LAT || "51.1657"; // Standardort: Berlin (f�r Vorhersage)
const BRIGHT_SKY_LON = process.env.BRIGHT_SKY_LON || "10.4515"; // Standardort: Berlin (f�r Vorhersage)
// Bright Sky: aktuelles Datum ist beim /weather-Endpunkt zwingend
const heute = new Date().toISOString().split('T')[0];
// Forecast-URL: behalte 'api.' am Anfang, '/weather' muss vorhanden sein, Datum als '&date='
const BRIGHT_SKY_FORECAST_URL = process.env.BRIGHT_SKY_FORECAST_URL || `${BRIGHT_SKY_API_BASE}/weather?lat=${BRIGHT_SKY_LAT}&lon=${BRIGHT_SKY_LON}&date=${heute}`;
// Alerts f�r ganz Deutschland (OHNE lat/lon Parameter)
const BRIGHT_SKY_ALERTS_URL = process.env.BRIGHT_SKY_ALERTS_URL || `${BRIGHT_SKY_API_BASE}/alerts`;
const DWD_RADAR_URL = "https://www.dwd.de/DE/leistungen/radar/radar_node.html";
const DWD_SATELLITE_URL = "https://www.dwd.de/DE/leistungen/satelliten/satelliten_node.html";
const VORHERSAGE_CHANNEL = process.env.VORHERSAGE_CHANNEL || "1501635539202216107";
const WARNUNGEN_CHANNEL = process.env.WARNUNGEN_CHANNEL || "1501843095485022350";
const STATE_FILE = path.join(__dirname, "wetterState.json");
// Standard: jede 60 Sekunden pr�fen
const POLL_INTERVAL_MS = 60 * 1000;
const ALL_CLEAR_MS = Number(process.env.ALL_CLEAR_MS || 2 * 60 * 60 * 1000);
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID || null;

let istBereit = false;
let bundeslandEmbedIds = {};
// Globale Referenz zur letzten gesendeten Vorhersage-Nachricht (wird zur stillen Aktualisierung genutzt)
let vorhersageNachricht = null;

let webcamSources = [];
if (process.env.WEBCAM_SOURCES) {
  try {
    webcamSources = JSON.parse(process.env.WEBCAM_SOURCES);
    if (!Array.isArray(webcamSources)) webcamSources = [];
  } catch (error) {
    console.warn("WEBCAM_SOURCES ist kein g�ltiges JSON-Array, der Bot �berspringt Webcam-Integration.");
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

// Set f�r bereits gesendete BrightSky-Warnungen (alert.id)
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
  if (!text) return "Unbekannte Gro�stadt";
  const normalized = text.toLowerCase();

  // Bundesl�nder zu Gro�st�dten mapping
  const stateToCity = {
    "baden-w�rttemberg": "Stuttgart",
    "bayern": "M�nchen",
    "berlin": "Berlin",
    "brandenburg": "Potsdam",
    "bremen": "Bremen",
    "hamburg": "Hamburg",
    "hessen": "Frankfurt am Main",
    "mecklenburg-vorpommern": "Rostock",
    "niedersachsen": "Hannover",
    "nordrhein-westfalen": "K�ln",
    "rheinland-pfalz": "Mainz",
    "saarland": "Saarbr�cken",
    "sachsen": "Dresden",
    "sachsen-anhalt": "Magdeburg",
    "schleswig-holstein": "Kiel",
    "th�ringen": "Erfurt"
  };

  // Zus�tzliche Aliase und Schreibweisen f�r Bundesl�nder
  const aliases = {
    "bw": "baden-w�rttemberg",
    "bawue": "baden-w�rttemberg",
    "by": "bayern",
    "nrw": "nordrhein-westfalen",
    "rlp": "rheinland-pfalz",
    "mv": "mecklenburg-vorpommern",
    "ni": "niedersachsen",
    "sh": "schleswig-holstein",
    "sachsen-anhalt": "sachsen-anhalt",
    "sa": "sachsen-anhalt",
    "sachsen": "sachsen",
    "th�ringen": "th�ringen",
  };

  // Spezifische St�dte
  const cities = {
    "stuttgart": "Stuttgart",
    "m�nchen": "M�nchen",
    "berlin": "Berlin",
    "potsdam": "Potsdam",
    "bremen": "Bremen",
    "hamburg": "Hamburg",
    "frankfurt": "Frankfurt am Main",
    "rostock": "Rostock",
    "hannover": "Hannover",
    "k�ln": "K�ln",
    "mainz": "Mainz",
    "saarbr�cken": "Saarbr�cken",
    "dresden": "Dresden",
    "magdeburg": "Magdeburg",
    "kiel": "Kiel",
    "erfurt": "Erfurt",
    "d�sseldorf": "D�sseldorf",
    "dortmund": "Dortmund",
    "essen": "Essen",
    "leipzig": "Leipzig",
    "n�rnberg": "N�rnberg",
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
    "saarbr�cken": "Saarbr�cken",
    "chemnitz": "Chemnitz",
    "halle": "Halle",
    "jena": "Jena"
  };

  // Zuerst nach spezifischen St�dten suchen
  for (const key of Object.keys(cities)) {
    if (normalized.includes(key)) {
      return cities[key];
    }
  }

  // Dann nach Bundesl�ndern suchen
  for (const key of Object.keys(stateToCity)) {
    if (normalized.includes(key)) {
      return stateToCity[key];
    }
  }

  // Aliase
  for (const [k, v] of Object.entries(aliases)) {
    if (normalized.includes(k)) {
      return stateToCity[v] || "Unbekannte Gro�stadt";
    }
  }

  return "Unbekannte Gro�stadt";
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

  // Pr�zisere Richtungserkennung
  if (text.includes("nordosten")) return "Nordosten";
  if (text.includes("nordwesten")) return "Nordwesten";
  if (text.includes("s�dosten")) return "S�dosten";
  if (text.includes("s�dwesten")) return "S�dwesten";
  if (text.includes("nord")) return "Norden";
  if (text.includes("ost")) return "Osten";
  if (text.includes("s�d")) return "S�den";
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
  if (entry.kategorie === "rotation") return "Erh�ht";
  const text = `${entry.beschreibung || ""}`.toLowerCase();
  if (text.includes("tornado")) return "Erh�ht";
  if (text.includes("rotation") || text.includes("wallcloud")) return "Moderat";
  return "Unbekannt";
}

function getRadarLinks() {
  return `[DWD Radar](${DWD_RADAR_URL}) � [Satellit](${DWD_SATELLITE_URL})`;
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
    embedColor = 0xff0000; // Rot f�r Tornado
  } else if (entry.kategorie === "rotation") {
    if (rotationStrenght >= 4) embedColor = 0xff0000; // Rot f�r 4/5-5/5
    else if (rotationStrenght >= 3) embedColor = 0xff6600; // Orange f�r 3/5
    else embedColor = 0xffcc00; // Gelb f�r 1/5-2/5
  } else if (alertLevel === "Extrem") {
    embedColor = 0xff0000; // Rot
  } else if (alertLevel === "Hoch") {
    embedColor = 0xff6600; // Orange
  } else if (alertLevel === "Gering") {
    embedColor = 0x00aa00; // Gr�n f�r Gering
  } else if (alertLevel === "Gering") {
    embedColor = 0x00aa00; // Gr�n f�r Gering
  }

  const fields = [
    { name: "Quelle", value: entry.quelle, inline: true },
    { name: "Ph�nomen", value: entry.ereignis || "Unbekannt", inline: true },
    { name: "Warnstufe", value: alertLevel, inline: true }
  ];

  // Zeige Orts-Felder je nach Quelle an
  if (entry.quelle === 'BrightSky') {
    // F�r Bright Sky: zeige die Regionen
    fields.push({ name: "Betroffene Landkreise", value: entry.landkreis || "Unbekannt", inline: false });
  } else {
    // F�r DWD und andere: zeige Bundesland und Landkreis
    fields.push({ name: "Bundesland, Landkreis", value: `${entry.region || "Unbekannt"}, ${entry.landkreis || "Unbekannt"}`, inline: false });
    fields.push({ name: "N�chste Gro�stadt", value: city, inline: false });
    fields.push({ name: "Wird diese Stadt �berquert?", value: crosses ? `Ja, ${city} liegt im m�glichen Wirkungsbereich dieser Warnung.` : `Nein, ${city} liegt au�erhalb des betroffenen Bereichs.`, inline: false });
  }

  if (entry.kategorie === "rotation" || entry.kategorie === "tornado") {
    // F�r Rotationen/Tornados
    fields.push({ name: "St�rke", value: entry.kategorie === "tornado" ? fujita : rotationStrenght + "/5", inline: true });
    fields.push({ name: "Best�tigung in Deutschland", value: confirmed ? "Ja ?" : "Noch nicht best�tigt", inline: true });
    
    const riskText = rotationStrenght >= 4 ? "Sehr hohes Risiko" : rotationStrenght >= 3 ? "Hohes Risiko" : "Erh�htes Risiko";
    fields.push({ name: "Tornado-Risiko", value: `${tornadoProb} (${riskText})`, inline: true });
    
    fields.push({ name: "Entwicklung", value: entry.entwicklung || "Rotation kann sich verst�rken, abschw�chen oder zu einem Tornado entwickeln. Beobachte Zugrichtung, Aufwindkern und Niederschlagsstruktur.", inline: false });
    fields.push({ name: "Zugrichtung", value: `${direction} � nahegelegene Orte beobachten.`, inline: false });
  } else if (entry.quelle === 'BrightSky') {
    // F�r Bright Sky Warnungen: zeige Beschreibung (gek�rzt auf Discord-Limit)
    const desc = entry.beschreibung || "Keine zus�tzliche Beschreibung verf�gbar.";
    const truncatedDesc = desc.length > 1000 ? desc.substring(0, 997) + '...' : desc;
    fields.push({ name: "Details", value: truncatedDesc, inline: false });
  } else {
    // F�r sonstige Warnungen
    fields.push({ name: "Schwere", value: entry.schwere || "Unbekannt", inline: true });
    fields.push({ name: "St�rke", value: fujita, inline: true });
    const desc = entry.beschreibung || "Keine zus�tzliche Beschreibung verf�gbar.";
    const truncatedDesc = desc.length > 1000 ? desc.substring(0, 997) + '...' : desc;
    fields.push({ name: "Beschreibung", value: truncatedDesc, inline: false });
  }

  if (entry.start && entry.ende) {
    fields.push({ name: "G�ltig", value: `${formatTimestamp(entry.start)} bis ${formatTimestamp(entry.ende)}`, inline: false });
  }

  fields.push({ name: "Ausgegeben", value: formatTimestamp(entry.letztesUpdate), inline: true });
  fields.push({ name: "Links", value: getRadarLinks(), inline: true });

  if (webcamUrl) {
    fields.push({ name: "Webcam", value: `[Livebild ansehen](${webcamUrl})`, inline: true });
  }

  // K�rze lange Titel
  const truncatedTitle = String(entry.ereignis || entry.titel || "Wetterlage").substring(0, 200);

  return {
    title: `${entry.icon || "??"} ${truncatedTitle}`,
    description: String(entry.beschreibung || "�bersicht der aktuellen Wetterlage").substring(0, 1000),
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
  if (text.includes("erh�ht")) return 3;
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
    id: raw.id || null, // F�r Deduplication (z.B. alert.id aus Bright Sky)
    quelle: quelle || raw.quelle || "DWD",
    titel: raw.titel || raw.ereignis || raw.type || "Wetterlage",
    ereignis: raw.ereignis || raw.titel || raw.type || "Wetterlage",
    beschreibung: raw.beschreibung || raw.description || raw.comment || "Keine zus�tzliche Beschreibung.",
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
    icon: raw.icon || (raw.kategorie === "tornado" ? "???" : raw.kategorie === "rotation" ? "???" : "??"),
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
  throw new Error("Keine DWD-Warnquelle verf�gbar.");
}

function parseDwdData(data) {
  if (!data) {
    // Mock-Daten f�r Testzwecke
    console.log("Verwende Mock-DWD-Daten f�r Testzwecke");
    data = {
      alerts: [
        {
          region: "Bayern",
          area: "M�nchen",
          severity: "gelb",
          event: "Starkregen",
          description: "Es wird mit Starkregen gerechnet. In den n�chsten Stunden k�nnen 20-30 l/m� fallen.",
          onset: Date.now() + 300000, // in 5 Minuten (damit es als warning gilt)
          ends: Date.now() + 7200000, // in 2 Stunden
          sent: Date.now(),
          url: "https://www.dwd.de"
        },
        {
          region: "Nordrhein-Westfalen",
          area: "K�ln",
          severity: "orange",
          event: "Gewitter",
          description: "Gewitter mit Starkregen und Hagel m�glich. Lokale �berschwemmungen nicht ausgeschlossen.",
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
    const beschreibung = props.description || props.body || "Keine zus�tzliche Beschreibung.";
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

  // Daten k�nnen verschieden strukturiert sein; versuche mehrere Formen
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

// Bright Sky (DWD-Daten) integration � optional, wenn BRIGHT_SKY_URL gesetzt ist.
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
    console.error('Bright Sky Vorhersage konnte nicht geladen werden:', error);
    return null;
  }
}

function parseBrightSkyWarnings(data) {
  // Erwartet eine Liste von Warnobjekten mit start/end/description/level/region
  if (!data) {
    console.log('[BrightSky] Keine Warnungsdaten empfangen.');
    return [];
  }

  // M�gliche Formen: Array direkt, { alerts: [...] }, { features: [...] }
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data.alerts)) items = data.alerts;
  else if (Array.isArray(data.features)) items = data.features.map(f => f.properties || f);
  else if (Array.isArray(data.data)) items = data.data;

  if (!items.length) {
    console.log('[BrightSky] Warnungsliste ist leer � keine Warnungen vorhanden.');
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
    
    // Severity-Mapping f�r Deutsche Warnstufen
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
      id: w.id || null, // Bright Sky alert.id f�r Deduplication
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

  // M�gliche Formate: { days: [...] } oder { daily: [...] } oder direkt array
  const days = Array.isArray(data.days) ? data.days : Array.isArray(data.daily) ? data.daily : Array.isArray(data) ? data : null;
  if (!days) {
    console.log('[BrightSky] Keine Day-Struktur gefunden.');
    return null;
  }

  console.log(`[BrightSky] ${days.length} Tage in Vorhersage gefunden.`);
  // Normalisiere minimal: [{ date, summary, temp_min, temp_max, condition }]
  return days.map(d => ({
    date: d.date || d.dt || d.timestamp || d.time || null,
    summary: d.summary || d.description || (d.temp_min || '') + '�' + (d.temp_max || '') + '�C ' + (d.condition || ''),
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
    console.warn(`L�schen der Nachricht ${messageId} fehlgeschlagen:`, error.message);
  }
}

async function postForecast(client, state) {
  try {
    const channel = await client.rest.channels.get(VORHERSAGE_CHANNEL);
    if (!channel) return;

    // Abruf der BrightSky-Vorhersage
    const brightData = await fetchBrightSkyForecast();
    if (brightData === null) {
      console.error('BrightSky Vorhersage konnte nicht geladen werden � Abbruch, sende keine Vorhersage.');
      return;
    }

    // Extrahiere st�ndliche Daten: bevorzugt response.data.weather
    const weatherArray = (brightData && brightData.data && Array.isArray(brightData.data.weather))
      ? brightData.data.weather
      : Array.isArray(brightData.weather)
        ? brightData.weather
        : Array.isArray(brightData.days)
          ? brightData.days
          : null;

    if (!weatherArray || !weatherArray.length) {
      console.log('[BrightSky] Keine st�ndlichen Wetterdaten gefunden, �berspringe Vorhersage.');
      return;
    }

    // Gruppiere st�ndliche Eintr�ge nach Datum (YYYY-MM-DD)
    const groups = {};
    for (const e of weatherArray) {
      const ts = e.timestamp || e.dt || e.time || e.date || e.datetime;
      let dateObj = null;
      if (typeof ts === 'number') {
        dateObj = new Date(ts < 1e12 ? ts * 1000 : ts);
      } else if (typeof ts === 'string') {
        dateObj = new Date(ts);
      }
      if (!dateObj || isNaN(dateObj)) continue;
      const key = dateObj.toISOString().split('T')[0];
      groups[key] = groups[key] || [];
      groups[key].push(e);
    }

    const allDates = Object.keys(groups).sort();
    if (!allDates.length) {
      console.log('[BrightSky] Keine gruppierbaren Daten f�r Vorhersage gefunden.');
      return;
    }

    // W�hle 3-7 Tage (min 3, max 7) beginnend ab heute, wenn m�glich
    const heuteStr = new Date().toISOString().split('T')[0];
    let selected = allDates.filter(d => d >= heuteStr).slice(0, 7);
    if (selected.length < 3) {
      selected = allDates.slice(0, Math.min(7, Math.max(3, allDates.length)));
    }

    const fields = [];
    for (const dateKey of selected) {
      const entries = groups[dateKey];
      // Ermittle min/max Temperatur
      let temps = entries.map(ent => ent.temperature ?? ent.temp ?? ent.temp_c ?? ent.air_temperature ?? ent.t ?? ent.t2m).filter(t => t !== undefined && t !== null).map(Number).filter(n => !Number.isNaN(n));
      const minT = temps.length ? Math.min(...temps) : null;
      const maxT = temps.length ? Math.max(...temps) : null;

      // Bestimme grobe Wetterbeschreibung (h�ufigste condition/symbol)
      const condCount = {};
      for (const ent of entries) {
        const cond = (ent.condition || ent.summary || ent.description || ent.symbol_code || ent.weather || '').toString();
        if (!cond) continue;
        condCount[cond] = (condCount[cond] || 0) + 1;
      }
      const sortedCond = Object.entries(condCount).sort((a, b) => b[1] - a[1]);
      const mainCond = sortedCond.length ? sortedCond[0][0] : '';

      const dateObj = new Date(dateKey + 'T00:00:00Z');
      const label = dateObj.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'short' });
      const tempStr = minT !== null && maxT !== null ? `${Math.round(minT)}�${Math.round(maxT)}�C` : 'Keine Temperaturdaten';
      const summary = `${tempStr} ${mainCond}`.trim();
      fields.push({ name: `${label}`, value: summary || 'Keine Daten', inline: false });
    }

    fields.push({ name: 'Stand', value: formatTimestamp(Date.now()), inline: false });

    const embed = {
      title: `?? Allgemeiner Wetterbericht f�r Deutschland (Zentraler Richtwert)`,
      description: `Automatisch aktualisierte Mehrtages-�bersicht (Bright Sky) � zentraler Richtwert aus st�ndlichen Daten.`,
      color: 0x0066cc,
      fields,
      footer: { text: `Quelle: Bright Sky` },
      timestamp: new Date().toISOString()
    };

    // Wenn noch keine globale Nachricht existiert: senden und speichern
    if (!vorhersageNachricht) {
      try {
        const msg = await channel.createMessage({ embeds: [embed] });
        vorhersageNachricht = msg;
        // Optional: persistent speichern
        try { state.vorhersageMessageId = msg.id; saveState(state); } catch (e) {}
        console.log('Wettervorhersage gesendet!');
        return;
      } catch (sendErr) {
        console.error('Fehler beim Senden der Vorhersage:', sendErr);
        return;
      }
    }

    // Versuch, die existierende Nachricht zu bearbeiten
    try {
      if (typeof vorhersageNachricht.edit === 'function') {
        await vorhersageNachricht.edit({ embeds: [embed] });
      } else if (vorhersageNachricht.id) {
        // Fallback: edit via Channel
        await channel.editMessage(vorhersageNachricht.id, { embeds: [embed] });
      } else {
        throw new Error('Keine g�ltige Vorhersage-Nachricht zum Editieren.');
      }
      console.log('Wettervorhersage still aktualisiert.');
    } catch (editErr) {
      console.warn('Bearbeiten der Vorhersage fehlgeschlagen, sende neu:', editErr);
      // Zur Sicherheit zur�cksetzen, damit beim n�chsten Lauf neu gesendet wird
      vorhersageNachricht = null;
      if (state.vorhersageMessageId) { state.vorhersageMessageId = null; saveState(state); }
      try {
        const msg2 = await channel.createMessage({ embeds: [embed] });
        vorhersageNachricht = msg2;
        try { state.vorhersageMessageId = msg2.id; saveState(state); } catch (e) {}
        console.log('Wettervorhersage gesendet (Fallback).');
      } catch (sendErr2) {
        console.error('Fehler beim Senden der Vorhersage im Fallback:', sendErr2);
      }
    }
  } catch (error) {
    console.error('Vorhersage konnte nicht gesendet werden:', error && error.message ? error.message : error);
  }
}


async function syncWeather(client, state) {
  try {
    const now = Date.now();
    const url = process.env.BRIGHT_SKY_ALERTS_URL || 'https://api.brightsky.dev/alerts';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { headers: { 'User-Agent': 'WetterBot/1.0' }, signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json();
    const alerts = data && Array.isArray(data.alerts) ? data.alerts : [];

    console.log(`[BrightSky Alerts] API erfolgreich abgefragt. Aktive Warnungen in Deutschland: ${alerts.length}. Sende-Sicherung ist aktiv.`);
    if (!alerts.length) return;

    state.sentAlertKeys = Array.isArray(state.sentAlertKeys) ? state.sentAlertKeys : [];
    state.bundeslandEmbedIds = state.bundeslandEmbedIds || {};
    state.istBereit = Boolean(state.istBereit);
    istBereit = state.istBereit;

    const knownIds = new Set(state.sentAlertKeys);

    if (!istBereit && knownIds.size === 0) {
      for (const alert of alerts) {
        if (!alert || !alert.id) continue;
        knownIds.add(alert.id);
        state.sentAlertKeys.push(alert.id);
      }
      istBereit = true;
      state.istBereit = true;
      saveState(state);
      console.log('Erster Start: vorhandene Warnungen stumm gelernt. Keine Meldungen gesendet.');
      return;
    }

    if (!istBereit && knownIds.size > 0) {
      istBereit = true;
      state.istBereit = true;
      saveState(state);
    }

    if (!istBereit) {
      return;
    }

    const newAlerts = alerts.filter(alert => alert && alert.id && !knownIds.has(alert.id));
    if (!newAlerts.length) return;

    const grouped = {};
    for (const alert of newAlerts) {
      const headline = String(alert.headline || alert.title || alert.event || 'Warnung').trim();
      const description = String(alert.description || alert.body || '').trim();
      let regionsArr = [];
      if (Array.isArray(alert.regions) && alert.regions.length) {
        regionsArr = alert.regions.map(r => String(r).trim()).filter(Boolean);
      } else if (typeof alert.regions === 'string' && alert.regions.trim()) {
        regionsArr = alert.regions.split(',').map(r => r.trim()).filter(Boolean);
      } else if (alert.region) {
        regionsArr = [String(alert.region).trim()];
      }

      const stateName = regionsArr.length ? regionsArr[regionsArr.length - 1] : 'Deutschland';
      const counties = regionsArr.length > 1 ? regionsArr.slice(0, -1) : (regionsArr.length === 1 ? [regionsArr[0]] : ['Deutschland']);

      grouped[stateName] = grouped[stateName] || { warnings: new Map(), counties: new Set(), ids: [] };
      const warnKey = `${headline}||${description}`;
      if (!grouped[stateName].warnings.has(warnKey)) {
        grouped[stateName].warnings.set(warnKey, { headline, description });
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
      const countiesText = counties.join(', ') || 'Gesamtgebiet';
      const detailsText = Array.from(info.warnings.values())
        .map(w => `**${w.headline}**\n${w.description || 'Keine zus�tzliche Beschreibung.'}`)
        .join('\n\n')
        .substring(0, 1024);

      const embed = {
        title: `?? Wetterwarnungen f�r ${stateName}`,
        color: 0xff3300,
        fields: [
          { name: 'Details', value: detailsText || 'Keine ausf�hrlichen Details verf�gbar.', inline: false },
          { name: 'Betroffene Regionen', value: countiesText.substring(0, 1024), inline: false }
        ],
        footer: { text: 'Quelle: Bright Sky � Gruppierte Bundesland-Zusammenfassung' },
        timestamp: new Date().toISOString()
      };

      const existingMessageId = state.bundeslandEmbedIds[stateName] || bundeslandEmbedIds[stateName];
      if (existingMessageId) {
        try {
          await channel.editMessage(existingMessageId, { embeds: [embed] });
          console.log(`Bundesland-Embed f�r ${stateName} aktualisiert.`);
          bundeslandEmbedIds[stateName] = existingMessageId;
          state.bundeslandEmbedIds[stateName] = existingMessageId;
          for (const id of info.ids) {
            if (!knownIds.has(id)) {
              knownIds.add(id);
              state.sentAlertKeys.push(id);
            }
          }
          saveState(state);
          continue;
        } catch (err) {
          console.warn(`Editieren des Bundesland-Embeds f�r ${stateName} fehlgeschlagen, sende neu:`, err && err.message ? err.message : err);
          delete bundeslandEmbedIds[stateName];
          delete state.bundeslandEmbedIds[stateName];
        }
      }

      try {
        const msg = await channel.createMessage({ embeds: [embed] });
        bundeslandEmbedIds[stateName] = msg.id;
        state.bundeslandEmbedIds[stateName] = msg.id;
        for (const id of info.ids) {
          if (!knownIds.has(id)) {
            knownIds.add(id);
            state.sentAlertKeys.push(id);
          }
        }
        saveState(state);
        console.log(`Neue Bundesland-Zusammenfassung f�r ${stateName} gesendet.`);
      } catch (err) {
        console.warn(`Senden des Bundesland-Embeds f�r ${stateName} fehlgeschlagen:`, err && err.message ? err.message : err);
      }
    }

    state.letzteSync = now;
    saveState(state);
  } catch (err) {
    console.warn('BrightSky Abruf fehlgeschlagen:', err && err.message ? err.message : err);
    return;
  }
}function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("WetterVorhersage-Bot l�uft\n");
  }).listen(port, () => {
    console.log(`Health-Server l�uft auf Port ${port}`);
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
  // Health-Server EINMAL beim Start starten (NICHT im ready-Event!)
  startHealthServer();
  
  startBot().catch((error) => {
    console.error("Start des Wetterbots fehlgeschlagen:", error);
    process.exit(1);
  });
}

module.exports = { startBot };
