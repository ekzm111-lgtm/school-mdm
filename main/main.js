const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const AdbManager = require('./adb');

let mainWindow;
let adbManager;

// ─── ngrok 자동 시작 · 워치독 ───────────────────────────
const NGROK_URL  = 'https://nonepithelial-unbased-reece.ngrok-free.dev';
const NGROK_PORT = 3010;
// 다른 PC에서도 ngrok이 구동되도록 본인의 ngrok authtoken을 여기에 입력하세요.
// 공백으로 둘 경우 시스템에 등록된 글로벌 토큰을 사용합니다.
const NGROK_AUTHTOKEN = '3Ankmw3lih9mgVp7WXc3llWLQug_4WxJzoG51aDaso6GLUzE'; 
let ngrokProc    = null;
let ngrokRestartTimer = null;

/**
 * ngrok 바이너리 경로 결정:
 *   1순위 — EXE 패키징 시 resources/ngrok.exe (번들, 어떤 PC에도 설치 불필요)
 *   2순위 — 개발 환경: 프로젝트 루트 resources/ngrok.exe
 *   3순위 — 시스템 PATH의 ngrok (fallback)
 */
function resolveNgrokBin() {
  const fs = require('fs');
  // 패키징된 Portable EXE 실행 시
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'resources', 'ngrok.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // 개발 환경 (npm run dev)
  const devPath = path.join(__dirname, '..', 'resources', 'ngrok.exe');
  if (fs.existsSync(devPath)) return devPath;
  // 최후 fallback: 시스템에 ngrok 설치돼 있으면
  return process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
}

function startNgrok() {
  if (ngrokProc) return;
  const ngrokBin = resolveNgrokBin();
  console.log('[ngrok] 터널 시작... 바이너리:', ngrokBin);

  const args = [
    'http', String(NGROK_PORT),
    '--url=' + NGROK_URL,
    '--log=stdout'
  ];

  if (NGROK_AUTHTOKEN) {
    args.push('--authtoken=' + NGROK_AUTHTOKEN);
  }

  ngrokProc = spawn(ngrokBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  ngrokProc.stdout.on('data', (d) => console.log('[ngrok]', d.toString().trim()));
  ngrokProc.stderr.on('data', (d) => console.error('[ngrok ERR]', d.toString().trim()));

  ngrokProc.on('exit', (code) => {
    console.log('[ngrok] 프로세스 종료 (code:', code, ') — 5초 후 자동 재시작');
    ngrokProc = null;
    if (!app.isQuitting) {
      ngrokRestartTimer = setTimeout(startNgrok, 5000);
    }
  });
}

function stopNgrok() {
  clearTimeout(ngrokRestartTimer);
  if (ngrokProc) {
    ngrokProc.kill();
    ngrokProc = null;
  }
}

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
const pendingClearRequests = new Map(); // serial -> resolve
const pendingLocationRequests = new Map(); // serial -> resolve
const pendingAppListRequests = new Map(); // serial -> resolve
const pendingUninstallRequests = new Map(); // serial -> resolve

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
    // 등록 즉시 UI 갱신
    mainWindow?.webContents.send('device-update', adbManager?.getDevices() ?? []);
  });

  // 태블릿이 주기적으로 보내는 배터리/IP 하트비트
  socket.on('heartbeat', (data) => {
    const { serial, battery, charging, ip } = data || {};
    if (!serial) return;
    const existing = socketDevices.get(serial);
    if (!existing) return;
    const updated = {
      ...existing,
      battery:  battery  != null ? battery  : existing.battery,
      charging: charging != null ? charging : existing.charging,
      ip:       ip       || existing.ip,
      lastSeen: new Date().toISOString()
    };
    socketDevices.set(serial, updated);
    adbManager?.setSocketDevices(socketDevices);
    // UI 실시간 반영
    mainWindow?.webContents.send('device-update', adbManager?.getDevices() ?? []);
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

  socket.on('clear-download-done', (data) => {
    console.log('[Socket] Received clear-download-done:', data);
    const { serial } = data || {};
    if (serial) {
      const resolve = pendingClearRequests.get(serial);
      if (resolve) {
        pendingClearRequests.delete(serial);
        resolve({
          ok: data.success !== false,
          deleted: data.deleted ?? 0,
          error: data.error
        });
      }
    }
  });

  socket.on('location-response', (data) => {
    console.log('[Socket] Received location-response:', data);
    const { serial } = data || {};
    if (serial) {
      const resolve = pendingLocationRequests.get(serial);
      if (resolve) {
        pendingLocationRequests.delete(serial);
        if (data.error) {
          resolve({ ok: false, error: data.error });
        } else {
          resolve({ ok: true, lat: data.lat, lng: data.lng });
        }
      }
    }
  });

  socket.on('app-list-response', (data) => {
    console.log('[Socket] Received app-list-response:', data);
    const { serial } = data || {};
    if (serial) {
      const resolve = pendingAppListRequests.get(serial);
      if (resolve) {
        pendingAppListRequests.delete(serial);
        resolve(data.apps || []);
      }
    }
  });

  socket.on('uninstall-done', (data) => {
    console.log('[Socket] Received uninstall-done:', data);
    const { serial } = data || {};
    if (serial) {
      const resolve = pendingUninstallRequests.get(serial);
      if (resolve) {
        pendingUninstallRequests.delete(serial);
        resolve({ ok: data.success, error: data.error });
      }
    }
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
    const locationResult = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingLocationRequests.delete(serial);
        resolve({ ok: false, error: '태블릿 응답 시간 초과 (GPS가 꺼져있을 수 있습니다)' });
      }, 10000);

      pendingLocationRequests.set(serial, resolve);
      socket.emit('get-location');
    });

    if (locationResult.ok) {
      res.json({ ok: true, lat: locationResult.lat, lng: locationResult.lng });
    } else {
      res.status(400).json({ ok: false, error: locationResult.error });
    }
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

// 일반 브라우저 관리자를 위한 기기 위치 카테고리 (그룹) 변경 API
expressApp.post('/devices/group', async (req, res) => {
  const { serial, group } = req.body;
  try {
    adbManager.setDeviceGroup(serial, group);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 일반 브라우저 관리자를 위한 다운로드 폴더 전체 비우기 API
expressApp.post('/devices/clear-download', async (req, res) => {
  const { serial } = req.body;
  try {
    const result = await adbManager.clearDownloadFolder(serial);
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
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/out/index.html'));
  }
  mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  createWindow();
  adbManager = new AdbManager();
  await adbManager.init();

  // ngrok 자동 시작 (프로그램 켜질 때마다 자동 터널 연결)
  startNgrok();

  // ADB + Socket 기기 연동 이벤트 전달
  adbManager.on('device-update', (devices) => {
    mainWindow?.webContents.send('device-update', devices);
  });
  adbManager.startPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 앱 종료 전 ngrok 정리
app.on('before-quit', () => {
  app.isQuitting = true;
  stopNgrok();
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

// 앱 목록 조회 (소켓 우선, ADB 폴백)
ipcMain.handle('get-apps', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingAppListRequests.delete(serial);
        resolve([]);
      }, 8000);
      pendingAppListRequests.set(serial, resolve);
      socket.emit('get-app-list');
    });
  }
  return adbManager?.getInstalledApps(serial) ?? [];
});

// 앱 강제 종료 (소켓 우선)
ipcMain.handle('force-stop-app', async (_, serial, packageName) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('force-stop-app', { packageName });
    return { ok: true, via: 'socket' };
  }
  return adbManager?.forceStopApp(serial, packageName);
});

// 앱 강제 삭제 (소켓 우선)
ipcMain.handle('uninstall-app', async (_, serial, packageName) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingUninstallRequests.delete(serial);
        resolve({ ok: false, error: 'timeout' });
      }, 15000);
      pendingUninstallRequests.set(serial, resolve);
      socket.emit('uninstall-app', { packageName });
    });
  }
  return adbManager?.uninstallApp(serial, packageName);
});

// 다운로드 폴더 비우기 (소켓 우선, ADB 폴백)
ipcMain.handle('clear-download-folder', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingClearRequests.delete(serial);
        resolve({ ok: false, error: '태블릿 응답 시간 초과 (소켓 연결 불안정)' });
      }, 30000);

      pendingClearRequests.set(serial, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      socket.emit('clear-download');
    });
  }
  // 소켓 연결이 없는 오프라인 상태일 때만 ADB fallback 시도
  return adbManager?.clearDownloadFolder(serial);
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

// 기기 위치 카테고리 (그룹) 설정 핸들러 추가
ipcMain.handle('set-device-group', async (_, serial, group) => {
  try {
    adbManager.setDeviceGroup(serial, group);
    return { ok: true };
  } catch (err) {
    console.error('Set device group error:', err);
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
    const timeout = setTimeout(() => {
      pendingLocationRequests.delete(serial);
      resolve({ ok: false, error: '태블릿 응답 시간 초과 (GPS 비활성화 또는 신호 지연)' });
    }, 20000);
    
    pendingLocationRequests.set(serial, resolve);
    socket.emit('get-location');
  });
});

ipcMain.handle('find-device', async (_, serial) => {
  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('find-device');
    return { ok: true };
  }
  return { ok: false, error: '태블릿이 소켓 서버에 오프라인 상태입니다.' };
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

