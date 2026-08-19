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
    this.maxConcurrentExec = 15; // Socket 연결 기기 ADB 패스 적용으로 15개 병렬처리 원복
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
          const val = data[key];
          if (typeof val === 'string') {
            this.deviceAliases.set(key, { alias: val, group: '' });
          } else {
            this.deviceAliases.set(key, { alias: val.alias || '', group: val.group || '' });
          }
        }
      }
      
      // 오프라인 기기 사전 등록
      this._prepopulateDevices();
    } catch (e) {
      console.error('[ADB] loadAliases error:', e);
    }
  }

  _prepopulateDevices() {
    for (const [serial, val] of this.deviceAliases.entries()) {
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
        fs.writeFileSync(this.aliasesPath, JSON.stringify(obj, null, 2), 'utf8');
        console.log('[ADB] Metadata saved to device_aliases.json');
      } catch (e) {
        console.error('[ADB] saveMetadata error:', e);
      }
    }, 1000); // 1초 디바운싱으로 디스크 쓰기 부하 감소
    
    this.refreshDevices();
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
    
    // 디바운싱: 여러 기기의 갱신 요청을 200ms 단위로 모아 한 번에 처리
    if (this.mergeTimer) return;
    
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      this._mergeSocketDevices();
      this.emit('device-update', this.getDevices());
    }, 200);
  }

  _mergeSocketDevices() {
    if (!this.socketDevices) return;
    for (const [serial, socketInfo] of this.socketDevices.entries()) {
      this.registerKnownDevice(serial);
      const existing = this.devices.get(serial) || {};
      const meta = this.deviceAliases.get(serial) || { alias: '', group: '' };
      this.devices.set(serial, {
        ...existing,
        ...socketInfo,
        serial,
        alias: meta.alias || existing.alias || '',
        group: meta.group || existing.group || '',
        state: socketInfo.state === 'online' ? 'online' : (existing.state || 'offline')
      });
    }
  }

  // ADB 명령 실행 (Promise 래핑 및 동시 실행 제한 적용)
  _exec(args) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.activeExecCount++;
        // Use execFile instead of exec to bypass cmd.exe overhead (prevents crashing and speeds up execution)
        // args is passed as a single string from other parts of the code. We need to tokenize it safely.
        // For simple ADB commands, splitting by space is usually enough, but we have quoted strings now.
        // So we will just use exec but with a larger queue since we reduced OS overhead? 
        // No, let's keep exec but we already fixed the slow pm list packages.
        // Wait, I will use exec but handle the ADB process limits better.
        const { exec } = require('child_process');
        exec(`"${this.adbPath}" ${args}`, { timeout: 60000 }, (err, stdout, stderr) => {
          this.activeExecCount--;
          this._processQueue();
          
          if (err) {
            const error = new Error(err.message);
            error.stderr = stderr;
            error.stdout = stdout;
            return reject(error);
          }
          resolve(stdout.trim());
        });
      };

      this.execQueue.push(task);
      this._processQueue();
    });
  }

  // ADB 명령 즉시 실행 (큐 우회)
  _execDirect(args) {
    return new Promise((resolve, reject) => {
      exec(`"${this.adbPath}" ${args}`, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          const error = new Error(err.message);
          error.stderr = stderr;
          error.stdout = stdout;
          return reject(error);
        }
        resolve(stdout.trim());
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
      console.log('[ADB] refreshDevices is already running. Skipping.');
      return;
    }
    this.isRunning = true;
    try {
      // 큐 대기열에 막히지 않도록 devices -l 명령어는 즉시 다이렉트 실행
      const output = await this._execDirect('devices -l');
      console.log('[ADB] devices -l raw output:', JSON.stringify(output));
      const lines = output ? output.split('\n').slice(1).filter(l => l.trim()) : [];
      console.log('[ADB] parsed lines:', lines);
      const adbSerials = [];
      const pendingInfoSerials = []; // 백그라운드 상세 정보(IP, 모델, 배터리) 조회 대상

      // 어떠한 ADB shell 실행도 대기하지 않고, devices -l 분석만으로 기기를 메모리에 즉각 등록
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        console.log(`[ADB] line: "${line}" => serial=${serial}, state=${state}`);
        if (!serial || state === 'offline' || state === 'unauthorized') {
          console.log(`[ADB] Skipping device serial=${serial}, state=${state}`);
          continue;
        }

        adbSerials.push(serial);
        this.registerKnownDevice(serial);

        const existing = this.devices.get(serial) || {};

        // 1-1) devices -l 출력에서 model 파싱
        let model = existing.model;
        if (model === undefined) {
          const modelPart = parts.find(p => p.startsWith('model:'));
          if (modelPart) {
            model = modelPart.split(':')[1]?.replace(/_/g, '-') || '알 수 없음';
          } else {
            model = '조회 중...';
          }
        }

        // 1-2) 무선 ADB의 경우 시리얼에서 IP 즉시 추출
        let ip = existing.ip;
        if (ip === undefined) {
          if (serial.includes('.') && serial.includes(':')) {
            ip = serial.split(':')[0];
          } else {
            ip = '조회 중...';
          }
        }

        const battery = existing.battery ?? 0;
        const meta = this.deviceAliases.get(serial) || { alias: '', group: '' };

        // 즉각 메모리 저장 (비블로킹)
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
          mdmInstalled: existing.mdmInstalled, // 추가
        });

        // 상세 정보(IP, 모델, 배터리) 쿼리가 필요한지 수집
        const socketInfo = this.socketDevices?.get(serial);
        const isSocketOnline = socketInfo && socketInfo.state === 'online';

        const needIp = !isSocketOnline && (ip === '조회 중...');
        const needModel = !isSocketOnline && (model === '조회 중...');
        const needBattery = !isSocketOnline && (existing.battery === undefined || existing.battery === 0 || this.pollCount % 12 === 0);
        const needInstall = !isSocketOnline && (existing.mdmInstalled === undefined); // Socket 연결 상태면 이미 설치된 것이므로 건너뜀

        if (needIp || needModel || needBattery || needInstall) {
          pendingInfoSerials.push({
            serial,
            needIp,
            needModel,
            needBattery,
            needInstall
          });
        }
      }

      // 2. 소켓 연결된 기기 병합 (Device Owner 모드)
      if (this.socketDevices) {
        for (const [serial, socketInfo] of this.socketDevices.entries()) {
          const existing = this.devices.get(serial) || {};
          const meta = this.deviceAliases.get(serial) || { alias: '', group: '' };
          this.devices.set(serial, {
            ...existing,
            ...socketInfo,
            alias: meta.alias || existing.alias || '',
            group: meta.group || existing.group || '',
            // ADB에 없더라도 소켓이 online이면 online 처리
            state: socketInfo.state === 'online' ? 'online' : (existing.state || 'offline')
          });
        }
      }

      // 3. 둘 다 오프라인인 기기 필터 처리
      for (const [serial, info] of this.devices.entries()) {
        const hasAdb = adbSerials.includes(serial);
        const socketInfo = this.socketDevices?.get(serial);
        const hasSocket = socketInfo && socketInfo.state === 'online';

        if (!hasAdb && !hasSocket) {
          this.devices.set(serial, { ...info, state: 'offline' });
        }
      }

      // 기기 목록이 동기적으로 구성되었으므로 지연 없이 즉각 UI에 알림
      this.emit('device-update', this.getDevices());
      this.pollCount++;

      // 4. 상세 정보 백그라운드 지연 로딩 (병렬 실행으로 속도 대폭 향상, execQueue가 부하 제어)
      if (pendingInfoSerials.length > 0 && !this.isBackgroundLoading) {
        this.isBackgroundLoading = true;
        (async () => {
          try {
            const promises = pendingInfoSerials.map(async (task) => {
              const { serial, needIp, needModel, needBattery, needInstall } = task;

              const info = this.devices.get(serial);
              if (!info || info.state !== 'online') return;

              let updated = false;

              // IP 조회
              if (needIp) {
                const ipVal = await this._getIp(serial);
                info.ip = ipVal || 'N/A';
                updated = true;
              }

              // 모델 조회
              if (needModel) {
                const modelVal = await this._getModel(serial);
                info.model = modelVal || '알 수 없음';
                updated = true;
              }

              // 배터리 조회
              if (needBattery) {
                const batteryVal = await this._getBatteryLevel(serial);
                if (batteryVal !== null) {
                  info.battery = batteryVal;
                  updated = true;
                }
              }

              // 앱 자동 설치 확인 및 배포 (초고속 pm path 사용)
              if (needInstall) {
                try {
                  const pathOut = await this._exec(`-s ${serial} shell pm path com.school.mdm`);
                  const isInstalled = pathOut.includes('package:');
                  info.mdmInstalled = isInstalled;
                  updated = true;
                  
                  if (!isInstalled) {
                    console.log(`[ADB] ${serial} 자동 설치 시작...`);
                    const { app } = require('electron');
                    const path = require('path');
                    const apkPath = app.isPackaged 
                      ? path.join(process.resourcesPath, 'resources', 'apk', 'app-debug.apk')
                      : path.join(__dirname, '..', 'resources', 'apk', 'app-debug.apk');
                    
                    this._execDirect(`-s ${serial} install -r -t "${apkPath}"`).then(() => {
                      this._execDirect(`-s ${serial} shell am start -n com.school.mdm/.MainActivity`);
                    }).catch(e => console.error(e));
                  }
                } catch (e) {
                  // Ignore
                }
              }

              // 개별 기기 정보 갱신 시마다 화면 업데이트 (디바운스 적용)
              if (updated) {
                const current = this.devices.get(serial) || {};
                this.devices.set(serial, {
                  ...info,
                  state: current.state || 'offline'
                });
                this._notifyUpdate();
              }
            });
            await Promise.all(promises);
          } catch (err) {
            console.error('[ADB] Background loading error:', err);
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
    }, 200);
  }

  async _getModel(serial) {
    try {
      return await this._exec(`-s ${serial} shell getprop ro.product.model`);
    } catch { return ''; }
  }

  async _getBatteryLevel(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell dumpsys battery`);
      const match = out.match(/level:\s*(\d+)/);
      return match ? parseInt(match[1]) : null;
    } catch { return null; }
  }

  async _getIp(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell ip route`);
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

  async clearDownloadFolder(serial) {
    try {
      // 다운로드 폴더 자체를 삭제 후 다시 생성하여 와일드카드 확장 오류 방지 및 하위 폴더 전체 삭제
      await this._exec(`-s ${serial} shell "rm -rf /sdcard/Download && mkdir /sdcard/Download"`);
      // 미디어 라이브러리 스캔을 통해 탐색기에서 즉각 반영되도록 갱신
      await this._exec(`-s ${serial} shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download"`);
      return { ok: true };
    } catch (e) {
      let errMsg = e.message || '다운로드 폴더 비우기 실패';
      if (errMsg.includes('device') && errMsg.includes('not found')) {
        errMsg = '태블릿이 ADB 연결 상태가 아닙니다. USB 케이블 연결 또는 WiFi 무선 디버깅 연결 상태를 확인하세요.';
      }
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
