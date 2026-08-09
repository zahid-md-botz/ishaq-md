require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadContentFromMessage, jidNormalizedUser, Browsers, delay } = require('@whiskeysockets/baileys');
const P = require('pino');
const { OpenAI } = require('openai');

// ================================================================
// ADMIN PANEL IMPORTS - FIXED
// ================================================================
let adminRouter = null;
let adminSetIo = null;

(async function loadAdminModule() {
    try {
        const adminModule = await import('./admin-api.js');
        adminRouter = adminModule.default;
        adminSetIo = adminModule.setIo;
        console.log('✅ Admin API loaded');
    } catch (err) {
        console.error('❌ Admin API failed:', err.message);
        const fallbackRouter = express.Router();
        fallbackRouter.get('/health', (req, res) => res.json({ status: 'ok', admin: 'fallback' }));
        adminRouter = fallbackRouter;
    }
})();

// ================================================================
// COMMANDS - ALL IMPORTED
// ================================================================
const commands = {
    song: require('./commands/song'),
    video: require('./commands/video'),
    kick: require('./commands/kick'),
    private: require('./commands/private'),
    public: require('./commands/public'),
    owner: require('./commands/owner'),
    ai: require('./commands/ai'),
    antilink: require('./commands/antilink'),
    anticall: require('./commands/anticall'),
    status: require('./commands/status'),
    antidelete: require('./commands/antidelete'),
    ping: require('./commands/ping'),
    autoreacts: require('./commands/autoreacts'),
    hidetag: require('./commands/hidetag'),
    tagall: require('./commands/tagall'),
    setname: require('./commands/setname'),
    insta: require('./commands/insta'),
    tiktok: require('./commands/tiktok'),
    dp: require('./commands/dp'),
    vv: require('./commands/vv'),
    joke: require('./commands/joke'),
    meme: require('./commands/meme'),
    groupinfo: require('./commands/groupinfo'),
    gdrive: require('./commands/gdrive'),
    mf: require('./commands/mf'),
    translate: require('./commands/translate').handleTranslateCommand,
    autostatus: require('./commands/status'),
    apk: require('./commands/apk'),
    autoread: require('./commands/autoread').autoreadCommand,
    character: require('./commands/character'),
    emojimix: require('./commands/emojimix'),
    facebook: require('./commands/facebook'),
    hack: require('./commands/hack'),
    accept: require('./commands/accept'),
    kickoffline: require('./commands/kickoffline'),
    antistatus: require('./commands/antistatus'),
    // UPDATED COMMANDS
    addcmd: require('./commands/addcmd').addcmdCommand,
    delcmd: require('./commands/delcmd'),
    listcmd: require('./commands/listcmd'),
    pair: require('./commands/pair')
};

const { executeCustomCommand } = require('./commands/addcmd');
const { handleAutoread } = require('./commands/autoread');
const { handleStatusUpdate } = require('./commands/autostatus');
const { storeMessage, handleMessageRevocation } = require('./commands/antidelete');

const app = express();
const server = http.createServer(app);

// ================================================================
// SOCKET.IO
// ================================================================
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

if (adminSetIo) adminSetIo(io);

// ================================================================
// TELEGRAM BOT
// ================================================================
const tgToken = "8858434345:AAE0M-vuRYWxCZYchi-e-hAFa4Qxx2RQscA";
const tgBot = new TelegramBot(tgToken, { polling: true });

tgBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (text === '/start') {
        await tgBot.sendMessage(chatId, "𝗜𝗦𝗛𝗔𝗤-𝑀𝐷-𝘮𝘪𝘯𝘪\n\nEnter WhatsApp number\nExample: 923000000000");
        return;
    }
    if (/^\d+$/.test(text)) {
        const userId = chatId.toString();
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        if (!botData.statusSettings[userId]) {
            botData.statusSettings[userId] = { autoStatus: false, autoSeen: false, autoLike: false, autoDownload: false, isPublic: false };
            saveBotData();
        }
        await tgBot.sendMessage(chatId, "⏳ Requesting Pairing Code for " + text + "...");
        sessions[userId].tgChatId = chatId;
        await sessions[userId].initialize(text);
    }
});

// ================================================================
// OPENAI
// ================================================================
let openai = null;
if (process.env.OPENAI_API_KEY) {
    try { openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.AI_BASE_URL || "https://api.openai.com/v1" }); } catch (e) {}
}

// ================================================================
// EXPRESS
// ================================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use('/admin', (req, res, next) => {
    if (adminRouter) adminRouter(req, res, next);
    else res.status(503).json({ error: 'Admin API loading...' });
});

// ================================================================
// CONSTANTS
// ================================================================
const AUTH_DIR = './auth_info';
const DATA_FILE = './data/bot_data.json';
const SESSION_REGISTRY = './data/session_registry.json';
fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync('./data');

let botData = { antilinkGroups: {}, totalBots: 0, registeredBots: [], statusSettings: {}, antiDelete: {}, userNames: {}, antiCall: {}, customCommands: {} };
if (fs.existsSync(DATA_FILE)) { try { botData = fs.readJsonSync(DATA_FILE); } catch (e) {} }

function saveBotData() { fs.writeJsonSync(DATA_FILE, botData); }

function updateSessionRegistry(number, data) {
    try {
        let registry = {};
        if (fs.existsSync(SESSION_REGISTRY)) registry = fs.readJsonSync(SESSION_REGISTRY);
        registry[number] = { number, pushName: data.pushName || 'Unknown', connectedAt: data.connectedAt || new Date().toISOString(), status: 'active', lastSeen: new Date().toISOString() };
        fs.writeJsonSync(SESSION_REGISTRY, registry);
    } catch (e) { console.error('[Registry] Error:', e.message); }
}

const sessions = {};
const userSockets = {};
const messageLogs = {};

// ================================================================
// LOAD EXISTING SESSIONS
// ================================================================
async function loadExistingSessions() {
    try {
        const authDirs = await fs.readdir(AUTH_DIR);
        for (const userId of authDirs) {
            const authPath = path.join(AUTH_DIR, userId);
            const stats = await fs.stat(authPath);
            if (stats.isDirectory()) {
                const credsFile = path.join(authPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    console.log(`[System] Found session: ${userId}`);
                    if (!sessions[userId]) {
                        sessions[userId] = new BotSession(userId);
                        sessions[userId].initialize().catch(err => console.error(err.message));
                    }
                }
            }
        }
    } catch (err) { console.error('[System] Error:', err.message); }
}

// ================================================================
// BOLD HELPER
// ================================================================
const toBold = (text) => {
    const boldChars = {
        'a': '𝗮','b':'𝗯','c':'𝗰','d':'𝗱','e':'𝗲','f':'𝗳','g':'𝗴','h':'𝗵','i':'𝗶','j':'𝗷','k':'𝗸','l':'𝗹','m':'𝗺','n':'𝗻','o':'𝗼','p':'𝗽','q':'𝗾','r':'𝗿','s':'𝘀','t':'𝘁','u':'𝘂','v':'𝘃','w':'𝘄','x':'𝘅','y':'𝘆','z':'𝘇',
        'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠','N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭',
        '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟳','8':'𝟴','9':'𝟵'
    };
    return text.split('').map(c => boldChars[c] || c).join('');
};

// ================================================================
// BOT SESSION CLASS
// ================================================================
class BotSession {
    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.aiEnabled = false;
        this.autoReact = botData.statusSettings[userId]?.autoReact || false;
        this.isPublic = botData.statusSettings[userId]?.isPublic || false;
        this.authPath = path.join(AUTH_DIR, userId);
        this.processedMessages = new Set();
        this.activeInterval = null;
        this.isInitializing = false;
        this.lastConnectMessageTime = null;
        this.tgChatId = null;
        this.pushName = 'Unknown';
    }

    sendLog(message, type = 'info') {
        const logEntry = { timestamp: new Date().toLocaleTimeString(), message, type };
        const socketId = userSockets[this.userId];
        if (socketId) io.to(socketId).emit('console', logEntry);
        io.emit('terminal', { chatType: 'SYSTEM', sender: 'ISHAQ-MD', content: message, session: this.userId, time: new Date().toISOString(), fromMe: false, system: true });
        console.log(`[${this.userId}] ${message}`);
    }

    sendConnectionStatus() {
        const socketId = userSockets[this.userId];
        if (socketId) io.to(socketId).emit('connection-status', { connected: this.isConnected, user: this.userId });
        io.emit('total-active', Object.values(sessions).filter(s => s.isConnected).length);
        io.emit('stats-update', { sessions: Object.keys(sessions).length, connected: Object.values(sessions).filter(s => s.isConnected).length });
    }

    async getAIResponse(userJid, userMessage) {
        if (!openai) return "❌ AI not configured.";
        try {
            const completion = await openai.chat.completions.create({
                model: process.env.AI_MODEL || "gpt-3.5-turbo",
                messages: [{ role: "system", content: "Helpful assistant." }, { role: "user", content: userMessage }],
                max_tokens: 150
            });
            return completion.choices[0].message.content.trim();
        } catch (error) { return "❌ AI Error: " + error.message; }
    }

    startActiveCheck() {
        if (this.activeInterval) clearInterval(this.activeInterval);
        this.activeInterval = setInterval(async () => {
            if (this.isConnected && this.sock?.user) {
                try {
                    const botNumber = jidNormalizedUser(this.sock.user.id);
                    await this.sock.sendMessage(botNumber, { text: "𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶 24/7 Active 🚀" });
                    this.sendLog("Keep-alive sent ✅", "success");
                } catch (e) { this.sendLog("Keep-alive failed: " + e.message, "error"); }
            }
        }, 60 * 60 * 1000);
    }

    async initialize(pairingNumber = null) {
        if (this.isInitializing) { this.sendLog("Init in progress...", "info"); return; }
        this.isInitializing = true;
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
            this.sock = makeWASocket({
                version,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' })) },
                printQRInTerminal: false,
                logger: P({ level: 'fatal' }),
                browser: Browsers.ubuntu('Chrome'),
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                markOnlineOnConnect: true,
                keepAliveIntervalMs: 30000,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                emitOwnEvents: true,
                retryRequestDelayMs: 5000,
                maxMsgRetryCount: 5,
                getMessage: async (key) => {
                    if (messageLogs[key.id]) return { conversation: messageLogs[key.id].text };
                    return { conversation: 'Bot is active' };
                }
            });

            if (pairingNumber && !state.creds.registered) {
                if (!this.sock.authState.creds.registered) {
                    await delay(3000);
                    try {
                        let code = await this.sock.requestPairingCode(pairingNumber);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        this.sendLog(`🔑 Pairing Code: ${code}`, 'success');
                        if (this.tgChatId) await tgBot.sendMessage(this.tgChatId, "🔑 PAIRING CODE: " + code);
                        const socketId = userSockets[this.userId];
                        if (socketId) io.to(socketId).emit('pairing-code', code);
                    } catch (err) {
                        this.sendLog(`❌ Pairing error: ${err.message}`, 'error');
                        if (this.tgChatId) await tgBot.sendMessage(this.tgChatId, "❌ Pairing Error: " + err.message);
                    }
                }
            }

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('call', async (calls) => {
                if (botData.antiCall[this.userId]) {
                    for (const call of calls) {
                        if (call.status === 'offer') {
                            try {
                                await this.sock.rejectCall(call.id, call.from);
                                await this.sock.sendMessage(call.from, { text: "⚠️ ANTI-CALL: I don't accept calls." });
                            } catch (e) {}
                        }
                    }
                }
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                if (m.type !== 'notify') return;
                await Promise.all(m.messages.map(async (msg) => {
                    try {
                        const from = msg.key.remoteJid;
                        const isMe = msg.key.fromMe;
                        const isGroup = from.endsWith('@g.us');
                        const isChannel = from.endsWith('@newsletter');
                        const isStatus = from === 'status@broadcast';
                        const messageContent = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message || msg.message;
                        if (!messageContent) return;
                        let type = Object.keys(messageContent)[0];
                        const text = (messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || messageContent.videoMessage?.caption || '').trim();

                        // Terminal
                        const senderJid = msg.key.participant || msg.key.remoteJid || '?';
                        const senderName = msg.pushName || senderJid.split('@')[0];
                        this.pushName = senderName;
                        const chatType = isChannel ? 'Channel' : isGroup ? 'Group' : isStatus ? 'Status' : 'Private';
                        let content = messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || messageContent.videoMessage?.caption || '';
                        if (!content) {
                            if (messageContent.audioMessage) content = '🎵 Voice/Audio';
                            else if (messageContent.stickerMessage) content = '🎭 Sticker';
                            else if (messageContent.contactMessage) content = `👤 Contact: ${messageContent.contactMessage.displayName}`;
                            else if (messageContent.locationMessage) content = '📍 Location';
                            else if (messageContent.reactionMessage) content = `${messageContent.reactionMessage.text || 'React'} to msg`;
                            else if (messageContent.pollCreationMessage) content = `📊 Poll: ${messageContent.pollCreationMessage.name}`;
                            else content = `[${type}]`;
                        }
                        io.emit('terminal', { chatType, sender: isMe ? `You (${this.userId})` : senderName, content: String(content).substring(0, 250), session: this.userId, jid: from, time: new Date().toISOString(), fromMe: isMe });

                        if (!isMe && !isStatus) { await handleAutoread(this.sock, msg); await storeMessage(msg); }
                        if (msg.message?.protocolMessage?.type === 0) { await handleMessageRevocation(this.sock, msg); return; }

                        const msgId = msg.key.id;
                        if (this.processedMessages.has(msgId)) return;
                        this.processedMessages.add(msgId);
                        if (this.processedMessages.size > 1000) this.processedMessages.delete(this.processedMessages.values().next().value);

                        if (this.autoReact && !isMe && !isStatus) {
                            const emojis = ['❤️','👍','🔥','👏','😃','😄','🙌','✨','⭐','✅','🤖','⚡','🌟','💯','🎉','💎','👊','🎊','🧿','🦅'];
                            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                            try { await this.sock.sendMessage(from, { react: { text: randomEmoji, key: msg.key } }); } catch (e) {}
                        }

                        if (this.aiEnabled && !isMe && !isStatus && !isGroup && text && !text.startsWith('.')) {
                            try {
                                const aiResponse = await this.getAIResponse(from, text);
                                await this.sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                            } catch (e) { console.error("AI Error:", e); }
                        }

                        if (isStatus && !isMe) { await handleStatusUpdate(this.sock, m, botData, this.userId); return; }

                        const botNumber = jidNormalizedUser(this.sock.user.id);
                        const sender = msg.key.participant || from;
                        const isOwner = isMe || sender.includes(botNumber.split('@')[0]);
                        let isAdmin = isOwner;
                        if (!isAdmin && isGroup) {
                            try {
                                const groupMetadata = await this.sock.groupMetadata(from);
                                const participant = groupMetadata.participants.find(p => p.id === sender);
                                isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                            } catch (e) { isAdmin = false; }
                        }

                        if (isGroup && botData.antiStatusGroups && botData.antiStatusGroups[from] && !isAdmin) {
                            const isStatusMsg = msg.message?.protocolMessage?.type === 0 || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension || (text && (text.includes('whatsapp.com/channel/') || text.includes('status@broadcast')));
                            if (msg.message?.forwardingScore > 0 || isStatusMsg) {
                                try { await this.sock.sendMessage(from, { delete: msg.key }); return; } catch (e) {}
                            }
                        }

                        if (isGroup && botData.antilinkGroups[from] && !isAdmin) {
                            const linkPatterns = [/chat.whatsapp.com\//i, /http:\/\//i, /https:\/\//i, /www\./i, /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/i];
                            if (linkPatterns.some(pattern => pattern.test(text))) {
                                try {
                                    const mode = botData.antilinkGroups[from];
                                    await this.sock.sendMessage(from, { delete: msg.key });
                                    if (mode === 'kick') await this.sock.groupParticipantsUpdate(from, [sender], "remove");
                                } catch (e) {}
                                return;
                            }
                        }

                        if (!this.isPublic && !isOwner) return;

                        const cmd = text.toLowerCase();
                        const args = text.split(' ').slice(1);
                        const q = args.join(' ');

                        if (cmd.startsWith('.')) {
                            const commandName = cmd.slice(1).split(' ')[0];
                            
                            // Custom commands
                            const customExecuted = await executeCustomCommand(this.sock, from, msg, commandName);
                            if (customExecuted) return;

                            (async () => {
                                try {
                                    switch (commandName) {
                                        /*case 'menu':
                                            const loadEmojis = ['⏳','⌛','🚀','✨'];
                                            for (const emoji of loadEmojis) await this.sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
                                            const customName = botData.userNames[this.userId] || msg.pushName || 'User';
                                            const menuText = `╭───【 ${toBold("𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶")} 】───╮\n│ 👤 ${toBold("User:")} ${customName}\n│ 🤖 ${toBold("Status:")} ${toBold("Online ✅")}\n│ ⚙️ ${toBold("Mode:")} ${this.isPublic ? toBold('Public 🌍') : toBold('Private 🔐')}\n│\n╰─────────────────╯\n\n╭───【 📋 COMMANDS 】───╮\n│ ▪ .ping - Check speed\n│ ▪ .owner - Bot owner\n│ ▪ .ai - AI chat\n│ ▪ .antilink - Anti-link\n│ ▪ .anticall - Anti-call\n│ ▪ .antidelete - Anti-delete\n│ ▪ .autostatus - Auto status\n│ ▪ .autoreacts - Auto reacts\n│ ▪ .kick - Kick member\n│ ▪ .private/.public - Toggle mode\n│ ▪ .hidetag - Hidden tag all\n│ ▪ .tagall - Tag all\n│ ▪ .setname - Set bot name\n│ ▪ .insta - Instagram download\n│ ▪ .tiktok - TikTok download\n│ ▪ .song - Audio download\n│ ▪ .video - Video download\n│ ▪ .joke - Random joke\n│ ▪ .meme - Random meme\n│ ▪ .vv - View-once download\n│ ▪ .dp - Profile picture\n│ ▪ .groupinfo - Group info\n│ ▪ .gdrive - Google Drive\n│ ▪ .mf - MediaFire\n│ ▪ .translate - Translate text\n│ ▪ .apk - APK download\n│ ▪ .character - Character analysis\n│ ▪ .emojimix - Mix emojis\n│ ▪ .facebook - Facebook download\n│ ▪ .hack - Fake hack\n│ ▪ .accept - Accept join requests\n│ ▪ .kickoffline - Kick offline\n│ ▪ .antistatus - Anti-status share\n│ ▪ . - Add custom command (Owner)\n│ ▪ .d - Delete custom command (Owner)\n│ ▪ .listcmd - List custom commands\n│ ▪ .pair - Generate pairing code\n╰─────────────────╯\n\n> *Powered by 𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶*`;
                                            try { await this.sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/f1ygtp.jpg' }, caption: menuText }); } catch (e) { await this.sock.sendMessage(from, { text: menuText }); }
                                            break;*/

                                              case 'menu':
                                            const loadEmojis = ['⏳', '⌛', '🚀', '✨'];
                                            for (const emoji of loadEmojis) await this.sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
                                            const customName = botData.userNames[this.userId] || msg.pushName || 'User';
                                            const menuText = `╭━━━〔 ${toBold("𝗜𝗦𝗛𝗔𝗤-𝑀𝐷-𝘮𝘪𝘯𝘪")} 〕━━━┈⊷\n` +
                                                           `┃ 👤 ${toBold("User:")} ${customName}\n` +
                                                           `┃ 🤖 ${toBold("Status:")} ${toBold("Online ✅")}\n` +
                                                           `┃ ⚙️ ${toBold("Mode:")} ${this.isPublic ? toBold('Public 🌍') : toBold('Private 🔐')}\n` +
                                                           `┃\n` +
                                                           `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                                                           `╭━━━〔 📋 *COMMANDS* 〕━━━┈⊷\n` +
                                                           `┃ ⋄ .ping - Check speed\n` +
                                                           `┃ ⋄ .owner - Bot owner\n` +
                                                           `┃ ⋄ .ai - AI chat\n` +
                                                           `┃ ⋄ .antilink - Anti-link\n` +
                                                           `┃ ⋄ .anticall - Anti-call\n` +
                                                           `┃ ⋄ .antidelete - Anti-delete\n` +
                                                           `┃ ⋄ .autostatus - Auto status\n` +
                                                           `┃ ⋄ .autoreacts - Auto reacts\n` +
                                                           `┃ ⋄ .kick - Kick member\n` +
                                                           `┃ ⋄ .private/.public - Toggle mode\n` +
                                                           `┃ ⋄ .hidetag - Hidden tag all\n` +
                                                           `┃ ⋄ .tagall - Tag all\n` +
                                                           `┃ ⋄ .setname - Set bot name\n` +
                                                           `┃ ⋄ .insta - Instagram download\n` +
                                                           `┃ ⋄ .tiktok - TikTok download\n` +
                                                           `┃ ⋄ .song - Audio download\n` +
                                                           `┃ ⋄ .video - Video download\n` +
                                                           `┃ ⋄ .joke - Random joke\n` +
                                                           `┃ ⋄ .meme - Random meme\n` +
                                                           `┃ ⋄ .vv - View-once download\n` +
                                                           `┃ ⋄ .dp - Profile picture\n` +
                                                           `┃ ⋄ .groupinfo - Group info\n` +
                                                           `┃ ⋄ .gdrive - Google Drive\n` +
                                                           `┃ ⋄ .mf - MediaFire\n` +
                                                           `┃ ⋄ .translate - Translate text\n` +
                                                           `┃ ⋄ .apk - APK download\n` +
                                                           `┃ ⋄ .character - Character analysis\n` +
                                                           `┃ ⋄ .emojimix - Mix emojis\n` +
                                                           `┃ ⋄ .facebook - Facebook download\n` +
                                                           `┃ ⋄ .hack - Fake hack\n` +
                                                           `┃ ⋄ .accept - Accept join requests\n` +
                                                           `┃ ⋄ .kickoffline - Kick offline\n` +
                                                           `┃ ⋄ .antistatus - Anti-status share\n` +
                                                           `┃ ⋄ .addcmd - Add custom command (Owner)\n` +
                                                           `┃ ⋄ .delcmd - Delete custom command (Owner)\n` +
                                                           `┃ ⋄ .listcmd - List custom commands\n` +
                                                           `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                                                        
`╔══❰📥ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇɴᴜ❱══╗\n` +
`║ ─ ғᴀᴄᴇʙᴏᴏᴋ\n` +
`║ ─ ᴍᴇᴅɪᴀғɪʀᴇ\n` +
`║ ─ ᴛɪᴋᴛᴏᴋ\n` +
`║ ─ ᴛᴡɪᴛᴛᴇʀ\n` +
`║ ─ ɪɴsᴛᴀ\n` +
`║ ─ ᴀᴘᴋ\n` +
`║ ─ ɪᴍɢ\n` +
`║ ─ ᴛᴛ2\n` +
`║ ─ ᴘɪɴs\n` +
`║ ─ ᴀᴘᴋ2\n` +
`║ ─ ғʙ2\n` +
`║ ─ ᴘɪɴᴛᴇʀᴇsᴛ\n` +
`║ ─ sᴘᴏᴛɪғʏ\n` +
`║ ─ ᴘʟᴀʏ\n` +
`║ ─ ᴘʟᴀʏ2\n` +
`║ ─ ᴀᴜᴅɪᴏ\n` +
`║ ─ ᴠɪᴅᴇᴏ\n` +
`║ ─ ᴠɪᴅᴇᴏ2\n` +
`║ ─ ʏᴛᴍᴘ3\n` +
`║ ─ ʏᴛᴍᴘ4\n` +
`║ ─ sᴏɴɢ\n` +
`║ ─ ᴅᴀʀᴀᴍᴀ\n` +
`║ ─ ɢᴅʀɪᴠᴇ\n` +
`║ ─ ssᴡᴇʙ\n` +
`║ ─ ᴀɪᴀʀᴛ\n` +
`║ ─ ᴛɪᴋs\n` +
`║ ─ sᴘʟᴀʏ\n` +
`║ ─ sᴘᴏᴛɪғʏᴘʟᴀʏ\n` +
`╚══════════════════╝\n` +

`╔══❰ 👥 ɢʀᴏᴜᴘ ᴍᴇɴᴜ ❱══╗\n` +
`║ ─ ɢʀᴏᴜᴘʟɪɴᴋ\n` +
`║ ─ ᴋɪᴄᴋᴀʟʟ\n` +
`║ ─ ᴋɪᴄᴋᴀʟʟ2\n` +
`║ ─ ᴋɪᴄᴋᴀʟʟ3\n` +
`║ ─ ᴀᴅᴅ\n` +
`║ ─ ʀᴇᴍᴏᴠᴇ\n` +
`║ ─ ᴋɪᴄᴋ\n` +
`║ ─ ᴘʀᴏᴍᴏᴛᴇ\n` +
`║ ─ ᴅᴇᴍᴏᴛᴇ\n` +
`║ ─ ᴅɪsᴍɪss\n` +
`║ ─ ʀᴇᴠᴏᴋᴇ\n` +
`║ ─ sᴇᴛɢᴏᴏᴅʙʏᴇ\n` +
`║ ─ sᴇᴛᴡᴇʟᴄᴏᴍᴇ\n` +
`║ ─ ᴅᴇʟᴇᴛᴇ\n` +
`║ ─ ɢᴇᴛᴘɪᴄ\n` +
`║ ─ ɢɪɴғᴏ\n` +
`║ ─ ᴅɪsᴀᴘᴘᴇᴀʀ ᴏɴ\n` +
`║ ─ ᴅɪsᴀᴘᴘᴇᴀʀ ᴏғғ\n` +
`║ ─ ᴅɪsᴀᴘᴘᴇᴀʀ 7ᴅ,24ʜ\n` +
`║ ─ ᴀʟʟʀᴇǫ\n` +
`║ ─ ᴜᴘᴅᴀᴛᴇɢɴᴀᴍᴇ\n` +
`║ ─ ᴜᴘᴅᴀᴛᴇɢᴅᴇsᴄ\n` +
`║ ─ ᴊᴏɪɴʀᴇǫᴜᴇsᴛs\n` +
`║ ─ sᴇɴᴅᴅᴍ\n` +
`║ ─ ɴɪᴋᴀʟ\n` +
`║ ─ ᴍᴜᴛᴇ\n` +
`║ ─ ᴜɴᴍᴜᴛᴇ\n` +
`║ ─ ʟᴏᴄᴋɢᴄ\n` +
`║ ─ ᴜɴʟᴏᴄᴋɢᴄ\n` +
`║ ─ ɪɴᴠɪᴛᴇ\n` +
`║ ─ ᴛᴀɢ\n` +
`║ ─ ʜɪᴅᴇᴛᴀɢ\n` +
`║ ─ ᴛᴀɢᴀʟʟ\n` +
`║ ─ ᴛᴀɢᴀᴅᴍɪɴs\n` +
`║ ─ ᵃᵘᵗᵒᵃᵖᵖʳᵒᵛᵉ\n` +
`╚══════════════════╝\n` +

`╔══❰💞ʀᴇᴀᴄᴛɪᴏɴs ᴍᴇɴᴜ❱══╗\n` +
`║ ─ ʙᴜʟʟʏ @ᴛᴀɢ\n` +
`║ ─ ᴄᴜᴅᴅʟᴇ @ᴛᴀɢ\n` +
`║ ─ ᴄʀʏ @ᴛᴀɢ\n` +
`║ ─ ʜᴜɢ @ᴛᴀɢ\n` +
`║ ─ ᴀᴡᴏᴏ @ᴛᴀɢ\n` +
`║ ─ ᴋɪss @ᴛᴀɢ\n` +
`║ ─ ʟɪᴄᴋ @ᴛᴀɢ\n` +
`║ ─ ᴘᴀᴛ @ᴛᴀɢ\n` +
`║ ─ sᴍᴜɢ @ᴛᴀɢ\n` +
`║ ─ ʙᴏɴᴋ @ᴛᴀɢ\n` +
`║ ─ ʏᴇᴇᴛ @ᴛᴀɢ\n` +
`║ ─ ʙʟᴜsʜ @ᴛᴀɢ\n` +
`║ ─ sᴍɪʟᴇ @ᴛᴀɢ\n` +
`║ ─ ᴡᴀᴠᴇ @ᴛᴀɢ\n` +
`║ ─ ʜɪɢʜғɪᴠᴇ @ᴛᴀɢ\n` +
`║ ─ ʜᴀɴᴅʜᴏʟᴅ @ᴛᴀɢ\n` +
`║ ─ ɴᴏᴍ @ᴛᴀɢ\n` +
`║ ─ ʙɪᴛᴇ @ᴛᴀɢ\n` +
`║ ─ ɢʟᴏᴍᴘ @ᴛᴀɢ\n` +
`║ ─ sʟᴀᴘ @ᴛᴀɢ\n` +
`║ ─ ᴋɪʟʟ @ᴛᴀɢ\n` +
`║ ─ ʜᴀᴘᴘʏ @ᴛᴀɢ\n` +
`║ ─ ᴡɪɴᴋ @ᴛᴀɢ\n` +
`║ ─ ᴘᴏᴋᴇ @ᴛᴀɢ\n` +
`║ ─ ᴅᴀɴᴄᴇ @ᴛᴀɢ\n` +
`║ ─ ᴄʀɪɴɢᴇ @ᴛᴀɢ\n` +
`╚══════════════════╝\n` +

`╔══❰ 🎨 ʟᴏɢᴏ ᴍᴇɴᴜ ❱═══╗\n` +
`║ ─ ɴᴇᴏɴʟɪɢʜᴛ\n` +
`║ ─ ᴘʀᴏғɪʟᴇᴄᴀʀᴅ\n` +
`║ ─ ʙʟᴀᴄᴋᴘɪɴᴋ\n` +
`║ ─ ᴅʀᴀɢᴏɴʙᴀʟʟ\n` +
`║ ─ 3ᴅᴄᴏᴍɪᴄ\n` +
`║ ─ ᴀᴍᴇʀɪᴄᴀ\n` +
`║ ─ ɴᴀʀᴜᴛᴏ\n` +
`║ ─ sᴀᴅɢɪʀʟ\n` +
`║ ─ ᴄʟᴏᴜᴅs\n` +
`║ ─ ғᴜᴛᴜʀɪsᴛɪᴄ\n` +
`║ ─ 3ᴅᴘᴀᴘᴇʀ\n` +
`║ ─ ᴇʀᴀsᴇʀ\n` +
`║ ─ sᴜɴsᴇᴛ\n` +
`║ ─ ʟᴇᴀғ\n` +
`║ ─ ɢᴀʟᴀxʏ\n` +
`║ ─ sᴀɴs\n` +
`║ ─ ʙᴏᴏᴍ\n` +
`║ ─ ʜᴀᴄᴋᴇʀ\n` +
`║ ─ ᴅᴇᴠɪʟᴡɪɴɢs\n` +
`║ ─ ɴɪɢᴇʀɪᴀ\n` +
`║ ─ ʙᴜʟʙ\n` +
`║ ─ ᴀɴɢᴇʟᴡɪɴɢs\n` +
`║ ─ ᴢᴏᴅɪᴀᴄ\n` +
`║ ─ ʟᴜxᴜʀʏ\n` +
`║ ─ ᴘᴀɪɴᴛ\n` +
`║ ─ ғʀᴏᴢᴇɴ\n` +
`║ ─ ᴄᴀsᴛʟᴇ\n` +
`║ ─ ᴛᴀᴛᴏᴏ\n` +
`║ ─ ᴠᴀʟᴏʀᴀɴᴛ\n` +
`║ ─ ʙᴇᴀʀ\n` +
`║ ─ ᴛʏᴘᴏɢʀᴀᴘʜʏ\n` +
`║ ─ ʙɪʀᴛʜᴅᴀʏ\n` +
`╚══════════════════╝\n` +

`╔══❰ 👑 ᴏᴡɴᴇʀ ᴍᴇɴᴜ ❱══╗\n` +
`║ ─ ᴏᴡɴᴇʀ\n` +
`║ ─ ᴍᴇɴᴜ\n` +
`║ ─ ᴍᴇɴᴜ2\n` +
`║ ─ ᴠᴠ\n` +
`║ ─ ʙɪᴏ\n` +
`║ ─ ʟɪsᴛᴄᴍᴅ\n` +
`║ ─ ᴀʟʟᴍᴇɴᴜ\n` +
`║ ─ ʀᴇᴘᴏ\n` +
`║ ─ ʙʟᴏᴄᴋ\n` +
`║ ─ ᴜɴʙʟᴏᴄᴋ\n` +
`║ ─ ғᴜʟʟᴘᴘ\n` +
`║ ─ sᴇᴛᴘᴘ\n` +
`║ ─ ʀᴇsᴛᴀʀᴛ\n` +
`║ ─ sʜᴜᴛᴅᴏᴡɴ\n` +
`║ ─ ᴜᴘᴅᴀᴛᴇᴄᴍᴅ\n` +
`║ ─ ᴀʟɪᴠᴇ\n` +
`║ ─ ᴘɪɴɢ\n` +
`║ ─ ɢᴊɪᴅ\n` +
`║ ─ ᴊɪᴅ\n` +
`║ ─ ᴄᴜʀʀᴇɴᴄʏ\n` +
`║ ─ ᴄᴏᴜɴᴛʀʏ\n` +
`║ ─ ғᴀᴋᴇᴄʜᴀᴛ\n` +
`║ ─ 𝚒𝚙𝚑𝚘𝚗𝚎𝚌𝚑𝚊𝚝\n` +
`║ ─ ʷᵉˡᶜᵒᵐᵉⁱᵐᵍ\n` +
`║ ─ ʸᵗᶜᵒᵐᵐᵉⁿᵗ\n` +
`╚══════════════════╝\n` +

`╔═══❰ 😄 ғᴜɴ ᴍᴇɴᴜ ❱═══╗\n` +
`║ ─ sʜᴀᴘᴀʀ\n` +
`║ ─ ʀᴀᴛᴇ\n` +
`║ ─ ɪɴsᴜʟᴛ\n` +
`║ ─ ʜᴀᴄᴋ\n` +
`║ ─ sʜɪᴘ\n` +
`║ ─ ᴄʜᴀʀᴀᴄᴛᴇʀ\n` +
`║ ─ ᴘɪᴄᴋᴜᴘ\n` +
`║ ─ ᴊᴏᴋKE\n` +
`║ ─ ʜʀᴛ\n` +
`║ ─ ʜᴘʏ\n` +
`║ ─ sʏᴅ\n` +
`║ ─ ᴀɴɢᴇʀ\n` +
`║ ─ sʜʏ\n` +
`║ ─ ᴋɪss\n` +
`║ ─ ᴍᴏɴ\n` +
`║ ─ ᴄᴜɴғᴜᴢᴇᴅ\n` +
`║ ─ sᴇᴛᴘᴘ\n` +
`║ ─ ʜᴀɴᴅ\n` +
`║ ─ ɴɪᴋᴀʟ\n` +
`║ ─ ʜᴏʟᴅ\n` +
`║ ─ ʜᴜɢ\n` +
`║ ─ ʜɪғɪ\n` +
`║ ─ ᴘᴏᴋᴇ\n` +
`║ ─ ʀᴏsᴇᴅᴀʏ\n` +
`╚══════════════════╝\n` +

`╔══❰ 🔄 ᴄᴏɴᴠᴇʀᴛ ᴍᴇɴᴜ❱══╗\n` +
`║ ─ sᴛɪᴄᴋᴇʀ\n` +
`║ ─ sᴛɪᴄᴋᴇʀ2\n` +
`║ ─ ᴇᴍᴏᴊɪᴍɪx\n` +
`║ ─ ғᴀɴᴄʏ\n` +
`║ ─ ᴛᴀᴋᴇ\n` +
`║ ─ ᴛᴏᴍᴘ3\n` +
`║ ─ ᴛ ... \n` +
`║ ─ ᴛʀᴛ\n` +
`║ ─ ʙᴀsᴇ64\n` +
`║ ─ ᴜɴʙᴀsᴇ64\n` +
`║ ─ ʙɪɴᴀʀʏ\n` +
`║ ─ ᴅʙɪɴᴀʀʏ\n` +
`║ ─ ᴛɪɴʏᴜʀʟ\n` +
`║ ─ ᴜʀʟᴅᴇᴄᴏᴅᴇ\n` +
`║ ─ ᴜʀʟᴇɴᴄᴏᴅᴇ\n` +
`║ ─ ᴜʀʟ\n` +
`║ ─ ʀᴇᴘᴇᴀᴛ\n` +
`║ ─ ᴀsᴋ\n` +
`║ ─ ʀᴇᴀᴅᴍᴏʀᴇ\n` +
`║ ─ ᴄᴏʟᴏʀɪᴢᴇ\n` +
`╚══════════════════╝\n` +

`╔════❰ 🤖 ᴀɪ ᴍᴇɴᴜ ❱═══╗\n` +
`║ ─ ᴀɪ\n` +
`║ ─ ɢᴘᴛ3\n` +
`║ ─ ɢᴘᴛ2\n` +
`║ ─ ɢᴘᴛᴍɪɴɪ\n` +
`║ ─ ɢᴘᴛ\n` +
`║ ─ ᴍᴇᴛᴀ\n` +
`║ ─ ʙʟᴀᴄᴋʙᴏx\n` +
`║ ─ ʟᴜᴍᴀ\n` +
`║ ─ ᴅᴊ\n` +
`║ ─ ᴅᴇᴇᴘsᴇᴇᴋ\n` +
`║ ─ ISHAQ\n` +
`║ ─ ɢᴘᴛ4\n` +
`║ ─ ʙɪɴɢ\n` +
`║ ─ ɪᴍᴀɢɪɴᴇ\n` +
`║ ─ ɪᴍᴀɢɪɴᴇ2\n` +
`║ ─ ᴄᴏᴘɪʟᴏᴛ\n` +
`║ ─ ʙᴀʀᴅ\n` +
`║ ─ ғᴇʟᴏ\n` +
`║ ─ ɢɪᴛᴀ\n` +
`╚══════════════════╝\n` +

`╔═══❰ 🏠 ᴍᴀɪɴ ᴍᴇɴᴜ❱═══╗\n` +
`║ ─ ᴘɪɴɢ\n` +
`║ ─ ᴘɪɴɢ2\n` +
`║ ─ sᴘᴇᴇᴅ\n` +
`║ ─ ʟɪᴠᴇ\n` +
`║ ─ ᴀʟɪᴠᴇ\n` +
`║ ─ ʀᴜɴᴛɪᴍᴇ\n` +
`║ ─ ᴜᴘᴛɪᴍᴇ\n` +
`║ ─ ʀᴇᴘᴏ\n` +
`║ ─ ᴏᴡɴᴇʀ\n` +
`║ ─ ᴍᴇɴᴜ\n` +
`║ ─ ᴍᴇɴᴜ2\n` +
`║ ─ ʀᴇsᴛᴀʀᴛ\n` +
`╚══════════════════╝\n` +

`╔══❰ 🎎 ᴀɴɪᴍᴇ ᴍᴇɴᴜ ❱══╗\n` +
`║ ─ ғᴀᴄᴋ\n` +
`║ ─ ᴛʀᴜᴛʜ\n` +
`║ ─ ᴅᴀʀᴇ\n` +
`║ ─ ᴅᴏɢ\n` +
`║ ─ ᴀᴡᴏᴏ\n` +
`║ ─ ɢᴀʀʟ\n` +
`║ ─ ᴡᴀɪғᴜ\n` +
`║ ─ ɴᴇᴋᴏ\n` +
`║ ─ ᴍᴇɢɴᴜᴍɪɴ\n` +
`║ ─ ᴍᴀɪᴅ\n` +
`║ ─ ʟᴏʟɪ\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ1\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ2\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ3\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ4\n` +
`║ ─ ᴀɴɪᴍᴇɢɪʀʟ5\n` +
`║ ─ ᴀɴɪᴍᴇ1\n` +
`║ ─ ᴀɴɪᴍᴇ2\n` +
`║ ─ ᴀɴɪᴍᴇ3\n` +
`║ ─ ᴀɴɪᴍᴇ4\n` +
`║ ─ ᴀɴɪᴍᴇ5\n` +
`║ ─ ᴀɴɪᴍᴇɴᴇᴡs\n` +
`║ ─ ғᴏxɢɪʀʟ\n` +
`║ ─ ɴᴀʀᴜᴛᴏ\n` +
`╚══════════════════╝\n` +

`╔══❰ 📌 ᴏᴛʜᴇʀ ᴍᴇɴᴜ ❱══╗\n` +
`║ ─ ᴛɪᴍᴇɴᴏᴡ\n` +
`║ ─ ᴅᴀᴛᴇ\n` +
`║ ─ ᴄᴏᴜɴᴛ\n` +
`║ ─ ᴄᴀʟᴄᴜʟᴀᴛᴇ\n` +
`║ ─ ᴄᴏᴜɴᴛx\n` +
`║ ─ ғʟɪᴘ\n` +
`║ ─ ᴄᴏɪɴғʟɪᴘ\n` +
`║ ─ ʀᴄᴏʟᴏʀ\n` +
`║ ─ ʀᴏʟʟ\n` +
`║ ─ ғᴀᴄᴛ\n` +
`║ ─ ᴄᴘᴘ\n` +
`║ ─ ʀᴡ\n` +
`║ ─ ᴘᴀɪʀ\n` +
`║ ─ ᴘᴀɪʀ2\n` +
`║ ─ ᴘᴀɪʀ3\n` +
`║ ─ ғᴀɴᴄʏ\n` +
`║ ─ ʟᴏɢᴏ [ᴛᴇxᴛ]\n` +
`║ ─ ᴅᴇғɪɴᴇ\n` +
`║ ─ ɴᴇᴡs\n` +
`║ ─ ᴍᴏᴠɪᴇ\n` +
`║ ─ ᴡᴇᴀᴛʜᴇʀ\n` +
`║ ─ sʀᴇᴘᴏ\n` +
`║ ─ ɪɴsᴜʟᴛ\n` +
`║ ─ sᴀᴠᴇ\n` +
`║ ─ ᴡɪᴋɪᴘᴇᴅɪᴀ\n` +
`║ ─ ɢᴘᴀss\n` +
`║ ─ ɢɪᴛʜᴜʙsᴛᴀʟᴋ\n` +
`║ ─ ʏᴛs\n` +
`║ ─ ʏᴛᴠ\n` +
`║ ─ ᴡᴀᴛᴇʀᴍᴀʀᴋ\n` +
`║ ─ ᶠᵒʳʷᵃʳᵈ\n` +
`║ ─ ᶠᵒʳʷᵃʳᵈᵃˡˡ\n` +
`║ ─ ᶠᵒʳʷᵃʳᵈᵍʳᵒᵘᵖ\n` +
`║ ─ sᴀᴠᴇ\n` +
`╚══════════════════╝\n` +
`> *Powered by 𝗜𝗦𝗛𝗔𝗤-𝑀𝐷-𝘮𝘪𝘯𝘪*`;

                                            try {
                                                await this.sock.sendMessage(from, { image: { url: 'https://files.catbox.moe/cikirz.png' }, caption: menuText });
                                            } catch (e) { 
                                                await this.sock.sendMessage(from, { text: menuText }); 
                                            }
                                            break;
                                      
                                            
     case 'addishaq':
    await commands.addcmd(this.sock, from, msg);
    break;
case 'delishaq':
    await commands.delcmd(this.sock, from, msg);
    break;                                 
                                        case 'listcmd':
                                            await commands.listcmd(this.sock, from, msg);
                                            break;
                                        case 'pair':
                                            await commands.pair(this.sock, from, msg);
                                            break;

                                        // Existing commands
                                        case 'ping': await commands.ping(this.sock, from, msg); break;
                                        case 'owner': await commands.owner(this.sock, from, msg); break;
                                        case 'ai': await commands.ai(this.sock, from, msg, isAdmin, this, args); break;
                                        case 'antilink': await commands.antilink(this.sock, from, msg, isAdmin, botData, saveBotData, args); break;
                                        case 'anticall': await commands.anticall(this.sock, from, msg, isAdmin, botData, saveBotData, this.userId, args); break;
                                        case 'antidelete': await commands.antidelete(this.sock, from, msg, isAdmin, botData, saveBotData, this.userId, args); break;
                                        case 'status': case 'autostatus': await commands.autostatus(this.sock, from, msg, isAdmin, botData, saveBotData, this.userId, args); break;
                                        case 'autoreacts': await commands.autoreacts(this.sock, from, msg, isAdmin, this, args); break;
                                        case 'kick': await commands.kick(this.sock, from, msg, isAdmin); break;
                                        case 'private': await commands.private(this.sock, from, msg, isAdmin, this); if (!botData.statusSettings[this.userId]) botData.statusSettings[this.userId] = {}; botData.statusSettings[this.userId].isPublic = false; saveBotData(); break;
                                        case 'public': await commands.public(this.sock, from, msg, isAdmin, this); if (!botData.statusSettings[this.userId]) botData.statusSettings[this.userId] = {}; botData.statusSettings[this.userId].isPublic = true; saveBotData(); break;
                                        case 'hidetag': await commands.hidetag(this.sock, from, msg, isAdmin, q); break;
                                        case 'tagall': await commands.tagall(this.sock, from, msg, isAdmin, q); break;
                                        case 'setname': await commands.setname(this.sock, from, msg, isAdmin, botData, saveBotData, this.userId, q); break;
                                        case 'insta': case 'ig': await commands.insta(this.sock, from, msg, q); break;
                                        case 'tiktok': await commands.tiktok(this.sock, from, msg, q); break;
                                        case 'song': await commands.song(this.sock, from, msg); break;
                                        case 'video': await commands.video(this.sock, from, msg); break;
                                        case 'joke': await commands.joke(this.sock, from, msg); break;
                                        case 'meme': await commands.meme(this.sock, from, msg); break;
                                        case 'vv': await commands.vv(this.sock, from, msg); break;
                                        case 'dp': await commands.dp(this.sock, from, msg); break;
                                        case 'groupinfo': await commands.groupinfo(this.sock, from, msg); break;
                                        case 'kickoffline': await commands.kickoffline(this.sock, from, msg, isAdmin, botData, saveBotData, args); break;
                                        case 'antistatus': await commands.antistatus(this.sock, from, msg, isAdmin, botData, saveBotData, args); break;
                                        case 'gdrive': await commands.gdrive(this.sock, from, msg, q); break;
                                        case 'mf': await commands.mf(this.sock, from, msg, q); break;
                                        case 'translate': case 'trt': await commands.translate(this.sock, from, msg); break;
                                        case 'apk': await commands.apk(this.sock, from, msg); break;
                                        case 'autoread': await commands.autoread(this.sock, from, msg); break;
                                        case 'character': await commands.character(this.sock, from, msg); break;
                                        case 'emojimix': await commands.emojimix(this.sock, from, msg); break;
                                        case 'facebook': case 'fb': await commands.facebook(this.sock, from, msg); break;
                                        case 'hack': await commands.hack(this.sock, from, msg); break;
                                        case 'accept': await commands.accept(this.sock, from, msg, isAdmin); break;
                                    }
                                } catch (e) { this.sendLog(`Command error (${commandName}): ` + e.message, 'error'); }
                            })();
                        }
                    } catch (e) { console.error('Message Error:', e); }
                }));
            });

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    const socketId = userSockets[this.userId];
                    if (socketId) io.to(socketId).emit('qr', qr);
                }
                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    this.isConnected = false;
                    this.isInitializing = false;
                    this.sendLog(`Connection closed. Reconnecting: ${shouldReconnect}`, 'warning');
                    this.sendConnectionStatus();
                    const statusCode = (lastDisconnect.error)?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        this.sendLog('Session expired.', 'error');
                        try {
                            if (fs.existsSync(this.authPath)) {
                                const backupPath = `${this.authPath}_backup_${Date.now()}`;
                                fs.moveSync(this.authPath, backupPath);
                                this.sendLog(`Backed up to ${backupPath}`, 'info');
                            }
                        } catch (e) { if (fs.existsSync(this.authPath)) fs.removeSync(this.authPath); }
                        delete sessions[this.userId];
                        this.sendConnectionStatus();
                    } else if (statusCode === DisconnectReason.restartRequired || statusCode === DisconnectReason.connectionLost || statusCode === 428) {
                        this.sendLog(`Connection issue (${statusCode}). Restarting in 3s...`, 'warning');
                        setTimeout(() => this.initialize(), 3000);
                    } else if (statusCode === 515) {
                        this.sendLog('Stream error. Reconnecting...', 'warning');
                        this.initialize();
                    } else {
                        this.sendLog(`Connection closed (${statusCode}). Reconnecting in 5s...`, 'info');
                        setTimeout(() => this.initialize(), 5000);
                    }
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.isInitializing = false;
                    this.sendLog('Connected! ✅', 'success');
                    updateSessionRegistry(this.userId, { pushName: this.pushName || this.userId, connectedAt: new Date().toISOString() });
                    this.sendConnectionStatus();
                    this.startActiveCheck();
                    const botName = botData.userNames[this.userId] || (this.sock.user && this.sock.user.name) || this.userId;
                    if (this.tgChatId) await tgBot.sendMessage(this.tgChatId, "✅ Bot connected!");
                    this.sendLog(`Bot ${botName} is online.`, 'success');
                    setTimeout(async () => {
                        try {
                            await this.sock.query({ tag: 'iq', attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'status' }, content: [{ tag: 'status', attrs: {}, content: Buffer.from("𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶", 'utf-8') }] });
                            this.sendLog("Bio updated! ✅", "success");
                        } catch (e) { this.sendLog("Bio update failed: " + e.message, "error"); }
                    }, 5000);
                    const botNumber = jidNormalizedUser(this.sock.user.id);
                    if (!this.lastConnectMessageTime || (Date.now() - this.lastConnectMessageTime > 60 * 60 * 1000)) {
                        await this.sock.sendMessage(botNumber, { text: "Bot connected ✅\n\nType .menu to see commands." });
                        this.lastConnectMessageTime = Date.now();
                    }
                }
            });
        } catch (err) {
            this.isInitializing = false;
            this.sendLog(`Init failed: ${err.message}. Retrying in 10s...`, 'error');
            setTimeout(() => this.initialize(), 10000);
        }
    }
}

// ================================================================
// SOCKET.IO EVENTS
// ================================================================
io.on('connection', (socket) => {
    console.log(`[🔌] Client connected: ${socket.id}`);
    io.emit('stats-update', { sessions: Object.keys(sessions).length, connected: Object.values(sessions).filter(s => s.isConnected).length });
    socket.on('set-user', (userId) => {
        userSockets[userId] = socket.id;
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        sessions[userId].sendConnectionStatus();
    });
    socket.on('pair-request', async ({ userId, number }) => {
        if (sessions[userId]) {
            if (!botData.statusSettings[userId]) {
                botData.statusSettings[userId] = { autoStatus: false, autoSeen: false, autoLike: false, autoDownload: false, isPublic: false };
                saveBotData();
            }
            await sessions[userId].initialize(number);
        }
    });
    socket.on('logout', async (userId) => {
        if (sessions[userId]) {
            if (sessions[userId].sock) { try { await sessions[userId].sock.logout(); } catch (e) {} }
            const authPath = path.join(AUTH_DIR, userId);
            if (fs.existsSync(authPath)) fs.removeSync(authPath);
            delete sessions[userId];
            io.emit('total-active', Object.values(sessions).filter(s => s.isConnected).length);
            const socketId = userSockets[userId];
            if (socketId) io.to(socketId).emit('connection-status', { connected: false, user: userId });
        }
    });
    socket.on('disconnect', () => {
        console.log(`[🔌] Client disconnected: ${socket.id}`);
        for (const userId in userSockets) {
            if (userSockets[userId] === socket.id) { delete userSockets[userId]; break; }
        }
    });
});

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 22495;
server.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║      𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶  BOT  ACTIVE          ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  🌐 Server:     http://localhost:${PORT}       ║`);
    console.log(`║  🔐 Admin:      http://localhost:${PORT}/admin-panel ║`);
    console.log(`║  📱 Pair:       http://localhost:${PORT}/           ║`);
    console.log(`║  🔌 Socket.IO:  ACTIVE                         ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
    loadExistingSessions();
    const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
    if (APP_URL) {
        setInterval(async () => {
            try { await axios.get(APP_URL); console.log("[⚡] Anti-Sleep Ping: Active."); } catch (e) { console.log("[⚡] Ping: " + e.message); }
        }, 5 * 60 * 1000);
    }
});