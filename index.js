/**
 * YTREX_KSH-MD1 - WhatsApp Bot
 * Owner: TYREX
 * Repo: https://github.com/bugvirustechtyrex-bit/TYREX_KSH-MD1
 */

require('dotenv').config()
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
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
const { rmSync } = require('fs')

// ===== CONFIG =====
global.botname = process.env.BOT_NAME || "YTREX_KSH-MD1"
global.ownername = process.env.OWNER_NAME || "TYREX"
global.themeemoji = "⚡"
let phoneNumber = process.env.PHONE_NUMBER
let owner = JSON.parse(fs.readFileSync('./data/owner.json'))

const pairingCode = true // Force pairing for Heroku
const useMobile = false

// ===== STORE =====
store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

// ===== MEMORY CLEANUP =====
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
        printQRInTerminal: false, // QR disabled, we use pairing
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

    // ===== MESSAGES =====
    YTREX.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages[0]
            if (!mek.message) return
            mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage')? mek.message.ephemeralMessage.message : mek.message
            if (mek.key && mek.key.remoteJid === 'status@broadcast') return await handleStatus(YTREX, chatUpdate);

            await handleMessages(YTREX, chatUpdate, true)
        } catch (err) {
            console.error("Error in messages.upsert:", err)
        }
    })

    // ===== PAIRING CODE FOR HEROKU =====
    if (!YTREX.authState.creds.registered) {
        setTimeout(async () => {
            if (!phoneNumber) {
                console.log(chalk.red('❌ Please set PHONE_NUMBER in Heroku Config Vars'))
                process.exit(1)
            }
            phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
            let code = await YTREX.requestPairingCode(phoneNumber)
            code = code?.match(/.{1,4}/g)?.join("-") || code
            console.log(chalk.black(chalk.bgGreen(` Your Pairing Code : `)), chalk.black(chalk.white(code)))
            console.log(chalk.yellow(`\n1. Open WhatsApp\n2. Settings > Linked Devices\n3. Link with Phone Number\n4. Enter Code Above`))
        }, 3000)
    }

    // ===== CONNECTION =====
    YTREX.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect } = s
        if (connection === 'connecting') console.log(chalk.yellow('🔄 Connecting to WhatsApp...'))
        if (connection == "open") {
            console.log(chalk.green(`\n✅ ${global.botname} Connected Successfully!`))
            console.log(chalk.cyan(`< ============================== >`))
            console.log(chalk.magenta(`${global.themeemoji} OWNER: ${global.ownername}`))
            console.log(chalk.magenta(`${global.themeemoji} VERSION: ${settings.version || '1.0.0'}`))
            console.log(chalk.cyan(`< ============================== >\n`))

            await YTREX.sendMessage(YTREX.user.id, {
                text: `🤖 *${global.botname}* is Online\n👑 Owner: ${global.ownername}\n⏰ ${new Date().toLocaleString()}`
            }).catch(console.error)
        }
        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode
            console.log(chalk.red(`Connection closed: ${reason}`))
            if (reason === DisconnectReason.loggedOut) {
                rmSync('./session', { recursive: true, force: true })
                console.log(chalk.yellow('Session deleted. Please re-pair.'))
            }
            console.log(chalk.yellow('Reconnecting in 5s...'))
            await new Promise(resolve => setTimeout(resolve, 5000))
            startYTREX()
        }
    })

    // ===== GROUP EVENTS =====
    YTREX.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(YTREX, update);
    });

    // ===== STATUS =====
    YTREX.ev.on('status.update', async (status) => {
        await handleStatus(YTREX, status);
    });

    return YTREX
}

startYTREX().catch(err => {
    console.error(err)
    process.exit(1)
})

// ===== AUTO RELOAD =====
let file = require.resolve(__filename)
fs.watchFile(file, () => {
    fs.unwatchFile(file)
    console.log(chalk.redBright(`Update ${__filename}`))
    delete require.cache[file]
    require(file)
})
