const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const localtunnel = require('localtunnel');

const app = express();
const PORT = 3000;

// Safe writable directory for Android
const writableRoot = (os.tmpdir && typeof os.tmpdir === 'function') ? os.tmpdir() : __dirname;
const UPLOAD_DIR = path.join(writableRoot, 'sync_tube_shared');

if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error("Failed to create UPLOAD_DIR:", e);
    }
}

// Helper to find local Wi-Fi IP address dynamically
function getLocalIp() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of interfaces) {
            for (const net of interfaces[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
    } catch (e) {
        console.error("Error getting local IP:", e);
    }
    return '127.0.0.1';
}

const localIpAddress = getLocalIp();

// Safely generate SSL certificate
let sslOptions;
try {
    const attrs = [{ name: 'commonName', value: localIpAddress }];
    const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
    sslOptions = {
        key: pems.private,
        cert: pems.cert
    };
} catch (e) {
    console.error("SSL Generation failed, falling back:", e);
    // Fallback dummy or basic keys if selfsigned fails
    sslOptions = null; 
}

// Create server (fallback to HTTP if SSL fails, though HTTPS is preferred)
let server;
if (sslOptions) {
    server = https.createServer(sslOptions, app);
} else {
    const http = require('http');
    server = http.createServer(app);
}

const io = new Server(server);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared_folder', express.static(UPLOAD_DIR));
app.use(express.json());

let activeTunnelUrl = 'Offline / Local Sandbox Mode';

async function setupTunnel() {
    try {
        const tunnel = await localtunnel({ port: PORT });
        activeTunnelUrl = tunnel.url;
        console.log(`Public Tunnel Active: ${activeTunnelUrl}`);
        tunnel.on('close', () => {
            activeTunnelUrl = 'Offline / Local Sandbox Mode';
        });
    } catch (err) {
        console.error('Tunnel offline or unavailable:', err.message);
        activeTunnelUrl = 'Offline / Local Sandbox Mode';
    }
}

app.get('/files', (req, res) => {
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: "Could not retrieve folder repository" });
        res.json(files || []);
    });
});

app.delete('/files/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const filePath = path.join(UPLOAD_DIR, filename);

        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) return res.status(500).json({ error: "Failed to delete file" });
                io.emit('file-deleted', filename);
                res.json({ success: true, message: `Deleted ${filename}` });
            });
        } else {
            res.status(404).json({ error: "File not found" });
        }
    } catch (e) {
        res.status(500).json({ error: "Server error during deletion" });
    }
});

app.post('/upload', upload.array('files'), (req, res) => {
    io.emit('file-added');
    res.json({ success: true, url: activeTunnelUrl });
});

app.get('/api/tunnel-status', (req, res) => {
    res.json({ 
        url: activeTunnelUrl,
        localUrl: `https://${localIpAddress}:${PORT}`
    });
});

app.post('/save-recording', upload.single('recording'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Missing recording content" });
    io.emit('file-added', req.file.filename);
    res.json({ success: true, filename: req.file.filename });
});

io.on('connection', (socket) => {
    socket.on('video-action', (data) => {
        socket.broadcast.emit('update-video-state', data);
    });

    socket.on('signal', (data) => {
        socket.broadcast.emit('signal', data);
    });
});

// Bind safely to 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
    console.log(`SyncTube running locally at port ${PORT}`);
    // Delay tunnel setup slightly so app boots smoothly first
    setTimeout(setupTunnel, 2000);
});
