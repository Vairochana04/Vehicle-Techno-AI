import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { uid, now } from './utils.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, passwordHash TEXT NOT NULL, bankName TEXT, lat REAL, lng REAL, rating REAL NOT NULL DEFAULT 0, ratingCount INTEGER NOT NULL DEFAULT 0, ratingSum REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS otp_codes(phone TEXT PRIMARY KEY, code TEXT NOT NULL, expiresAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, bankId TEXT NOT NULL, seekerName TEXT NOT NULL, seekerPhone TEXT, seekerEmail TEXT, loanRef TEXT, regNumber TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, variant TEXT, year INTEGER NOT NULL, fuel TEXT, transmission TEXT, vehicleLat REAL, vehicleLng REAL, address TEXT, city TEXT, pincode TEXT, expectedOdometer INTEGER, valuationFee REAL NOT NULL DEFAULT 2500, status TEXT NOT NULL DEFAULT 'CREATED', verification TEXT, assignedInspectorId TEXT, allocationMode TEXT NOT NULL DEFAULT 'FIRST_COME', broadcastRadiusKm REAL NOT NULL DEFAULT 25, priorityUntil TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inspections(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, inspectorId TEXT NOT NULL, odometerReading INTEGER, chassisNumber TEXT, conditionJson TEXT, damagesJson TEXT, manualValuation REAL, manualRepairEstimate REAL, notes TEXT, imagesJson TEXT, documentsJson TEXT, submittedAt TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, damageJson TEXT NOT NULL, fraudJson TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS valuations(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, marketValue REAL NOT NULL, aiValuation REAL NOT NULL, manualValuation REAL NOT NULL, variancePct REAL NOT NULL, flag TEXT NOT NULL, finalValuation REAL, status TEXT NOT NULL, varianceReasonsJson TEXT, auditJson TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, createdAt TEXT NOT NULL, deliveredAt TEXT);
CREATE TABLE IF NOT EXISTS ratings(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, inspectorId TEXT NOT NULL, seekerJson TEXT NOT NULL, seekerScore REAL NOT NULL, platformScore REAL NOT NULL, composite REAL NOT NULL, feedback TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, jobId TEXT, type TEXT NOT NULL, fromParty TEXT, toParty TEXT, userId TEXT, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'PAID', ref TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, userId TEXT, title TEXT NOT NULL, body TEXT, channel TEXT NOT NULL DEFAULT 'PUSH', isRead INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY, jobId TEXT, actorId TEXT, action TEXT NOT NULL, detail TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bank_feedback(id TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, bankId TEXT NOT NULL, scoresJson TEXT NOT NULL, avgScore REAL NOT NULL, comment TEXT, createdAt TEXT NOT NULL);
`);
const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
export const settings = {
  get allocationMode() { return getSetting('allocationMode', 'FIRST_COME'); },
  get radiusKm() { return Number(getSetting('radiusKm', String(config.defaultRadiusKm))); },
  set(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); },
};
export function audit(jobId, actorId, action, detail = '') {
  db.prepare('INSERT INTO audit_log VALUES(?,?,?,?,?,?)').run(uid(), jobId || null, actorId || null, action, String(detail || ''), now());
}
export function notify(userId, title, body, channel = 'PUSH') {
  db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,?)').run(uid(), userId || null, title, body || '', channel, 0, now());
}
export function addLedger({ jobId = null, type, fromParty, toParty, userId = null, amount, status = 'PAID', ref = '' }) {
  const existing = ref ? db.prepare('SELECT id FROM ledger WHERE type=? AND jobId IS ? AND ref=?').get(type, jobId, ref) : null;
  if (existing) return existing.id; // idempotency guard — money never double-posts
  const id = uid();
  db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, jobId, type, fromParty, toParty, userId, amount, status, ref, now());
  return id;
}
export function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const hash = (p) => bcrypt.hashSync(p, 8); const t = now();
  const users = [
    ['ADMIN', 'Platform Admin', 'admin@valuation.techno', '+919000000001', 'Admin@123', null, 11.0168, 76.9558],
    ['BANK', 'Arun Kumar (HDFC Bank)', 'bank@valuation.techno', '+919000000002', 'Bank@123', 'HDFC Bank', 11.0168, 76.9558],
    ['INSPECTOR', 'Inspector Ravi', 'inspector@valuation.techno', '+919000000003', 'Inspector@123', null, 11.0200, 76.9600],
    ['INSPECTOR', 'Inspector Priya', 'inspector2@valuation.techno', '+919000000004', 'Inspector@123', null, 11.0500, 76.9900],
    ['INSPECTOR', 'Inspector Karthik (Far)', 'inspector3@valuation.techno', '+919000000005', 'Inspector@123', null, 13.0827, 80.2707],
    ['LOAN_SEEKER', 'Demo Loan Seeker', 'seeker@valuation.techno', '+919000000006', 'Seeker@123', null, 11.0168, 76.9558],
  ];
  for (const u of users) db.prepare('INSERT INTO users(id,role,name,email,phone,passwordHash,bankName,lat,lng,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid(), u[0], u[1], u[2], u[3], hash(u[4]), u[5], u[6], u[7], t);
  // Give Ravi a strong prior rating so RATING_PRIORITY mode is demonstrable
  db.prepare("UPDATE users SET rating=4.6, ratingCount=12, ratingSum=55.2 WHERE email='inspector@valuation.techno'").run();
  db.prepare("UPDATE users SET rating=4.1, ratingCount=8, ratingSum=32.8 WHERE email='inspector2@valuation.techno'").run();
}
export const publicUser = (u) => u && ({ id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, bankName: u.bankName, lat: u.lat, lng: u.lng, rating: u.rating, ratingCount: u.ratingCount, status: u.status });
export const parseJob = (j) => j && ({ ...j, verification: j.verification ? JSON.parse(j.verification) : null });
