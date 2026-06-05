#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set([".git", "node_modules", "dist", "coverage"]);
const skipFiles = new Set(["scripts/privacy-scan.mjs"]);
const denyTerms = [
  ["Ka", "ran"].join(""), ["Her", "mes"].join(""), ["Yeho", "nal"].join(""),
  ["Odi", "no"].join(""), ["Tirre", "nia"].join(""), ["Dras", "sil"].join(""),
  ["Jo", "seph"].join(""), ["Coffee", "Break", "Time"].join(""), ["Giu", "seppe"].join(""),
  ["agent-mesh-tab", "oo"].join(""), ["/home/", "administrator"].join(""), ["/root/.", "openclaw"].join("")
];
const denyPatterns = [
  { name: "real Discord snowflake", re: /(?<!PLACEHOLDER)(?<![A-Z_])\b\d{17,20}\b(?![A-Z_])/ },
  { name: "secret assignment", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{6,}["']/i },
  { name: "private IP", re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/ }
];
const hits = [];
function scanFile(file) {
  const rel = path.relative(root, file);
  if (skipFiles.has(rel)) return;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return; }
  for (const term of denyTerms) if (text.toLowerCase().includes(term.toLowerCase())) hits.push(`${rel}: contains private term ${term[0]}***`);
  for (const { name, re } of denyPatterns) if (re.test(text)) hits.push(`${rel}: matches ${name}`);
}
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full); else if (stat.isFile()) scanFile(full);
  }
}
walk(root);
if (hits.length) {
  console.error("Privacy scan failed:");
  for (const hit of hits) console.error(`- ${hit}`);
  process.exit(1);
}
console.log("PASS public privacy scan");
