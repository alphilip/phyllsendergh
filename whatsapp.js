import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  isLidUser,
  isPnUser
} from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";

import { getUserStore, identifierFor } from "./store.js";
import { spin } from "./spintax.js";

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";
const SKIP_WHATSAPP = process.env.SKIP_WHATSAPP === "1";

const OPT_OUT_RE = /^(stop|unsubscribe|opt\s?out|remove me|no more|delete me)$/i;

// Don't auto-reply to the same person more than once per 10 minutes.
const AUTO_REPLY_COOLDOWN_MS = 10 * 60 * 1000;

const WELCOME_COOLDOWN_MS = 24 * 3600 * 1000;

export function senderDigits(jid) {
  const user = String(jid || "").split("@")[0].split(":")[0];
  return user.replace(/\D/g, "");
}

function extractMessageText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    ""
  ).trim();
}

class UserConnection {
  constructor(userId) {
    this.userId = userId;
    this.sock = null;
    this.starting = false;
    this.currentQR = null;
    this.connectionStatus = "disconnected";
    this.connectedNumber = null;
    // digits -> display name cache (from incoming messages / contact updates)
    this.contactNames = new Map();
    // jid -> { jid, name, isGroup, unreadCount, lastActive }
    this.chatCache = new Map();
    // call ids already texted back
    this.seenCallIds = new Set();
  }

  get sessionDir() {
    return path.join(BASE_DATA_DIR, this.userId, "whatsapp-session");
  }

  userStore() {
    return getUserStore(this.userId);
  }

  upsertChatCache(chat) {
    const jid = chat?.id;
    if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) return;
    const prev = this.chatCache.get(jid) || {};
    const ts = Number(chat.conversationTimestamp || chat.lastMessageRecvTimestamp || 0) || 0;
    this.chatCache.set(jid, {
      jid,
      name: chat.name || prev.name || null,
      isGroup: jid.endsWith("@g.us"),
      unreadCount: typeof chat.unreadCount === "number" ? chat.unreadCount : prev.unreadCount || 0,
      lastActive: ts || prev.lastActive || 0
    });
  }

  attachChatCache() {
    const sock = this.sock;
    sock.ev.on("messaging-history.set", ({ chats }) => {
      for (const c of chats || []) this.upsertChatCache(c);
      console.log(`[wa:${this.userId}] Chat history synced: ${this.chatCache.size} chats cached.`);
    });
    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats || []) this.upsertChatCache(c);
    });
    sock.ev.on("chats.update", (updates) => {
      for (const u of updates || []) {
        if (u?.id && this.chatCache.has(u.id)) this.upsertChatCache({ ...this.chatCache.get(u.id), ...u });
      }
    });
    sock.ev.on("chats.delete", (deletions) => {
      for (const jid of deletions || []) this.chatCache.delete(jid);
    });
  }

  cacheName(digits, name) {
    if (digits && name && !this.contactNames.has(digits)) {
      this.contactNames.set(digits, String(name).slice(0, 80));
    }
  }

  // Resolve a @lid JID to its real phone-number JID via Baileys' mapping
  // store. Returns null when WhatsApp hasn't shared the number.
  async resolvePhoneJid(jid) {
    if (!jid || !isLidUser(jid) || !this.sock) return null;
    try {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(jid);
      return pn && isPnUser(pn) ? pn : null;
    } catch {
      return null;
    }
  }

  // One identifier per sender for opt-outs: real digits when known,
  // otherwise a stable "lid:..." key so STOP still works.
  async senderIdentifier(senderJid) {
    if (isLidUser(senderJid)) {
      const pn = await this.resolvePhoneJid(senderJid);
      if (pn) return senderDigits(pn);
      return "lid:" + String(senderJid).split("@")[0].split(":")[0];
    }
    return senderDigits(senderJid);
  }

  // Record the inbound message on the contact (powers follow-up
  // "didn't reply" detection). Creates a lightweight "inbound" contact
  // for people who message us first.
  async trackInbound(senderJid, pushName) {
    const us = this.userStore();
    try {
      let digits = "";
      let lid = null;
      if (isLidUser(senderJid)) {
        lid = senderJid;
        const pn = await this.resolvePhoneJid(senderJid);
        if (pn) digits = senderDigits(pn);
      } else if (isPnUser(senderJid)) {
        digits = senderDigits(senderJid);
      } else {
        return null;
      }
      if (!digits && !lid) return null;
      const contact = us.upsertContact({ digits, lid, name: pushName || null, sourceGroup: "inbound" });
      if (contact) {
        contact.lastInboundAt = new Date().toISOString();
        us.save();
      }
      return contact;
    } catch {
      return null;
    }
  }

  matchAutoReply(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;
    for (const rule of this.userStore().get().autoReplies || []) {
      if (!rule.active) continue;
      const kw = String(rule.keyword || "").trim().toLowerCase();
      if (!kw) continue;
      if (rule.matchType === "contains" ? t.includes(kw) : t === kw) return rule;
    }
    return null;
  }

  attachIncomingHandler() {
    const sock = this.sock;
    sock.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts || []) {
        const digits = senderDigits(c.id);
        this.cacheName(digits, c.name || c.notify || c.verifiedName);
      }
    });

    sock.ev.on("messages.upsert", async ({ type, messages }) => {
      if (type !== "notify") return;
      const us = this.userStore();
      for (const msg of messages || []) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          const remoteJid = msg.key.remoteJid || "";
          if (remoteJid === "status@broadcast") continue;

          const senderJid = msg.key.participant || remoteJid;
          const digits = senderDigits(senderJid);
          this.cacheName(digits, msg.pushName);
          this.cacheName(senderJid, msg.pushName);

          // Only DMs from here on (no groups).
          if (remoteJid.endsWith("@g.us")) continue;

          const text = extractMessageText(msg);
          if (!text || !senderJid) continue;

          const contact = await this.trackInbound(senderJid, msg.pushName);
          const identifier = contact ? identifierFor(contact) : await this.senderIdentifier(senderJid);
          if (!identifier) continue;

          // 1. STOP always wins.
          if (OPT_OUT_RE.test(text)) {
            const added = us.addOptOut(identifier, "STOP reply");
            const settings = us.get().settings;
            if (added && settings.autoOptOutReply) {
              const target = contact?.lid || (contact?.digits ? contact.digits + "@s.whatsapp.net" : null);
              if (target) {
                await sock.sendMessage(target, {
                  text: "You have been unsubscribed. You will not receive promotional messages from this number again."
                });
              }
            }
            us.addLog({ kind: "system", target: identifier, message: "STOP keyword received" });
            continue;
          }

          // 2. Keyword auto-replies (never to opted-out contacts).
          if (!us.isOptedOut(identifier)) {
            const rule = this.matchAutoReply(text);
            const lastReply = contact?.lastAutoReplyAt ? new Date(contact.lastAutoReplyAt).getTime() : 0;
            if (rule && Date.now() - lastReply > AUTO_REPLY_COOLDOWN_MS) {
              try {
                const replyText = spin(rule.message, contact);
                const image = await us.readUpload(rule.imagePath);
                const target = contact?.lid || (contact?.digits ? contact.digits + "@s.whatsapp.net" : null);
                if (target) {
                  if (image) await sock.sendMessage(target, { image, caption: replyText.slice(0, 1000) });
                  else await sock.sendMessage(target, { text: replyText.slice(0, 2000) });
                  if (contact) {
                    contact.lastAutoReplyAt = new Date().toISOString();
                    us.save();
                  }
                  us.addLog({ kind: "dm", target: identifier, ok: true, message: `Auto-reply sent (keyword "${rule.keyword}")` });
                }
              } catch (err) {
                us.addLog({ kind: "dm", target: identifier, ok: false, error: "Auto-reply failed: " + err.message });
              }
            }
          }
        } catch (error) {
          console.error(`[wa:${this.userId}] Incoming message handler error:`, error.message);
        }
      }
    });
  }

  // Resolve any DM JID to a sendable target + identity parts.
  async resolveDmTarget(jid) {
    let digits = "";
    let lid = null;
    if (isLidUser(jid)) {
      lid = jid;
      const pn = await this.resolvePhoneJid(jid);
      if (pn) digits = senderDigits(pn);
    } else if (isPnUser(jid)) {
      digits = senderDigits(jid);
    } else {
      return null;
    }
    if (!digits && !lid) return null;
    return { target: lid || digits + "@s.whatsapp.net", digits, lid };
  }

  attachEngagementHandlers() {
    const sock = this.sock;
    // Someone joined a group -> welcome rules.
    sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
      if (action !== "add" || !id) return;
      const us = this.userStore();
      try {
        const rules = (us.get().welcomeRules || []).filter((r) => r.active && r.groupJid === id);
        if (!rules.length) return;
        for (const p of participants || []) {
          const resolved = await this.resolveDmTarget(p);
          if (!resolved) continue;
          for (const rule of rules) {
            // Don't welcome the same person twice in 24h.
            const contact = us.upsertContact({ digits: resolved.digits, lid: resolved.lid, name: null, sourceGroup: `welcomed:${id}` });
            const last = contact?.lastWelcomedAt ? new Date(contact.lastWelcomedAt).getTime() : 0;
            if (Date.now() - last < WELCOME_COOLDOWN_MS) continue;
            try {
              const text = spin(rule.message, contact);
              const image = await us.readUpload(rule.imagePath);
              if (rule.via === "group") {
                if (image) await sock.sendMessage(id, { image, caption: text.slice(0, 1000) });
                else await sock.sendMessage(id, { text: text.slice(0, 2000) });
              } else {
                if (image) await sock.sendMessage(resolved.target, { image, caption: text.slice(0, 1000) });
                else await sock.sendMessage(resolved.target, { text: text.slice(0, 2000) });
              }
              if (contact) {
                contact.lastWelcomedAt = new Date().toISOString();
                us.save();
              }
              us.addLog({ kind: "dm", target: resolved.digits ? `+${resolved.digits}` : "(number hidden)", ok: true, message: `Welcome message sent (${rule.via})` });
            } catch (err) {
              us.addLog({ kind: "dm", ok: false, error: "Welcome message failed: " + err.message });
            }
          }
        }
      } catch (error) {
        console.error(`[wa:${this.userId}] Welcome handler error:`, error.message);
      }
    });

    // Incoming call ringing -> instant text-back.
    sock.ev.on("call", async (calls) => {
      const us = this.userStore();
      try {
        const reply = us.get().callReply;
        if (!reply?.active || !reply.message?.trim()) return;
        for (const c of calls || []) {
          if (c.status !== "offer" || c.isGroup) continue;
          if (this.seenCallIds.has(c.id)) continue;
          this.seenCallIds.add(c.id);
          if (this.seenCallIds.size > 500) {
            const first = this.seenCallIds.values().next().value;
            this.seenCallIds.delete(first);
          }
          const resolved = await this.resolveDmTarget(c.from);
          if (!resolved) continue;
          try {
            await sock.sendMessage(resolved.target, { text: spin(reply.message, null).slice(0, 2000) });
            us.addLog({ kind: "dm", target: resolved.digits ? `+${resolved.digits}` : "(number hidden)", ok: true, message: "Missed-call text-back sent" });
          } catch (err) {
            us.addLog({ kind: "dm", ok: false, error: "Missed-call text-back failed: " + err.message });
          }
        }
      } catch (error) {
        console.error(`[wa:${this.userId}] Call handler error:`, error.message);
      }
    });
  }

  async clearSession() {
    this.sock = null;
    this.starting = false;
    this.currentQR = null;
    this.connectionStatus = "disconnected";
    this.connectedNumber = null;
    this.chatCache.clear();
    try {
      await rm(this.sessionDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`[wa:${this.userId}] Failed to clear WhatsApp session:`, error.message);
    }
    try {
      await mkdir(this.sessionDir, { recursive: true });
    } catch (error) {
      console.error(`[wa:${this.userId}] Failed to recreate session dir:`, error.message);
    }
  }

  async start() {
    if (SKIP_WHATSAPP) return;
    if (this.starting || this.sock) return;
    this.starting = true;
    try {
      await mkdir(this.sessionDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: "silent" }),
        browser: ["Phyllhost", "Chrome", "1.0.0"],
        syncFullHistory: true
      });
      this.sock = sock;

      sock.ev.on("creds.update", saveCreds);
      this.attachIncomingHandler();
      this.attachChatCache();
      this.attachEngagementHandlers();

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.connectionStatus = "qr";
          this.currentQR = await QRCode.toDataURL(qr);
          console.log(`[wa:${this.userId}] WhatsApp QR code generated.`);
        }

        if (connection === "open") {
          this.connectionStatus = "connected";
          this.currentQR = null;
          if (sock.user?.id) {
            this.connectedNumber = senderDigits(sock.user.id);
          }
          console.log(`[wa:${this.userId}] WhatsApp connected. Number:`, this.connectedNumber);
          this.userStore().addLog({ kind: "system", message: `WhatsApp connected (${this.connectedNumber || "unknown"})` });
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[wa:${this.userId}] WhatsApp logged out. Clearing session for a fresh QR...`);
            this.userStore().addLog({ kind: "system", message: "WhatsApp logged out; session cleared" });
            await this.clearSession();
            setTimeout(() => this.start().catch((e) => console.error(`[wa:${this.userId}]`, e.message)), 1000);
            return;
          }
          this.connectionStatus = "disconnected";
          this.currentQR = null;
          this.sock = null;
          this.starting = false;
          console.log(`[wa:${this.userId}] WhatsApp disconnected. Reconnecting...`);
          setTimeout(() => this.start().catch((e) => console.error(`[wa:${this.userId}]`, e.message)), 3000);
        }
      });
    } catch (error) {
      this.starting = false;
      this.sock = null;
      console.error(`[wa:${this.userId}] Failed to start WhatsApp:`, error.message);
      // Back off, then retry.
      setTimeout(() => this.start().catch(() => {}), 10000);
    } finally {
      // starting stays true while the socket lives; cleared on close/logout.
      if (this.sock) this.starting = true;
      else this.starting = false;
    }
  }

  isConnected() {
    return !!this.sock && this.connectionStatus === "connected";
  }

  requireConnected() {
    if (!this.isConnected()) {
      const error = new Error("WhatsApp is not connected. Scan the QR code on the dashboard first.");
      error.code = "NOT_CONNECTED";
      throw error;
    }
  }

  getStatus() {
    return {
      status: this.connectionStatus,
      number: this.connectedNumber,
      qr: this.currentQR
    };
  }

  normalizeGroup(meta) {
    const id = meta.id || meta.jid || "";
    const participants = Array.isArray(meta.participants) ? meta.participants : [];
    return {
      id,
      name: meta.subject || meta.name || id,
      participantCount: participants.length,
      isCommunity: !!(meta.isCommunity || meta.isCommunityGroup),
      isAnnounce: !!(meta.isCommunityAnnounce || meta.announce),
      parent: meta.parent || meta.parentGroup || null
    };
  }

  async listGroups() {
    this.requireConnected();
    const all = await this.sock.groupFetchAllParticipating();
    const list = Array.isArray(all) ? all : Object.values(all || {});
    return list
      .map((m) => this.normalizeGroup(m))
      .filter((g) => g.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getGroupParticipants(jid) {
    this.requireConnected();
    const metadata = await this.sock.groupMetadata(jid);
    const participants = Array.isArray(metadata.participants) ? metadata.participants : [];
    const selfId = this.sock.user?.id || "";
    const selfLid = this.sock.user?.lid || null;
    const selfDigits = senderDigits(selfId);
    const out = [];

    for (const p of participants) {
      const rawId = p.id || "";
      let phoneJid = null;
      let lidJid = null;

      if (isLidUser(rawId)) {
        lidJid = rawId;
        if (p.phoneNumber && isPnUser(p.phoneNumber)) {
          phoneJid = p.phoneNumber;
        } else {
          phoneJid = await this.resolvePhoneJid(rawId);
        }
      } else if (isPnUser(rawId)) {
        phoneJid = rawId;
        if (p.lid && isLidUser(p.lid)) lidJid = p.lid;
      } else {
        continue;
      }

      const digits = phoneJid ? senderDigits(phoneJid) : "";
      if (!digits && !lidJid) continue;

      const name =
        this.contactNames.get(digits) ||
        this.contactNames.get(rawId) ||
        p.notify ||
        p.name ||
        null;

      const isSelf =
        (selfLid && lidJid && lidJid === selfLid) ||
        (phoneJid && selfDigits && digits === selfDigits) ||
        (rawId && selfId && rawId === selfId);

      out.push({
        jid: rawId,
        lid: lidJid,
        digits,
        numberHidden: !digits,
        name,
        admin: p.admin === "superadmin" ? "superadmin" : p.admin === "admin" ? "admin" : null,
        isSelf: !!isSelf
      });
    }

    return out;
  }

  // Send to a contact: prefers the LID JID, falls back to the real number
  // (LIDs are routable WhatsApp addresses even when the number is hidden).
  async deliverToContact(contact, message, imageBuffer) {
    this.requireConnected();
    const target = contact.lid || (contact.digits ? contact.digits + "@s.whatsapp.net" : null);
    if (!target) throw new Error("Contact has no usable address.");
    if (imageBuffer) {
      return this.sock.sendMessage(target, {
        image: imageBuffer,
        caption: String(message || "").slice(0, 1000)
      });
    }
    return this.sock.sendMessage(target, { text: String(message || "").slice(0, 2000) });
  }

  // All chats (DMs + groups) from history sync, newest first.
  async listChats() {
    this.requireConnected();
    const out = [];
    for (const c of this.chatCache.values()) {
      let digits = "";
      let lidJid = null;
      let numberHidden = false;
      if (!c.isGroup) {
        if (isLidUser(c.jid)) {
          lidJid = c.jid;
          const pn = await this.resolvePhoneJid(c.jid);
          if (pn) digits = senderDigits(pn);
          else numberHidden = true;
        } else if (isPnUser(c.jid)) {
          digits = senderDigits(c.jid);
        } else {
          continue;
        }
      }
      out.push({
        jid: c.jid,
        name: c.name || this.contactNames.get(digits) || this.contactNames.get(c.jid) || (c.isGroup ? c.jid : null),
        isGroup: c.isGroup,
        digits,
        lid: lidJid,
        numberHidden,
        unreadCount: c.unreadCount || 0,
        lastActive: c.lastActive || 0
      });
    }
    return out.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  }

  // Resolve one DM chat to a contact-shaped object for extraction.
  async resolveChatContact(jid) {
    this.requireConnected();
    let phoneJid = null;
    let lidJid = null;
    if (isLidUser(jid)) {
      lidJid = jid;
      phoneJid = await this.resolvePhoneJid(jid);
    } else if (isPnUser(jid)) {
      phoneJid = jid;
    } else {
      return null;
    }
    const digits = phoneJid ? senderDigits(phoneJid) : "";
    const cached = this.chatCache.get(jid);
    return {
      jid,
      lid: lidJid,
      digits,
      numberHidden: !digits,
      name: cached?.name || this.contactNames.get(digits) || this.contactNames.get(jid) || null
    };
  }

  async sendTextToJid(jid, text) {
    this.requireConnected();
    if (!jid || !text) throw new Error("Missing recipient or message text.");
    return this.sock.sendMessage(jid, { text: String(text).slice(0, 2000) });
  }

  async sendPollToJid(jid, question, options, selectableCount = 1) {
    this.requireConnected();
    const values = (options || []).map((o) => String(o).slice(0, 100)).filter(Boolean);
    if (!question || values.length < 2) throw new Error("A poll needs a question and at least 2 options.");
    return this.sock.sendMessage(jid, {
      poll: {
        name: String(question).slice(0, 300),
        values: values.slice(0, 12),
        selectableCount: Math.max(1, Math.min(values.length, selectableCount || 1))
      }
    });
  }

  async sendStatusPost(text, imageBuffer) {
    this.requireConnected();
    if (imageBuffer) {
      return this.sock.sendMessage("status@broadcast", {
        image: imageBuffer,
        caption: String(text || "").slice(0, 1000)
      });
    }
    if (!text) throw new Error("Status post needs text or an image.");
    return this.sock.sendMessage("status@broadcast", { text: String(text).slice(0, 700) });
  }

  async sendTextToDigits(digits, text) {
    const clean = String(digits || "").replace(/\D/g, "");
    if (!clean) throw new Error("Invalid phone number.");
    return this.sendTextToJid(clean + "@s.whatsapp.net", text);
  }

  async sendImageToJid(jid, buffer, caption) {
    this.requireConnected();
    if (!jid || !buffer) throw new Error("Missing recipient or image.");
    return this.sock.sendMessage(jid, {
      image: buffer,
      caption: String(caption || "").slice(0, 1000)
    });
  }

  async sendImageToDigits(digits, buffer, caption) {
    const clean = String(digits || "").replace(/\D/g, "");
    if (!clean) throw new Error("Invalid phone number.");
    return this.sendImageToJid(clean + "@s.whatsapp.net", buffer, caption);
  }

  async disconnect({ restart = true } = {}) {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout();
      } catch (error) {
        console.error(`[wa:${this.userId}] Logout error:`, error.message);
      }
    }
    await this.clearSession();
    // The store may not be loaded in this process (e.g. billing suspend
    // path) — never let logging break the disconnect itself.
    try {
      const us = this.userStore();
      await us.load();
      us.addLog({ kind: "system", message: "WhatsApp disconnected from dashboard" });
    } catch (error) {
      console.error(`[wa:${this.userId}] Could not log disconnect:`, error.message);
    }
    // Manual disconnects restart so a fresh QR appears; billing suspension
    // passes restart:false so the number stays offline until renewal.
    if (restart) {
      this.start().catch((error) => {
        console.error(`[wa:${this.userId}] Failed to restart WhatsApp after logout:`, error.message);
      });
    }
  }
}

const connections = new Map();

function getConn(userId) {
  const key = String(userId || "");
  if (!key) throw new Error("Missing user id.");
  if (!connections.has(key)) connections.set(key, new UserConnection(key));
  return connections.get(key);
}

// Start (or ensure started) the connection for a user. Safe to call often;
// concurrent calls collapse into one boot.
export async function startWhatsApp(userId) {
  const conn = getConn(userId);
  await getUserStore(userId).load();
  await conn.start();
}

export function getStatus(userId) {
  const conn = getConn(userId);
  // Lazy-connect on first dashboard visit (skipped in testing mode).
  // The store is loaded first so event handlers never see it unloaded.
  if (!SKIP_WHATSAPP && !conn.sock && !conn.starting) {
    getUserStore(userId).load()
      .then(() => conn.start())
      .catch((e) => console.error(`[wa:${userId}] lazy start failed:`, e.message));
  }
  return conn.getStatus();
}

export function isConnected(userId) {
  return getConn(userId).isConnected();
}

// Admin panel: read a user's link state WITHOUT starting their socket.
// (The exported getStatus() lazy-starts; this never does.)
export function peekStatus(userId) {
  return getConn(userId).getStatus();
}

export async function disconnect(userId, opts) {
  await getConn(userId).disconnect(opts);
}

export async function listGroups(userId) {
  return getConn(userId).listGroups();
}

export async function getGroupParticipants(userId, jid) {
  return getConn(userId).getGroupParticipants(jid);
}

export async function deliverToContact(userId, contact, message, imageBuffer) {
  return getConn(userId).deliverToContact(contact, message, imageBuffer);
}

export async function listChats(userId) {
  return getConn(userId).listChats();
}

export async function resolveChatContact(userId, jid) {
  return getConn(userId).resolveChatContact(jid);
}

export async function resolvePhoneJid(userId, jid) {
  return getConn(userId).resolvePhoneJid(jid);
}

export async function sendTextToJid(userId, jid, text) {
  return getConn(userId).sendTextToJid(jid, text);
}

export async function sendPollToJid(userId, jid, question, options, selectableCount) {
  return getConn(userId).sendPollToJid(jid, question, options, selectableCount);
}

export async function sendStatusPost(userId, text, imageBuffer) {
  return getConn(userId).sendStatusPost(text, imageBuffer);
}

export async function sendTextToDigits(userId, digits, text) {
  return getConn(userId).sendTextToDigits(digits, text);
}

export async function sendImageToJid(userId, jid, buffer, caption) {
  return getConn(userId).sendImageToJid(jid, buffer, caption);
}

export async function sendImageToDigits(userId, digits, buffer, caption) {
  return getConn(userId).sendImageToDigits(digits, buffer, caption);
}
