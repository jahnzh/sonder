#!/usr/bin/env node
// Live check (#909 follow-up): the covers the library shows are images. Reads only: signs in as the administrator,
// takes the covers of GET /api/library (the library by work) and GET /api/works that are web addresses (at most 12, one per host first), and fetches each one;
// every one must answer 200 with an image. A broken cover address (as AudiobookDB's image folders were, 25 Nov)
// fails here at deploy instead of showing a letter in every row.
import fs from "node:fs";
import { request } from "@playwright/test";
import { verifyBaseURL } from "./live-check-target.mjs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.APP_PASSWORD) throw Error("The cover check needs APP_PASSWORD, the administrator's password (from .env or the environment)");
const baseURL = verifyBaseURL();
const api = await request.newContext({ baseURL });
const report = { checked: [], errors: [] };
try {
  const login = await api.post("/api/auth/login", { data: { password: process.env.APP_PASSWORD } });
  if (!login.ok()) throw Error(`Admin sign-in failed (${login.status()})`);
  const listed = [];
  for (const path of ["/api/library", "/api/works"]) {
    const answer = await api.get(path);
    if (!answer.ok()) throw Error(`GET ${path} answered ${answer.status()}`);
    const body = await answer.json();
    listed.push(...(Array.isArray(body) ? body : body.works ?? []));
  }
  const covers = [...new Set(listed.map((work) => work.cover).filter((cover) => typeof cover === "string" && /^https:\/\//.test(cover)))];
  // One address of each host first, so every cover source is tried, then the rest up to 12.
  const byHost = new Map();
  for (const cover of covers) if (!byHost.has(new URL(cover).host)) byHost.set(new URL(cover).host, cover);
  const sample = [...new Set([...byHost.values(), ...covers])].slice(0, 12);
  for (const cover of sample) {
    let status = 0, type = "";
    try {
      const answer = await fetch(cover, { headers: { "User-Agent": "Mozilla/5.0 (Sonder cover check)" }, signal: AbortSignal.timeout(15000) });
      status = answer.status;
      type = answer.headers.get("content-type") ?? "";
      await answer.body?.cancel();
    } catch (error) {
      type = `no answer: ${error.message}`;
    }
    report.checked.push({ cover, status, type });
    if (status !== 200 || !type.startsWith("image/")) report.errors.push(`${cover} answered ${status} ${type}`);
  }
  if (!sample.length) report.skipped = "no web cover in the library";
} catch (error) {
  report.errors.push(error.message);
} finally {
  await api.dispose();
}
console.log(JSON.stringify(report, null, 2));
if (report.errors.length) process.exit(1);
