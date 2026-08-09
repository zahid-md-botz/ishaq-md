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

async function addcmdCommand(sock, from, msg) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const args = text.split(' ').slice(1);
    const commandName = args[0];
    const commandCode = args.slice(1).join(' ');

    if (!commandName || !commandCode) {
        await sock.sendMessage(from, { text: '❌ Usage: .addcmdaass <name> <code>' });
        return;
    }

    const customCommands = loadCustomCommands();
    customCommands[commandName] = commandCode;
    saveCustomCommands(customCommands);

    await sock.sendMessage(from, { text: `✅ Custom command added: .${commandName}` });
}

async function executeCustomCommand(sock, from, msg, commandName) {
    const customCommands = loadCustomCommands();
    if (customCommands[commandName]) {
        const code = customCommands[commandName];
        try {
            const fn = new Function('sock', 'from', 'msg', code);
            await fn(sock, from, msg);
            return true;
        } catch (e) {
            await sock.sendMessage(from, { text: `❌ Error: ${e.message}` });
            return true;
        }
    }
    return false;
}

// ✅ FIXED: Proper exports
module.exports = { 
    addcmdCommand, 
    executeCustomCommand 
};