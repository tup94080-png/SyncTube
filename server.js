const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const localtunnel = require('localtunnel');

const app = express();

const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });

const sslOptions = {
    key: pems.private,
    cert: pems.cert
};
const server = https.createServer(sslOptions, app);
const io = new Server(server);

const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'shared_folder');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

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
            console.log('Tunnel closed');
        });
    } catch (err) {
        console.error('Tunnel offline or unavailable (normal for offline mobile sandbox):', err.message);
    }
}

app.get('/files', (req, res) => {
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: "Could not retrieve folder repository" });
        res.json(files);
    });
});

app.delete('/files/:filename', (req, res) => {
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
});

app.post('/upload', upload.array('files'), (req, res) => {
    io.emit('file-added');
    res.json({ success: true, url: activeTunnelUrl });
});

app.get('/api/tunnel-status', (req, res) => {
    res.json({ url: activeTunnelUrl });
});

app.post('/save-recording', upload.single('recording'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Missing recording content" });
    io.emit('file-added', req.file.filename);
    res.json({ success: true, filename: req.file.filename });
});

io.on('connection', (socket) => {
    console.log(`Secure client connected: ${socket.id}`);

    socket.on('video-action', (data) => {
        socket.broadcast.emit('update-video-state', data);
    });

    socket.on('signal', (data) => {
        socket.broadcast.emit('signal', data);
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

server.listen(PORT, 'localhost', () => {
    console.log(`SyncTube secure local HTTPS server running on https://localhost:${PORT}`);
    setupTunnel();
});
