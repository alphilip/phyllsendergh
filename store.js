import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";

const DEFAULT_SETTINGS = {
  dmDelayMs: 9000,
  dmDailyCap: 150,
  dmHourlyCap: 0, // 0 = no hourly limit
  dmHourlyCooldownMin: 20, // rest minutes after the hourly cap is hit (0 = none)
  dmBatchSize: 0, // 0 = no batch cooldowns; N = pause after every N DMs
  dmBatchCooldownMin: 20, // cooldown minutes between batches
  groupDelayMs: 6000,
  defaultTimezone: "Africa/Accra",
  autoOptOutReply: true,
  quietEnabled: false,
  quietStart: "21:00",
  quietEnd: "07:00"
};

function blankStore() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    contacts: [],
    campaigns: [],
    followUps: [],
    reminders: [],
    schedules: [],
    statusPosts: [],
    welcomeRules: [],
    callReply: { active: false, message: "" },
    autoReplies: [],
    lists: [],
    groupNames: {},
    sentKeys: [],
    optouts: [],
    logs: []
  };
}

// Keep userIds safe for use as directory names.
function safeUserId(userId) {
  const clean = String(userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new Error("Invalid user id.");
  return clean;
}

export class UserStore {
  constructor(userId) {
    this.userId = safeUserId(userId);
    this.dataDir = path.join(BASE_DATA_DIR, this.userId);
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.sessionDir = path.join(this.dataDir, "whatsapp-session");
    this.storeFile = path.join(this.dataDir, "marketing.json");
    this.store = null;
    this.saveTimer = null;
  }

  async ensureDirs() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
  }

  // Loads from disk on first use; afterwards the in-memory copy is the
  // source of truth (dashboard, scheduler and WhatsApp handlers all share
  // this same instance within the process).
  async load() {
    if (this.store) return this.store;
    await this.ensureDirs();
    try {
      const raw = await readFile(this.storeFile, "utf8");
      const parsed = JSON.parse(raw);
      this.store = { ...blankStore(), ...parsed };
      this.store.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      // Normalize older stores.
      if (!Array.isArray(this.store.followUps)) this.store.followUps = [];
      if (!Array.isArray(this.store.reminders)) this.store.reminders = [];
      if (!Array.isArray(this.store.autoReplies)) this.store.autoReplies = [];
      if (!Array.isArray(this.store.lists)) this.store.lists = [];
      if (!Array.isArray(this.store.statusPosts)) this.store.statusPosts = [];
      if (!Array.isArray(this.store.welcomeRules)) this.store.welcomeRules = [];
      if (!this.store.callReply || typeof this.store.callReply !== "object") {
        this.store.callReply = { active: false, message: "" };
      }
      if (!this.store.groupNames || typeof this.store.groupNames !== "object") {
        this.store.groupNames = {};
      }
      for (const c of this.store.contacts || []) {
        if (!Array.isArray(c.listIds)) c.listIds = [];
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Could not read marketing store for user ${this.userId}, starting fresh:`, error.message);
      }
      this.store = blankStore();
      await this.saveNow();
    }
    return this.store;
  }

  get() {
    if (!this.store) throw new Error("Store not loaded yet.");
    return this.store;
  }

  async saveNow() {
    if (!this.store) return;
    await this.ensureDirs();
    const tmp = this.storeFile + ".tmp";
    await writeFile(tmp, JSON.stringify(this.store, null, 2), "utf8");
    await rename(tmp, this.storeFile);
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        await this.saveNow();
      } catch (error) {
        console.error(`Failed to save marketing store for user ${this.userId}:`, error.message);
      }
    }, 500);
  }

  addLog(entry) {
    const s = this.get();
    s.logs.unshift({
      id: newId(),
      ts: new Date().toISOString(),
      kind: "system",
      ok: true,
      ...entry
    });
    if (s.logs.length > 500) s.logs.length = 500;
    this.save();
  }

  isOptedOut(identifier) {
    const s = this.get();
    return s.optouts.some((o) => o.digits === identifier);
  }

  addOptOut(identifier, source = "STOP") {
    const s = this.get();
    if (!identifier || this.isOptedOut(identifier)) return false;
    s.optouts.push({ digits: identifier, source, createdAt: new Date().toISOString() });
    const contact = s.contacts.find((c) => identifierFor(c) === identifier);
    if (contact) contact.optedOut = true;
    this.addLog({ kind: "system", target: identifier, message: `Opt-out added (${source})` });
    this.save();
    return true;
  }

  setContactOptOut(identifier, optedOut) {
    const s = this.get();
    const contact = s.contacts.find((c) => identifierFor(c) === identifier);
    if (contact) contact.optedOut = !!optedOut;
    if (optedOut) {
      if (!this.isOptedOut(identifier)) {
        s.optouts.push({ digits: identifier, source: "dashboard", createdAt: new Date().toISOString() });
      }
    } else {
      s.optouts = s.optouts.filter((o) => o.digits !== identifier);
    }
    this.save();
  }

  upsertContact({ digits = "", lid = null, name, sourceGroup }) {
    const s = this.get();
    const cleanDigits = String(digits || "").replace(/\D/g, "");
    const cleanLid = lid || null;
    if (!cleanDigits && !cleanLid) return null;

    let contact = null;
    if (cleanDigits) contact = s.contacts.find((c) => c.digits === cleanDigits);
    if (!contact && cleanLid) contact = s.contacts.find((c) => c.lid === cleanLid);

    if (!contact) {
      contact = {
        id: newId(),
        digits: cleanDigits,
        lid: cleanLid,
        name: name || null,
        sourceGroups: [],
        createdAt: new Date().toISOString(),
        optedOut: false,
        lastSentAt: null
      };
      s.contacts.push(contact);
    }
    const hadDigits = !!contact.digits;
    if (cleanDigits && !contact.digits) contact.digits = cleanDigits;
    if (cleanLid && !contact.lid) contact.lid = cleanLid;
    if (cleanDigits && !hadDigits) {
      // If this contact previously opted out under their LID key, carry the
      // opt-out over to the real number now that we know it.
      const lidKey = contact.lid ? "lid:" + String(contact.lid).split("@")[0].split(":")[0] : null;
      const old = lidKey ? s.optouts.find((o) => o.digits === lidKey) : null;
      if (old) {
        s.optouts = s.optouts.filter((o) => o.digits !== lidKey);
        if (!s.optouts.some((o) => o.digits === cleanDigits)) {
          s.optouts.push({ digits: cleanDigits, source: old.source, createdAt: old.createdAt });
        }
      }
    }
    if (name && !contact.name) contact.name = name;
    if (sourceGroup && !contact.sourceGroups.includes(sourceGroup)) {
      contact.sourceGroups.push(sourceGroup);
    }
    const identifier = identifierFor(contact);
    if (identifier && !contact.optedOut) contact.optedOut = this.isOptedOut(identifier);
    return contact;
  }

  // Read an uploaded file (images etc.) stored under this user's uploads dir.
  async readUpload(relativePath) {
    if (!relativePath) return null;
    // Never allow escaping the user's own data dir.
    const resolved = path.resolve(this.dataDir, relativePath);
    if (!resolved.startsWith(this.dataDir + path.sep)) return null;
    try {
      return await readFile(resolved);
    } catch {
      return null;
    }
  }
}

const userStores = new Map();

export function getUserStore(userId) {
  const key = safeUserId(userId);
  if (!userStores.has(key)) userStores.set(key, new UserStore(key));
  return userStores.get(key);
}

export function newId() {
  return randomUUID();
}

// One stable key per contact for opt-outs: the real number when known,
// otherwise "lid:<id>" so STOP still works for hidden numbers.
export function identifierFor(contact) {
  if (contact.digits) return contact.digits;
  if (contact.lid) return "lid:" + String(contact.lid).split("@")[0].split(":")[0];
  return null;
}

export function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Parts of "now" in a given IANA timezone, e.g. Africa/Accra.
export function tzParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

export function isQuietNow(settings, timeZone) {
  if (!settings.quietEnabled) return false;
  const { time } = tzParts(new Date(), timeZone || settings.defaultTimezone);
  const start = settings.quietStart;
  const end = settings.quietEnd;
  if (start <= end) return time >= start && time < end;
  return time >= start || time < end;
}
