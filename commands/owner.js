const settings = require('../settings');

async function ownerCommand(sock, from, msg) {
    const ownerText = `👤 *BOT OWNER:* ${settings.ownerName}\n` +
                    `📱 *NUMBER:* +${settings.ownerNumber}\n` +
                    `🔗 *OFFICIAL WHATSAPP CHANNEL:*\n` +
                    `> *رنگیـﹻﹻـن دنیـﹻﹻﹻـا، کالـﹻـے دل، سستـﹻﹻـے شـﹻﹻـوق، حـﹻـرامی لـﹻﹻـوگ🔱*`;
    await sock.sendMessage(from, { text: ownerText }, { quoted: msg });
}

module.exports = ownerCommand;
