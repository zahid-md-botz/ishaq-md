const { default: makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const P = require('pino');

async function pairCommand(sock, from, msg) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const args = text.split(' ').slice(1);
    const number = args[0];

    if (!number) {
        await sock.sendMessage(from, { 
            text: '❌ *Usage:* .pair <number>\n\n*Example:* .pair 923001234567\n\n_Enter this number in your WhatsApp to get pairing code._' 
        });
        return;
    }

    // Clean number
    const cleanNum = number.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) {
        await sock.sendMessage(from, { 
            text: '❌ Invalid number. Include country code.\n\n*Example:* 923001234567' 
        });
        return;
    }

    // Send processing message
    await sock.sendMessage(from, { 
        text: `⏳ *Generating pairing code for +${cleanNum}...*\n\nPlease wait...` 
    });

    try {
        // Create temporary session for pairing
        const tempDir = path.join(__dirname, '../temp_pair', cleanNum);
        fs.ensureDirSync(tempDir);

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);

        const tempSock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: state.keys
            },
            logger: P({ level: 'fatal' }),
            browser: Browsers.windows('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 30000,
            connectTimeoutMs: 30000,
        });

        // Request pairing code
        let pairCode = null;
        let pairingDone = false;

        tempSock.ev.on('creds.update', saveCreds);

        // Wait for pairing code
        const codePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Pairing request timeout. Please try again.'));
            }, 30000);

            tempSock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'open') {
                    clearTimeout(timeout);
                    try {
                        // Get the code
                        const code = await tempSock.requestPairingCode(cleanNum);
                        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                        pairCode = formattedCode;
                        pairingDone = true;
                        resolve(formattedCode);
                    } catch (err) {
                        reject(new Error('Failed to get pairing code: ' + err.message));
                    }
                }

                if (connection === 'close') {
                    clearTimeout(timeout);
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === 401 || code === 403) {
                        reject(new Error('Session expired. Please try again.'));
                    } else if (!pairingDone) {
                        reject(new Error('Connection closed. Please try again.'));
                    }
                }
            });
        });

        const code = await codePromise;

        // Clean up temp session
        try {
            fs.removeSync(tempDir);
        } catch (e) {}

        // Send code to user
        await sock.sendMessage(from, { 
            text: `🔑 *PAIRING CODE GENERATED!*\n\n` +
                  `📱 *Number:* +${cleanNum}\n` +
                  `🔐 *Code:* \`${code}\`\n\n` +
                  `📝 *Instructions:*\n` +
                  `1️⃣ Open WhatsApp on +${cleanNum}\n` +
                  `2️⃣ Go to Settings → Linked Devices\n` +
                  `3️⃣ Tap "Link a Device"\n` +
                  `4️⃣ Enter this code: *${code}*\n\n` +
                  `⏰ *Code expires in 5 minutes*\n` +
                  `⚡ *Powered by 𝗜𝗦𝗛𝗔𝗤-𝗠𝗗-𝗺𝗶𝗻𝗶*`
        });

    } catch (error) {
        console.error('[Pair] Error:', error.message);
        
        // Clean up temp files
        try {
            const tempDir = path.join(__dirname, '../temp_pair', cleanNum);
            if (fs.existsSync(tempDir)) fs.removeSync(tempDir);
        } catch (e) {}

        await sock.sendMessage(from, { 
            text: `❌ *Pairing Failed*\n\n` +
                  `Error: ${error.message}\n\n` +
                  `*Possible reasons:*\n` +
                  `• Number is already linked to another device\n` +
                  `• Invalid phone number format\n` +
                  `• WhatsApp server issue\n\n` +
                  `*Try:* .pair 923001234567` 
        });
    }
}

module.exports = pairCommand;