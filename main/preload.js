const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdm', {
  // 기기 조회
  getDevices: () => ipcRenderer.invoke('get-devices'),
  onDeviceUpdate: (cb) => ipcRenderer.on('device-update', (_, data) => cb(data)),
  removeDeviceUpdate: () => ipcRenderer.removeAllListeners('device-update'),

  // 제어
  lockDevice: (serial) => ipcRenderer.invoke('lock-device', serial),
  unlockDevice: (serial) => ipcRenderer.invoke('unlock-device', serial),
  setKiosk: (serial, pkg) => ipcRenderer.invoke('set-kiosk', serial, pkg),
  exitKiosk: (serial) => ipcRenderer.invoke('exit-kiosk', serial),
  setVolume: (serial, level) => ipcRenderer.invoke('set-volume', serial, level),

  // 앱
  getApps: (serial) => ipcRenderer.invoke('get-apps', serial),
  forceStopApp: (serial, pkg) => ipcRenderer.invoke('force-stop-app', serial, pkg),

  // 정보
  getBattery: (serial) => ipcRenderer.invoke('get-battery', serial),

  // 연결
  connectWifi: (ip, port) => ipcRenderer.invoke('connect-wifi', ip, port),

  // 메시지
  sendMessage: (serial, msg) => ipcRenderer.invoke('send-message', serial, msg),

  // 파일 배포
  distributeFile: (filePath, targetSerials, options) => ipcRenderer.invoke('distribute-file', filePath, targetSerials, options),
  onDistributeProgress: (cb) => ipcRenderer.on('distribute-progress', (_, data) => cb(data)),
  removeDistributeProgress: () => ipcRenderer.removeAllListeners('distribute-progress'),

  // 기기 네임텍 (별명) 설정
  setDeviceAlias: (serial, alias) => ipcRenderer.invoke('set-device-alias', serial, alias),

  // 기기 위치 조회
  getDeviceLocation: (serial) => ipcRenderer.invoke('get-device-location', serial),

  // 실시간 화면 미러링 제어
  startMirror: (serial) => ipcRenderer.invoke('start-mirror', serial),
  stopMirror: (serial) => ipcRenderer.invoke('stop-mirror', serial),
  onMirrorFrame: (cb) => ipcRenderer.on('mirror-frame', (_, data) => cb(data)),
  removeMirrorFrame: () => ipcRenderer.removeAllListeners('mirror-frame'),
  onMirrorState: (cb) => ipcRenderer.on('mirror-state', (_, data) => cb(data)),
  removeMirrorState: () => ipcRenderer.removeAllListeners('mirror-state'),

  // 앱 강제 제거 (삭제)
  uninstallApp: (serial, packageName) => ipcRenderer.invoke('uninstall-app', serial, packageName),

  // 기기 위치 카테고리 (그룹) 설정
  setDeviceGroup: (serial, group) => ipcRenderer.invoke('set-device-group', serial, group),

  // 다운로드 폴더 전체 비우기
  clearDownloadFolder: (serial) => ipcRenderer.invoke('clear-download-folder', serial),

  // 서버 IP 조회
  getServerIp: () => ipcRenderer.invoke('get-server-ip'),

  // 네트워크 모드 (local: 같은 WiFi 직접 / external: Cloudflare 터널)
  setNetworkMode: (mode) => ipcRenderer.invoke('set-network-mode', mode),
  getNetworkMode: () => ipcRenderer.invoke('get-network-mode'),

  // APK 자동 빌드 & 전체 배포
  buildAndDeployApk: () => ipcRenderer.invoke('build-and-deploy-apk'),
  onBuildProgress: (cb) => ipcRenderer.on('build-progress', (_, data) => cb(data)),
  removeBuildProgress: () => ipcRenderer.removeAllListeners('build-progress'),
});
