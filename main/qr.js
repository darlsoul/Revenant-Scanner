const axios = require('axios');
const { MONGODB_URL, SESSION_NAME } = require('../config');
const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const pino = require("pino");
const { MongoClient } = require("mongodb");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay
} = require("@whiskeysockets/baileys");
const { log } = require('console');

let router = express.Router();

// Ensure the temp folder exists
async function ensureFolderExists(folderPath) {
    try {
        await fs.mkdir(folderPath, { recursive: true });
    } catch (err) {
        console.error("❌ Error creating folder:", err);
    }
}

// Function to remove files
async function removeFile(filePath) {
    try {
        const stats = await fs.lstat(filePath);

        if (stats.isDirectory()) {
            const files = await fs.readdir(filePath);
            await Promise.all(files.map(file => removeFile(path.join(filePath, file))));
            await fs.rmdir(filePath); // Remove directory after emptying it
        } else {
            await fs.unlink(filePath); // Remove file
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`⚠️ Path does not exist: ${filePath}`);
        } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
            console.error("❌ File in use, retrying...");
            setTimeout(() => removeFile(filePath), 1000);
        } else {
            console.error("❌ Error removing file:", err);
        }
    }
}

// Function to wait for creds.json
async function waitForFile(filePath, timeout = 30000) { // Increased timeout to 30 seconds
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            await fs.access(filePath);
            return true;
        } catch (err) {
            await delay(1000); // Wait 1 second before checking again
        }
    }
    throw new Error(`❌ Timeout: ${filePath} was not created in time.`);
}

// Function to store session data in MongoDB
async function storeData(id, sessionName, mongoUrl, session) {
    try {
        const dbName = 'session';  // Replace with your database name
        const collectionName = 'create';  // Replace with your collection name
        const filePath = path.join(__dirname, "temp", id, "creds.json");

        console.log("⏳ Waiting for creds.json...");
        await waitForFile(filePath, 30000); // Increased timeout to 30 seconds

        console.log("✅ creds.json found. Reading file...");
        const jsonData = await fs.readFile(filePath, 'utf-8');
        const creds = JSON.parse(jsonData);

        console.log("⏳ Connecting to MongoDB...");
        const client = new MongoClient(mongoUrl);
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        console.log("✅ Inserting session data...");
        const document = {
            SessionID: sessionName + id,
            creds: creds,
            createdAt: new Date(),
        };
        const result = await collection.insertOne(document);
        console.log(`✅ Session stored in MongoDB: ${result.insertedId}`);

        const count = await collection.countDocuments();
        await session.sendMessage(session.user.id, { text: `*Successfully Connected*\n\n *Total Scans:* ${count}` });
        await session.sendMessage(session.user.id, { text: document.SessionID });

        await client.close();
    } catch (error) {
        console.error('❌ Error storing data in MongoDB:', error);
    }
}

// Route to generate QR code and handle authentication
router.get('/', async (req, res) => {
    const id = makeid();
    const tempPath = path.join(__dirname, "temp", id);

    console.log(`🚀 Starting session: ${id}`);
    await ensureFolderExists(tempPath);

    async function Getqr() {
        const { state, saveCreds } = await useMultiFileAuthState(tempPath);
        let SAVED = false;

        try {
            const session = makeWASocket({
                auth: state,
                printQRInTerminal: true,
                logger: pino({ level: "silent" }),
                browser: ["Chrome", "Windows", "121.0.0.0"],
                syncFullHistory: true,
            });
            

            session.ev.on('creds.update', async () => {
                console.log("🔄 creds.update triggered! Saving credentials...");
                await saveCreds();
                SAVED = true;
                console.log("✅ Credentials Saved.");
            });

            session.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect, qr } = s;

                if (qr) {
                    console.log("📸 QR Code generated. Scan it.");
                    return res.end(await QRCode.toBuffer(qr));
                }

                if (connection === "open") {
                    console.log("✅ WhatsApp Web Connected. Waiting for creds.json...");
                    console.log("🔄 Storing session data...");
                    await storeData(id, SESSION_NAME, MONGODB_URL, session);

                    await delay(100);
                    console.log("🔒 Closing session...");
                    await session.ws.close();
                    console.log("🔒 session closed.");

                    console.log("🗑 Removing temp folder...");
                    removeFile(tempPath);
                    console.log("🗑 Removed temp folder.");
                    return;
                }

                if (connection === "close" || connection === "closed") {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                    if (shouldReconnect) {
                        console.log("🔄 Reconnecting...");
                        return Getqr();
                    } else {
                        console.log("❌ Session expired or banned. Cleaning up...");
                        await removeFile(tempPath);
                        return;
                    }
                }
            });


        } catch (err) {
            if (!res.headersSent) {
                res.json({ code: "Service Unavailable" });
            }
            console.error("❌ Unexpected error:", err);
            await removeFile(tempPath);
        }
    }

    return await Getqr();
});

module.exports = router;
