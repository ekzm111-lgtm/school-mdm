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

// 메모리 기반 기기 세션 관리
const tabletSockets = new Map(); // serial -> socket
const socketDevices = new Map(); // serial -> deviceInfo
const disconnectTimers = new Map(); // serial -> timer

// 기본 헬스체크 API (Render.com 헬스체크용)
app.get('/', (req, res) => {
  res.send(`🚀 School-MDM Relay Server is running! Total Devices: ${socketDevices.size}`);
});

app.get('/devices', (req, res) => {
  res.json(Array.from(socketDevices.values()));
});

// Socket.IO 커넥션 및 양방향 릴레이
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // 관리자 PC 등록
  socket.on('admin-register', () => {
    socket.join('admin-room');
    console.log(`[Admin] Registered Admin Socket: ${socket.id}`);
    socket.emit('device-update', Array.from(socketDevices.values()));
  });

  // 태블릿 등록
  socket.on('register', (deviceInfo) => {
    const { serial } = deviceInfo || {};
    if (!serial) return;

    if (disconnectTimers.has(serial)) {
      clearTimeout(disconnectTimers.get(serial));
      disconnectTimers.delete(serial);
    }

    tabletSockets.set(serial, socket);
    const updatedDev = {
      ...deviceInfo,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(serial, updatedDev);

    console.log(`[Tablet Registered] Serial: ${serial}, Total: ${socketDevices.size}`);

    // 관리자 PC 룸으로 즉시 알림 (0ms 지연)
    io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
    io.emit('device-update', Array.from(socketDevices.values()));
  });

  // 태블릿 하트비트
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
    io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
  });

  // 관리자 ↔ 태블릿 제어 명령 릴레이 (lock, unlock, kiosk, exit_kiosk, volume 등)
  socket.on('control-command', ({ serial, command, payload }) => {
    console.log(`[Control] Command '${command}' to ${serial}`);
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
            io.to('admin-room').emit('device-update', Array.from(socketDevices.values()));
            io.emit('device-update', Array.from(socketDevices.values()));
          }
        }, 5000);
        disconnectTimers.set(serial, timer);
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Server] School-MDM Relay Server running on port ${PORT}`);
});
