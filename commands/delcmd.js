const fs = require('fs-extra');
const path = require('path');

const CUSTOM_COMMANDS_FILE = path.join(__dirname, '../data/custom_commands.json');

function loadCustomCommands() {
    try {
        if (fs.existsSync(CUSTOM_COMMANDS_FILE)) {
            return fs.readJsonSync(CUSTOM_COMMANDS_FILE);
        }
    } catch (e) {}
    return {};
}

function saveCustomCommands(commands) {
    fs.writeJsonSync(CUSTOM_COMMANDS_FILE, commands);
}

async function delcmdCommand(sock, from, msg) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const args = text.split(' ').slice(1);
    const commandName = args[0];

    if (!commandName) {
        await sock.sendMessage(from, { text: '❌ Usage: .delcmdaass <name>' });
        return;
    }

    const customCommands = loadCustomCommands();
    if (!customCommands[commandName]) {
        await sock.sendMessage(from, { text: `❌ Command .${commandName} not found` });
        return;
    }

    delete customCommands[commandName];
    saveCustomCommands(customCommands);

    await sock.sendMessage(from, { text: `✅ Custom command deleted: .${commandName}` });
}

// ✅ FIXED: Proper export
module.exports = delcmdCommand;