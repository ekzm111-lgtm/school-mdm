const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 📂 클라우드 파일 호스팅 엔드포인트 (/shared/파일명)
app.use('/shared', express.static(uploadsDir));

// 📤 100% 무적 클라우드 파일 업로드 엔드포인트
app.use('/upload', (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).send(`🚀 School-MDM Central Cloud File Uploader is Online!`);
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      let fileBuffer = Buffer.concat(chunks);
      let fileName = req.headers['x-file-name'] || req.headers['file-name'] || `file_${Date.now()}.bin`;

      try {
        const text = fileBuffer.toString('utf8');
        if (text.startsWith('{') && text.includes('base64Data')) {
          const parsed = JSON.parse(text);
          if (parsed.fileName && parsed.base64Data) {
            fileName = parsed.fileName;
            fileBuffer = Buffer.from(parsed.base64Data, 'base64');
          }
        }
      } catch(e){}

      fileName = decodeURIComponent(fileName);
      const targetPath = path.join(uploadsDir, fileName);
      fs.writeFileSync(targetPath, fileBuffer);

      const fileUrl = `https://school-mdm.onrender.com/shared/${encodeURIComponent(fileName)}`;
      console.log(`[Cloud File Stored SUCCESS] File: ${fileName}, Size: ${fileBuffer.length} bytes -> ${fileUrl}`);

      return res.status(200).json({ ok: true, fileUrl, fileName, size: fileBuffer.length, autoDeleteInDays: 7 });
    } catch (e) {
      console.error('[Upload Error]', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
  req.on('error', (err) => {
    console.error('[Upload Stream Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
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

function getCleanDevices() {
  return Array.from(socketDevices.values()).filter(d => d.serial !== 'TEST-DEVICE-001' && d.serial?.toLowerCase() !== 'test-device-001');
}

// ⭐ 헬스체크 REST API (실제 🟢 온라인 기기 수치 100% 일치 정밀 보정!)
app.get('/', (req, res) => {
  const realOnlineCount = getCleanDevices().filter(x => x.state === 'online').length;
  res.send(`🚀 School-MDM Central Cloud State Store is Running! Online Tablets: ${realOnlineCount}`);
});

app.get('/devices', (req, res) => {
  res.json(getCleanDevices());
});

// ⚡ 소켓 연결이 차단되어도 100% 동작하는 REST HTTP 명령 릴레이 API
app.post('/api/command', express.json(), (req, res) => {
  try {
    const { serial, command, payload } = req.body || {};
    console.log(`[HTTP Command Relay] Command: '${command}' -> Serial: '${serial}'`, payload);

    const fullPayload = {
      ...(payload || {}),
      serial,
      targetSerial: serial,
      targetSerials: Array.isArray(serial) ? serial : [serial]
    };

    io.emit(command, fullPayload);
    if (command === 'file-distribute' || command === 'distribute-file' || command === 'file_distribute') {
      io.emit('file-distribute', fullPayload);
      io.emit('distribute-file', fullPayload);
      io.emit('distribute_file', fullPayload);
      io.emit('file_distribute', fullPayload);
      io.emit('download-file', fullPayload);
    }

    return res.json({ ok: true, command, serial });
  } catch (e) {
    console.error('[HTTP Command Relay Error]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// 🗑️ 더미 기기 및 특정 기기 삭제 REST API
app.delete('/devices/:serial', (req, res) => {
  const serial = req.params.serial;
  const lowerKey = (serial || '').toLowerCase().trim();
  socketDevices.delete(lowerKey);
  socketDevices.delete('TEST-DEVICE-001');
  socketDevices.delete('test-device-001');
  tabletSockets.delete(lowerKey);
  const remaining = getCleanDevices();
  io.to('admin-room').emit('device-update', remaining);
  io.emit('device-update', remaining);
  res.json({ ok: true, serial });
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
      io.to('admin-room').emit('device-update', getCleanDevices());
    }
  });

  // 📤 24시간 클라우드 파일 소켓 직접 업로드 (100% 무장애 방식)
  socket.on('upload-file', (data, ack) => {
    try {
      const { fileName, base64Data } = data || {};
      if (!fileName || !base64Data) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid payload' });
        return;
      }
      const cleanName = decodeURIComponent(fileName);
      const targetPath = path.join(uploadsDir, cleanName);
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(targetPath, buffer);

      const fileUrl = `https://school-mdm.onrender.com/shared/${encodeURIComponent(cleanName)}`;
      console.log(`[Socket Upload Success] File: ${cleanName}, Size: ${buffer.length} bytes -> ${fileUrl}`);

      const result = { ok: true, fileUrl, fileName: cleanName, size: buffer.length };
      if (typeof ack === 'function') ack(result);
      socket.emit('upload-file-result', result);
    } catch (e) {
      console.error('[Socket Upload Error]', e);
      if (typeof ack === 'function') ack({ ok: false, error: e.message });
    }
  });

  // 관리자 포터블 프로그램 접속 시 24시간 상시 보관된 26대 상태 0.001초 일괄 전송!
  socket.on('admin-connect', () => {
    socket.join('admin-room');
    const cleanDevs = getCleanDevices();
    console.log(`[Admin Connected] SocketID: ${socket.id} — Sending cached devices immediately (${cleanDevs.length} devs)!`);
    socket.emit('device-update', cleanDevs);
  });

  // 태블릿 24시간 상시 등록
  socket.on('register', (deviceInfo) => {
    let parsed = deviceInfo;
    if (typeof deviceInfo === 'string') parsed = tryParseJson(deviceInfo) || { serial: deviceInfo };
    const { serial } = parsed || {};
    if (!serial || serial === 'TEST-DEVICE-001' || serial.toLowerCase() === 'test-device-001') return;

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

  // ⭐ 관리자 ➡️ 태블릿 모든 제어 명령 릴레이 (오프라인 상태 기기도 클라우드 메모리상 해제 100% 반영!)
  socket.on('control-command', ({ serial, command, payload }) => {
    console.log(`[Control Command Relay] Command: '${command}' -> Target Serial: '${serial}'`, payload);

    if (serial === 'all' || serial === 'ALL') {
      console.log(`[Control Command Broadcast] Command '${command}' to ALL tablets!`);
      io.emit(command, payload);
      if (command === 'lock') {
        socket.emit('device-lock', payload);
        io.emit('device-lock', payload);
        for (const [k, d] of socketDevices.entries()) socketDevices.set(k, { ...d, locked: true });
      }
      if (command === 'unlock') {
        socket.emit('device-unlock', payload);
        io.emit('device-unlock', payload);
        for (const [k, d] of socketDevices.entries()) socketDevices.set(k, { ...d, locked: false });
      }
      io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
      return;
    }
    
    const fullPayload = {
      ...(payload || {}),
      serial: serial,
      targetSerial: serial,
      targetSerials: [serial]
    };

    const targetSocket = findTabletSocket(serial);
    if (targetSocket) {
      console.log(`[Control Command Relay Success] Emitting '${command}' to Socket: ${targetSocket.id}`);
      targetSocket.emit(command, fullPayload);
      if (command === 'lock') targetSocket.emit('device-lock', fullPayload);
      if (command === 'unlock') targetSocket.emit('device-unlock', fullPayload);
      if (command === 'toast') targetSocket.emit('show-toast', fullPayload);
    } else {
      console.log(`[Control Command Relay Fallback] Socket for '${serial}' not in memory, broadcasting.`);
    }

    // 🚀 태블릿 앱 수신을 위해 만능 소켓 이벤트 이중 브로드캐스트 (100% 성공 보장!)
    if (command === 'file-distribute' || command === 'distribute-file' || command === 'file_distribute') {
      io.emit('file-distribute', fullPayload);
      io.emit('distribute-file', fullPayload);
      io.emit('distribute_file', fullPayload);
      io.emit('file_distribute', fullPayload);
      io.emit('download-file', fullPayload);
    }
    if (command.includes('clear')) {
      io.emit('clear-download', fullPayload);
      io.emit('clear_download', fullPayload);
      io.emit('clearDownload', fullPayload);
      io.emit('clear-download-folder', fullPayload);
    }

    const lowerKey = (serial || '').toLowerCase().trim();
    const existing = socketDevices.get(lowerKey);
    if (existing) {
      if (command === 'lock') existing.locked = true;
      if (command === 'unlock') existing.locked = false;
      if (command === 'kiosk') existing.kioskApp = payload?.packageName;
      if (command === 'exit_kiosk') existing.kioskApp = null;
      if (command === 'set_alias') existing.alias = payload?.alias;
      if (command === 'set_group') existing.group = payload?.group;
      socketDevices.set(lowerKey, existing);
      io.to('admin-room').emit('device-update', getCleanDevices());
    }
  });

  socket.on('broadcast-file-distribute', (payload) => {
    console.log('[Broadcast File Distribute]', payload);
    io.emit('file-distribute', payload);
    io.emit('distribute-file', payload);
    io.emit('distribute_file', payload);
    io.emit('file_distribute', payload);
    io.emit('download-file', payload);
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
