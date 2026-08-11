import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AUTH_FILE = path.join(__dirname, 'data', 'admin-auth.json');
const SESSION_COOKIE = 'market_dashboard_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64);
}

function equalText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('base64');
}

function readCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function requestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}

export class AdminAuthStore {
  constructor({ filePath = DEFAULT_AUTH_FILE, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  get configured() {
    return fs.existsSync(this.filePath);
  }

  getStatus() {
    const record = this.readRecord();
    return {
      configured: !!record,
      username: record?.username || null,
      resetMethod: 'Run npm run admin:reset on the deployment host. Web and email password recovery are not enabled.',
    };
  }

  readRecord() {
    if (!this.configured) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, ''));
      if (!parsed || parsed.version !== 1 || !normalizeUsername(parsed.username) || !parsed.salt || !parsed.passwordHash) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  resetPassword({ username = 'admin', password } = {}) {
    const normalizedUsername = normalizeUsername(username);
    const rawPassword = String(password || '');
    if (!normalizedUsername) throw new Error('管理员账号只能包含字母、数字、.、_ 或 -');
    if (rawPassword.length < 12) throw new Error('管理员密码至少需要 12 个字符');
    const salt = crypto.randomBytes(16).toString('base64');
    const record = {
      version: 1,
      username: normalizedUsername,
      salt,
      passwordHash: passwordHash(rawPassword, salt),
      updatedAt: this.now(),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    this.sessions.clear();
    this.attempts.clear();
    return { username: normalizedUsername, updatedAt: record.updatedAt };
  }

  createInitialAdmin({ username = 'admin', password, ip = 'unknown' } = {}) {
    // The web bootstrap route may only create the very first credential.  It
    // never overwrites an existing (or malformed) auth file.
    if (fs.existsSync(this.filePath)) return { ok: false, code: 'already_configured' };
    this.resetPassword({ username, password });
    return this.login({ username, password, ip });
  }

  canAttempt(ip) {
    const item = this.attempts.get(ip);
    if (!item) return true;
    if (this.now() - item.firstAt > LOGIN_WINDOW_MS) {
      this.attempts.delete(ip);
      return true;
    }
    return item.count < MAX_LOGIN_ATTEMPTS;
  }

  recordFailure(ip) {
    const now = this.now();
    const item = this.attempts.get(ip);
    if (!item || now - item.firstAt > LOGIN_WINDOW_MS) this.attempts.set(ip, { count: 1, firstAt: now });
    else this.attempts.set(ip, { ...item, count: item.count + 1 });
  }

  login({ username, password, ip = 'unknown', remember = false } = {}) {
    if (!this.configured) return { ok: false, code: 'not_configured' };
    if (!this.canAttempt(ip)) return { ok: false, code: 'rate_limited' };
    const record = this.readRecord();
    const valid = !!record
      && equalText(normalizeUsername(username), record.username)
      && equalText(passwordHash(String(password || ''), record.salt), record.passwordHash);
    if (!valid) {
      this.recordFailure(ip);
      return { ok: false, code: 'invalid_credentials' };
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const ttlMs = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
    this.sessions.set(token, { username: record.username, issuedAt: now, expiresAt: now + ttlMs });
    return { ok: true, token, username: record.username, expiresAt: now + ttlMs };
  }

  authenticate(req) {
    const token = readCookies(req?.headers?.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { token, username: session.username, expiresAt: session.expiresAt };
  }

  logout(req) {
    const token = readCookies(req?.headers?.cookie)[SESSION_COOKIE];
    if (token) this.sessions.delete(token);
  }
}

export const adminAuth = new AdminAuthStore();

function isHttpsRequest(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https' || !!req?.socket?.encrypted;
}

function sessionCookieAttributes(req, maxAge) {
  const secure = isHttpsRequest(req) ? ' Secure;' : '';
  return `Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAge}`;
}

export function sessionCookie(token, req, ttlMs = SESSION_TTL_MS) {
  return `${SESSION_COOKIE}=${token}; ${sessionCookieAttributes(req, Math.floor(ttlMs / 1000))}`;
}

export function clearSessionCookie(req) {
  return `${SESSION_COOKIE}=; ${sessionCookieAttributes(req, 0)}`;
}

export function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === String(req?.headers?.host || '') && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return false;
  }
}

export function authRequestIp(req) {
  return requestIp(req);
}

export function isStateChangingMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
}
