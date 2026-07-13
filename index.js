/**
 * YTREX_KSH-MD1 - WhatsApp Bot
 * Owner: TYREX
 * Base: Knight Bot + Baileys
 */

require('./settings')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const path = require('path')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { imageToWebp, videoToWebp } = require('./lib/exif')
const { smsg } = require('./lib/myfunc')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidDecode,
    jidNormalizedUser,
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
const store = require('./lib/lightweight_store')
const pino = require("pino")
const readline = require("readline")
const { rmSync } = require('fs')

// Settings
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

// Globals
global.botname = "YTREX_KSH-MD1"
global.ownername = "TYREX"
global.themeemoji = "⚡"
let phoneNumber = "2547XXXXXXXX" // <-- put your number here for pairing
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

const pairingCode =!!phoneNumber || process.argv.includes("--pairing-code")
const useMobile = process.argv.includes("--mobile")

const rl = process.stdin.isTTY? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
const question = (text) => {
    if (rl) return new Promise((resolve) => rl.question(text, resolve))
    return Promise.resolve(settings.ownerNumber || phoneNumber)
}

// Memory cleanup
setInterval(() => { if (global.gc) global.gc() }, 60_000)
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024
    if (used > 400) {
        console.log(chalk.red('⚠️ RAM > 400MB, restarting...'))
        process.exit(1)
    }
}, 30_000)

async function startYTREX() {
    const { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState(`./session`)
    const msgRetryCounterCache = new NodeCache()

    const YTREX = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal:!pairingCode,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        getMessage: async (key) => {
            let jid = jidNormalizedUser(key.remoteJid)
            let msg = await store.loadMessage(jid, key.id)
            return msg?.message || ""
        },
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000,
    })

    YTREX.ev.on('creds.update', saveCreds)
    store.bind(YTREX.ev)

    // Decode JID
    YTREX.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {}
            return decode.user && decode.server? decode.user + '@' + decode.server : jid
        } else return jid
    }

    YTREX.getName = (jid) => {
        id = YTREX.decodeJid(jid)
        if (id.endsWith("@g.us")) return store.contacts[id]?.subject || "Group"
        return store.contacts[id]?.name || id.split('@')[0]
    }

    YTREX.public = true
    YTREX.serializeM = (m) => smsg(YTREX, m, store)

    // MENU COMMAND
    YTREX.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0]
            if (!mek.message) return
            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage')? mek.message.ephemeralMessage.message : mek.message

            await handleMessages(YTREX, chatUpdate, true)
        } catch (err) {
            console.error("Error:", err)
        }
    })

    // PAIRING CODE
    if (pairingCode &&!YTREX.authState.creds.registered) {
        if (useMobile) throw new Error('Cannot use pairing code with mobile api')
        setTimeout(async () => {
            let code = await YTREX.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''))
            code = code?.match(/.{1,4}/g)?.join("-") || code
            console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
        }, 3000)
    }

    // CONNECTION
    YTREX.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect, qr } = s
        if (qr) console.log(chalk.yellow('📱 Scan QR Code'))
        if (connection === 'connecting') console.log(chalk.yellow('🔄 Connecting...'))
        if (connection == "open") {
            console.log(chalk.green(`\n✅ ${global.botname} Connected!`))
            console.log(chalk.cyan(`< ============================== >`))
            console.log(chalk.magenta(`${global.themeemoji} OWNER: ${global.ownername}`))
            console.log(chalk.magenta(`${global.themeemoji} VERSION: ${settings.version}`))
            console.log(chalk.cyan(`< ============================== >\n`))

            await YTREX.sendMessage(YTREX.user.id, {
                text: `🤖 *${global.botname}* is Online\n👑 Owner: ${global.ownername}\n⏰ ${new Date().toLocaleString()}`
            })
        }
        if (connection === 'close') {
            let reason = lastDisconnect?.error?.output?.statusCode
            if (reason === DisconnectReason.loggedOut) {
                rmSync('./session', { recursive: true, force: true })
                console.log(chalk.red('Session deleted. Please re-scan.'))
            }
            console.log(chalk.yellow('Reconnecting...'))
            await new Promise(resolve => setTimeout(resolve, 5000))
            startYTREX()
        }
    })

    // GROUP UPDATE
    YTREX.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(YTREX, update);
    });

    // STATUS
    YTREX.ev.on('status.update', async (status) => {
        await handleStatus(YTREX, status);
    });

    return YTREX
}

startYTREX().catch(err => {
    console.error(err)
    process.exit(1)
})

// Auto reload
let file = require.resolve(__filename)
fs.watchFile(file, () => {
    fs.unwatchFile(file)
    console.log(chalk.redBright(`Update ${__filename}`))
    delete require.cache[file]
    require(file)
})
