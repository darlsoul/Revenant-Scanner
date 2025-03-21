const axios = require('axios');
const { MongoClient } = require('mongodb');
const { MONGODB_URL, SESSION_NAME } = require('../config');
const { makeid } = require('./id');
const express = require('express');
const fs = require('fs').promises;
const cors = require('cors');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const router = express.Router();
const dbName = 'session';  // Replace with your database name
const collectionName = 'create';  // Replace with your collection name

// Function to remove a file or directory
async function removeFile(filePath) {
    try {
        if (await fs.stat(filePath)) {
            await fs.rm(filePath, { recursive: true, force: true });
        }
    } catch (err) {
        console.error(`Failed to remove file or directory at ${filePath}:`, err);
    }
}

router.use(cors());

router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;

    async function getPaire() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);

        try {
            const session = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
                browser: Browsers.macOS("Google Chrome"),
            });

            if (!session.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                const code = await session.requestPairingCode(num);
                if (!res.headersSent) {
                    return res.send({ code });
                }
            }

            session.ev.on('creds.update', saveCreds);

            session.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === 'open') {
                    await delay(5000);
                    await storeData(id, SESSION_NAME, MONGODB_URL, session);
                    await delay(100);
                    await session.ws.close();
                    await removeFile('./temp/' + id);
                    return;
                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    await delay(10000);
                    await getPaire();
                }
            });
        } catch (err) {
            console.log('Service restarted');
            await removeFile('./temp/' + id);
            if (!res.headersSent) {
                return res.send({ code: 'Service Unavailable' });
            }
        }
    }

    return getPaire();
});

// ✅ Securely Store Data in MongoDB
async function storeData(id, sessionName, mongoUrl, session) {
    if (!mongoUrl) {
        console.error("❌ MongoDB URL is missing. Set it in environment variables.");
        return;
    }

    try {
        const jsonPath = `./temp/${id}/creds.json`;

        // Check if creds.json exists
        try {
            await fs.access(jsonPath);
        } catch (err) {
            console.error(`❌ creds.json not found for session: ${id}`);
            return;
        }

        // Read and parse the credentials
        const jsonData = await fs.readFile(jsonPath, 'utf-8');
        const creds = JSON.parse(jsonData);

        // Connect to MongoDB
        const client = new MongoClient(mongoUrl);
        await client.connect();

        // Select database and collection
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        // Prepare document
        const document = {
            SessionID: sessionName + id,
            creds: creds,
            createdAt: new Date(),
        };

        // Insert document
        const result = await collection.insertOne(document);
        console.log(`✅ Session stored with _id: ${result.insertedId}`);

        // Close connection
        await client.close();
    } catch (error) {
        console.error('❌ Error storing session data in MongoDB:', error);
    }
}

module.exports = router;
