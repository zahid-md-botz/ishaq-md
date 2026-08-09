const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

async function handleStatusUpdate(sock, m, botData, userId) {
    try {
        // Ensure settings exist and autoStatus is enabled
        const settings = botData.statusSettings[userId];
        if (!settings || !settings.autoStatus) return;

        const ownerJid = jidNormalizedUser(sock.user.id);

        for (const msg of m.messages) {
            // Ensure message is a status update
            if (msg.key && (msg.key.remoteJid === 'status@broadcast' || msg.broadcast)) {
                const participant = msg.key.participant || msg.participant;
                if (!participant) continue;
                
                // 1. Auto Seen
                if (settings.autoSeen) {
                    await sock.readMessages([msg.key]);
                }

                // 2. Auto Like (Reaction)
                if (settings.autoLike) {
                    const emojis = ['❤️', '🔥', '✨', '✅', '🙌', '🌟'];
                    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                    
                    try {
                        await sock.relayMessage('status@broadcast', {
                            reactionMessage: {
                                key: {
                                    remoteJid: 'status@broadcast',
                                    id: msg.key.id,
                                    participant: participant,
                                    fromMe: false
                                },
                                text: emoji
                            }
                        }, { 
                            messageId: msg.key.id, 
                            statusJidList: [participant] 
                        });
                    } catch (e) {
                        console.error('Status Like Error:', e.message);
                    }
                }

                // 3. Auto Download (Send to owner DM)
                if (settings.autoDownload) {
                    // Improved message content detection
                    const messageContent = msg.message?.ephemeralMessage?.message || 
                                         msg.message?.viewOnceMessage?.message || 
                                         msg.message?.viewOnceMessageV2?.message || 
                                         msg.message?.viewOnceMessageV2Extension?.message ||
                                         msg.message;
                    
                    // Special handling for potential first-status sync issues or protocol variations
                    if (!messageContent && msg.messageStubType) {
                        console.log(`[Status] Received stub message type ${msg.messageStubType}, skipping media download.`);
                        continue;
                    }
                    
                    if (!messageContent) continue;

                    const type = Object.keys(messageContent).find(k => k.endsWith('Message')) || (messageContent.conversation ? 'conversation' : null);
                    if (!type) continue;

                    const pushName = msg.pushName || 'Unknown';
                    const senderNumber = participant.split('@')[0];

                    if (type === 'imageMessage' || type === 'videoMessage') {
                        try {
                            const mContent = messageContent[type];
                            if (mContent) {
                                const stream = await downloadContentFromMessage(mContent, type.replace('Message', ''));
                                let buffer = Buffer.from([]);
                                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                                
                                const caption = `📥 *Status Downloaded*\n👤 *From:* ${pushName}\n📱 *Number:* ${senderNumber}\n💬 *Caption:* ${mContent.caption || 'No caption'}`;
                                
                                if (type === 'imageMessage') {
                                    await sock.sendMessage(ownerJid, { image: buffer, caption });
                                } else {
                                    await sock.sendMessage(ownerJid, { video: buffer, caption });
                                }
                            }
                        } catch (e) {
                            console.error('Status Media Download Error:', e.message);
                        }
                    } else if (type === 'conversation' || type === 'extendedTextMessage') {
                        const text = messageContent.conversation || messageContent.extendedTextMessage?.text;
                        if (text) {
                            const caption = `📥 *Status Text Downloaded*\n👤 *From:* ${pushName}\n📱 *Number:* ${senderNumber}\n\n*Content:* ${text}`;
                            await sock.sendMessage(ownerJid, { text: caption });
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in handleStatusUpdate:', error);
    }
}

module.exports = { handleStatusUpdate };
