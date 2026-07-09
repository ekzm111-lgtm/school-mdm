const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const AdbManager = require('./adb');

let mainWindow;
let adbManager;

// ─── Socket.IO MDM 서버 구축 ───────────────────────────
const cors = require('cors');
const expressApp = express();
expressApp.use(cors());
const server = http.createServer(expressApp);
const io = new Server(server, {
  cors: { origin: "*" }
});

const tabletSockets = new Map(); // serial -> socket instance
const socketDevices = new Map(); // serial -> deviceInfo

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // 태블릿 클라이언트 등록
  socket.on('register', (deviceInfo) => {
    const { serial } = deviceInfo;
    if (!serial) return;
    
    console.log('[Socket] Device registered:', serial, deviceInfo.model);
    tabletSockets.set(serial, socket);
    
    // 기기 정보 갱신 및 상태 강제 주입
    socketDevices.set(serial, {
      ...deviceInfo,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    });

    // ADB 매니저에 소켓으로 등록된 기기 정보 합쳐서 넘김
    adbManager?.setSocketDevices(socketDevices);
  });

  // 실시간 미러링 화면 및 상태 릴레이
  socket.on('mirror-frame', (data) => {
    io.emit('mirror-frame-client', data);
    mainWindow?.webContents.send('mirror-frame', data);
  });

  socket.on('mirror-state', (data) => {
    io.emit('mirror-state-client', data);
    mainWindow?.webContents.send('mirror-state', data);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
    for (const [serial, s] of tabletSockets.entries()) {
      if (s.id === socket.id) {
        tabletSockets.delete(serial);
        const info = socketDevices.get(serial);
        if (info) {
          socketDevices.set(serial, { ...info, state: 'offline' });
        }
        break;
      }
    }
    adbManager?.setSocketDevices(socketDevices);
  });
});

// APK 다운로드 API 추가 (태블릿 무선 연결용)
const fs = require('fs');
const sharedDir = path.join(app.getPath('userData'), 'shared_files');
if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir, { recursive: true });
}
expressApp.use(express.json());
expressApp.use('/shared', express.static(sharedDir));

// 일반 브라우저 관리자를 위한 HTTP 기기 목록 조회 API 추가
expressApp.get('/devices', (req, res) => {
  res.json(adbManager?.getDevices() ?? []);
});

// 일반 브라우저 관리자를 위한 기기 네임텍 별명 변경 API 추가
expressApp.post('/devices/alias', (req, res) => {
  const { serial, alias } = req.body;
  try {
    adbManager.setDeviceAlias(serial, alias);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 일반 브라우저 관리자를 위한 실시간 기기 위치 조회 API 추가
expressApp.post('/devices/location', async (req, res) => {
  const { serial } = req.body;
  const socket = tabletSockets.get(serial);
  if (!socket) {
    return res.status(404).json({ ok: false, error: '태블릿이 소켓 서버에 오프라인 상태입니다.' });
  }
  try {
    socket.emit('get-location');
    const timeout = setTimeout(() => {
      socket.removeAllListeners('location-response');
      res.status(504).json({ ok: false, error: '태블릿 응답 시간 초과 (GPS가 꺼져있을 수 있습니다)' });
    }, 10000);
    
    socket.once('location-response', (data) => {
      clearTimeout(timeout);
      socket.removeAllListeners('location-response');
      if (data.error) {
        res.status(400).json({ ok: false, error: data.error });
      } else {
        res.json({ ok: true, lat: data.lat, lng: data.lng });
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 일반 브라우저 관리자를 위한 기기 앱 강제 삭제 API 추가
expressApp.post('/devices/uninstall', async (req, res) => {
  const { serial, packageName } = req.body;
  try {
    const result = await adbManager.uninstallApp(serial, packageName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

expressApp.get('/apk', (req, res) => {
  const apkPath = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'apk', 'app-debug.apk')
    : path.join(__dirname, '..', 'resources', 'apk', 'app-debug.apk');

  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'School-MDM-Client.apk');
  } else {
    res.status(404).send('APK 파일을 찾을 수 없습니다. resources/apk/app-debug.apk 경로를 확인하세요.');
  }
});

// Next.js Dev 포트(3000)와 충돌을 피하기 위해 3010 포트 사용
server.listen(3010, '0.0.0.0', () => {
  console.log('[Socket] MDM Control Server running on port 3010');
});

// ─── Electron 윈도우 생성 ─────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    frame: true,
    titleBarStyle: 'default',
    backgroundColor: '#ffffff',
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/out/index.html'));
  }
}

app.whenReady().then(async () => {
  createWindow();
  adbManager = new AdbManager();
  await adbManager.init();

  // ADB + Socket 기기 연동 이벤트 전달
  adbManager.on('device-update', (devices) => {
    mainWindow?.webContents.send('device-update', devices);
  });
  adbManager.startPolling();
});

app.on('window-all-closed', () => {
  adbManager?.stopPolling();
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC 핸들러 (어드민 UI ↔ 메인 프로세스) ──────────────────
ipcMain.handle('get-devices', async () => {
  return adbManager?.getDevices() ?? [];
});

// 화면 잠금
ipcMain.handle('lock-device', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    // 소켓 클라이언트가 있으면 무선 소켓 명령 우선 전송 (Device Owner)
    console.log('[Control] Sending LOCK via Socket to:', serial);
    socket.emit('lock');
    return { ok: true, via: 'socket' };
  }
  // 차선책으로 ADB 직접 제어 시도
  return adbManager?.lockDevice(serial);
});

// 화면 해제
ipcMain.handle('unlock-device', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    console.log('[Control] Sending UNLOCK via Socket to:', serial);
    socket.emit('unlock');
    return { ok: true, via: 'socket' };
  }
  return adbManager?.unlockDevice(serial);
});

// 키오스크 설정
ipcMain.handle('set-kiosk', async (_, serial, packageName) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    console.log('[Control] Sending KIOSK via Socket to:', serial, packageName);
    socket.emit('kiosk', { packageName });
    return { ok: true, via: 'socket' };
  }
  return adbManager?.setKioskMode(serial, packageName);
});

// 키오스크 해제
ipcMain.handle('exit-kiosk', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    console.log('[Control] Sending EXIT_KIOSK via Socket to:', serial);
    socket.emit('exit_kiosk');
    return { ok: true, via: 'socket' };
  }
  return adbManager?.exitKioskMode(serial);
});

// 볼륨 제어
ipcMain.handle('set-volume', async (_, serial, level) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    console.log('[Control] Sending VOLUME via Socket to:', serial, level);
    socket.emit('volume', level);
    return { ok: true, via: 'socket' };
  }
  return adbManager?.setVolume(serial, level);
});

// 앱 목록 조회
ipcMain.handle('get-apps', async (_, serial) => {
  return adbManager?.getInstalledApps(serial);
});

// 앱 강제 종료
ipcMain.handle('force-stop-app', async (_, serial, packageName) => {
  return adbManager?.forceStopApp(serial, packageName);
});

// 앱 강제 삭제 (원격 앱 제거)
ipcMain.handle('uninstall-app', async (_, serial, packageName) => {
  return adbManager?.uninstallApp(serial, packageName);
});

// 배터리 정보
ipcMain.handle('get-battery', async (_, serial) => {
  return adbManager?.getBattery(serial);
});

// WiFi ADB 연결
ipcMain.handle('connect-wifi', async (_, ip, port) => {
  return adbManager?.connectWifi(ip, port ?? 5555);
});

// 알림 및 메시지 전송
ipcMain.handle('send-message', async (_, serial, message) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    console.log('[Control] Sending MESSAGE via Socket to:', serial, message);
    socket.emit('message', message);
    return { ok: true, via: 'socket' };
  }
  return adbManager?.sendToast(serial, message);
});

// 다중 파일 전송
ipcMain.handle('distribute-file', async (event, filePath, targetSerials, options) => {
  try {
    const fileName = path.basename(filePath);
    const destPath = path.join(sharedDir, fileName);
    
    // 1. 스트림을 사용하여 파일을 복사하면서 진행률 이벤트 전송
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    let copiedSize = 0;
    
    const readStream = fs.createReadStream(filePath);
    const writeStream = fs.createWriteStream(destPath);
    
    await new Promise((resolve, reject) => {
      readStream.on('data', (chunk) => {
        copiedSize += chunk.length;
        const progress = Math.round((copiedSize / totalSize) * 100);
        mainWindow?.webContents.send('distribute-progress', { progress, state: 'copying' });
      });
      
      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      
      readStream.pipe(writeStream);
    });
    
    // 2. 어드민 PC의 현재 IP 주소 확인 및 도메인 분기 처리
    const ip = require('os').networkInterfaces();
    let localIp = '127.0.0.1';
    for (const devName in ip) {
      const iface = ip[devName];
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          localIp = alias.address;
          break;
        }
      }
    }
    
    const serverHost = options?.serverIp || localIp;
    const fileUrl = serverHost.includes('ngrok-free') || serverHost.includes('loca.lt')
      ? `https://${serverHost}/shared/${encodeURIComponent(fileName)}`
      : `http://${serverHost}:3010/shared/${encodeURIComponent(fileName)}`;
      
    console.log('[Control] Distributing file:', fileUrl, 'to:', targetSerials, 'options:', options);
    
    // 3. 대상 시리얼 번호 목록에 해당하는 소켓에 이벤트 발송
    let sentCount = 0;
    for (const serial of targetSerials) {
      const socket = tabletSockets.get(serial);
      if (socket) {
        socket.emit('file-distribute', { fileUrl, fileName, createShortcut: options?.createShortcut });
        sentCount++;
      }
    }
    
    return { ok: true, sentCount, fileUrl };
  } catch (err) {
    console.error('File distribution error:', err);
    return { ok: false, error: err.message };
  }
});

// 기기 네임텍 (별명) 설정 핸들러 추가
ipcMain.handle('set-device-alias', async (_, serial, alias) => {
  try {
    adbManager.setDeviceAlias(serial, alias);
    return { ok: true };
  } catch (err) {
    console.error('Set device alias error:', err);
    return { ok: false, error: err.message };
  }
});

// 실시간 기기 위치 쿼리 핸들러 추가 (Device Owner 불필요)
ipcMain.handle('get-device-location', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (!socket) {
    return { ok: false, error: '태블릿이 소켓 서버에 오프라인 상태입니다.' };
  }
  return new Promise((resolve) => {
    // 소켓으로 위치 요청 전송
    socket.emit('get-location');
    
    // 1회성 응답 리스너 (10초 타임아웃)
    const timeout = setTimeout(() => {
      socket.removeAllListeners('location-response');
      resolve({ ok: false, error: '태블릿 응답 시간 초과 (GPS 비활성화 또는 신호 지연)' });
    }, 10000);
    
    socket.once('location-response', (data) => {
      clearTimeout(timeout);
      socket.removeAllListeners('location-response');
      if (data.error) {
        resolve({ ok: false, error: data.error });
      } else {
        resolve({ ok: true, lat: data.lat, lng: data.lng });
      }
    });
  });
});

// 실시간 화면 미러링 개시 (Device Owner 불필요)
ipcMain.handle('start-mirror', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('start-mirror');
    return { ok: true };
  }
  return { ok: false, error: '태블릿이 소켓 서버에 오프라인 상태입니다.' };
});

// 실시간 화면 미러링 종료
ipcMain.handle('stop-mirror', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('stop-mirror');
    return { ok: true };
  }
  return { ok: false, error: '태블릿이 소켓 서버에 오프라인 상태입니다.' };
});

// 서버 IP 조회
ipcMain.handle('get-server-ip', async () => {
  const ip = require('os').networkInterfaces();
  let localIp = '127.0.0.1';
  for (const devName in ip) {
    const iface = ip[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        localIp = alias.address;
        break;
      }
    }
  }
  return localIp;
});
