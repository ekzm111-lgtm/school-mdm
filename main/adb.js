const { EventEmitter } = require('events');
const { execFile, exec } = require('child_process');
const path = require('path');

/**
 * AdbManager - ADB over WiFi로 Android 태블릿과 통신
 * adb.exe가 PATH에 있거나 resources/adb/adb.exe에 있어야 합니다.
 */
class AdbManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // serial → deviceInfo
    this.socketDevices = new Map(); // serial → socketInfo (Device Owner 클라이언트들)
    this.pollingInterval = null;
    this.pollCount = 0; // 폴링 카운트 추가 (배터리 등의 주기적 갱신을 조절하여 CPU 과부하 방지)
    this.isRunning = false; // 중복 실행 방지 Lock 플래그 추가 (프로세스 폭주 방지)
    this.adbPath = this._resolveAdbPath();
    const { app } = require('electron');
    // 패키징 상태일 때는 실행 파일과 같은 경로(즉, dist나 설치 폴더)에 device_aliases.json을 위치시켜 다른 PC 유실 방지
    this.aliasesPath = app.isPackaged 
      ? path.join(path.dirname(process.execPath), 'device_aliases.json')
      : path.join(app.getPath('userData'), 'device_aliases.json');
    this.deviceAliases = new Map();
    this._loadAliases();
    this.activeExecCount = 0;
    this.execQueue = [];
    this.maxConcurrentExec = 3; // ADB 무선 포트(5037) 병목 방지: 동시 실행수 3개로 제한
    this.mergeTimer = null;
    this.isBackgroundLoading = false;
  }

  _loadAliases() {
    const fs = require('fs');
    const { app } = require('electron');
    const oldAliasesPath = path.join(app.getPath('userData'), 'device_aliases.json');
    try {
      // 새로운 경로에 파일이 없고 이전 경로에 파일이 있다면 자동 마이그레이션(이전 복구) 처리
      if (this.aliasesPath !== oldAliasesPath && !fs.existsSync(this.aliasesPath) && fs.existsSync(oldAliasesPath)) {
        console.log('[ADB] Migrating old device_aliases.json to new location:', this.aliasesPath);
        fs.copyFileSync(oldAliasesPath, this.aliasesPath);
      }

      if (fs.existsSync(this.aliasesPath)) {
        const data = JSON.parse(fs.readFileSync(this.aliasesPath, 'utf8'));
        for (const key in data) {
          if (key === 'TEST-DEVICE-001' || key.toLowerCase() === 'test-device-001') continue;
          const val = data[key];
          if (typeof val === 'string') {
            this.deviceAliases.set(key, { alias: val, group: '' });
          } else {
            this.deviceAliases.set(key, { alias: val.alias || '', group: val.group || '' });
          }
        }
      }
      
      // 더미 기기 파일에서 강제 삭제
      this.deviceAliases.delete('TEST-DEVICE-001');
      this.deviceAliases.delete('test-device-001');
      this._saveMetadata();

      // 오프라인 기기 사전 등록
      this._prepopulateDevices();
    } catch (e) {
      console.error('[ADB] loadAliases error:', e);
    }
  }

  _prepopulateDevices() {
    for (const [serial, val] of this.deviceAliases.entries()) {
      if (serial === 'TEST-DEVICE-001' || serial.toLowerCase() === 'test-device-001') continue;
      if (!this.devices.has(serial)) {
        this.devices.set(serial, {
          serial,
          alias: val.alias || '',
          group: val.group || '',
          state: 'offline',
          ip: '',
          model: 'Unknown',
          battery: 0,
          charging: false,
          locked: false,
          kioskApp: null,
          isDeviceOwner: false,
          mdmInstalled: false
        });
      }
    }
    this.devices.delete('TEST-DEVICE-001');
    this.devices.delete('test-device-001');
  }

  deleteDevice(serial) {
    if (!serial) return;
    const lowerKey = serial.toLowerCase().trim();
    for (const key of Array.from(this.deviceAliases.keys())) {
      if (key.toLowerCase().trim() === lowerKey || key === serial) {
        this.deviceAliases.delete(key);
      }
    }
    for (const key of Array.from(this.devices.keys())) {
      if (key.toLowerCase().trim() === lowerKey || key === serial) {
        this.devices.delete(key);
      }
    }
    this._saveMetadata();
    this.emit('device-update', this.getDevices());
  }

  registerKnownDevice(serial) {
    if (!serial) return;
    if (!this.deviceAliases.has(serial)) {
      this.deviceAliases.set(serial, { alias: '', group: '' });
      this._saveMetadata();
    }
  }

  setDeviceAlias(serial, alias) {
    const existing = this.deviceAliases.get(serial) || { alias: '', group: '' };
    existing.alias = (alias || '').trim();
    if (!existing.alias && !existing.group) {
      this.deviceAliases.delete(serial);
    } else {
      this.deviceAliases.set(serial, existing);
    }
    this._saveMetadata();
  }

  setDeviceGroup(serial, group) {
    const existing = this.deviceAliases.get(serial) || { alias: '', group: '' };
    existing.group = (group || '').trim();
    if (!existing.alias && !existing.group) {
      this.deviceAliases.delete(serial);
    } else {
      this.deviceAliases.set(serial, existing);
    }
    this._saveMetadata();
  }

  _saveMetadata() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const fs = require('fs');
      try {
        const obj = {};
        for (const [k, v] of this.deviceAliases.entries()) {
          obj[k] = v;
        }
        fs.writeFile(this.aliasesPath, JSON.stringify(obj, null, 2), 'utf8', (err) => {
          if (err) console.error('[ADB] saveMetadata async write error:', err);
          else console.log('[ADB] Metadata saved to device_aliases.json');
        });
      } catch (e) {
        console.error('[ADB] saveMetadata error:', e);
      }
    }, 1000);
    
    this._notifyUpdate(); // refreshDevices()의 무한 재귀 및 블로킹 방지
  }

  _resolveAdbPath() {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'resources', 'adb', 'adb.exe');
    }
    return 'adb'; // PATH에서 찾음
  }

  async init() {
    console.log('[ADB] AdbManager initialized. adbPath:', this.adbPath);
  }

  setSocketDevices(socketDevices) {
    this.socketDevices = socketDevices;
    this._mergeSocketDevices();
    this._notifyUpdate();
  }

  _mergeSocketDevices() {
    if (!this.socketDevices) return;
    for (const [rawSerial, socketInfo] of this.socketDevices.entries()) {
      if (!rawSerial) continue;
      const lowerSerial = rawSerial.toLowerCase().trim();
      
      let targetSerial = rawSerial;
      for (const existingKey of this.devices.keys()) {
        if (existingKey.toLowerCase().trim() === lowerSerial) {
          targetSerial = existingKey;
          break;
        }
      }

      this.registerKnownDevice(targetSerial);
      const existing = this.devices.get(targetSerial) || {};
      const meta = this.deviceAliases.get(targetSerial) || this.deviceAliases.get(rawSerial) || { alias: '', group: '' };
      this.devices.set(targetSerial, {
        ...existing,
        ...socketInfo,
        serial: targetSerial,
        alias: meta.alias || existing.alias || '',
        group: meta.group || existing.group || '',
        state: socketInfo.state === 'online' ? 'online' : (existing.state || 'offline')
      });
    }
  }

  // ADB 명령 실행 (Promise 래핑, execFile 사용으로 cmd.exe 부하 제거 & 짧은 타임아웃 3초)
  _exec(args, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.activeExecCount++;
        const argsArray = typeof args === 'string' ? args.trim().split(/\s+/).filter(Boolean) : args;
        execFile(this.adbPath, argsArray, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          this.activeExecCount--;
          this._processQueue();
          
          if (err) {
            const error = new Error(err.message);
            error.stderr = stderr;
            error.stdout = stdout;
            return reject(error);
          }
          resolve(stdout ? stdout.trim() : '');
        });
      };

      // 오래된 대기 큐 비우기 (작업이 5개 이상 누적되면 대기열 비워 최신화)
      if (this.execQueue.length > 5) {
        this.execQueue.length = 0;
      }

      this.execQueue.push(task);
      this._processQueue();
    });
  }

  // ADB 명령 즉시 실행 (큐 우회, execFile 사용)
  _execDirect(args, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const argsArray = typeof args === 'string' ? args.trim().split(/\s+/).filter(Boolean) : args;
      execFile(this.adbPath, argsArray, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const error = new Error(err.message);
          error.stderr = stderr;
          error.stdout = stdout;
          return reject(error);
        }
        resolve(stdout ? stdout.trim() : '');
      });
    });
  }

  _processQueue() {
    if (this.activeExecCount >= this.maxConcurrentExec) return;
    if (this.execQueue.length === 0) return;

    const nextTask = this.execQueue.shift();
    nextTask();
  }

  // 연결된 기기 목록 새로고침
  async refreshDevices() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      // 1. 소켓 연결된 기기 우선 처리 (0.001초 다이렉트 병합 & 대소문자 무관 매칭)
      if (this.socketDevices) {
        for (const [rawSerial, socketInfo] of this.socketDevices.entries()) {
          if (!rawSerial) continue;
          const lowerSerial = rawSerial.toLowerCase().trim();
          
          // 기존 대시보드 25대 목록 중 대소문자 무관 키 매칭
          let targetSerial = rawSerial;
          for (const existingKey of this.devices.keys()) {
            if (existingKey.toLowerCase().trim() === lowerSerial) {
              targetSerial = existingKey;
              break;
            }
          }

          this.registerKnownDevice(targetSerial);
          const existing = this.devices.get(targetSerial) || {};
          const meta = this.deviceAliases.get(targetSerial) || this.deviceAliases.get(rawSerial) || { alias: '', group: '' };
          
          this.devices.set(targetSerial, {
            ...existing,
            ...socketInfo,
            serial: targetSerial,
            alias: meta.alias || existing.alias || '',
            group: meta.group || existing.group || '',
            state: socketInfo.state === 'online' ? 'online' : (existing.state || 'offline')
          });
        }
      }

      // 기기 목록이 동기적으로 구성되었으므로 지연 없이 즉각 UI에 알림 (즉시 렌더링)
      this.emit('device-update', this.getDevices());

      // 2. ADB 실행 (타임아웃 3초로 대폭 단축하여 병목 제거)
      let output = '';
      try {
        output = await this._execDirect('devices -l', 3000);
      } catch (e) {
        // ADB 응답 지연/오류 시 대기 없이 소켓 정보로 즉시 통과
      }

      const lines = output ? output.split('\n').slice(1).filter(l => l.trim()) : [];
      const adbSerials = [];
      const pendingInfoSerials = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        if (!serial || state === 'offline' || state === 'unauthorized') continue;

        adbSerials.push(serial);
        this.registerKnownDevice(serial);

        const socketInfo = this.socketDevices?.get(serial);
        const isSocketOnline = socketInfo && socketInfo.state === 'online';

        // ⭐ 소켓으로 연결된 기기는 느린 ADB shell 명령을 전면 건너뛰어 초고속 갱신!
        if (isSocketOnline) {
          continue;
        }

        const existing = this.devices.get(serial) || {};

        let model = existing.model;
        if (!model || model === '조회 중...') {
          const modelPart = parts.find(p => p.startsWith('model:'));
          model = modelPart ? modelPart.split(':')[1]?.replace(/_/g, '-') || '알 수 없음' : '조회 중...';
        }

        let ip = existing.ip;
        if (!ip || ip === '조회 중...') {
          ip = (serial.includes('.') && serial.includes(':')) ? serial.split(':')[0] : '조회 중...';
        }

        const battery = existing.battery ?? 0;
        const meta = this.deviceAliases.get(serial) || { alias: '', group: '' };

        this.devices.set(serial, {
          serial,
          model,
          alias: meta.alias,
          group: meta.group,
          battery,
          ip,
          state: 'online',
          locked: existing.locked ?? false,
          kioskApp: existing.kioskApp ?? null,
          lastSeen: new Date().toISOString(),
          isDeviceOwner: existing.isDeviceOwner ?? false,
          mdmInstalled: existing.mdmInstalled,
        });

        const needIp = (ip === '조회 중...');
        const needModel = (model === '조회 중...');
        const needBattery = (existing.battery === undefined || existing.battery === 0);

        if (needIp || needModel || needBattery) {
          pendingInfoSerials.push({ serial, needIp, needModel, needBattery });
        }
      }

      // 오프라인 기기 정리
      for (const [serial, info] of this.devices.entries()) {
        const hasAdb = adbSerials.includes(serial);
        const socketInfo = this.socketDevices?.get(serial);
        const hasSocket = socketInfo && socketInfo.state === 'online';

        if (!hasAdb && !hasSocket) {
          this.devices.set(serial, { ...info, state: 'offline' });
        }
      }

      this.emit('device-update', this.getDevices());
      this.pollCount++;

      // 백그라운드 지연 로딩 (타임아웃 2초로 안전하게 병렬 처리)
      if (pendingInfoSerials.length > 0 && !this.isBackgroundLoading) {
        this.isBackgroundLoading = true;
        (async () => {
          try {
            const promises = pendingInfoSerials.map(async (task) => {
              const { serial, needIp, needModel, needBattery } = task;
              const info = this.devices.get(serial);
              if (!info || info.state !== 'online') return;

              let updated = false;
              if (needIp) {
                const ipVal = await this._getIp(serial);
                if (ipVal) { info.ip = ipVal; updated = true; }
              }
              if (needModel) {
                const modelVal = await this._getModel(serial);
                if (modelVal) { info.model = modelVal; updated = true; }
              }
              if (needBattery) {
                const batteryVal = await this._getBatteryLevel(serial);
                if (batteryVal !== null) { info.battery = batteryVal; updated = true; }
              }
              if (updated) {
                this.devices.set(serial, { ...info });
                this._notifyUpdate();
              }
            });
            await Promise.all(promises);
          } catch (err) {
          } finally {
            this.isBackgroundLoading = false;
          }
        })();
      }
    } catch (e) {
      console.error('[ADB] refreshDevices error:', e);
    } finally {
      this.isRunning = false;
    }
  }

  _notifyUpdate() {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('device-update', this.getDevices());
    }, 30);
  }

  async _getModel(serial) {
    try {
      return await this._exec(`-s ${serial} shell getprop ro.product.model`, 2000);
    } catch { return ''; }
  }

  async _getBatteryLevel(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell dumpsys battery`, 2000);
      const match = out.match(/level:\s*(\d+)/);
      return match ? parseInt(match[1]) : null;
    } catch { return null; }
  }

  async _getIp(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell ip route`, 2000);
      const match = out.match(/src\s+([\d.]+)/);
      return match ? match[1] : '';
    } catch { return ''; }
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  startPolling(intervalMs = 5000) {
    this.refreshDevices();
    this.pollingInterval = setInterval(() => this.refreshDevices(), intervalMs);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async resetAdb() {
    try {
      console.log('[ADB] 강제로 ADB 연결 초기화 (disconnect) 및 갱신 수행');
      await this._execDirect('disconnect');
      // 오프라인 상태 초기화
      for (const [serial, info] of this.devices.entries()) {
        this.devices.set(serial, { ...info, state: 'offline' });
      }
      this.refreshDevices();
      return { ok: true };
    } catch (e) {
      console.error('[ADB] resetAdb error:', e);
      return { ok: false, error: e.message || '오류 발생' };
    }
  }

  // ── 제어 명령들 ────────────────────────────────────────────

  async lockDevice(serial) {
    try {
      await this._exec(`-s ${serial} shell input keyevent 26`); // KEYCODE_POWER
      const info = this.devices.get(serial);
      if (info) this.devices.set(serial, { ...info, locked: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async unlockDevice(serial) {
    try {
      await this._exec(`-s ${serial} shell input keyevent 82`); // KEYCODE_MENU (wake)
      await this._exec(`-s ${serial} shell input swipe 300 900 300 300`); // 스와이프 잠금 해제
      const info = this.devices.get(serial);
      if (info) this.devices.set(serial, { ...info, locked: false });
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async setKioskMode(serial, packageName) {
    try {
      // 홈런처를 특정 앱으로 고정 (Android task affinity lock)
      await this._exec(`-s ${serial} shell am start -n ${packageName}`);
      await this._exec(`-s ${serial} shell am task lock $(adb -s ${serial} shell am stack list | head -1 | awk '{print $NF}')`);
      const info = this.devices.get(serial);
      if (info) this.devices.set(serial, { ...info, kioskApp: packageName });
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async exitKioskMode(serial) {
    try {
      await this._exec(`-s ${serial} shell am task lock stop`);
      const info = this.devices.get(serial);
      if (info) this.devices.set(serial, { ...info, kioskApp: null });
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async setVolume(serial, level) {
    // level: 0~15 (Android 미디어 볼륨)
    try {
      await this._exec(`-s ${serial} shell media volume --stream 3 --set ${level}`);
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async getInstalledApps(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell pm list packages -3`); // -3: 서드파티만
      return out.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
    } catch { return []; }
  }

  async forceStopApp(serial, packageName) {
    try {
      await this._exec(`-s ${serial} shell am force-stop ${packageName}`);
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async uninstallApp(serial, packageName) {
    try {
      await this._exec(`-s ${serial} shell pm uninstall ${packageName}`);
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }

  async pushFile(serial, localFilePath, remoteFileName) {
    try {
      const cleanFileName = path.basename(remoteFileName);
      const remotePath = `/sdcard/Download/${cleanFileName}`;
      await this._exec(`-s ${serial} push "${localFilePath}" "${remotePath}"`);
      await this._exec(`-s ${serial} shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remotePath}"`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async clearDownloadFolder(serial) {
    try {
      await this._exec(`-s ${serial} shell "rm -rf /sdcard/Download/* /sdcard/Download/.* /storage/emulated/0/Download/* 2>/dev/null; mkdir -p /sdcard/Download"`);
      await this._exec(`-s ${serial} shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download"`);
      return { ok: true };
    } catch (e) {
      let errMsg = e.message || '다운로드 폴더 비우기 실패';
      return { ok: false, error: errMsg };
    }
  }

  async getBattery(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell dumpsys battery`);
      const level = out.match(/level:\s*(\d+)/)?.[1];
      const status = out.match(/status:\s*(\d+)/)?.[1];
      const temp = out.match(/temperature:\s*(\d+)/)?.[1];
      return {
        level: level ? parseInt(level) : 0,
        charging: status === '2',
        temperature: temp ? (parseInt(temp) / 10).toFixed(1) : 0,
      };
    } catch { return { level: 0, charging: false, temperature: 0 }; }
  }

  async connectWifi(ip, port = 5555) {
    try {
      const out = await this._exec(`connect ${ip}:${port}`);
      await this.refreshDevices();
      return { ok: true, message: out };
    } catch (e) { return { ok: false, error: e }; }
  }

  async sendToast(serial, message) {
    try {
      const escaped = message.replace(/'/g, "\\'");
      await this._exec(`-s ${serial} shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS`);
      // ADB shell로 알림 전송 (notification via am)
      await this._exec(`-s ${serial} shell service call notification 1 s16 "MDM" s16 "${escaped}"`);
      return { ok: true };
    } catch (e) { return { ok: false, error: e }; }
  }
}

module.exports = AdbManager;
