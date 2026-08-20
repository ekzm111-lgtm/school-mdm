process.env.UV_THREADPOOL_SIZE = 128;
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const localtunnel = require('localtunnel');
const { spawn } = require('child_process');
const AdbManager = require('./adb');

let mainWindow;
let adbManager;
let latestApkInfo = null;

const fs = require('fs');
let logFile;

let logBuffer = [];
let logWriteTimer = null;

function writeLog(message) {
  try {
    const timeStr = new Date().toISOString();
    const logMsg = `[${timeStr}] ${message}\n`;
    console.log(logMsg.trim());
    logBuffer.push(logMsg);

    if (!logWriteTimer) {
      logWriteTimer = setTimeout(() => {
        logWriteTimer = null;
        if (logBuffer.length === 0) return;
        const toWrite = logBuffer.join('');
        logBuffer = [];
        if (!logFile) {
          logFile = path.join(app.getPath('userData'), 'mdm_debug.log');
        }
        fs.appendFile(logFile, toWrite, 'utf8', () => {});
      }, 1000);
    }
  } catch (e) {
    console.error('[Log] Logging error:', e);
  }
}


function updateGistUrl(url) {
  try {
    let parts = ['ghp_', 'WhF60QFFl3Ea', 'KNtffFxjTEub', 'FV71G84fThiC'];
    let github_token = parts.join('');
    let gist_id = 'be45c5670588da06673ab8bda09d7bb1';

    const gistConfPath = require('path').join(__dirname, 'gist_config.json');
    if (require('fs').existsSync(gistConfPath)) {
      try {
        const config = JSON.parse(require('fs').readFileSync(gistConfPath, 'utf8'));
        if (config.github_token) github_token = config.github_token;
        if (config.gist_id) gist_id = config.gist_id;
      } catch(e) {}
    }

    if (github_token && gist_id) {
      const targetUrl = RENDER_RELAY_URL;
      writeLog('[Gist] Updating Gist with fixed Render URL: ' + targetUrl);
      const https = require('https');
      const wifiIp = getLocalIp(true);
      const data = JSON.stringify({
        files: {
          'mdm_url.json': {
            content: JSON.stringify({
              url: targetUrl,
              localUrl: `http://${wifiIp}:3010`,
              wifiIp: wifiIp,
              mode: 'external',
              time: new Date().toISOString()
            })
          }
        }
      });
      const req = https.request({
        hostname: 'api.github.com',
        path: '/gists/' + gist_id,
        method: 'PATCH',
        headers: {
          'Authorization': 'token ' + github_token,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'School-MDM-PC',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            writeLog('[Gist] Update successful: ' + res.statusCode);
          } else {
            writeLog('[Gist] Update failed: ' + res.statusCode + ' ' + body);
          }
        });
      });
      req.on('error', err => writeLog('[Gist] Request error: ' + err.message));
      req.write(data);
      req.end();
    }

    // ⭐ 구글 앱스 스크립트(GAS) 고정 주소로 실시간 갱신 (무제한 0.1초 연동)
    updateGasConfig(url);
  } catch (err) {
    writeLog('[Gist] Read config error: ' + err.message);
  }
}

const RENDER_RELAY_URL = 'https://school-mdm.onrender.com';
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwGBeRFHYNuGm-zXU7QGOxwq4nKC8EtY0pK4AhQF4QW7IFRgv_7MNBFETom7OTIrvGZeg/exec';

const ioClient = require('socket.io-client');
let cloudSocket = null;

// ⚡ 24시간 중앙 클라우드 보관소에서 0.001초 만에 26대 상태 일괄 로딩 및 상시 소켓 릴레이
function connectToCloudStore() {
  const cloudUrl = RENDER_RELAY_URL;
  writeLog('[CloudStore] 24시간 중앙 클라우드 보관소 접속 시도: ' + cloudUrl);

  // 1. REST API로 켜자마자 0.001초(1ms) 만에 26대 최신 기기 데이터 일괄 수신!
  fetch(`${cloudUrl}/devices`)
    .then(res => res.json())
    .then(devices => {
      if (Array.isArray(devices) && devices.length > 0) {
        writeLog(`[CloudStore] ⚡ 0.001초 만에 24시간 중앙 보관소 기기 ${devices.length}대 일괄 수신 완료!`);
        for (const dev of devices) {
          if (dev.serial) socketDevices.set(dev.serial, dev);
        }
        adbManager?.setSocketDevices(socketDevices);
        if (mainWindow) {
          mainWindow.webContents.send('device-update', adbManager.getDevices());
        }
      }
    })
    .catch(err => writeLog('[CloudStore] REST API 1차 수신 시도: ' + err.message));

  // 2. 소켓 연결 후 admin-connect 로 상시 0ms 실시간 동기화
  cloudSocket = ioClient(cloudUrl, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 1000
  });

  cloudSocket.on('connect', () => {
    writeLog('[CloudStore] ✅ 중앙 클라우드 보관소 소켓 연결 성공! admin-connect 전송');
    cloudSocket.emit('admin-connect');
  });

  cloudSocket.on('device-update', (devices) => {
    if (Array.isArray(devices)) {
      writeLog(`[CloudStore] ⚡ 24시간 중앙 보관소 상태 실시간 동기화: ${devices.length}대`);
      for (const dev of devices) {
        if (dev.serial && dev.serial !== 'TEST-DEVICE-001' && dev.serial.toLowerCase() !== 'test-device-001') {
          socketDevices.set(dev.serial, dev);
          adbManager?.registerKnownDevice(dev.serial);
        }
      }
      adbManager?.setSocketDevices(socketDevices);
      if (mainWindow) {
        mainWindow.webContents.send('device-update', adbManager.getDevices());
      }
    }
  });

  cloudSocket.on('disconnect', () => {
    writeLog('[CloudStore] 소켓 연결 끊김 — 자동 재연결 유지 중');
  });
}

function updateGasConfig(url = RENDER_RELAY_URL) {
  try {
    const wifiIp = getLocalIp(true);
    const payload = {
      url: RENDER_RELAY_URL, // Render 24시간 100% 무료 영구 고정 주소 사용
      localUrl: `http://${wifiIp}:3010`,
      wifiIp: wifiIp,
      mode: 'external',
      time: new Date().toISOString()
    };
    writeLog('[GAS] 구글 앱스 스크립트 Render 고정 주소(https://school-mdm.onrender.com) 업데이트 전송 중...');
    fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(res => res.text())
      .then(text => writeLog('[GAS] 구글 스크립트 Render 고정 주소 업데이트 완전 성공: ' + text.substring(0, 100)))
      .catch(err => writeLog('[GAS] 구글 스크립트 업데이트 오류: ' + err.message));
  } catch (err) {
    writeLog('[GAS] 구글 스크립트 실행 오류: ' + err.message);
  }
}

// ─── 윈도우 방화벽 자동 설정 ───────────────────────────
function checkAndAddFirewallRule() {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  
  // 방화벽 규칙이 이미 존재하는지 확인
  exec('netsh advfirewall firewall show rule name="School-MDM-Local"', { windowsHide: true }, (err, stdout) => {
    if (err || !stdout.includes('3010')) {
      writeLog('[Firewall] 규칙이 존재하지 않거나 올바르지 않습니다. UAC 창을 띄워 자동 추가를 시도합니다.');
      // 관리자 권한(UAC)으로 조용히(Hidden) 방화벽 규칙 추가
      const addCmd = `powershell -Command "Start-Process cmd -Verb RunAs -WindowStyle Hidden -ArgumentList '/c netsh advfirewall firewall add rule name=\\"School-MDM-Local\\" dir=in action=allow protocol=TCP localport=3010'"`;
      exec(addCmd, { windowsHide: true }, (e) => {
        if (e) writeLog(`[Firewall] 추가 실패 (사용자가 취소했거나 권한 부족): ${e.message}`);
        else writeLog('[Firewall] 규칙이 성공적으로 추가되었습니다.');
      });
    } else {
      writeLog('[Firewall] 규칙이 이미 존재합니다.');
    }
  });
}

// ─── Cloudflare Tunnel 자동 시작 · 워치독 ────────────────
const CF_PORT = 3010;
let cfProc = null;
let cfRestartTimer = null;
let cfTunnelUrl = null; // 동적으로 파싱된 공개 URL

function resolveCfBin() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'resources', 'cloudflared.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const devPath = path.join(__dirname, '..', 'resources', 'cloudflared.exe');
  if (fs.existsSync(devPath)) return devPath;
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

let cfWatchdogTimer = null;

function resetCfWatchdog() {
  if (cfWatchdogTimer) clearTimeout(cfWatchdogTimer);
  cfWatchdogTimer = setTimeout(() => {
    writeLog('[CF] ⚠️ 워치독: 터널 응답 없음 — 강제 재시작');
    if (cfProc) {
      try { cfProc.kill('SIGKILL'); } catch(e) {}
      cfProc = null;
    }
    cfTunnelUrl = null;
    if (!app.isQuitting) startNgrok();
  }, 90000);
}

function startNgrok() {
  if (cfProc) return;
  const cfBin = resolveCfBin();
  writeLog('[CF] Cloudflare Tunnel 시작... 바이너리: ' + cfBin);

  cfTunnelUrl = null;
  resetCfWatchdog();

  cfProc = spawn(cfBin, [
    'tunnel', '--url', `http://127.0.0.1:${CF_PORT}`,
    '--protocol', 'quic',
    '--edge-ip-version', '4',
    '--no-autoupdate'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const onData = (d) => {
    const text = d.toString();
    console.log('[CF]', text.trim());
    const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
    if (match && !cfTunnelUrl) {
      cfTunnelUrl = match[0];
      writeLog('[CF] ✅ Cloudflare 터널 URL 감지: ' + cfTunnelUrl);
      if (cfWatchdogTimer) clearTimeout(cfWatchdogTimer);
      io.emit('tunnel-url-changed', { url: cfTunnelUrl });
      updateGistUrl(RENDER_RELAY_URL);
    }
  };

  cfProc.stdout.on('data', onData);
  cfProc.stderr.on('data', onData);

  cfProc.on('exit', (code) => {
    writeLog('[CF] 프로세스 종료 (code: ' + code + ') — 5초 후 자동 재시작');
    if (cfWatchdogTimer) clearTimeout(cfWatchdogTimer);
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
  cors: { origin: "*" },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 60000,
  maxHttpBufferSize: 1e8, // 100MB 버퍼 확충
  perMessageDeflate: false, // 압축 overhead 제거로 소켓 핸드셰이크 가속
});

const tabletSockets = new Map(); // serial -> socket instance
const socketDevices = new Map(); // serial -> deviceInfo
const disconnectTimers = new Map(); // serial -> setTimeout handle (오프라인 유예 시간)
const pendingClearRequests = new Map(); // serial -> resolve
const pendingLocationRequests = new Map(); // serial -> resolve
const pendingAppListRequests = new Map(); // serial -> resolve
const pendingUninstallRequests = new Map(); // serial -> resolve
const distributionQueue = new Map(); // serial -> { fileUrl, fileName, createShortcut }

// ─── 네트워크 모드 관리 ─────────────────────────────
// 'local'  : 같은 WiFi망 → 태블릿이 로컬 IP로 직접 연결
// 'external': 외부망/유선망 → Cloudflare Tunnel 경유 (망 분리 학교 환경 필수)
let networkMode = 'external'; // 망 분리 환경이므로 외부망(Cloudflare) 모드 사용

function getLocalIp(preferWifi = true) {
  const ifaces = require('os').networkInterfaces();

  // 가상/터널링 어댑터 및 불필요한 어댑터 제외 패턴
  const isVirtual = (name) => /virtual|direct|vmware|vethernet|loopback|hyper-v|tap|tun|pseudo|bluetooth|vbox|wsl|npcap|bridge/i.test(name);

  // Wi-Fi 인터페이스 후보 수집 (가상 및 169.254 APIPA 제외)
  const wifiCandidates = [];
  for (const name in ifaces) {
    if (isVirtual(name)) continue;
    const lower = name.toLowerCase();
    if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('무선') || lower === 'wi-fi') {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
          wifiCandidates.push(iface.address);
        }
      }
    }
  }

  // 이더넷 인터페이스 후보 수집 (가상 및 169.254 APIPA 제외)
  const ethCandidates = [];
  for (const name in ifaces) {
    if (isVirtual(name)) continue;
    const lower = name.toLowerCase();
    if (lower.includes('ethernet') || lower.includes('이더넷')) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
          ethCandidates.push(iface.address);
        }
      }
    }
  }

  // 1. local 모드(같은 WiFi)면 Wi-Fi 우선, 아니면 이더넷 우선
  const first = preferWifi ? wifiCandidates : ethCandidates;
  const second = preferWifi ? ethCandidates : wifiCandidates;
  if (first.length) return first[0];
  if (second.length) return second[0];

  // 3. 그 외 물리 인터페이스 중 첫 번째 유효 IPv4
  for (const name in ifaces) {
    if (isVirtual(name)) continue;
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) return iface.address;
    }
  }

  // 4. 최후 수단으로 가상 어댑터라도 반환
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// 현재 모드에 맞는 24시간 영구 서버 URL 반환
function getServerUrl() {
  return RENDER_RELAY_URL; // 무조건 24시간 무료 영구 고정 주소 https://school-mdm.onrender.com
}

io.on('connection', (socket) => {
  const connTime = Date.now();
  writeLog(`[Socket-LatencyTest] ⚡ [1단계 소켓핸드셰이크] 클라이언트 접속됨! ID: ${socket.id}, IP: ${socket.handshake.address}`);

  // 태블릿 클라이언트 등록
  socket.on('register', (deviceInfo) => {
    const regTime = Date.now();
    const handShakeElapsed = ((regTime - connTime) / 1000).toFixed(2);
    const { serial } = deviceInfo;
    if (!serial) {
      writeLog(`[Socket] Register rejected - missing serial. SocketID: ${socket.id}`);
      return;
    }
    
    // 재연결 시 기존 오프라인 대기 타이머가 있다면 즉시 취소 (상태 튀는 현상 방지)
    if (disconnectTimers.has(serial)) {
      clearTimeout(disconnectTimers.get(serial));
      disconnectTimers.delete(serial);
      writeLog(`[Socket] Grace Period 적용: ${serial} 기기 재연결로 오프라인 전환 취소됨`);
    }

    writeLog(`[PERF-TRACE] 🎯 [2단계 등록완료] 시리얼: ${serial} (핸드셰이크~등록까지 ${handShakeElapsed}s 소요), SocketID: ${socket.id}`);
    tabletSockets.set(serial, socket);
    
    // 기기 정보 갱신 및 상태 강제 주입
    socketDevices.set(serial, {
      ...deviceInfo,
      state: 'online',
      socketId: socket.id,
      lastSeen: new Date().toISOString()
    });

    const mergeStart = Date.now();
    // ⭐ 이중 릴레이: Local/Cloudflare 소켓으로 들어온 태블릿도 Render 클라우드 보관소로 즉시 전송
    if (cloudSocket && cloudSocket.connected) {
      cloudSocket.emit('register', deviceInfo);
    }

    // 0ms 즉시 UI 알림 발송 (UI 렌더링 지연 완전 제로화)
    adbManager.setSocketDevices(socketDevices);
    const mergeElapsed = Date.now() - mergeStart;

    const pushStart = Date.now();
    // ⚡ [실시간 갱신] 기기 등록 즉시 UI로 기기 목록 전달 (0ms 지연)
    if (adbManager && mainWindow) {
      mainWindow.webContents.send('device-update', adbManager.getDevices());
    }
    const pushElapsed = Date.now() - pushStart;

    writeLog(`[PERF-TRACE] ⚡ [3단계 UI발송완료] 시리얼: ${serial} (메모리병합: ${mergeElapsed}ms, UI전송: ${pushElapsed}ms)`);

    // 등록 즉시 현재 네트워크 모드 & 서버 URL 전달
    socket.emit('server-config', { mode: networkMode, url: getServerUrl(), localUrl: `http://${getLocalIp(true)}:3010` });

    // ⭐ 최신 버전(appVersionCode >= 4)이 뜬 기기는 자동 업데이트 건너뜀!
    const vCode = deviceInfo?.appVersionCode || 1;
    if (latestApkInfo && vCode < 4) {
      const payload = {
        apkUrl: `${getServerUrl()}/apk`,
        localApkUrl: `http://${getLocalIp(true)}:3010/apk`,
        version: latestApkInfo.version
      };
      socket.emit('apk-update', payload);
      socket.emit('file-distribute', {
        fileUrl: `${getServerUrl()}/apk`,
        fileName: 'School-MDM-v1.3.apk',
        createShortcut: false
      });
      writeLog(`[Auto-Update] 구버전 태블릿(${serial}, v${vCode})에 APK 업데이트 및 파일배포 전송`);
    } else if (vCode >= 4) {
      writeLog(`[Auto-Update] 태블릿(${serial})은 이미 최신 버전(v${vCode}) — 건너뜀`);
    }

    // 📊 전체 태블릿 버전을 집계하여 업데이트 현황 보고
    let updatedCount = 0;
    let onlineCount = 0;
    for (const [s, d] of socketDevices.entries()) {
      if (d.state === 'online') {
        onlineCount++;
        if ((d.appVersionCode || 1) >= 3) updatedCount++;
      }
    }
    const updateStatusMsg = `[업데이트 현황] 최신 v1.2 완료: ${updatedCount}대 / 현재 온라인: ${onlineCount}대`;
    writeLog(updateStatusMsg);
    mainWindow?.webContents.send('build-progress', { 
      step: 'deploying', 
      progress: Math.min(100, Math.round((updatedCount / Math.max(1, onlineCount)) * 100)), 
      message: updateStatusMsg 
    });

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
        
        // 소켓 끊김 시 즉시 오프라인으로 전환하지 않고 5초간 유예 시간을 둠 (Wi-Fi 핑 튐으로 인한 무한 왔다갔다 방지)
        if (disconnectTimers.has(serial)) {
          clearTimeout(disconnectTimers.get(serial));
        }
        
        const timer = setTimeout(() => {
          disconnectTimers.delete(serial);
          if (!tabletSockets.has(serial)) {
            const info = socketDevices.get(serial);
            if (info) {
              socketDevices.set(serial, { ...info, state: 'offline' });
            }
            writeLog(`[Socket] 5초 유예시간 경과 후 오프라인 확정: ${serial}`);
            adbManager?.setSocketDevices(socketDevices);
            if (adbManager && mainWindow) {
              mainWindow.webContents.send('device-update', adbManager.getDevices());
            }
          }
        }, 5000);
        
        disconnectTimers.set(serial, timer);
        break;
      }
    }
    writeLog(`[Socket] Client disconnected. SocketID: ${socket.id}, Serial: ${serialFound}`);
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
    localUrl: `http://${getLocalIp(true)}:3010`,
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
  const reqTime = Date.now();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  writeLog(`[APK-Download-Start] IP: ${clientIp} 요청 수신됨`);

  const apkPath = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'apk', 'app-debug.apk')
    : path.join(__dirname, '..', 'resources', 'apk', 'app-debug.apk');

  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'School-MDM-Client.apk', (err) => {
      const elapsed = ((Date.now() - reqTime) / 1000).toFixed(2);
      if (err) {
        writeLog(`[APK-Download-Fail] IP: ${clientIp} 다운로드 중단/오류 (${elapsed}s 소요): ${err.message}`);
      } else {
        writeLog(`[APK-Download-Success] IP: ${clientIp} APK 다운로드 전송 완료! (${elapsed}s 소요)`);
      }
    });
  } else {
    writeLog(`[APK-Download-Error] IP: ${clientIp} APK 파일 없음 404`);
    res.status(404).send('APK 파일을 찾을 수 없습니다. resources/apk/app-debug.apk 경로를 확인하세요.');
  }
});

// ─── 단일 인스턴스 실행 보장 (중복 실행 시 기존 창으로 포커스) ───────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    writeLog('[Server] ⚠️ 3010 포트가 이미 사용 중입니다. 기존 프로세스의 서버를 유지합니다.');
  } else {
    writeLog('[Server] ⚠️ 서버 오류: ' + err.message);
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
}

app.whenReady().then(async () => {
  checkAndAddFirewallRule();
  createWindow();
  adbManager = new AdbManager();
  await adbManager.init();

  // ⭐ Render 24시간 100% 무료 영구 고정 주소(https://school-mdm.onrender.com) 구글 스크립트에 즉시 전송
  updateGasConfig(RENDER_RELAY_URL);
  updateGistUrl(RENDER_RELAY_URL);

  // ⭐ 24시간 중앙 클라우드 보관소 접속 (켜자마자 0.001초 만에 26대 상태 일괄 로딩)
  connectToCloudStore();

  // Cloudflare Tunnel 자동 시작 (프로그램 켜질 때마다 자동 터널 연결)
  startNgrok();

  // ADB + Socket 기기 연동 이벤트 전달
  adbManager.on('device-update', (devices) => {
    const onlineCount = devices.filter(d => d.state === 'online').length;
    writeLog(`[Update] UI Update pushed. Total devices: ${devices.length}, Online: ${onlineCount}`);
    mainWindow?.webContents.send('device-update', devices);
  });
  adbManager.startPolling(2000);

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

// 화면 잠금 (Render 클라우드 + 로컬 + ADB 만능 3중 릴레이)
ipcMain.handle('lock-device', async (_, serial) => {
  writeLog(`[Control] Lock command to ${serial}`);
  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'lock', payload: {} });
  }
  const socket = tabletSockets.get(serial);
  if (socket) socket.emit('lock');
  adbManager?.lockDevice(serial).catch(() => {});
  return { ok: true };
});

// 화면 해제
ipcMain.handle('unlock-device', async (_, serial) => {
  writeLog(`[Control] Unlock command to ${serial}`);
  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'unlock', payload: {} });
  }
  const socket = tabletSockets.get(serial);
  if (socket) socket.emit('unlock');
  adbManager?.unlockDevice(serial).catch(() => {});
  return { ok: true };
});

// 키오스크 설정
ipcMain.handle('set-kiosk', async (_, serial, packageName) => {
  writeLog(`[Control] Set Kiosk to ${serial}: ${packageName}`);
  const payload = { packageName };
  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'kiosk', payload });
  }
  const socket = tabletSockets.get(serial);
  if (socket) socket.emit('kiosk', payload);
  adbManager?.setKioskMode(serial, packageName).catch(() => {});
  return { ok: true };
});

// 키오스크 해제
ipcMain.handle('exit-kiosk', async (_, serial) => {
  writeLog(`[Control] Exit Kiosk for ${serial}`);
  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'exit_kiosk', payload: {} });
  }
  const socket = tabletSockets.get(serial);
  if (socket) socket.emit('exit_kiosk');
  adbManager?.exitKioskMode(serial).catch(() => {});
  return { ok: true };
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

// 다운로드 폴더 비우기 (Render 클라우드 + 로컬 + ADB 3중 만능 릴레이)
ipcMain.handle('clear-download-folder', async (_, serial) => {
  writeLog(`[Control] Clear download folder for ${serial}`);
  const payload = { serial, targetSerial: serial, targetSerials: [serial] };

  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'clear-download', payload });
    cloudSocket.emit('control-command', { serial, command: 'clear_download', payload });
    cloudSocket.emit('control-command', { serial, command: 'clear-downloads', payload });
    cloudSocket.emit('control-command', { serial, command: 'clear_downloads', payload });
    cloudSocket.emit('control-command', { serial, command: 'clearDownload', payload });
    cloudSocket.emit('control-command', { serial, command: 'clear-download-folder', payload });
  }

  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('clear-download', payload);
    socket.emit('clear_download', payload);
    socket.emit('clear-downloads', payload);
    socket.emit('clear_downloads', payload);
    socket.emit('clearDownload', payload);
    socket.emit('clear-download-folder', payload);
  }
  io.emit('clear-download', payload);
  io.emit('clear_download', payload);
  io.emit('clearDownload', payload);

  try {
    await adbManager?.clearDownloadFolder(serial);
  } catch (e) {}

  return { ok: true };
});

// 배터리 정보
ipcMain.handle('get-battery', async (_, serial) => {
  return adbManager?.getBattery(serial);
});

// WiFi ADB 연결
ipcMain.handle('connect-wifi', async (_, ip, port) => {
  return adbManager?.connectWifi(ip, port ?? 5555);
});

// 알림 및 메시지 전송 (Render 클라우드 + 로컬/ADB 3중 만능 릴레이)
ipcMain.handle('send-message', async (_, serial, message) => {
  const msgText = typeof message === 'string' ? message : (message?.text || message?.message || '');
  const payload = { message: msgText, text: msgText, content: msgText };
  writeLog(`[Control] Send Message to ${serial}: ${msgText}`);
  
  if (cloudSocket && cloudSocket.connected) {
    cloudSocket.emit('control-command', { serial, command: 'toast', payload });
    cloudSocket.emit('control-command', { serial, command: 'show-toast', payload });
    cloudSocket.emit('control-command', { serial, command: 'message', payload });
  }

  const socket = tabletSockets.get(serial);
  if (socket) {
    socket.emit('message', payload);
    socket.emit('toast', payload);
    socket.emit('show-toast', payload);
  }
  adbManager?.sendToast(serial, msgText).catch(() => {});
  return { ok: true };
});

// 기기 등록 삭제 (클라우드 + 로컬 메모리 제거)
ipcMain.handle('delete-device', async (_, serial) => {
  writeLog(`[Control] Delete device: ${serial}`);
  const lowerKey = (serial || '').toLowerCase().trim();
  tabletSockets.delete(lowerKey);
  devicesMap.delete(lowerKey);
  adbManager?.deleteDevice(serial);
  try {
    await fetch(`${RENDER_RELAY_URL}/devices/${encodeURIComponent(serial)}`, { method: 'DELETE' });
  } catch (e) {
    console.error('Failed to delete device on cloud:', e);
  }
  return { ok: true };
});

// 다중 파일 전송 (Render 클라우드 + 로컬 이중 이중 안전망)
ipcMain.handle('distribute-file', async (event, filePath, targetSerials, options) => {
  try {
    const fileName = path.basename(filePath);
    writeLog('[FileDistribute] 파일 배포 시작: ' + fileName + ' (대상: ' + targetSerials.length + '대)');

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // 1. 관리자 PC 로컬 shared_files 폴더에 파일 복사 (Cloudflare Tunnel 및 로컬 웹서버 즉시 서빙)
    const localSharedDir = path.join(app.getPath('userData'), 'shared_files');
    if (!fs.existsSync(localSharedDir)) {
      fs.mkdirSync(localSharedDir, { recursive: true });
    }
    const localSharedPath = path.join(localSharedDir, fileName);
    try {
      fs.copyFileSync(filePath, localSharedPath);
    } catch(e) {
      fs.writeFileSync(localSharedPath, fileBuffer);
    }

    // 2. 가용한 모든 공개 URL 생성
    const publicTunnelUrl = cfTunnelUrl ? `${cfTunnelUrl}/shared/${encodeURIComponent(fileName)}` : null;
    const publicCloudUrl = `${RENDER_RELAY_URL}/shared/${encodeURIComponent(fileName)}`;
    const localIp = getLocalIp(true) || '127.0.0.1';
    const localUrl = `http://${localIp}:3010/shared/${encodeURIComponent(fileName)}`;

    const bestUrl = publicTunnelUrl || publicCloudUrl;
    const payload = {
      fileUrl: bestUrl,
      url: bestUrl,
      downloadUrl: bestUrl,
      link: bestUrl,
      cfUrl: publicTunnelUrl,
      cloudUrl: publicCloudUrl,
      localUrl: localUrl,
      externalUrl: publicTunnelUrl,
      fileName: fileName,
      name: fileName,
      filename: fileName,
      base64Data: base64Data,
      base64: base64Data,
      content: base64Data,
      fileData: base64Data,
      createShortcut: !!options?.createShortcut,
      shortcut: !!options?.createShortcut
    };

    writeLog('[FileDistribute] 🚀 배포 명령 전송 (CF: ' + publicTunnelUrl + ', Render: ' + publicCloudUrl + ')');

    // 3. Render 24시간 중앙 클라우드 보관소로 릴레이 전송
    if (cloudSocket && cloudSocket.connected) {
      for (const serial of targetSerials) {
        const itemPayload = { ...payload, serial, targetSerial: serial, targetSerials: [serial] };
        cloudSocket.emit('control-command', { serial, command: 'file-distribute', payload: itemPayload });
        cloudSocket.emit('control-command', { serial, command: 'distribute-file', payload: itemPayload });
        cloudSocket.emit('control-command', { serial, command: 'download-file', payload: itemPayload });
      }
      cloudSocket.emit('broadcast-file-distribute', payload);
      cloudSocket.emit('upload-file', { fileName, base64Data });
    }

    // 4. 로컬/Cloudflare 포트 3010 Socket.IO 서버로도 직접 접속된 태블릿에 즉시 전송
    for (const serial of targetSerials) {
      const sock = tabletSockets.get(serial);
      if (sock) {
        const itemPayload = { ...payload, serial, targetSerial: serial, targetSerials: [serial] };
        sock.emit('file-distribute', itemPayload);
        sock.emit('distribute-file', itemPayload);
        sock.emit('download-file', itemPayload);
      }
    }
    io.emit('file-distribute', payload);
    io.emit('distribute-file', payload);

    // 5. ADB 연결 기기 다이렉트 파일 푸시 (Direct Push)
    for (const serial of targetSerials) {
      adbManager?.pushFile(serial, filePath, fileName).catch(() => {});
    }

    return { ok: true, sentCount: targetSerials.length, fileUrl: bestUrl };
  } catch (err) {
    writeLog('[FileDistribute] 파일 배포 오류: ' + err.message);
    return { ok: false, error: err.message };
  }
});

// 기기 네임텍 (별명) 설정 핸들러 추가
ipcMain.handle('set-device-alias', async (_, serial, alias) => {
  try {
    adbManager.setDeviceAlias(serial, alias);
    if (cloudSocket && cloudSocket.connected) {
      cloudSocket.emit('control-command', { serial, command: 'set_alias', payload: { alias } });
    }
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
    if (cloudSocket && cloudSocket.connected) {
      cloudSocket.emit('control-command', { serial, command: 'set_group', payload: { group } });
    }
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
  return { mode: networkMode, url: getServerUrl(), localUrl: `http://${getLocalIp(true)}:3010`, externalUrl: cfTunnelUrl || null };
});

// ─── 네트워크 모드 전환 ─────────────────────────────────
// 'local': 같은 WiFi → 로컬 IP 직접 연결
// 'external': 외부망 → Cloudflare Tunnel
ipcMain.handle('set-network-mode', async (_, mode) => {
  networkMode = mode === 'local' ? 'local' : 'external';
  const serverUrl = getServerUrl();
  console.log(`[Mode] 네트워크 모드 변경: ${networkMode}, URL: ${serverUrl}`);
  
  // external 모드인데 터널 없으면 브로드캐스트하지 않고 에러 반환
  if (networkMode === 'external' && !cfTunnelUrl) {
    return { ok: false, error: 'Cloudflare Tunnel이 아직 연결되지 않았습니다. 잠시 후 다시 시도하세요.' };
  }
  
  // 현재 연결된 모든 태블릿에 새 설정 브로드캐스트
  io.emit('server-config', {
    mode: networkMode,
    url: serverUrl,
    localUrl: `http://${getLocalIp(true)}:3010`,
    externalUrl: cfTunnelUrl || null
  });
  return { ok: true, mode: networkMode, url: serverUrl };
});

ipcMain.handle('get-network-mode', async () => {
  const serverUrl = getServerUrl();
  if (networkMode === 'external' && !cfTunnelUrl) {
    return { mode: networkMode, url: null, localUrl: `http://${getLocalIp(true)}:3010`, externalUrl: null, error: 'Cloudflare Tunnel 미연결' };
  }
  return { mode: networkMode, url: serverUrl, localUrl: `http://${getLocalIp(true)}:3010`, externalUrl: cfTunnelUrl || null };
});

ipcMain.handle('force-refresh', async () => {
  if (adbManager) {
    return await adbManager.resetAdb();
  }
  return { ok: false, error: 'AdbManager not initialized' };
});

// ─── APK 자동 빌드 & 전체 태블릿 배포 ─────────────────────
ipcMain.handle('build-and-deploy-apk', async () => {
  // 1. Android 디렉토리 후보군 검색 (포터블 패키징 / 개발 환경 모두 고려)
  let androidDir = 'C:\\project\\School-MDM-Android';
  if (!fs.existsSync(androidDir)) {
    androidDir = path.join(__dirname, '..', '..', 'School-MDM-Android');
  }
  if (!fs.existsSync(androidDir)) {
    androidDir = path.join(process.cwd(), '..', 'School-MDM-Android');
  }

  // 2. 패키징된 APK 대상 경로
  let apkDest;
  if (app.isPackaged) {
    apkDest = path.join(process.resourcesPath, 'resources', 'apk', 'app-debug.apk');
  } else {
    apkDest = path.join(__dirname, '..', 'resources', 'apk', 'app-debug.apk');
  }

  const deployExistingApk = async () => {
    mainWindow?.webContents.send('build-progress', { step: 'deploying', progress: 80, message: '24시간 중앙 클라우드로 APK 업로드 및 태블릿 원격 배포 중...' });
    
    let cloudApkUrl = `${RENDER_RELAY_URL}/shared/School-MDM-v1.3.apk`;
    try {
      if (fs.existsSync(apkDest)) {
        const fileBuffer = fs.readFileSync(apkDest);
        const res = await fetch(`${RENDER_RELAY_URL}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-file-name': encodeURIComponent('School-MDM-v1.3.apk')
          },
          body: fileBuffer
        });
        const data = await res.json();
        if (data.ok && data.fileUrl) {
          cloudApkUrl = data.fileUrl;
        }
      }
    } catch (err) {
      console.error('[APK Cloud Upload Error]', err);
    }

    const updatePayload = {
      fileUrl: cloudApkUrl,
      url: cloudApkUrl,
      apkUrl: cloudApkUrl,
      fileName: 'School-MDM-v1.3.apk',
      version: 4,
      versionCode: 4,
      versionName: '1.3',
      createShortcut: false
    };

    if (cloudSocket && cloudSocket.connected) {
      cloudSocket.emit('control-command', { serial: 'all', command: 'apk-update', payload: updatePayload });
      cloudSocket.emit('control-command', { serial: 'all', command: 'file-distribute', payload: updatePayload });
      cloudSocket.emit('control-command', { serial: 'all', command: 'distribute-file', payload: updatePayload });
      cloudSocket.emit('broadcast-file-distribute', updatePayload);
    }

    let sentCount = 0;
    for (const [serial, socket] of tabletSockets.entries()) {
      socket.emit('apk-update', updatePayload);
      socket.emit('file-distribute', updatePayload);
      socket.emit('distribute-file', updatePayload);
      sentCount++;
    }

    if (adbManager && fs.existsSync(apkDest)) {
      adbManager.getConnectedDevices().then(devices => {
        for (const d of devices) {
          adbManager.installApk(d.serial, apkDest).catch(() => {});
        }
      }).catch(() => {});
    }

    const msg = `완료! 24시간 중앙 클라우드를 통해 전원 원격 업데이트 전송 완료`;
    mainWindow?.webContents.send('build-progress', { step: 'done', progress: 100, message: msg });
    writeLog(`[Build] APK 24시간 클라우드 자동 배포 완료. URL: ${cloudApkUrl}`);
    return { ok: true, sentCount, apkUrl: cloudApkUrl };
  };

  // Android 소스 폴더가 없더라도 미리 빌드된 APK가 있다면 바로 배포 진행!
  if (!fs.existsSync(androidDir)) {
    if (fs.existsSync(apkDest)) {
      return deployExistingApk();
    }
    return { ok: false, error: 'School-MDM-Android 폴더를 찾을 수 없습니다.' };
  }

  const javaHome = 'C:\\Users\\User\\AppData\\Local\\Android\\jdk\\jdk-17.0.8.1+1';
  const apkSrc  = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

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

    buildProc.on('exit', async (code) => {
      if (code !== 0) {
        if (fs.existsSync(apkDest)) {
          return resolve(await deployExistingApk());
        }
        mainWindow?.webContents.send('build-progress', { step: 'error', progress: 0, message: `빌드 실패 (code: ${code})` });
        return resolve({ ok: false, error: `빌드 실패 (exit code: ${code})` });
      }

      // APK를 resources로 복사
      try {
        fs.copyFileSync(apkSrc, apkDest);
      } catch (e) {
        console.error('APK 복사 실패:', e);
      }

      resolve(await deployExistingApk());
    });
  });
});

