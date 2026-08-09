import express from "express";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    generateMessageID,
    downloadMediaMessage,
    getContentType,
} from "@whiskeysockets/baileys";
import pino from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const router = express.Router();

// ================================================================
// CONFIGURATION
// ================================================================
const ADMIN_CONFIG_FILE = join(__dirname, "data/admin_config.json");
const REGISTRY_FILE = join(__dirname, "data/session_registry.json");
const DATA_DIR = join(__dirname, "data");
const BACKUP_DIR = join(DATA_DIR, "backups");
const MEDIA_DIR = join(DATA_DIR, "media");
const VIEW_ONCE_DIR = join(DATA_DIR, "view_once");
const STATS_FILE = join(DATA_DIR, "stats.json");
const ACTIVITY_FILE = join(DATA_DIR, "activity.json");
const KEYWORD_ALERTS_FILE = join(DATA_DIR, "keyword_alerts.json");
const AUTO_REACT_FILE = join(DATA_DIR, "auto_react.json");

// Create directories
for (const d of [DATA_DIR, BACKUP_DIR, MEDIA_DIR, VIEW_ONCE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ================================================================
// ADMIN CONFIGURATION
// ================================================================
let adminConfig = {
    username: "ishaqmd",
    password: "aass1122@",
    recoveryKey: "ishqkatala0077@007707",
    createdAt: new Date().toISOString()
};

function loadAdminConfig() {
    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            adminConfig = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, "utf-8"));
        } else {
            fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(adminConfig, null, 2));
        }
    } catch (e) {
        console.error("[Admin] Config load error:", e.message);
    }
}

function saveAdminConfig() {
    try {
        fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(adminConfig, null, 2));
    } catch (e) {
        console.error("[Admin] Config save error:", e.message);
    }
}

loadAdminConfig();

// ================================================================
// SOCKET.IO - Injected from index.js
// ================================================================
let _io = null;
export function setIo(io) {
    _io = io;
    console.log("[📡] Socket.IO instance registered in admin-api");
}

function emitTerminal(data) {
    if (_io) {
        _io.emit("terminal", data);
    }
}

function emitStats(data) {
    if (_io) {
        _io.emit("stats-update", data);
    }
}

function sysLog(msg) {
    emitTerminal({
        chatType: "SYSTEM",
        sender: "ISHAQ-MD",
        content: msg,
        session: "system",
        time: new Date().toISOString(),
        fromMe: false,
        system: true,
    });
}

// ================================================================
// REGISTRY FUNCTIONS
// ================================================================
function readRegistry() {
    try {
        if (fs.existsSync(REGISTRY_FILE)) {
            return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
        }
    } catch (e) {}
    return {};
}

function writeRegistry(data) {
    try {
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// ================================================================
// STATS FUNCTIONS
// ================================================================
let stats = { 
    messages: 0, 
    reactions: 0, 
    channelActions: 0, 
    groupActions: 0, 
    backups: 0 
};

try {
    if (fs.existsSync(STATS_FILE)) {
        stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
    }
} catch (e) {}

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {}
}

// ================================================================
// ACTIVITY LOG FUNCTIONS
// ================================================================
let actLog = [];
try {
    if (fs.existsSync(ACTIVITY_FILE)) {
        actLog = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf-8"));
    }
} catch (e) {}

function logAct(user, action, details, status = "success") {
    actLog.unshift({
        time: new Date().toISOString(),
        user,
        action,
        details,
        status
    });
    if (actLog.length > 200) actLog = actLog.slice(0, 200);
    try {
        fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(actLog, null, 2));
    } catch (e) {}
}

// ================================================================
// AUTO-REACT CONFIG
// ================================================================
let autoReactConfig = {};
try {
    if (fs.existsSync(AUTO_REACT_FILE)) {
        autoReactConfig = JSON.parse(fs.readFileSync(AUTO_REACT_FILE, "utf-8"));
    }
} catch (e) {}

function saveAutoReact() {
    try {
        fs.writeFileSync(AUTO_REACT_FILE, JSON.stringify(autoReactConfig, null, 2));
    } catch (e) {}
}

// ================================================================
// KEYWORD ALERTS
// ================================================================
let keywordAlerts = {};
try {
    if (fs.existsSync(KEYWORD_ALERTS_FILE)) {
        keywordAlerts = JSON.parse(fs.readFileSync(KEYWORD_ALERTS_FILE, "utf-8"));
    }
} catch (e) {}

function saveKeywordAlerts() {
    try {
        fs.writeFileSync(KEYWORD_ALERTS_FILE, JSON.stringify(keywordAlerts, null, 2));
    } catch (e) {}
}

// ================================================================
// SOCKET POOL
// ================================================================
const pool = new Map(); // num → { sock, ready }

async function getSocket(num) {
    const sessionDir = join(__dirname, `auth_info/${num}`);
    if (!fs.existsSync(sessionDir)) {
        throw new Error(`Session folder not found: ${num}. Please re-pair.`);
    }

    if (pool.has(num)) {
        const p = pool.get(num);
        if (p.ready) return p.sock;
        pool.delete(num);
    }

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        logger: pino({ level: "fatal" }),
        browser: Browsers.windows("Chrome"),
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        defaultQueryTimeoutMs: 20000,
        connectTimeoutMs: 20000,
        getMessage: async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    // ============================================================
    // LIVE TERMINAL - Message Handler
    // ============================================================
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key?.remoteJid || "";
            const isGroup = remoteJid.endsWith("@g.us");
            const isChannel = remoteJid.endsWith("@newsletter");
            const isStatus = remoteJid === "status@broadcast";
            const fromMe = msg.key?.fromMe || false;

            const chatType = isChannel ? "Channel" : isGroup ? "Group" : isStatus ? "Status" : "Private";

            const senderJid = fromMe ? (sock.authState.creds.me?.id || num) : (msg.key?.participant || msg.key?.remoteJid || "?");
            const senderNum = senderJid.split("@")[0];
            const senderName = msg.pushName || senderNum;
            const senderLabel = fromMe ? `You (${num})` : senderName;

            // Extract message content
            const m = msg.message;
            const innerMsg = m?.ephemeralMessage?.message ||
                m?.viewOnceMessage?.message ||
                m?.viewOnceMessageV2?.message ||
                m?.viewOnceMessageV2Extension?.message ||
                m?.documentWithCaptionMessage?.message ||
                m;

            const msgType = getContentType(innerMsg) || "unknown";

            let content =
                innerMsg?.conversation ||
                innerMsg?.extendedTextMessage?.text ||
                innerMsg?.imageMessage?.caption ||
                innerMsg?.videoMessage?.caption ||
                innerMsg?.documentMessage?.title ||
                innerMsg?.audioMessage ? "🎵 Voice/Audio" :
                innerMsg?.stickerMessage ? "🎭 Sticker" :
                innerMsg?.contactMessage ? `👤 Contact: ${innerMsg.contactMessage.displayName}` :
                innerMsg?.locationMessage ? "📍 Location" :
                innerMsg?.reactionMessage ? `${innerMsg.reactionMessage.text || "React"} to msg` :
                innerMsg?.pollCreationMessage ? `📊 Poll: ${innerMsg.pollCreationMessage.name}` :
                `[${msgType}]`;

            // Emit to Live Terminal
            emitTerminal({
                chatType,
                sender: senderLabel,
                content: String(content).substring(0, 250),
                session: num,
                jid: remoteJid,
                time: new Date().toISOString(),
                fromMe,
            });

            // Keyword Alerts
            if (keywordAlerts[num]?.length && typeof content === "string") {
                const lc = content.toLowerCase();
                for (const kw of keywordAlerts[num]) {
                    if (lc.includes(kw.toLowerCase())) {
                        emitTerminal({
                            chatType: "ALERT",
                            sender: `⚠️ KEYWORD: "${kw}"`,
                            content: `${senderLabel}: ${String(content).substring(0, 200)}`,
                            session: num,
                            jid: remoteJid,
                            time: new Date().toISOString(),
                            fromMe: false,
                            alert: true,
                        });
                        break;
                    }
                }
            }

            // Auto-React
            if (autoReactConfig[num]?.enabled && !fromMe && !isStatus && !isChannel) {
                const emojis = autoReactConfig[num]?.emojis?.length ? autoReactConfig[num].emojis : ["❤️"];
                const picked = emojis[Math.floor(Math.random() * emojis.length)];
                sock.sendMessage(remoteJid, {
                    react: { text: picked, key: msg.key }
                }).catch(() => {});
            }

            // View-Once Auto-Save
            const isViewOnce = !!(
                m?.viewOnceMessage ||
                m?.viewOnceMessageV2 ||
                m?.viewOnceMessageV2Extension
            );

            if (isViewOnce) {
                try {
                    const voMsg = m.viewOnceMessage?.message ||
                        m.viewOnceMessageV2?.message ||
                        m.viewOnceMessageV2Extension?.message;

                    const voType = getContentType(voMsg);
                    const isImage = voType === "imageMessage";
                    const isVideo = voType === "videoMessage";
                    const isAudio = voType === "audioMessage";

                    if (isImage || isVideo || isAudio) {
                        const ext = isImage ? "jpg" : isVideo ? "mp4" : "ogg";
                        const safeId = (msg.key.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
                        const fileName = `vo_${num}_${safeId}.${ext}`;
                        const filePath = join(VIEW_ONCE_DIR, fileName);

                        if (!fs.existsSync(filePath)) {
                            const voFullMsg = { ...msg, message: voMsg };
                            const buffer = await downloadMediaMessage(voFullMsg, "buffer", {});
                            fs.writeFileSync(filePath, buffer);

                            const meta = {
                                fileName,
                                type: voType,
                                session: num,
                                from: senderLabel,
                                jid: remoteJid,
                                savedAt: new Date().toISOString(),
                                size: buffer.length,
                            };
                            fs.writeFileSync(filePath + ".meta.json", JSON.stringify(meta, null, 2));

                            emitTerminal({
                                chatType: "VIEW-ONCE",
                                sender: `📸 Saved from ${senderLabel}`,
                                content: `View-once ${voType.replace("Message", "")} saved → ${fileName}`,
                                session: num,
                                jid: remoteJid,
                                time: new Date().toISOString(),
                                fromMe: false,
                                alert: true,
                            });
                            logAct(num, "VIEW_ONCE_SAVE", `Saved: ${fileName} from ${senderLabel}`);
                        }
                    }
                } catch (e) {
                    console.log(`[⚠️] View-once save failed: ${e.message}`);
                }
            }
        }
    });

    const entry = { sock, ready: false };
    pool.set(num, entry);

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            pool.delete(num);
            reject(new Error("Connection timeout"));
        }, 20000);
        sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
            if (connection === "open") {
                entry.ready = true;
                clearTimeout(t);
                sysLog(`✅ Session ${num} connected to admin pool`);
                resolve();
            }
            if (connection === "close") {
                clearTimeout(t);
                entry.ready = false;
                pool.delete(num);
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    const reg = readRegistry();
                    if (reg[num]) {
                        reg[num].status = "logged_out";
                        writeRegistry(reg);
                    }
                    reject(new Error("Session logged out — please re-pair"));
                } else {
                    reject(new Error("Connection closed: " + (lastDisconnect?.error?.message || "unknown")));
                }
            }
        });
    });

    return sock;
}

setInterval(() => {
    for (const [n, e] of pool.entries()) {
        if (!e.ready) pool.delete(n);
    }
    emitStats({
        sessions: Object.keys(readRegistry()).length,
        connected: pool.size
    });
}, 5 * 60 * 1000);

// ================================================================
// CHANNEL JID RESOLVER
// ================================================================
async function resolveChannelJid(sock, channelInput) {
    if (!channelInput) throw new Error("No channel input provided");
    if (/^\d+@newsletter$/.test(channelInput)) return channelInput;

    const match = channelInput.match(/channel\/([A-Za-z0-9_-]+)/);
    if (!match) throw new Error("Invalid channel link. Use https://whatsapp.com/channel/... or JID like 120363...@newsletter");
    const inviteCode = match[1];

    try {
        const result = await sock.newsletterGetInfo(`https://whatsapp.com/channel/${inviteCode}`);
        if (result?.id) return result.id;
    } catch (e1) {
        console.log(`[⚠️] newsletterGetInfo: ${e1.message}`);
    }

    try {
        const result = await sock.query({
            tag: "iq",
            attrs: { id: sock.generateMessageTag(), type: "get", to: "g.us", xmlns: "w:newsletter" },
            content: [{ tag: "newsletter_link_preview", attrs: { link: `https://whatsapp.com/channel/${inviteCode}` } }],
        });
        const jid = result?.content?.[0]?.attrs?.jid || result?.content?.[0]?.content?.[0]?.attrs?.jid;
        if (jid) return jid;
    } catch (e2) {
        console.log(`[⚠️] IQ fallback: ${e2.message}`);
    }

    throw new Error("Cannot resolve channel JID. Use format: 120363XXXXXXXXXX@newsletter");
}

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
function requireAuth(req, res, next) {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: "No authorization header" });
    try {
        const b64 = h.startsWith("Basic ") ? h.slice(6) : h.split(" ")[1];
        const dec = Buffer.from(b64, "base64").toString();
        const idx = dec.indexOf(":");
        const u = dec.substring(0, idx);
        const p = dec.substring(idx + 1);
        if (u === adminConfig.username && p === adminConfig.password) return next();
        res.status(401).json({ error: "Invalid credentials" });
    } catch (e) {
        res.status(401).json({ error: "Auth error" });
    }
}

// ================================================================
// AUTH ROUTES
// ================================================================

// Login
router.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (username === adminConfig.username && password === adminConfig.password) {
        return res.json({
            success: true,
            token: Buffer.from(`${username}:${password}`).toString("base64")
        });
    }
    res.status(401).json({ error: "Invalid credentials" });
});

// Change Password with Recovery Key
router.post("/change-password", (req, res) => {
    const { recoveryKey, newPassword } = req.body;
    if (!recoveryKey || !newPassword) {
        return res.status(400).json({ error: "Recovery key and new password required" });
    }
    if (recoveryKey !== adminConfig.recoveryKey) {
        return res.status(401).json({ error: "Invalid recovery key" });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    adminConfig.password = newPassword;
    saveAdminConfig();
    logAct("admin", "PASSWORD_CHANGE", "Password updated successfully");
    res.json({ success: true, message: "Password changed successfully" });
});

// Health Check
router.get("/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        poolSize: pool.size,
        sessions: Object.keys(readRegistry()).length
    });
});

// ================================================================
// SESSION ROUTES
// ================================================================

// Get All Sessions
router.get("/sessions", requireAuth, (req, res) => {
    const reg = readRegistry();
    const sessions = Object.values(reg).map(s => ({
        ...s,
        pooled: pool.has(s.number) && pool.get(s.number).ready,
        folderExists: fs.existsSync(join(__dirname, `auth_info/${s.number}`)),
    }));
    res.json({ sessions, total: sessions.length });
});

// Get Stats
router.get("/stats", requireAuth, (req, res) => {
    const reg = readRegistry();
    const ut = Math.floor(process.uptime());
    const h = Math.floor(ut / 3600),
        m = Math.floor((ut % 3600) / 60),
        s = ut % 60;
    let backupCount = 0,
        voCount = 0;
    try {
        backupCount = fs.readdirSync(BACKUP_DIR).length;
    } catch (e) {}
    try {
        voCount = fs.readdirSync(VIEW_ONCE_DIR).filter(f => !f.endsWith(".meta.json")).length;
    } catch (e) {}
    res.json({
        ...stats,
        totalSessions: Object.keys(reg).length,
        pooledConnections: pool.size,
        uptime: ut,
        uptimeStr: h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`,
        backupFiles: backupCount,
        viewOnceCount: voCount,
    });
});

// Get Activity
router.get("/activity", requireAuth, (req, res) => {
    res.json({ activity: actLog.slice(0, 100) });
});

// Delete Session
router.delete("/sessions/:number", requireAuth, (req, res) => {
    const num = req.params.number;
    if (pool.has(num)) {
        try {
            pool.get(num).sock.end();
        } catch (e) {}
        pool.delete(num);
    }
    const reg = readRegistry();
    delete reg[num];
    writeRegistry(reg);
    const dir = join(__dirname, `auth_info/${num}`);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
    logAct(num, "DELETE_SESSION", `Deleted session ${num}`);
    res.json({ success: true });
});

// ================================================================
// MESSAGING ROUTES
// ================================================================

// Send Single Message
router.post("/send-message", requireAuth, async (req, res) => {
    const { sessionNumber, recipient, message, mediaUrl } = req.body;
    if (!sessionNumber || !recipient || !message) {
        return res.status(400).json({ error: "sessionNumber, recipient, message required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const jid = recipient.includes("@") ? recipient : recipient + "@s.whatsapp.net";
        const content = mediaUrl ? { image: { url: mediaUrl }, caption: message } : { text: message };
        await sock.sendMessage(jid, content);
        stats.messages++;
        saveStats();
        logAct(sessionNumber, "SEND_MESSAGE", `To: ${recipient}`);
        res.json({ success: true });
    } catch (e) {
        logAct(sessionNumber, "SEND_MESSAGE", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

// Broadcast to List
router.post("/broadcast", requireAuth, async (req, res) => {
    const { sessionNumber, recipients, message, mediaUrl, delayMs = 2000 } = req.body;
    if (!sessionNumber || !recipients?.length || !message) {
        return res.status(400).json({ error: "sessionNumber, recipients[], message required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    try {
        const sock = await getSocket(sessionNumber);
        for (const r of recipients) {
            try {
                const jid = r.includes("@") ? r : r + "@s.whatsapp.net";
                await sock.sendMessage(jid, mediaUrl ? { image: { url: mediaUrl }, caption: message } : { text: message });
                ok++;
                stats.messages++;
                results.push({ recipient: r, status: "sent" });
                await delay(delayMs);
            } catch (e) {
                fail++;
                results.push({ recipient: r, status: "failed", error: e.message });
            }
        }
        saveStats();
        logAct(sessionNumber, "BROADCAST", `Sent:${ok} Failed:${fail}`, ok > 0 ? "success" : "failed");
        res.json({ success: true, successCount: ok, failCount: fail, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk Broadcast to All Groups
router.post("/bulk-broadcast-all", requireAuth, async (req, res) => {
    const { sessionNumber, message, mediaUrl, delayMs = 3000 } = req.body;
    if (!sessionNumber || !message) {
        return res.status(400).json({ error: "sessionNumber and message required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        let ok = 0,
            fail = 0;
        const results = [];
        for (const jid of Object.keys(groups)) {
            try {
                await sock.sendMessage(jid, mediaUrl ? { image: { url: mediaUrl }, caption: message } : { text: message });
                ok++;
                stats.messages++;
                results.push({ jid, status: "sent" });
                await delay(delayMs);
            } catch (e) {
                fail++;
                results.push({ jid, status: "failed", error: e.message });
            }
        }
        saveStats();
        logAct(sessionNumber, "BULK_BROADCAST", `Groups:${ok} Failed:${fail}`, ok > 0 ? "success" : "failed");
        res.json({ success: true, successCount: ok, failCount: fail, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk Bomber (Multi-Session)
router.post("/bulk-bomber", requireAuth, async (req, res) => {
    const { sessions, recipients, message, mediaUrl, delayMs = 2000 } = req.body;
    if (!sessions?.length || !recipients?.length || !message) {
        return res.status(400).json({ error: "sessions[], recipients[], message required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    const recipList = Array.isArray(recipients) ? recipients : String(recipients).split("\n").map(r => r.trim()).filter(Boolean);
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            for (const r of recipList) {
                try {
                    const jid = r.includes("@") ? r : r + "@s.whatsapp.net";
                    await sock.sendMessage(jid, mediaUrl ? { image: { url: mediaUrl }, caption: message } : { text: message });
                    ok++;
                    stats.messages++;
                    results.push({ session: num, recipient: r, status: "sent" });
                    await delay(delayMs);
                } catch (e) {
                    fail++;
                    results.push({ session: num, recipient: r, status: "failed", error: e.message });
                }
            }
        } catch (e) {
            results.push({ session: num, status: "session_failed", error: e.message });
            fail++;
        }
    }
    saveStats();
    logAct("multi", "BULK_BOMBER", `Sent:${ok} Failed:${fail}`, ok > 0 ? "success" : "failed");
    res.json({ success: ok > 0, successCount: ok, failCount: fail, results });
});

// ================================================================
// CHANNEL ROUTES
// ================================================================

// Channel Action (Follow/Unfollow/Mute/Unmute)
router.post("/channel-action", requireAuth, async (req, res) => {
    const { channelLink, action, sessions } = req.body;
    if (!channelLink || !action || !sessions?.length) {
        return res.status(400).json({ error: "channelLink, action, sessions[] required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    let resolvedJid = null;
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            if (!resolvedJid) resolvedJid = await resolveChannelJid(sock, channelLink);
            if (action === "follow") await sock.newsletterFollow(resolvedJid);
            else if (action === "unfollow") await sock.newsletterUnfollow(resolvedJid);
            else if (action === "mute") await sock.newsletterMute(resolvedJid);
            else if (action === "unmute") await sock.newsletterUnmute(resolvedJid);
            else if (action === "join") await sock.newsletterFollow(resolvedJid);
            else throw new Error(`Unknown action: ${action}`);
            ok++;
            stats.channelActions++;
            results.push({ session: num, status: "success", jid: resolvedJid });
            await delay(1500);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    saveStats();
    logAct("admin", `CHANNEL_${action.toUpperCase()}`, `${resolvedJid || channelLink} — ${ok} ok`, ok > 0 ? "success" : "failed");
    if (ok === 0) return res.status(400).json({ success: false, successCount: 0, failCount: fail, results });
    res.json({ success: true, successCount: ok, failCount: fail, results, resolvedJid });
});

// Channel Join
router.post("/channel-join", requireAuth, async (req, res) => {
    const { channelLink, sessions } = req.body;
    if (!channelLink || !sessions?.length) {
        return res.status(400).json({ error: "channelLink and sessions[] required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    let resolvedJid = null;
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            if (!resolvedJid) resolvedJid = await resolveChannelJid(sock, channelLink);
            await sock.newsletterFollow(resolvedJid);
            ok++;
            stats.channelActions++;
            results.push({ session: num, status: "joined", jid: resolvedJid });
            await delay(1200);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    saveStats();
    logAct("admin", "CHANNEL_JOIN", `${resolvedJid || channelLink} — ${ok} joined`, ok > 0 ? "success" : "failed");
    res.json({ success: ok > 0, successCount: ok, failCount: fail, results, resolvedJid });
});

// Channel React
router.post("/channel-react", requireAuth, async (req, res) => {
    const { channelLink, reaction, sessions } = req.body;
    if (!channelLink || !reaction || !sessions?.length) {
        return res.status(400).json({ error: "channelLink, reaction, sessions[] required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    let resolvedJid = null;
    let latestMsgId = null;
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            if (!resolvedJid) resolvedJid = await resolveChannelJid(sock, channelLink);
            if (!latestMsgId) {
                try {
                    const msgs = await sock.newsletterFetchMessages(resolvedJid, { count: 1 });
                    latestMsgId = msgs?.[0]?.key?.id || msgs?.[0]?.id;
                } catch (e) {
                    latestMsgId = generateMessageID();
                }
            }
            await sock.newsletterReactMessage(resolvedJid, latestMsgId, reaction);
            ok++;
            stats.reactions++;
            results.push({ session: num, status: "success", jid: resolvedJid, msgId: latestMsgId });
            await delay(1500);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    saveStats();
    logAct("admin", "CHANNEL_REACT", `${reaction} on ${resolvedJid} — ${ok} ok`, ok > 0 ? "success" : "failed");
    res.json({ success: ok > 0, successCount: ok, failCount: fail, results, resolvedJid });
});

// ================================================================
// GROUP ROUTES
// ================================================================

// Group Action (Join/Leave)
router.post("/group-action", requireAuth, async (req, res) => {
    const { action, groupLink, groupJid, sessions } = req.body;
    if (!action || !sessions?.length) {
        return res.status(400).json({ error: "action, sessions[] required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            if (action === "join" && groupLink) {
                let code = groupLink.trim();
                const m = code.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
                if (m) code = m[1];
                else if (code.includes("/")) code = code.split("/").pop().trim();
                code = code.split("?")[0].split("#")[0].trim();
                await sock.groupAcceptInvite(code);
            } else if (action === "leave" && groupJid) {
                const jid = groupJid.includes("@") ? groupJid : groupJid + "@g.us";
                await sock.groupLeave(jid);
            } else throw new Error("Invalid action or missing params");
            ok++;
            stats.groupActions++;
            results.push({ session: num, status: "success" });
            await delay(1500);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    saveStats();
    logAct("admin", `GROUP_${action.toUpperCase()}`, `${ok} ok`, ok > 0 ? "success" : "failed");
    res.json({ success: true, successCount: ok, failCount: fail, results });
});

// List Groups
router.get("/groups/:number", requireAuth, async (req, res) => {
    try {
        const sock = await getSocket(req.params.number);
        const groups = await sock.groupFetchAllParticipating();
        const myId = sock.authState.creds.me?.id || "";
        const list = Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.subject,
            participants: g.participants?.length || 0,
            isAdmin: g.participants?.some(p => p.id === myId && ["admin", "superadmin"].includes(p.admin)),
        }));
        res.json({ groups: list, total: list.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// REACTION ROUTES
// ================================================================

// Send Reaction
router.post("/send-reaction", requireAuth, async (req, res) => {
    const { reaction, sessions, channelJid, messageId, postLink } = req.body;
    if (!reaction || !sessions?.length || !messageId) {
        return res.status(400).json({ error: "reaction, messageId, sessions[] required" });
    }
    let ok = 0,
        fail = 0;
    const results = [];
    let targetJid = channelJid || "status@broadcast";
    for (const num of sessions) {
        try {
            const sock = await getSocket(num);
            if (postLink && targetJid === "status@broadcast") {
                try {
                    const r = await resolveChannelJid(sock, postLink);
                    if (r) targetJid = r;
                } catch (e) {}
            }
            if (targetJid.endsWith("@newsletter")) {
                await sock.newsletterReactMessage(targetJid, messageId, reaction);
            } else {
                await sock.sendMessage(targetJid, {
                    react: {
                        text: reaction,
                        key: { id: messageId, remoteJid: targetJid, fromMe: false }
                    }
                });
            }
            ok++;
            stats.reactions++;
            results.push({ session: num, status: "success", targetJid });
            await delay(1500);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    saveStats();
    logAct("admin", "SEND_REACTION", `${reaction} on ${targetJid} — ${ok} ok`, ok > 0 ? "success" : "failed");
    res.json({ success: true, successCount: ok, failCount: fail, results, targetJid });
});

// Auto-Reaction Config
router.post("/auto-reaction", requireAuth, (req, res) => {
    const { sessionNumber, enabled, emojis = ["❤️", "👍", "🔥"] } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    autoReactConfig[sessionNumber] = { enabled: !!enabled, emojis };
    saveAutoReact();
    logAct(sessionNumber, "AUTO_REACT", `${enabled ? "Enabled" : "Disabled"} with ${emojis.join(" ")}`);
    res.json({ success: true, config: autoReactConfig[sessionNumber] });
});

router.get("/auto-reaction/:number", requireAuth, (req, res) => {
    const cfg = autoReactConfig[req.params.number] || { enabled: false, emojis: ["❤️"] };
    res.json({ success: true, config: cfg });
});

// ================================================================
// VIEW-ONCE GALLERY ROUTES
// ================================================================

router.get("/view-once/list", requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(VIEW_ONCE_DIR)
            .filter(f => !f.endsWith(".meta.json"))
            .map(f => {
                const metaPath = join(VIEW_ONCE_DIR, f + ".meta.json");
                let meta = {};
                try {
                    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                } catch (e) {}
                const stat = fs.statSync(join(VIEW_ONCE_DIR, f));
                return {
                    fileName: f,
                    type: meta.type || (f.endsWith(".jpg") ? "imageMessage" : f.endsWith(".mp4") ? "videoMessage" : "audioMessage"),
                    session: meta.session || "unknown",
                    from: meta.from || "unknown",
                    savedAt: meta.savedAt || stat.birthtime.toISOString(),
                    size: meta.size || stat.size,
                    sizeStr: stat.size < 1024 ? `${stat.size}B` : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1024 / 1024).toFixed(1)}MB`,
                };
            })
            .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
        res.json({ files, total: files.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/view-once/file/:filename", requireAuth, (req, res) => {
    const filePath = join(VIEW_ONCE_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    res.sendFile(filePath);
});

router.delete("/view-once/file/:filename", requireAuth, (req, res) => {
    const filePath = join(VIEW_ONCE_DIR, path.basename(req.params.filename));
    const metaPath = filePath + ".meta.json";
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

import path from "path";

// ================================================================
// STATUS ROUTES
// ================================================================

router.post("/status/text", requireAuth, async (req, res) => {
    const { sessionNumber, text, backgroundColor = "#000000", font = 3 } = req.body;
    if (!sessionNumber || !text) {
        return res.status(400).json({ error: "sessionNumber and text required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        await sock.sendMessage("status@broadcast", { text, backgroundColor, font }, { statusJidList: [] });
        logAct(sessionNumber, "STATUS_TEXT", `Posted: ${text.substring(0, 50)}`);
        res.json({ success: true });
    } catch (e) {
        logAct(sessionNumber, "STATUS_TEXT", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.post("/status/image", requireAuth, async (req, res) => {
    const { sessionNumber, imageUrl, caption = "" } = req.body;
    if (!sessionNumber || !imageUrl) {
        return res.status(400).json({ error: "sessionNumber and imageUrl required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        await sock.sendMessage("status@broadcast", { image: { url: imageUrl }, caption }, { statusJidList: [] });
        logAct(sessionNumber, "STATUS_IMAGE", `Posted image status`);
        res.json({ success: true });
    } catch (e) {
        logAct(sessionNumber, "STATUS_IMAGE", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// PROFILE ROUTES
// ================================================================

router.post("/profile/dp", requireAuth, async (req, res) => {
    const { sessionNumber, imageUrl } = req.body;
    if (!sessionNumber || !imageUrl) {
        return res.status(400).json({ error: "sessionNumber and imageUrl required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Image fetch failed: ${response.statusText}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        await sock.updateProfilePicture(sock.authState.creds.me?.id, buffer);
        logAct(sessionNumber, "PROFILE_DP", "DP updated");
        res.json({ success: true });
    } catch (e) {
        logAct(sessionNumber, "PROFILE_DP", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.post("/profile/bio", requireAuth, async (req, res) => {
    const { sessionNumber, bio } = req.body;
    if (!sessionNumber || bio === undefined) {
        return res.status(400).json({ error: "sessionNumber and bio required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        await sock.updateProfileStatus(bio);
        logAct(sessionNumber, "PROFILE_BIO", `Bio: ${bio.substring(0, 40)}`);
        res.json({ success: true });
    } catch (e) {
        logAct(sessionNumber, "PROFILE_BIO", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.post("/profile/auto-bio", requireAuth, async (req, res) => {
    const { sessionNumber, template } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    try {
        const sock = await getSocket(sessionNumber);
        const reg = readRegistry();
        const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        const bio = (template || "🤖 ISHAQ-MD Active | {sessions} sessions | {messages} msgs | {time}")
            .replace("{sessions}", Object.keys(reg).length)
            .replace("{messages}", stats.messages)
            .replace("{reactions}", stats.reactions)
            .replace("{uptime}", `${Math.floor(process.uptime() / 60)}m`)
            .replace("{time}", now);
        await sock.updateProfileStatus(bio);
        logAct(sessionNumber, "AUTO_BIO", `Set: ${bio}`);
        res.json({ success: true, bio });
    } catch (e) {
        logAct(sessionNumber, "AUTO_BIO", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// PRIVACY ROUTES
// ================================================================

router.post("/privacy/settings", requireAuth, async (req, res) => {
    const { sessionNumber, lastSeen, profilePhoto, status, readReceipts } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    try {
        const sock = await getSocket(sessionNumber);
        const changes = [];
        const valid = ["all", "contacts", "contact_blacklist", "none"];
        if (lastSeen && valid.includes(lastSeen)) {
            await sock.updateLastSeenPrivacy(lastSeen);
            changes.push(`lastSeen→${lastSeen}`);
        }
        if (profilePhoto && valid.includes(profilePhoto)) {
            await sock.updateProfilePicturePrivacy(profilePhoto);
            changes.push(`photo→${profilePhoto}`);
        }
        if (status && valid.includes(status)) {
            await sock.updateStatusPrivacy(status);
            changes.push(`status→${status}`);
        }
        if (readReceipts !== undefined) {
            await sock.updateReadReceiptsPrivacy(readReceipts ? "all" : "none");
            changes.push(`readReceipts→${readReceipts ? "on" : "off"}`);
        }
        logAct(sessionNumber, "PRIVACY_UPDATE", changes.join(", "));
        res.json({ success: true, changes });
    } catch (e) {
        logAct(sessionNumber, "PRIVACY_UPDATE", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.post("/stealth-mode", requireAuth, async (req, res) => {
    const { enabled, sessions } = req.body;
    const targets = sessions?.length ? sessions : Object.keys(readRegistry());
    const results = [];
    let ok = 0,
        fail = 0;
    for (const num of targets) {
        try {
            const sock = await getSocket(num);
            if (enabled) {
                await sock.updateReadReceiptsPrivacy("none");
                await sock.updateLastSeenPrivacy("none");
                await sock.sendPresenceUpdate("unavailable");
            } else {
                await sock.updateReadReceiptsPrivacy("all");
                await sock.updateLastSeenPrivacy("contacts");
                await sock.sendPresenceUpdate("available");
            }
            ok++;
            results.push({ session: num, status: "success" });
            await delay(800);
        } catch (e) {
            fail++;
            results.push({ session: num, status: "failed", error: e.message });
        }
    }
    logAct("multi", "STEALTH_MODE", `${enabled ? "Enabled" : "Disabled"} on ${ok} sessions`, ok > 0 ? "success" : "failed");
    res.json({ success: ok > 0, enabled, successCount: ok, failCount: fail, results });
});

router.post("/ghost-mode", requireAuth, async (req, res) => {
    const { sessionNumber, enabled } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    try {
        const sock = await getSocket(sessionNumber);
        if (enabled) {
            await sock.updateReadReceiptsPrivacy("none");
            await sock.updateLastSeenPrivacy("none");
            await sock.sendPresenceUpdate("unavailable");
        } else {
            await sock.updateReadReceiptsPrivacy("all");
            await sock.updateLastSeenPrivacy("contacts");
            await sock.sendPresenceUpdate("available");
        }
        logAct(sessionNumber, "GHOST_MODE", enabled ? "Enabled" : "Disabled");
        res.json({ success: true, ghostMode: enabled });
    } catch (e) {
        logAct(sessionNumber, "GHOST_MODE", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.post("/always-online", requireAuth, async (req, res) => {
    const { sessionNumber, enabled } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    try {
        const sock = await getSocket(sessionNumber);
        await sock.sendPresenceUpdate(enabled ? "available" : "unavailable");
        logAct(sessionNumber, "ALWAYS_ONLINE", enabled ? "ON" : "OFF");
        res.json({ success: true, alwaysOnline: enabled });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// SIMULATE ROUTES
// ================================================================

router.post("/simulate", requireAuth, async (req, res) => {
    const { sessionNumber, targetJid, action, durationMs = 5000 } = req.body;
    if (!sessionNumber || !targetJid || !action) {
        return res.status(400).json({ error: "sessionNumber, targetJid, action required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const jid = targetJid.includes("@") ? targetJid : targetJid + "@s.whatsapp.net";
        const presence = action === "typing" ? "composing" : action === "recording" ? "recording" : "available";
        await sock.sendPresenceUpdate(presence, jid);
        setTimeout(() => sock.sendPresenceUpdate("paused", jid).catch(() => {}), durationMs);
        logAct(sessionNumber, "SIMULATE", `${action} to ${jid} for ${durationMs}ms`);
        res.json({ success: true, presence, jid, durationMs });
    } catch (e) {
        logAct(sessionNumber, "SIMULATE", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// BLOCK ROUTES
// ================================================================

router.post("/block", requireAuth, async (req, res) => {
    const { sessionNumber, targetNumber, action } = req.body;
    if (!sessionNumber || !targetNumber || !action) {
        return res.status(400).json({ error: "sessionNumber, targetNumber, action required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const jid = targetNumber.includes("@") ? targetNumber : targetNumber + "@s.whatsapp.net";
        await sock.updateBlockStatus(jid, action === "block" ? "block" : "unblock");
        logAct(sessionNumber, `BLOCK_${action.toUpperCase()}`, jid);
        res.json({ success: true, jid, action });
    } catch (e) {
        logAct(sessionNumber, "BLOCK_ACTION", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.get("/blocklist/:number", requireAuth, async (req, res) => {
    try {
        const sock = await getSocket(req.params.number);
        const list = await sock.fetchBlocklist();
        res.json({ success: true, blocklist: list, total: list.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// KEYWORD ALERTS ROUTES
// ================================================================

router.post("/keyword-alerts", requireAuth, (req, res) => {
    const { sessionNumber, keywords } = req.body;
    if (!sessionNumber || !Array.isArray(keywords)) {
        return res.status(400).json({ error: "sessionNumber and keywords[] required" });
    }
    keywordAlerts[sessionNumber] = keywords;
    saveKeywordAlerts();
    logAct(sessionNumber, "KEYWORD_ALERTS", `Set: ${keywords.join(", ")}`);
    res.json({ success: true, keywords });
});

router.get("/keyword-alerts/:number", requireAuth, (req, res) => {
    res.json({ success: true, keywords: keywordAlerts[req.params.number] || [] });
});

// ================================================================
// MEDIA SCRAPER ROUTES
// ================================================================

router.post("/media-scraper", requireAuth, async (req, res) => {
    const { sessionNumber, targetJid, limit = 20 } = req.body;
    if (!sessionNumber || !targetJid) {
        return res.status(400).json({ error: "sessionNumber and targetJid required" });
    }
    try {
        const sock = await getSocket(sessionNumber);
        const jid = targetJid.includes("@") ? targetJid : targetJid + "@s.whatsapp.net";
        let downloaded = 0;
        const files = [];
        try {
            const msgs = await sock.loadMessages(jid, parseInt(limit), undefined);
            const mediaMsgs = (msgs?.messages || []).filter(m =>
                m.message?.imageMessage || m.message?.videoMessage || m.message?.documentMessage);
            for (const msg of mediaMsgs) {
                try {
                    const t = msg.message?.imageMessage ? "image" : msg.message?.videoMessage ? "video" : "document";
                    const ext = t === "image" ? "jpg" : t === "video" ? "mp4" : "bin";
                    const fn = `${t}_${msg.key.id}.${ext}`;
                    const buffer = await downloadMediaMessage(msg, "buffer", {});
                    fs.writeFileSync(join(MEDIA_DIR, fn), buffer);
                    files.push({ fileName: fn, mediaType: t, size: buffer.length });
                    downloaded++;
                } catch (e) {}
            }
        } catch (e) {
            console.log("[⚠️] loadMessages:", e.message);
        }
        logAct(sessionNumber, "MEDIA_SCRAPER", `${downloaded} files from ${targetJid}`);
        res.json({ success: true, downloaded, files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// CONTACTS ROUTES
// ================================================================

router.get("/contacts/:number", requireAuth, async (req, res) => {
    try {
        const sock = await getSocket(req.params.number);
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        const seen = new Set();
        const contacts = [];
        for (const [, g] of Object.entries(groups)) {
            for (const p of (g.participants || [])) {
                const num = p.id.split("@")[0];
                if (!seen.has(num)) {
                    seen.add(num);
                    contacts.push({
                        number: num,
                        jid: p.id,
                        source: `group:${g.subject}`,
                        admin: p.admin || null
                    });
                }
            }
        }
        res.json({ contacts, total: contacts.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get("/contacts/export/:number", requireAuth, async (req, res) => {
    const format = req.query.format || "json";
    try {
        const sock = await getSocket(req.params.number);
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        const seen = new Set();
        const contacts = [];
        for (const [, g] of Object.entries(groups)) {
            for (const p of (g.participants || [])) {
                const num = p.id.split("@")[0];
                if (!seen.has(num)) {
                    seen.add(num);
                    contacts.push({
                        number: num,
                        jid: p.id,
                        source: `group:${g.subject}`,
                        admin: p.admin || null
                    });
                }
            }
        }
        logAct(req.params.number, "CONTACTS_EXPORT", `${contacts.length} contacts`);
        if (format === "txt") {
            let txt = `ISHAQ-MD Contact Export — ${req.params.number}\nDate: ${new Date().toISOString()}\nTotal: ${contacts.length}\n\n`;
            contacts.forEach((c, i) => {
                txt += `${i + 1}. +${c.number} [${c.source}]\n`;
            });
            res.setHeader("Content-Type", "text/plain");
            res.setHeader("Content-Disposition", `attachment; filename="contacts_${req.params.number}.txt"`);
            return res.send(txt);
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="contacts_${req.params.number}.json"`);
        res.send(JSON.stringify({
            exportDate: new Date().toISOString(),
            session: req.params.number,
            contacts
        }, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// BACKUP ROUTES
// ================================================================

router.get("/backup/chats/:number", requireAuth, async (req, res) => {
    const num = req.params.number;
    try {
        const sock = await getSocket(num);
        const chats = [];
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        for (const [jid, g] of Object.entries(groups)) {
            chats.push({
                jid,
                name: g.subject || jid,
                type: "group",
                participants: g.participants?.length || 0
            });
        }
        logAct(num, "LIST_CHATS", `${chats.length} chats`);
        res.json({ success: true, chats, total: chats.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post("/backup/download", requireAuth, async (req, res) => {
    const { sessionNumber, targetJid, format = "json", chatName } = req.body;
    if (!sessionNumber) return res.status(400).json({ error: "sessionNumber required" });
    try {
        const sock = await getSocket(sessionNumber);
        const myId = sock.authState.creds.me?.id || "unknown";
        const myNumber = myId.split("@")[0];
        const bd = {
            exportedBy: "ISHAQ-MD Admin Panel",
            exportDate: new Date().toISOString(),
            sessionNumber,
            myNumber,
            targetJid: targetJid || "all",
            chatName: chatName || targetJid || "All Chats",
            messages: [],
        };
        if (targetJid?.endsWith("@g.us")) {
            try {
                const gm = await sock.groupMetadata(targetJid);
                bd.groupMetadata = {
                    subject: gm.subject,
                    desc: gm.desc,
                    creation: gm.creation,
                    participants: gm.participants?.map(p => ({ id: p.id, admin: p.admin })),
                };
            } catch (e) {}
        }
        try {
            if (targetJid) {
                const msgs = await sock.loadMessages(targetJid, 100, undefined);
                if (msgs?.messages?.length) {
                    bd.messages = msgs.messages.map(m => ({
                        id: m.key?.id,
                        from: m.key?.fromMe ? myNumber : (m.key?.participant || m.key?.remoteJid),
                        fromMe: m.key?.fromMe,
                        timestamp: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null,
                        type: Object.keys(m.message || {})[0] || "unknown",
                        text: m.message?.conversation || m.message?.extendedTextMessage?.text ||
                            m.message?.imageMessage?.caption || "[media]",
                    }));
                }
            }
        } catch (e) {
            bd.note = "Message history not in local store.";
        }

        stats.backups++;
        saveStats();
        const ts = Date.now();
        const safeJid = (targetJid || "all").replace(/[@.]/g, "_");
        const fn = `backup_${sessionNumber}_${safeJid}_${ts}`;

        if (format === "txt") {
            let txt = `╔══════════════════════════════════╗\n║    ISHAQ-MD Chat Backup          ║\n╚══════════════════════════════════╝\n\nSession: ${sessionNumber} | Chat: ${bd.chatName}\nDate: ${bd.exportDate}\nMessages: ${bd.messages.length}\n\n── Messages ──\n\n`;
            bd.messages.forEach(m => {
                txt += `[${m.timestamp || "?"}] ${m.fromMe ? "[YOU]" : `[${m.from}]`}\n${m.text}\n\n`;
            });
            if (!bd.messages.length) txt += bd.note || "No messages.\n";
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="${fn}.txt"`);
            return res.send(txt);
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fn}.json"`);
        return res.send(JSON.stringify(bd, null, 2));
    } catch (e) {
        logAct(sessionNumber, "BACKUP_DOWNLOAD", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.get("/backup/session/:number", requireAuth, async (req, res) => {
    const num = req.params.number;
    const format = req.query.format || "json";
    try {
        const sock = await getSocket(num);
        const myId = sock.authState.creds.me?.id || "unknown";
        const ed = {
            exportedBy: "ISHAQ-MD Admin Panel",
            exportDate: new Date().toISOString(),
            sessionNumber: num,
            myJid: myId,
            myNumber: myId.split("@")[0],
            groups: [],
        };
        const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
        ed.groups = Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.subject,
            creation: g.creation,
            desc: g.desc,
            participants: g.participants?.map(p => ({ id: p.id, admin: p.admin })) || [],
        }));
        stats.backups++;
        saveStats();
        logAct(num, "SESSION_BACKUP", `Exported ${ed.groups.length} groups`);
        const fn = `session_${num}_${Date.now()}`;
        if (format === "txt") {
            let txt = `ISHAQ-MD Session Backup — ${num}\nDate: ${ed.exportDate}\nJID: ${myId}\n\n=== Groups (${ed.groups.length}) ===\n\n`;
            ed.groups.forEach((g, i) => {
                txt += `${i + 1}. ${g.name}\n   JID: ${g.jid}\n   Members: ${g.participants.length}\n\n`;
            });
            res.setHeader("Content-Type", "text/plain");
            res.setHeader("Content-Disposition", `attachment; filename="${fn}.txt"`);
            return res.send(txt);
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${fn}.json"`);
        res.send(JSON.stringify(ed, null, 2));
    } catch (e) {
        logAct(num, "SESSION_BACKUP", `Failed: ${e.message}`, "failed");
        res.status(500).json({ error: e.message });
    }
});

router.get("/backup/files", requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR).map(f => {
            const stat = fs.statSync(join(BACKUP_DIR, f));
            return {
                name: f,
                size: stat.size,
                created: stat.birthtime.toISOString(),
                sizeStr: stat.size < 1024 ? `${stat.size}B` : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1024 / 1024).toFixed(1)}MB`,
            };
        }).sort((a, b) => new Date(b.created) - new Date(a.created));
        res.json({ files, total: files.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;