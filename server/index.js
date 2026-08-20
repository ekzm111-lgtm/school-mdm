const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 📂 클라우드 파일 호스팅 엔드포인트 (/shared/파일명)
app.use('/shared', express.static(uploadsDir));

// 📤 관리자 포터블 앱에서 배포용 파일 대용량 업로드 API
app.post('/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  const rawFileName = req.headers['x-file-name'] || `file_${Date.now()}`;
  const fileName = decodeURIComponent(rawFileName);
  const targetPath = path.join(uploadsDir, fileName);

  fs.writeFile(targetPath, req.body, (err) => {
    if (err) {
      console.error('[Upload Error]', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const fileUrl = `${protocol}://${host}/shared/${encodeURIComponent(fileName)}`;
    console.log(`[Cloud File Stored] File: ${fileName}, Public URL: ${fileUrl}`);
    res.json({ ok: true, fileUrl, fileName });
  });
});

const server = http.createServer(app);

// ⭐ EIO=3 (구버전 안드로이드 Socket.IO SDK) & EIO=4 (신버전) 100% 수용 설정
const io = new Server(server, {
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  },
  allowEIO3: true,
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 60000,
  maxHttpBufferSize: 1e8,
});

// 24시간 상시 중앙 상태 보관소 (Central Cloud State Store)
const tabletSockets = new Map(); // serial -> socket
const socketDevices = new Map(); // serial -> deviceInfo
const disconnectTimers = new Map(); // serial -> timer

// Render 서버 셀프 핑 (24시간 자동 수면 방지 Keep-Alive)
setInterval(() => {
  http.get(`http://127.0.0.1:${PORT}/`, () => {}).on('error', () => {});
}, 4 * 60 * 1000);

// 헬스체크 및 0.001초 기기 목록 일괄 수신 REST API
app.get('/', (req, res) => {
  res.send(`🚀 School-MDM Central Cloud State Store is Running! Online Tablets: ${socketDevices.size}`);
});

app.get('/devices', (req, res) => {
  res.json(Array.from(socketDevices.values()));
});

// Socket.IO 양방향 중계 및 상시 보관 로직
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}, IP: ${socket.handshake.address}`);

  // 태블릿이 전송하는 모든 이벤트 감지 (만능 트래커)
  socket.onAny((eventName, ...args) => {
    if (eventName === 'admin-connect' || eventName === 'mirror-frame') return;

    const payload = args[0];
    const deviceInfo = typeof payload === 'string' ? (tryParseJson(payload) || { serial: payload }) : payload;
    const serial = deviceInfo?.serial || deviceInfo?.mac || deviceInfo?.deviceId;
    
    if (serial && !socketDevices.has(serial)) {
      tabletSockets.set(serial, socket);
      const dev = {
        ...deviceInfo,
        serial,
        state: 'online',
        socketId: socket.id,
        lastSeen: new Date().toISOString()
      };
      socketDevices.set(serial, dev);
      io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
    }
  });

  // 관리자 포터블 프로그램 접속 시 24시간 상시 보관된 26대 상태 0.001초 일괄 전송!
  socket.on('admin-connect', () => {
    socket.join('admin-room');
    console.log(`[Admin Connected] SocketID: ${socket.id} — Sending cached devices immediately (${socketDevices.size} devs)!`);
    const allDevices = Array.from(socketDevices.values());
    socket.emit('device-update', allDevices);
  });

  // 태블릿 24시간 상시 등록 및 상태 자동 최신화
  socket.on('register', (deviceInfo) => {
    let parsed = deviceInfo;
    if (typeof deviceInfo === 'string') parsed = tryParseJson(deviceInfo) || { serial: deviceInfo };
    const { serial } = parsed || {};
    if (!serial) return;

    if (disconnectTimers.has(serial)) {
      clearTimeout(disconnectTimers.get(serial));
      disconnectTimers.delete(serial);
    }

    tabletSockets.set(serial, socket);

    const existing = socketDevices.get(serial) || {};
    const updatedDev = {
      ...existing,
      ...parsed,
      serial,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(serial, updatedDev);

    console.log(`[Cloud Store Updated] Tablet Registered: ${serial} (Total Online: ${socketDevices.size})`);

    const allDevs = Array.from(socketDevices.values());
    io.to('admin-room').emit('device-update', allDevs);
    io.emit('device-update', allDevs);
  });

  // 태블릿 24시간 상시 하트비트 수신
  socket.on('heartbeat', (data) => {
    let parsed = data;
    if (typeof data === 'string') parsed = tryParseJson(data) || {};
    const { serial, battery, charging, ip } = parsed || {};
    if (!serial) return;
    const existing = socketDevices.get(serial);
    if (!existing) return;

    const updated = {
      ...existing,
      battery: battery != null ? battery : existing.battery,
      charging: charging != null ? charging : existing.charging,
      ip: ip || existing.ip,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(serial, updated);

    io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
  });

  // 관리자 ➡️ 태블릿 제어 및 파일 배포 릴레이 명령
  socket.on('control-command', ({ serial, command, payload }) => {
    console.log(`[Control Command] Relay '${command}' to ${serial}`, payload);
    
    const existing = socketDevices.get(serial);
    if (existing) {
      if (command === 'lock') existing.locked = true;
      if (command === 'unlock') existing.locked = false;
      if (command === 'kiosk') existing.kioskApp = payload?.packageName;
      if (command === 'exit_kiosk') existing.kioskApp = null;
      socketDevices.set(serial, existing);
      io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
    }

    const targetSocket = tabletSockets.get(serial);
    if (targetSocket) {
      targetSocket.emit(command, payload);
    }
  });

  // 전체 태블릿 브로드캐스트 파일 배포 명령 (만능 호환 이벤트 전송)
  socket.on('broadcast-file-distribute', (payload) => {
    console.log('[Broadcast File Distribute]', payload);
    io.emit('file-distribute', payload);
    io.emit('distribute-file', payload);
  });

  // 미러링 프레임 릴레이
  socket.on('mirror-frame', (data) => {
    io.to('admin-room').emit('mirror-frame-client', data);
  });

  socket.on('disconnect', () => {
    for (const [serial, s] of tabletSockets.entries()) {
      if (s.id === socket.id) {
        tabletSockets.delete(serial);

        if (disconnectTimers.has(serial)) clearTimeout(disconnectTimers.get(serial));
        const timer = setTimeout(() => {
          disconnectTimers.delete(serial);
          const dev = socketDevices.get(serial);
          if (dev) {
            socketDevices.set(serial, { ...dev, state: 'offline' });
            const allDevs = Array.from(socketDevices.values());
            io.to('admin-room').emit('device-update', allDevs);
            io.emit('device-update', allDevs);
          }
        }, 5000);
        disconnectTimers.set(serial, timer);
        break;
      }
    }
  });
});

function tryParseJson(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}

server.listen(PORT, () => {
  console.log(`[Cloud Central Store] Server running on port ${PORT}`);
});
