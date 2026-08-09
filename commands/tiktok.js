const axios = require('axios');

async function tiktokCommand(sock, from, msg, q) {
    if (!q) return await sock.sendMessage(from, { text: "❌ Please provide a TikTok URL." }, { quoted: msg });
    
    try {
        const loadEmojis = ['📥', '⏳', '📱'];
        for (const emoji of loadEmojis) {
            await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
        }
        const res = await axios.get(`https://tikwm.com/api/?url=${q}`);
        const videoUrl = res.data.data.play;
        await sock.sendMessage(from, { video: { url: videoUrl }, caption: "✅ TIKTOK DOWNLOADED 𝗜𝗦𝗛𝗔𝗤-𝑀𝐷-𝘮𝘪𝘯𝘪" }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(from, { text: "❌ Error downloading TikTok." }, { quoted: msg });
    }
}

module.exports = tiktokCommand;
