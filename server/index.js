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

// ⏰ 7일(일주일) 지난 업로드 공유 파일 자동 삭제 청소기 (Retention Policy)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 7일 (밀리초)

function cleanupOldSharedFiles() {
  try {
    const files = fs.readdirSync(uploadsDir);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      // 생성/수정 시간이 7일(일주일)을 초과한 경우 자동 삭제
      if (now - stats.mtimeMs > SEVEN_DAYS_MS) {
        fs.unlinkSync(filePath);
        deletedCount++;
        console.log(`[Auto Cleanup] 7일 경과 파일 자동 삭제: ${file}`);
      }
    }
    if (deletedCount > 0) {
      console.log(`[Auto Cleanup Complete] 총 ${deletedCount}개 일주일 경과 파일 삭제 완료.`);
    }
  } catch (err) {
    console.error('[Auto Cleanup Error]', err);
  }
}

// 1시간마다 7일 이상 된 파일 자동 청소 스케줄러 실행
setInterval(cleanupOldSharedFiles, 60 * 60 * 1000);
// 서버 구동 즉시 1회 실행
cleanupOldSharedFiles();

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
    console.log(`[Cloud File Stored] File: ${fileName}, Public URL: ${fileUrl} (7일 후 자동 삭제 예정)`);
    res.json({ ok: true, fileUrl, fileName, autoDeleteInDays: 7 });
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
const tabletSockets = new Map(); // serial -> socket (lowercase serial key)
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

// 소켓 찾기 도우미 (대소문자 무관 검색)
function findTabletSocket(serial) {
  if (!serial) return null;
  const targetLower = serial.toLowerCase().trim();
  for (const [keySocketSerial, s] of tabletSockets.entries()) {
    if (keySocketSerial.toLowerCase().trim() === targetLower) {
      return s;
    }
  }
  return null;
}

// Socket.IO 양방향 중계 및 상시 보관 로직
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}, IP: ${socket.handshake.address}`);

  // 만능 이벤트 수신 트래커
  socket.onAny((eventName, ...args) => {
    if (eventName === 'admin-connect' || eventName === 'mirror-frame' || eventName === 'control-command') return;

    const payload = args[0];
    const deviceInfo = typeof payload === 'string' ? (tryParseJson(payload) || { serial: payload }) : payload;
    const serial = deviceInfo?.serial || deviceInfo?.mac || deviceInfo?.deviceId;
    
    if (serial) {
      const lowerKey = serial.toLowerCase().trim();
      tabletSockets.set(lowerKey, socket);
      const existing = socketDevices.get(lowerKey) || {};
      const dev = {
        ...existing,
        ...deviceInfo,
        serial,
        state: 'online',
        socketId: socket.id,
        lastSeen: new Date().toISOString()
      };
      socketDevices.set(lowerKey, dev);
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

  // 태블릿 24시간 상시 등록
  socket.on('register', (deviceInfo) => {
    let parsed = deviceInfo;
    if (typeof deviceInfo === 'string') parsed = tryParseJson(deviceInfo) || { serial: deviceInfo };
    const { serial } = parsed || {};
    if (!serial) return;

    const lowerKey = serial.toLowerCase().trim();
    if (disconnectTimers.has(lowerKey)) {
      clearTimeout(disconnectTimers.get(lowerKey));
      disconnectTimers.delete(lowerKey);
    }

    tabletSockets.set(lowerKey, socket);

    const existing = socketDevices.get(lowerKey) || {};
    const updatedDev = {
      ...existing,
      ...parsed,
      serial,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(lowerKey, updatedDev);

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

    const lowerKey = serial.toLowerCase().trim();
    const existing = socketDevices.get(lowerKey);
    if (!existing) return;

    const updated = {
      ...existing,
      battery: battery != null ? battery : existing.battery,
      charging: charging != null ? charging : existing.charging,
      ip: ip || existing.ip,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(lowerKey, updated);

    io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
  });

  // ⭐ 관리자 ➡️ 태블릿 모든 제어 명령 릴레이
  socket.on('control-command', ({ serial, command, payload }) => {
    console.log(`[Control Command Relay] Command: '${command}' -> Target Serial: '${serial}'`, payload);

    if (serial === 'all' || serial === 'ALL') {
      console.log(`[Control Command Broadcast] Command '${command}' to ALL tablets!`);
      io.emit(command, payload);
      if (command === 'lock') {
        socket.emit('device-lock', payload);
        io.emit('device-lock', payload);
      }
      return;
    }
    
    const targetSocket = findTabletSocket(serial);
    if (targetSocket) {
      console.log(`[Control Command Relay Success] Emitting '${command}' to Socket: ${targetSocket.id}`);
      targetSocket.emit(command, payload);
      if (command === 'lock') targetSocket.emit('device-lock', payload);
      if (command === 'unlock') targetSocket.emit('device-unlock', payload);
      if (command === 'toast') targetSocket.emit('show-toast', payload);
    } else {
      console.log(`[Control Command Relay Fallback] Socket for '${serial}' not in memory, broadcasting to all.`);
      io.emit(command, payload);
    }

    const lowerKey = (serial || '').toLowerCase().trim();
    const existing = socketDevices.get(lowerKey);
    if (existing) {
      if (command === 'lock') existing.locked = true;
      if (command === 'unlock') existing.locked = false;
      if (command === 'kiosk') existing.kioskApp = payload?.packageName;
      if (command === 'exit_kiosk') existing.kioskApp = null;
      socketDevices.set(lowerKey, existing);
      io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
    }
  });

  socket.on('broadcast-file-distribute', (payload) => {
    console.log('[Broadcast File Distribute]', payload);
    io.emit('file-distribute', payload);
    io.emit('distribute-file', payload);
  });

  socket.on('mirror-frame', (data) => {
    io.to('admin-room').emit('mirror-frame-client', data);
  });

  socket.on('disconnect', () => {
    for (const [lowerKey, s] of tabletSockets.entries()) {
      if (s.id === socket.id) {
        tabletSockets.delete(lowerKey);

        if (disconnectTimers.has(lowerKey)) clearTimeout(disconnectTimers.get(lowerKey));
        const timer = setTimeout(() => {
          disconnectTimers.delete(lowerKey);
          const dev = socketDevices.get(lowerKey);
          if (dev) {
            socketDevices.set(lowerKey, { ...dev, state: 'offline' });
            const allDevs = Array.from(socketDevices.values());
            io.to('admin-room').emit('device-update', allDevs);
            io.emit('device-update', allDevs);
          }
        }, 5000);
        disconnectTimers.set(lowerKey, timer);
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
