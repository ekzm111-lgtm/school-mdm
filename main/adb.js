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
    this.adbPath = this._resolveAdbPath();
    const { app } = require('electron');
    this.aliasesPath = path.join(app.getPath('userData'), 'device_aliases.json');
    this.deviceAliases = new Map();
    this._loadAliases();
  }

  _loadAliases() {
    const fs = require('fs');
    try {
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
    } catch (e) {
      console.error('[ADB] loadAliases error:', e);
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
    const fs = require('fs');
    try {
      const obj = {};
      for (const [k, v] of this.deviceAliases.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.aliasesPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('[ADB] saveMetadata error:', e);
    }
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
    this.refreshDevices();
  }

  // ADB 명령 실행 (Promise 래핑)
  _exec(args) {
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

  // 연결된 기기 목록 새로고침
  async refreshDevices() {
    try {
      const output = await this._exec('devices -l');
      const lines = output ? output.split('\n').slice(1).filter(l => l.trim()) : [];
      const adbSerials = [];

      // 1. ADB로 감지된 USB/무선 기기 파싱
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        if (!serial || state === 'offline') continue;

        adbSerials.push(serial);

        const existing = this.devices.get(serial) || {};
        const model = await this._getModel(serial);
        const battery = await this._getBatteryLevel(serial);
        const ip = await this._getIp(serial);

        const meta = this.deviceAliases.get(serial) || { alias: '', group: '' };
        this.devices.set(serial, {
          serial,
          model: model || existing.model || '알 수 없음',
          alias: meta.alias,
          group: meta.group,
          battery: battery ?? existing.battery ?? 0,
          ip: ip || existing.ip || '',
          state: 'online',
          locked: existing.locked ?? false,
          kioskApp: existing.kioskApp ?? null,
          lastSeen: new Date().toISOString(),
          isDeviceOwner: existing.isDeviceOwner ?? false,
        });
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

      this.emit('device-update', this.getDevices());
    } catch (e) {
      console.error('[ADB] refreshDevices error:', e);
    }
  }

  async _getModel(serial) {
    try {
      return await this._exec(`-s ${serial} shell getprop ro.product.model`);
    } catch { return ''; }
  }

  async _getBatteryLevel(serial) {
    try {
      const out = await this._exec(`-s ${serial} shell dumpsys battery | grep level`);
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
