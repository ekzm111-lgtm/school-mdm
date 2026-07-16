process.env.UV_THREADPOOL_SIZE = 64;
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const AdbManager = require('./adb');

let mainWindow;
let adbManager;

const fs = require('fs');
let logFile;

function writeLog(message) {
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('userData'), 'mdm_debug.log');
      console.log('====== DEBUG LOG FILE PATH ======');
      console.log(logFile);
      console.log('=================================');
    }
    const timeStr = new Date().toISOString();
    const logMsg = `[${timeStr}] ${message}\n`;
    console.log(logMsg.trim());
    fs.appendFile(logFile, logMsg, 'utf8', (err) => {
      if (err) console.error('[Log] Failed to write debug log:', err);
    });
  } catch (e) {
    console.error('[Log] Logging error:', e);
  }
}

// ─── Cloudflare Tunnel 자동 시작 · 워치독 ────────────────
// ngrok 대비 장점: 대역폭 제한 없음, 완전 무료, 계정 불필요
const CF_PORT = 3010;
let cfProc = null;
let cfRestartTimer = null;
let cfTunnelUrl = null; // 동적으로 파싱된 공개 URL

/**
 * cloudflared 바이너리 경로 결정:
 *   1순위 — EXE 패키징 시 resources/cloudflared.exe
 *   2순위 — 개발 환경: 프로젝트 루트 resources/cloudflared.exe
 *   3순위 — 시스템 PATH의 cloudflared (fallback)
 */
function resolveCfBin() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'resources', 'cloudflared.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const devPath = path.join(__dirname, '..', 'resources', 'cloudflared.exe');
  if (fs.existsSync(devPath)) return devPath;
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function startNgrok() {
  if (cfProc) return;
  const cfBin = resolveCfBin();
  console.log('[CF] Cloudflare Tunnel 시작... 바이너리:', cfBin);

  cfTunnelUrl = null;

  cfProc = spawn(cfBin, [
    'tunnel', '--url', `http://localhost:${CF_PORT}`, '--no-autoupdate'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  // stdout/stderr 모두 URL 정보가 담길 수 있음
  const onData = (d) => {
    const text = d.toString();
    console.log('[CF]', text.trim());
    // trycloudflare.com URL 파싱
    const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
    if (match && !cfTunnelUrl) {
      cfTunnelUrl = match[0];
      console.log('[CF] ✅ 터널 URL 감지:', cfTunnelUrl);
      // 현재 연결된 모든 소켓 기기에게 새 URL 브로드캐스트
      io.emit('tunnel-url-changed', { url: cfTunnelUrl });
    }
  };

  cfProc.stdout.on('data', onData);
  cfProc.stderr.on('data', onData);

  cfProc.on('exit', (code) => {
    console.log('[CF] 프로세스 종료 (code:', code, ') — 5초 후 자동 재시작');
    cfProc = null;
    cfTunnelUrl = null;
    if (!app.isQuitting) {
      cfRestartTimer = setTimeout(startNgrok, 5000);
    }
  });
}

function stopNgrok() {
  clearTimeout(cfRestartTimer);
  if (cfProc) {
    cfProc.kill();
    cfProc = null;
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
const distributionQueue = new Map(); // serial -> { fileUrl, fileName, createShortcut }

// ─── 네트워크 모드 관리 ─────────────────────────────
// 'local'  : 같은 WiFi망 → 태블릿이 로컬 IP로 직접 연결 (빠름, 방화벽 불필요)
// 'external': 외부망/유선망 → Cloudflare Tunnel 경유 (학교 외부 or 유선 PC)
let networkMode = 'external'; // 기본값: 외부망 (Cloudflare)

function getLocalIp() {
  const ifaces = require('os').networkInterfaces();
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// 현재 모드에 맞는 서버 URL 반환
function getServerUrl() {
  if (networkMode === 'local') return `http://${getLocalIp()}:3010`;
  return cfTunnelUrl || `http://${getLocalIp()}:3010`; // 터널 없으면 로컬 폴백
}

io.on('connection', (socket) => {
  writeLog(`[Socket] Client connected. SocketID: ${socket.id}, IP: ${socket.handshake.address}`);

  // 태블릿 클라이언트 등록
  socket.on('register', (deviceInfo) => {
    const { serial } = deviceInfo;
    if (!serial) {
      writeLog(`[Socket] Register rejected - missing serial. SocketID: ${socket.id}`);
      return;
    }
    
    writeLog(`[Socket] Device registered. Serial: ${serial}, Model: ${deviceInfo.model || 'Unknown'}, SocketID: ${socket.id}`);
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

    // 등록 즉시 현재 네트워크 모드 & 서버 URL 전달
    socket.emit('server-config', { mode: networkMode, url: getServerUrl(), localUrl: `http://${getLocalIp()}:3010` });

    // ⭐ 추가: 이 기기가 대기 큐에 있으면 온라인 되자마자 즉시 전송
    const queued = distributionQueue.get(serial);
    if (queued) {
      socket.emit('file-distribute', queued);
      distributionQueue.delete(serial);
      console.log('[Queue] 온라인 감지, 즉시 전송:', serial);
    }
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
    let serialFound = 'Unknown';
    for (const [serial, s] of tabletSockets.entries()) {
      if (s.id === socket.id) {
        serialFound = serial;
        tabletSockets.delete(serial);
        const info = socketDevices.get(serial);
        if (info) {
          socketDevices.set(serial, { ...info, state: 'offline' });
        }
        break;
      }
    }
    writeLog(`[Socket] Client disconnected. SocketID: ${socket.id}, Serial: ${serialFound}`);
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

// 태블릿이 현재 Cloudflare Tunnel URL을 조회하는 API
expressApp.get('/tunnel-url', (req, res) => {
  res.json({ url: cfTunnelUrl || null });
});

// 태블릿 최초 접속 시 서버 연결 설정 조회 (로컬 IP 경유)
expressApp.get('/server-config', (req, res) => {
  res.json({
    mode: networkMode,
    url: getServerUrl(),
    localUrl: `http://${getLocalIp()}:3010`,
    externalUrl: cfTunnelUrl || null
  });
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

  // Cloudflare Tunnel 자동 시작 (프로그램 켜질 때마다 자동 터널 연결)
  startNgrok();

  // ADB + Socket 기기 연동 이벤트 전달
  adbManager.on('device-update', (devices) => {
    const onlineCount = devices.filter(d => d.state === 'online').length;
    writeLog(`[Update] UI Update pushed. Total devices: ${devices.length}, Online: ${onlineCount}`);
    mainWindow?.webContents.send('device-update', devices);
  });
  adbManager.startPolling(5000);

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
    // Cloudflare Tunnel이 활성화된 경우 우선 사용 (대역폭 무제한)
    const fileUrl = cfTunnelUrl
      ? `${cfTunnelUrl}/shared/${encodeURIComponent(fileName)}`
      : serverHost.includes('trycloudflare') || serverHost.includes('ngrok-free') || serverHost.includes('loca.lt')
        ? `https://${serverHost}/shared/${encodeURIComponent(fileName)}`
        : `http://${serverHost}:3010/shared/${encodeURIComponent(fileName)}`;
      
    console.log('[Control] Distributing file:', fileUrl, 'to:', targetSerials, 'options:', options);
    
    // 3. 대상 시리얼 번호 목록에 해당하는 소켓에 이벤트 발송 (오프라인인 기기는 큐에 저장)
    let sentCount = 0;
    for (const serial of targetSerials) {
      const socket = tabletSockets.get(serial);
      const payload = { fileUrl, fileName, createShortcut: options?.createShortcut };
      if (socket) {
        socket.emit('file-distribute', payload);
        sentCount++;
      } else {
        // ⭐ 오프라인이면 큐에 저장, 온라인 되는 즉시 위 register 핸들러가 자동 전송
        distributionQueue.set(serial, payload);
      }
    }
    
    return { ok: true, sentCount, queuedCount: distributionQueue.size, fileUrl };
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

// 서버 설정 조회 (모드에 따른 URL 포함)
ipcMain.handle('get-server-config', async () => {
  return { mode: networkMode, url: getServerUrl(), localUrl: `http://${getLocalIp()}:3010`, externalUrl: cfTunnelUrl || null };
});

// ─── 네트워크 모드 전환 ─────────────────────────────────
// 'local': 같은 WiFi → 로컬 IP 직접 연결
// 'external': 외부망 → Cloudflare Tunnel
ipcMain.handle('set-network-mode', async (_, mode) => {
  networkMode = mode === 'local' ? 'local' : 'external';
  const serverUrl = getServerUrl();
  console.log(`[Mode] 네트워크 모드 변경: ${networkMode}, URL: ${serverUrl}`);
  // 현재 연결된 모든 태블릿에 새 설정 브로드캐스트
  io.emit('server-config', {
    mode: networkMode,
    url: serverUrl,
    localUrl: `http://${getLocalIp()}:3010`,
    externalUrl: cfTunnelUrl || null
  });
  return { ok: true, mode: networkMode, url: serverUrl };
});

ipcMain.handle('get-network-mode', async () => {
  return { mode: networkMode, url: getServerUrl(), localUrl: `http://${getLocalIp()}:3010`, externalUrl: cfTunnelUrl || null };
});

// ─── APK 자동 빌드 & 전체 태블릿 배포 ─────────────────────
ipcMain.handle('build-and-deploy-apk', async () => {
  const androidDir = path.join(__dirname, '..', '..', 'School-MDM-Android');
  const javaHome = 'C:\\Users\\User\\AppData\\Local\\Android\\jdk\\jdk-17.0.8.1+1';
  const apkSrc  = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const apkDest = path.join(__dirname, '..', 'resources', 'apk', 'app-debug.apk');

  if (!fs.existsSync(androidDir)) {
    return { ok: false, error: 'School-MDM-Android 폴더를 찾을 수 없습니다.' };
  }

  mainWindow?.webContents.send('build-progress', { step: 'building', progress: 0, message: '빌드 시작...' });

  return new Promise((resolve) => {
    const env = { ...process.env, JAVA_HOME: javaHome };
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    const buildProc = spawn(gradlew, ['assembleDebug', '--quiet'], {
      cwd: androidDir, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    buildProc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) mainWindow?.webContents.send('build-progress', { step: 'building', progress: 50, message: msg });
    });
    buildProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[Build]', msg);
    });

    buildProc.on('exit', (code) => {
      if (code !== 0) {
        mainWindow?.webContents.send('build-progress', { step: 'error', progress: 0, message: `빌드 실패 (code: ${code})` });
        return resolve({ ok: false, error: `빌드 실패 (exit code: ${code})` });
      }

      // APK를 resources로 복사
      try {
        fs.copyFileSync(apkSrc, apkDest);
      } catch (e) {
        return resolve({ ok: false, error: `APK 복사 실패: ${e.message}` });
      }

      mainWindow?.webContents.send('build-progress', { step: 'deploying', progress: 80, message: '태블릿에 배포 중...' });

      // 서버 URL 기반으로 APK 다운로드 URL 생성
      const serverUrl = getServerUrl();
      const apkUrl = `${serverUrl}/apk`;

      // 현재 연결된 모든 태블릿에 업데이트 알림
      let sentCount = 0;
      for (const [serial, socket] of tabletSockets.entries()) {
        socket.emit('apk-update', { apkUrl, version: new Date().toISOString() });
        sentCount++;
      }

      mainWindow?.webContents.send('build-progress', { step: 'done', progress: 100, message: `완료! ${sentCount}대에 배포됨` });
      console.log(`[Build] APK 배포 완료. ${sentCount}대 전송됨. URL: ${apkUrl}`);
      resolve({ ok: true, sentCount, apkUrl });
    });
  });
});

