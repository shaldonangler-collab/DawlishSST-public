import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mappingPath = join(root, "water_watch_sites.json");
const outputPath = join(root, "latest_water_watch.json");
const baseUrl = "https://riverhub-teign.vercel.app/explore/sites";
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

function categoryFor(eru, thresholds) {
  if (eru == null) return "pending";
  if (eru >= thresholds.highFrom) return "high";
  if (eru >= thresholds.mediumFrom) return "medium";
  return "low";
}

async function fetchLatest(site) {
  if (!site.riverHubSiteId) return null;
  const url = `${baseUrl}/${site.riverHubSiteId}`;
  const response = await fetch(url, {
    headers: { "user-agent": "Friends-of-the-River-Teign-Water-Watch/1.0" }
  });
  if (!response.ok) throw new Error(`${site.name}: River Hub returned ${response.status}`);
  const record = latestBactiquick(await response.text());
  return record ? { ...record, sourceUrl: url } : null;
}

const config = JSON.parse(await readFile(mappingPath, "utf8"));
const previous = JSON.parse(await readFile(outputPath, "utf8"));
const sites = [];

for (const mapping of config.sites) {
  const record = await fetchLatest(mapping);
  sites.push({
    id: mapping.localId,
    name: mapping.name,
    category: categoryFor(record?.eru, config.thresholds),
    eru: record?.eru ?? null,
    sampleDate: record?.sampleDate ?? null,
    collector: record?.collector ?? null,
    tempC: null,
    salinityPpt: null,
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
  source: "River Hub public site",
  sites
};

const comparable = value => JSON.stringify({ ...value, generatedAt: null });
const changed = comparable(data) !== comparable(previous);
if (changed) data.generatedAt = new Date().toISOString();

const json = `${JSON.stringify(data, null, 2)}\n`;
if (dryRun) process.stdout.write(json);
else if (changed) {
  await writeFile(outputPath, json, "utf8");
  console.log(`Updated ${outputPath}`);
} else {
  console.log("No Bactiquick result changes");
}
