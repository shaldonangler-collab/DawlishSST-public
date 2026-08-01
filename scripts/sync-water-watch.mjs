import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mappingPath = join(root, "water_watch_sites.json");
const outputPath = join(root, "latest_water_watch.json");
const baseUrl = "https://riverhub-teign.vercel.app/explore/sites";
const sheetId = "1tLSBwgaX7mqT1h0_mpzvznemQFq335q6zDInnP5-k34";
const dryRun = process.argv.includes("--dry-run");

const decodeHtml = value => value
  .replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#(?:39|x27);/gi, "'")
  .trim();

function rowsFromHtml(html) {
  return Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi), match =>
    Array.from(match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi), cell => decodeHtml(cell[1]))
  ).filter(cells => cells.length >= 3);
}

function latestBactiquick(html) {
  return rowsFromHtml(html)
    .filter(cells => cells[1]?.trim().toLowerCase() === "bactiquick")
    .map(cells => {
      const result = cells[2]?.match(/(-?\d+(?:\.\d+)?)\s*ERU/i);
      return result ? {
        sampleDate: cells[0],
        eru: Number(result[1]),
        collector: cells[3] || null
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.sampleDate.localeCompare(a.sampleDate))[0] ?? null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function isoDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? match[3] + "-" + match[2].padStart(2, "0") + "-" + match[1].padStart(2, "0") : value;
}

function numberOrNull(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isFinite(number) ? number : null;
}

function categoryFromRating(value) {
  const rating = String(value || "").trim().toLowerCase();
  if (rating.includes("high")) return "high";
  if (rating.includes("medium")) return "medium";
  if (rating.includes("low")) return "low";
  return null;
}

function categoryFor(eru, thresholds) {
  if (eru == null) return "pending";
  if (eru >= thresholds.highFrom) return "high";
  if (eru >= thresholds.mediumFrom) return "medium";
  return "low";
}

async function fetchLatest(site) {
  if (!site.riverHubSiteId) return null;
  const url = baseUrl + "/" + site.riverHubSiteId;
  const response = await fetch(url, {
    headers: { "user-agent": "Friends-of-the-River-Teign-Water-Watch/1.0" }
  });
  if (!response.ok) throw new Error(site.name + ": River Hub returned " + response.status);
  const record = latestBactiquick(await response.text());
  return record ? { ...record, sourceUrl: url } : null;
}

async function fetchSheetMeasurement(site, record) {
  if (!site.sheetName || !record) return null;
  const url = "https://docs.google.com/spreadsheets/d/" + sheetId +
    "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(site.sheetName);
  const response = await fetch(url, {
    headers: { "user-agent": "Friends-of-the-River-Teign-Water-Watch/1.0" }
  });
  if (!response.ok) throw new Error(site.name + ": Google Sheet returned " + response.status);

  const rows = parseCsv(await response.text());
  const headers = rows.shift() ?? [];
  const column = name => headers.indexOf(name);
  const dateColumn = column("Date collected");
  const resultColumn = column("Result (ERU)");
  const ratingColumn = column("Risk rating (as shown on the device)");
  const temperatureColumn = column("Temperature (°C)");
  const salinityColumn = column("Salinity (ppt)");

  const match = rows.find(row =>
    isoDate(row[dateColumn]) === record.sampleDate &&
    numberOrNull(row[resultColumn]) === record.eru
  );
  if (!match) return null;

  return {
    category: categoryFromRating(match[ratingColumn]),
    tempC: numberOrNull(match[temperatureColumn]),
    salinityPpt: numberOrNull(match[salinityColumn])
  };
}

const config = JSON.parse(await readFile(mappingPath, "utf8"));
const previous = JSON.parse(await readFile(outputPath, "utf8"));
const sites = [];

for (const mapping of config.sites) {
  const record = await fetchLatest(mapping);
  const measurement = await fetchSheetMeasurement(mapping, record);
  sites.push({
    id: mapping.localId,
    name: mapping.name,
    category: measurement?.category ?? categoryFor(record?.eru, config.thresholds),
    eru: record?.eru ?? null,
    sampleDate: record?.sampleDate ?? null,
    collector: record?.collector ?? null,
    tempC: measurement?.tempC ?? null,
    salinityPpt: measurement?.salinityPpt ?? null,
    rainfall24hMm: null,
    tide: null,
    riverHubSiteId: mapping.riverHubSiteId,
    sourceUrl: record?.sourceUrl ?? null
  });
}

const dates = sites.map(site => site.sampleDate).filter(Boolean).sort().reverse();
const data = {
  date: dates[0] ?? new Date().toISOString().slice(0, 10),
  updated: null,
  sampled: null,
  recorded: null,
  generatedAt: previous.generatedAt,
  source: "River Hub public site; measurements enriched from Google Sheet",
  sites
};

const comparable = value => JSON.stringify({ ...value, generatedAt: null });
const changed = comparable(data) !== comparable(previous);
if (changed) data.generatedAt = new Date().toISOString();

const json = JSON.stringify(data, null, 2) + "\n";
if (dryRun) process.stdout.write(json);
else if (changed) {
  await writeFile(outputPath, json, "utf8");
  console.log("Updated " + outputPath);
} else {
  console.log("No Bactiquick result changes");
}
