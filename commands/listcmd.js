// commands/listcmd.js
const { listCustomCommands } = require('./addcmd');

async function listcmdCommand(sock, chatId, message) {
    await listCustomCommands(sock, chatId, message);
}

module.exports = listcmdCommand;