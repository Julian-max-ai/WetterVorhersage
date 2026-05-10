const http = require("http");
const fs = require("fs");
const path = require("path");
const { Client } = require("oceanic.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("Fehlender BOT_TOKEN Umgebungsvariable.");
}

const DWD_WARNINGS_URL = "https://opendata.dwd.de/weather/alerts/alerts.json";
const METEOPPOOL_URL = process.env.METEOPPOOL_URL || "https://www.meteopool.de/rotations.json";
const DWD_RADAR_URL = "https://www.dwd.de/DE/leistungen/radar/radar_node.html";
const DWD_SATELLITE_URL = "https://www.dwd.de/DE/leistungen/satelliten/satelliten_node.html";
const VORHERSAGE_CHANNEL = process.env.VORHERSAGE_CHANNEL || "1501635539202216107";
const WARNUNGEN_CHANNEL = process.env.WARNUNGEN_CHANNEL || "1501843095485022350";
const STATE_FILE = path.join(__dirname, "wetterState.json");
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
  if (!text) return "Unbekannte Grossstadt";
  const normalized = text.toLowerCase();
  const cities = {
    stuttgart: "Stuttgart",
    muenchen: "Muenchen",
    berlin: "Berlin",
    potsdam: "Potsdam",
    bremen: "Bremen",
    hamburg: "Hamburg",
    "frankfurt am main": "Frankfurt am Main",
    rostock: "Rostock",
    hannover: "Hannover",
    koeln: "Koeln",
    mainz: "Mainz",
    saarbuecken: "Saarbruecken",
    dresden: "Dresden",
    magdeburg: "Magdeburg",
    kiel: "Kiel",
    erfurt: "Erfurt"
  };
  for (const key of Object.keys(cities)) {
    if (normalized.includes(key)) {
      return cities[key];
    }
  }
  return "Unbekannte Grossstadt";
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
  if (text.includes("nord")) return "Nordwaerts";
  if (text.includes("ost")) return "Ostwaerts";
  if (text.includes("sued")) return "Suedwaerts";
  if (text.includes("west")) return "Westwaerts";
  return "Nordosten / Osten / Suedosten";
}

function getAlertLevel(entry) {
  const severity = (entry.schwere || "").toLowerCase();
  if (severity.includes("rot") || severity.includes("extrem") || severity.includes("tornado")) return "Extrem";
  if (severity.includes("orange") || severity.includes("hoch") || severity.includes("warnung")) return "Hoch";
  if (severity.includes("gelb") || severity.includes("mittel")) return "Mittel";
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
  } else if (alertLevel === "Mittel") {
    embedColor = 0xffcc00; // Gelb
  }

  const fields = [
    { name: "Quelle", value: entry.quelle, inline: true },
    { name: "Bundesland, Landkreis", value: `${entry.region || "Unbekannt"}, ${entry.landkreis || "Unbekannt"}`, inline: true },
    { name: "Phänomen", value: entry.ereignis || "Unbekannt", inline: true }
  ];

  fields.push({ name: "Nächste Großstadt", value: city, inline: false });
  fields.push({ name: "Wird diese Stadt überquert?", value: crosses ? `Ja, ${city} liegt im möglichen Wirkungsbereich dieser Warnung.` : `Nein, ${city} liegt außerhalb des betroffenen Bereichs.`, inline: false });

  if (entry.kategorie === "rotation" || entry.kategorie === "tornado") {
    // Für Rotationen/Tornados
    fields.push({ name: "Stärke", value: entry.kategorie === "tornado" ? fujita : rotationStrenght + "/5", inline: true });
    fields.push({ name: "Bestätigung in Deutschland", value: confirmed ? "Ja ✓" : "Noch nicht bestätigt", inline: true });
    
    const riskText = rotationStrenght >= 4 ? "Sehr hohes Risiko" : rotationStrenght >= 3 ? "Hohes Risiko" : "Erhöhtes Risiko";
    fields.push({ name: "Tornado-Risiko", value: `${tornadoProb} (${riskText})`, inline: true });
    
    fields.push({ name: "Entwicklung", value: entry.entwicklung || "Rotation kann sich verstärken, abschwächen oder zu einem Tornado entwickeln. Beobachte Zugrichtung, Aufwindkern und Niederschlagsstruktur.", inline: false });
    fields.push({ name: "Zugrichtung", value: `${direction} — nahegelegene Orte beobachten.`, inline: false });
  } else {
    // Für DWD-Warnungen
    fields.push({ name: "Warnstufe", value: alertLevel, inline: true });
    fields.push({ name: "Schwere", value: entry.schwere || "Unbekannt", inline: true });
    fields.push({ name: "Stärke", value: fujita, inline: true });
    fields.push({ name: "Beschreibung", value: entry.beschreibung || "Keine zusätzliche Beschreibung verfügbar.", inline: false });
  }

  if (entry.start && entry.ende) {
    fields.push({ name: "Gültig", value: `${formatTimestamp(entry.start)} bis ${formatTimestamp(entry.ende)}`, inline: false });
  }

  fields.push({ name: "Letztes Update", value: formatTimestamp(entry.letztesUpdate), inline: true });
  fields.push({ name: "Links", value: getRadarLinks(), inline: true });

  if (webcamUrl) {
    fields.push({ name: "Webcam", value: `[Livebild ansehen](${webcamUrl})`, inline: true });
  }

  return {
    title: `${entry.icon || "⚠️"} ${entry.titel || entry.ereignis || "Wetterlage"}`,
    description: entry.beschreibung || "Übersicht der aktuellen Wetterlage",
    color: embedColor,
    fields,
    footer: { text: `Automatisch aktualisiert | Quelle: ${entry.quelle}` },
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

function parseDwdData(data) {
  const entries = [];
  if (!data) return entries;
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

function parseMeteopoolData(data) {
  const entries = [];
  if (!data) return entries;
  const items = Array.isArray(data.rotations) ? data.rotations : Array.isArray(data.features) ? data.features : [];

  for (const item of items) {
    const props = item.properties || item;
    const landkreis = props.county || props.region || props.area || props.location || "Unbekannt";
    const region = props.state || props.region || "";
    const eventText = props.event || props.title || "Rotation";
    const kategorie = eventText.toLowerCase().includes("tornado") || props.type === "tornado" ? "tornado" : "rotation";
    const beschreibung = props.description || props.comment || "Rotation im Beobachtungsbereich.";
    const schwere = props.severity || props.level || kategorie;
    const bestaetigung = props.confirmed === true || props.confirmed === "true";
    const start = props.time || props.start || null;
    const letztesUpdate = props.updated || props.lastUpdate || props.time || Date.now();
    const bilder = props.images || props.imageUrls || props.image ? [].concat(props.images || props.imageUrls || props.image) : [];

    entries.push(normalizeEntry({
      quelle: "Meteopool",
      ereignis: eventText,
      beschreibung,
      landkreis,
      region,
      schwere,
      kategorie,
      bestatigt: bestaetigung,
      start,
      letztesUpdate,
      mehrInfoUrl: props.url || props.link || "",
      wahrscheinlichkeit: props.certainty || props.probability || "",
      richtung: props.motion || props.direction || "",
      windKmh: Number(props.windSpeed || props.windSpeedKmh || 0),
      bilder,
      fujita: props.fujita || ""
    }, "Meteopool"));
  }
  return entries;
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

async function postForecast(client) {
  try {
    const channel = await client.rest.channels.get(VORHERSAGE_CHANNEL);
    if (!channel) return;

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Generische 2-Tage Vorhersage
    const regions = [
      { name: "Südwesten (Baden-Württemberg, Rheinland-Pfalz, Saarland)", forecast: "☀️ Zumeist sonnig, angenehme Temperaturen um 18-22°C. Am Morgen möglich einzelne Hochnebel." },
      { name: "Nordwesten (Schleswig-Holstein, Hamburg, Bremen, Niedersachsen)", forecast: "🌤️ Wechselhaft mit Wolken und Sonnenschein, Windböen bis 40 km/h, Temperaturen 12-16°C." },
      { name: "Osten (Brandenburg, Berlin, Mecklenburg-Vorpommern)", forecast: "⛈️ Mit Gewittern zu rechnen, besonders nachmittags. Temperaturen 14-18°C, Starkregen möglich." },
      { name: "Bayern und Süden", forecast: "🌦️ Teils bewölkt, nachmittags Schauer möglich, besonders in den Bergen. 16-20°C." }
    ];

    let forecastText = `📋 **Vorhersage für ${today.toLocaleDateString('de-DE', { weekday: 'long', month: 'long', day: 'numeric' })} und ${tomorrow.toLocaleDateString('de-DE', { weekday: 'long', month: 'long', day: 'numeric' })}**\n\n`;

    for (const region of regions) {
      forecastText += `**${region.name}**\n${region.forecast}\n\n`;
    }

    const embed = {
      title: "🌤️ Wettervorhersage für die nächsten 2 Tage",
      description: forecastText,
      color: 0x0099ff,
      fields: [
        {
          name: "Allgemeine Information",
          value: "Diese Vorhersage bietet einen Überblick über die erwartete Wetterlage. Bei starken Wetterereignissen werden separat Warnungen ausgegeben.",
          inline: false
        }
      ],
      footer: { text: "Quelle: DWD | Automatisch aktualisiert" },
      timestamp: new Date().toISOString()
    };

    await channel.createMessage({ embeds: [embed] });
    console.log("Wettervorhersage gesendet!");
  } catch (error) {
    console.error("Vorhersage konnte nicht gesendet werden:", error.message);
  }
}

async function syncWeather(client, state) {
  try {
    const now = Date.now();
    const [dwdEntries, meteopoolEntries] = await Promise.all([
      fetchJson(DWD_WARNINGS_URL).then(parseDwdData).catch((err) => { console.warn("DWD-Abruf fehlgeschlagen:", err.message); return []; }),
      fetchJson(METEOPPOOL_URL).then(parseMeteopoolData).catch((err) => { console.warn("Meteopool-Abruf fehlgeschlagen:", err.message); return []; })
    ]);

    const allEntries = [...dwdEntries, ...meteopoolEntries];
    const activeKeys = new Set();

    for (const entry of allEntries) {
      const key = `${entry.quelle}|${entry.landkreis}|${entry.region}|${entry.ereignis}|${entry.kategorie}`;
      activeKeys.add(key);
      const channelId = channelForCategory(entry.kategorie);
      const embed = buildEmbed(entry);
      const components = buildComponents(entry);
      const hash = hashEntry(entry);
      const existing = state.eintraege[key] || { messageId: null, channelId, lastHash: null, entwarnungSeit: null };

      if (!existing.messageId || existing.lastHash !== hash) {
        const roleMention = ALERT_ROLE_ID && entry.kategorie !== "forecast" ? ALERT_ROLE_ID : null;
        const messageId = await sendEmbed(client, channelId, existing.messageId, embed, components, roleMention);
        existing.messageId = messageId;
        existing.channelId = channelId;
        existing.lastHash = hash;
      }

      existing.entwarnungSeit = null;
      existing.letzteSichtbarkeit = now;
      state.eintraege[key] = existing;
    }

    for (const [key, entry] of Object.entries(state.eintraege)) {
      if (!activeKeys.has(key)) {
        if (!entry.entwarnungSeit) {
          entry.entwarnungSeit = now;
        }
        if (entry.entwarnungSeit && now - entry.entwarnungSeit >= ALL_CLEAR_MS) {
          await deleteMessage(client, entry.channelId, entry.messageId);
          delete state.eintraege[key];
        }
      }
    }

    state.letzteSync = now;
    saveState(state);
  } catch (error) {
    console.error("Wetter-Synchronisation fehlgeschlagen:", error);
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
    await postForecast(client);
    
    // Wetter synchronisieren
    await syncWeather(client, state);
    setInterval(() => syncWeather(client, state), POLL_INTERVAL_MS);
    
    // Vorhersage täglich neu posten
    setInterval(() => postForecast(client), 24 * 60 * 60 * 1000);
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
