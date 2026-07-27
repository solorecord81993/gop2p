/* =====================================================================
 * GO BATTLE LIVE — neural-ai.js
 * Adapter สำหรับ KataGo neural network analysis engine
 *
 * รองรับ 2 วิธี:
 *   1. Remote HTTPS endpoint (เหมาะกับ Vercel)
 *   2. KataGo process แบบ long-running (เหมาะกับ Render / เครื่อง GPU)
 *
 * ทั้งสองวิธีใช้ JSON Analysis Engine protocol ของ KataGo โดยตรง
 * และไม่เรียก AI แบบ heuristic ว่าเป็น neural หากยังไม่ได้ตั้งค่า
 * ===================================================================== */

'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { randomUUID } = require('crypto');
const { BLACK, WHITE } = require('./go-engine.js');

const GTP_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

function intSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function settingsFromEnv(env = process.env) {
  const apiUrl = String(env.KATAGO_API_URL || '').trim();
  const bin = String(env.KATAGO_BIN || '').trim();
  const model = String(env.KATAGO_MODEL || '').trim();
  const config = String(env.KATAGO_CONFIG || '').trim();
  const mode = apiUrl ? 'remote' : (bin && model && config ? 'local' : 'disabled');
  return {
    mode,
    apiUrl,
    apiKey: String(env.KATAGO_API_KEY || '').trim(),
    bin,
    model,
    config,
    maxVisits: intSetting(env.KATAGO_MAX_VISITS, 1600, 1, 100_000),
    rootSymmetries: intSetting(env.KATAGO_ROOT_SYMMETRIES, 8, 1, 8),
    timeoutMs: intSetting(env.KATAGO_TIMEOUT_MS, 20_000, 1_000, 120_000),
    cooldownMs: intSetting(env.KATAGO_RETRY_COOLDOWN_MS, 30_000, 0, 600_000),
  };
}

function colorName(color) {
  if (color === BLACK) return 'B';
  if (color === WHITE) return 'W';
  throw new Error('Unknown Go color');
}

function toGtp(x, y, size) {
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= size || y >= size || x >= GTP_COLUMNS.length) {
    throw new Error('Coordinate is outside the supported board');
  }
  return `${GTP_COLUMNS[x]}${size - y}`;
}

function fromGtp(value, size) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'PASS') return { pass: true };
  const m = raw.match(/^([A-HJ-Z])(\d+)$/);
  if (!m) return null;
  const x = GTP_COLUMNS.indexOf(m[1]);
  const row = Number(m[2]);
  const y = size - row;
  if (x < 0 || x >= size || y < 0 || y >= size) return null;
  return { pass: false, x, y };
}

function buildAnalysisQuery(game, color, options = {}) {
  const initialStones = [];
  for (let y = 0; y < game.size; y++) {
    for (let x = 0; x < game.size; x++) {
      const stone = game.get(x, y);
      if (stone === BLACK || stone === WHITE) {
        initialStones.push([colorName(stone), toGtp(x, y, game.size)]);
      }
    }
  }

  const query = {
    id: options.id || randomUUID(),
    moves: [],
    initialStones,
    initialPlayer: colorName(color),
    rules: 'japanese',
    komi: game.komi,
    boardXSize: game.size,
    boardYSize: game.size,
    maxVisits: intSetting(options.maxVisits, 1600, 1, 100_000),
    analysisPVLen: 1,
  };
  const rootSymmetries = intSetting(options.rootSymmetries, 8, 1, 8);
  if (rootSymmetries > 1) {
    query.overrideSettings = { rootNumSymmetriesToSample: rootSymmetries };
  }
  return query;
}

function responsePayload(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.result && typeof value.result === 'object') return value.result;
  if (value.analysis && typeof value.analysis === 'object') return value.analysis;
  if (value.data && typeof value.data === 'object') return value.data;
  return value;
}

function parseRemoteResponse(text, id) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('KataGo endpoint returned an empty response');

  let values;
  try {
    values = [JSON.parse(raw)];
  } catch {
    values = raw.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => JSON.parse(line));
  }

  const expanded = values.flatMap(value => Array.isArray(value) ? value : [value])
    .map(responsePayload);
  const match = expanded.find(value =>
    value && typeof value === 'object' && !value.warning &&
    (!value.id || value.id === id));
  if (!match) throw new Error('KataGo endpoint did not return a matching analysis');
  if (match.error) throw new Error(String(match.error));
  return match;
}

function chooseFromAnalysis(game, color, analysis) {
  if (analysis?.error) throw new Error(String(analysis.error));
  if (!Array.isArray(analysis?.moveInfos) || analysis.moveInfos.length === 0) {
    throw new Error('KataGo analysis contains no candidate moves');
  }

  const candidates = [...analysis.moveInfos].sort((a, b) => {
    const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return Number(b.visits || 0) - Number(a.visits || 0);
  });

  for (const info of candidates) {
    const move = fromGtp(info.move, game.size);
    if (!move) continue;
    const meta = {
      visits: Number(info.visits || 0),
      winrate: Number.isFinite(Number(info.winrate)) ? Number(info.winrate) : null,
      scoreLead: Number.isFinite(Number(info.scoreLead)) ? Number(info.scoreLead) : null,
    };
    if (move.pass) return { pass: true, neural: meta };
    if (game.isLegal(move.x, move.y, color)) return { ...move, neural: meta };
  }
  throw new Error('KataGo returned no move legal in the authoritative game state');
}

class LocalKataGoProcess {
  constructor(settings, deps = {}) {
    this.settings = settings;
    this.spawnImpl = deps.spawn || spawn;
    this.child = null;
    this.pending = new Map();
  }

  ensureStarted() {
    if (this.child && !this.child.killed && this.child.exitCode == null) return;
    const args = [
      'analysis',
      '-model', this.settings.model,
      '-config', this.settings.config,
    ];
    const child = this.spawnImpl(this.settings.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { return; }
      if (!message?.id) return;
      const request = this.pending.get(message.id);
      if (!request || message.warning || message.isDuringSearch) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(String(message.error)));
      else request.resolve(message);
    });

    child.stderr.on('data', chunk => {
      const message = String(chunk).trim();
      if (message) console.warn('[katago]', message.slice(0, 500));
    });
    child.on('error', error => this.failAll(error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.failAll(new Error(`KataGo process stopped (${signal || code || 'unknown'})`));
    });
  }

  request(query, timeoutMs) {
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(query.id);
        reject(new Error(`KataGo analysis timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(query.id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(query)}\n`, error => {
        if (!error) return;
        const request = this.pending.get(query.id);
        if (!request) return;
        this.pending.delete(query.id);
        clearTimeout(request.timer);
        request.reject(error);
      });
    });
  }

  failAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  close() {
    const child = this.child;
    this.child = null;
    this.failAll(new Error('KataGo client closed'));
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

class KataGoClient {
  constructor(settings = settingsFromEnv(), deps = {}) {
    this.settings = { ...settings };
    this.fetchImpl = deps.fetch || globalThis.fetch;
    this.local = null;
    this.state = this.configured ? 'configured' : 'disabled';
    this.lastError = null;
    this.unavailableUntil = 0;
    this.deps = deps;
  }

  get configured() {
    return this.settings.mode === 'remote' || this.settings.mode === 'local';
  }

  publicStatus() {
    return {
      engine: 'katago',
      configured: this.configured,
      transport: this.configured ? this.settings.mode : 'disabled',
      state: this.state,
      maxVisits: this.settings.maxVisits,
      rootSymmetries: this.settings.rootSymmetries,
    };
  }

  async requestRemote(query) {
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    timer.unref?.();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.settings.apiKey) headers.Authorization = `Bearer ${this.settings.apiKey}`;
    try {
      const response = await this.fetchImpl(this.settings.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(query),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`KataGo endpoint HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return parseRemoteResponse(body, query.id);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`KataGo endpoint timed out after ${this.settings.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async analyze(query) {
    if (!this.configured) throw new Error('KataGo neural engine is not configured');
    if (Date.now() < this.unavailableUntil) {
      throw new Error('KataGo neural engine is cooling down after a failed request');
    }
    try {
      let result;
      if (this.settings.mode === 'remote') {
        result = await this.requestRemote(query);
      } else {
        if (!this.local) this.local = new LocalKataGoProcess(this.settings, this.deps);
        result = await this.local.request(query, this.settings.timeoutMs);
      }
      this.state = 'online';
      this.lastError = null;
      this.unavailableUntil = 0;
      return result;
    } catch (error) {
      this.state = 'error';
      this.lastError = String(error?.message || error).slice(0, 300);
      this.unavailableUntil = Date.now() + this.settings.cooldownMs;
      throw error;
    }
  }

  async chooseMove(game, color, profile = {}) {
    const query = buildAnalysisQuery(game, color, {
      maxVisits: profile.maxVisits || this.settings.maxVisits,
      rootSymmetries: profile.rootSymmetries || this.settings.rootSymmetries,
    });
    const analysis = await this.analyze(query);
    return chooseFromAnalysis(game, color, analysis);
  }

  close() {
    this.local?.close();
    this.local = null;
  }
}

module.exports = {
  KataGoClient,
  LocalKataGoProcess,
  settingsFromEnv,
  buildAnalysisQuery,
  chooseFromAnalysis,
  parseRemoteResponse,
  toGtp,
  fromGtp,
};
