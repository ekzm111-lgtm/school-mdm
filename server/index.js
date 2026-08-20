const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 60000,
  maxHttpBufferSize: 1e8,
  perMessageDeflate: false,
});

// 24시간 상시 중앙 상태 보관소 (Central Cloud State Store)
const tabletSockets = new Map(); // serial -> socket
const socketDevices = new Map(); // serial -> deviceInfo
const disconnectTimers = new Map(); // serial -> timer

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

  // 관리자 포터블 프로그램 접속 시 24시간 상시 보관된 26대 상태 0.001초 일괄 전송!
  socket.on('admin-connect', () => {
    socket.join('admin-room');
    console.log(`[Admin Connected] SocketID: ${socket.id} — Sending cached devices immediately!`);
    const allDevices = Array.from(socketDevices.values());
    socket.emit('device-update', allDevices);
  });

  // 태블릿 24시간 상시 등록 및 상태 자동 최신화
  socket.on('register', (deviceInfo) => {
    const { serial } = deviceInfo || {};
    if (!serial) return;

    if (disconnectTimers.has(serial)) {
      clearTimeout(disconnectTimers.get(serial));
      disconnectTimers.delete(serial);
    }

    tabletSockets.set(serial, socket);

    const existing = socketDevices.get(serial) || {};
    const updatedDev = {
      ...existing,
      ...deviceInfo,
      serial,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(serial, updatedDev);

    console.log(`[Cloud Store Updated] Tablet Registered: ${serial} (Total Online: ${socketDevices.size})`);

    // 관리자 포터블 앱 대시보드로 0ms 즉시 전송
    const allDevs = Array.from(socketDevices.values());
    io.to('admin-room').emit('device-update', allDevs);
    io.emit('device-update', allDevs);
  });

  // 태블릿 24시간 상시 하트비트 수신 (배터리/IP/충전상태 상시 갱신)
  socket.on('heartbeat', (data) => {
    const { serial, battery, charging, ip } = data || {};
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

    // 관리자 포터블 앱 대시보드로 갱신 전송
    io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
  });

  // 관리자 포터블 앱 ➡️ 특정 태블릿 제어 명령 릴레이 (lock, unlock, kiosk, exit_kiosk, volume 등)
  socket.on('control-command', ({ serial, command, payload }) => {
    console.log(`[Control Command] Relay '${command}' to ${serial}`);
    
    // 로컬 메모리 상태 즉시 반영 (낙관적 UI)
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

server.listen(PORT, () => {
  console.log(`[Cloud Central Store] Server running on port ${PORT}`);
});
