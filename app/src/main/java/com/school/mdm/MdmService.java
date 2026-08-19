package com.school.mdm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.os.BatteryManager;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.net.URISyntaxException;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;
import android.os.Environment;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.location.Location;
import android.location.LocationManager;
import android.webkit.MimeTypeMap;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.hardware.display.VirtualDisplay;
import android.hardware.display.DisplayManager;
import android.media.Image;
import android.media.ImageReader;
import android.graphics.PixelFormat;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;

public class MdmService extends Service {
    private static final String TAG = "MdmService";
    private static final String CHANNEL_ID = "MdmServiceChannel";
    
    // 어드민 PC 서버 주소 (ngrok 고정 외부 중계 터널 주소로 매핑)
    // ⚠️ Cloudflare Tunnel로 교체됨 — URL이 매번 바뀌므로 서버에서 동적으로 조회
    private static final String SERVER_URL = "https://nonepithelial-unbased-reece.ngrok-free.dev";
    // 로컬 IP 폴백: 같은 WiFi에서 직접 연결 (cloudflared가 없어도 동작)
    private static final String FALLBACK_LOCAL_IP = "10.131.1.19"; // 관리 PC IP
    private int mReconnectAttempts = 0;

    private Socket mSocket;
    private DevicePolicyManager dpm;
    private ComponentName adminComponent;

    private MediaProjection mMediaProjection;
    private VirtualDisplay mVirtualDisplay;
    private ImageReader mImageReader;
    private Handler mMirrorHandler;
    private Runnable mMirrorRunnable;
    private boolean mIsMirroring = false;

    // 15초마다 하트비트 (engine.io pingTimeout 20초보다 짧게)
    private static final long HEARTBEAT_INTERVAL_MS = 15 * 1000L; // 15초
    private final android.os.Handler mHeartbeatHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable mHeartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            sendHeartbeat();
            mHeartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
        }
    };

    private android.os.PowerManager.WakeLock mWakeLock;
    private android.net.wifi.WifiManager.WifiLock mWifiLock;

    private void acquireLocks() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && (mWakeLock == null || !mWakeLock.isHeld())) {
                mWakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "SchoolMDM::ServiceWakeLock");
                mWakeLock.acquire();
                Log.d(TAG, "[Lock] PARTIAL_WAKE_LOCK acquired — CPU stays awake during sleep/charging");
            }
            android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null && (mWifiLock == null || !mWifiLock.isHeld())) {
                mWifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "SchoolMDM::ServiceWifiLock");
                mWifiLock.acquire();
                Log.d(TAG, "[Lock] WIFI_MODE_FULL_HIGH_PERF acquired — WiFi stays awake during sleep/charging");
            }
        } catch (Exception e) {
            Log.e(TAG, "[Lock] Lock acquire failed", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        adminComponent = new ComponentName(this, MyDeviceAdminReceiver.class);
        
        createNotificationChannel();
        startForeground(1, getNotification());

        acquireLocks();
        connectToServer();
    }

    private void connectToServer() {
        try {
            String savedUrl = getSharedPreferences("MDM_PREFS", MODE_PRIVATE).getString("server_url", SERVER_URL);
            
            IO.Options opts = new IO.Options();
            opts.transports = new String[]{"websocket"}; // HTTP Polling을 건너뛰고 바로 웹소켓으로 붙어 Cloudflare Rate Limit 우회
            opts.extraHeaders = new java.util.HashMap<>();
            opts.extraHeaders.put("ngrok-skip-browser-warning", java.util.Arrays.asList("true"));
            opts.reconnection = true;
            opts.reconnectionAttempts = Integer.MAX_VALUE; // 영원히 재연결 시도
            opts.reconnectionDelay = 300;  // 첫 연결 실패 후 0.3초 대기
            opts.reconnectionDelayMax = 3000; // 최대 3초 대기 후 재시도 (기본 5초에서 단축)
            
            mSocket = IO.socket(savedUrl, opts);
            
            mSocket.on(Socket.EVENT_CONNECT, new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    Log.d(TAG, "Connected to MDM server.");
                    mReconnectAttempts = 0;
                    registerDevice();
                    // 연결 즉시 하트비트 시작 (20분 주기)
                    mHeartbeatHandler.removeCallbacks(mHeartbeatRunnable);
                    mHeartbeatHandler.postDelayed(mHeartbeatRunnable, HEARTBEAT_INTERVAL_MS);
                }
            });

            // ⭐ Cloudflare Tunnel URL 변경 감지: 서버가 새 URL을 브로드캐스트하면 자동 재연결
            mSocket.on("tunnel-url-changed", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            org.json.JSONObject data = (org.json.JSONObject) args[0];
                            String newUrl = data.getString("url");
                            Log.d(TAG, "[CF] 새 터널 URL 수신: " + newUrl);
                            getSharedPreferences("MDM_PREFS", MODE_PRIVATE)
                                    .edit().putString("server_url", newUrl).apply();
                            // 기존 소켓 종료 후 새 URL로 재연결
                            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                                if (mSocket != null) { mSocket.disconnect(); mSocket.off(); }
                                connectToServer();
                            }, 1000);
                        } catch (Exception e) {
                            Log.e(TAG, "tunnel-url-changed parse error", e);
                        }
                    }
                }
            });

            // 소켓 연결 실패 시 로컬 IP 폴백 또는 서버에서 새 URL 조회
            mSocket.on(Socket.EVENT_CONNECT_ERROR, new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    mReconnectAttempts++;
                    Log.w(TAG, "[Socket] 연결 실패 (시도 " + mReconnectAttempts + ")");
                    if (mReconnectAttempts >= 3) {
                        // 3회 실패 시 (1.5초 만에!) 즉시 Gist/로컬에서 새 URL 조회
                        new Thread(() -> fetchTunnelUrlFromLocal()).start();
                        mReconnectAttempts = 0;
                    }
                }
            });


            mSocket.on("lock", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    lockDevice();
                }
            });

            mSocket.on("unlock", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    unlockDevice();
                }
            });

            mSocket.on("kiosk", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            JSONObject data = (JSONObject) args[0];
                            String pkg = data.getString("packageName");
                            setKioskMode(pkg);
                        } catch (Exception e) {
                            Log.e(TAG, "Kiosk command parse error", e);
                        }
                    }
                }
            });

            mSocket.on("exit_kiosk", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    exitKioskMode();
                }
            });

            mSocket.on("volume", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        int level = (int) args[0];
                        setVolume(level);
                    }
                }
            });

            mSocket.on("message", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        String msg = (String) args[0];
                        showNotificationMessage(msg);
                    }
                }
            });

            mSocket.on("file-distribute", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            JSONObject data = (JSONObject) args[0];
                            String fileUrl = data.getString("fileUrl");
                            String fileName = data.getString("fileName");
                            boolean createShortcut = data.optBoolean("createShortcut", false);
                            downloadAndProcessFile(fileUrl, fileName, createShortcut);
                        } catch (Exception e) {
                            Log.e(TAG, "File distribute command parse error", e);
                        }
                    }
                }
            });

            mSocket.on("get-location", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    sendCurrentLocation();
                }
            });

            mSocket.on("find-device", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    playFindDeviceSound();
                }
            });

            mSocket.on("get-app-list", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    sendAppList();
                }
            });

            mSocket.on("clear-download", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    Log.d(TAG, "[ClearDownload] 명령 수신됨 — 폴더 비우기 시작");
                    clearDownloadFolder();
                }
            });

            mSocket.on("force-stop-app", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            JSONObject data = (JSONObject) args[0];
                            String packageName = data.getString("packageName");
                            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
                            if (am != null) am.killBackgroundProcesses(packageName);
                            Log.d(TAG, "[ForceStop] " + packageName);
                        } catch (Exception e) { Log.e(TAG, "force-stop error", e); }
                    }
                }
            });

            mSocket.on("uninstall-app", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            JSONObject data = (JSONObject) args[0];
                            String packageName = data.getString("packageName");
                            uninstallApp(packageName);
                        } catch (Exception e) { Log.e(TAG, "uninstall error", e); }
                    }
                }
            });

            mSocket.on("start-mirror", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    startMirrorFlow();
                }
            });

            mSocket.on("stop-mirror", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    stopMirror();
                }
            });

            // ⭐ 네트워크 모드 변경 (서버가 server-config 이벤트로 새 URL을 전송)
            mSocket.on("server-config", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            org.json.JSONObject data = (org.json.JSONObject) args[0];
                            String mode = data.optString("mode", "external");
                            String newUrl = data.optString("url", null);
                            String localUrl = data.optString("localUrl", null);

                            Log.d(TAG, "[Config] server-config 수신: mode=" + mode + ", url=" + newUrl);

                            if (newUrl == null || newUrl.isEmpty()) {
                                Log.w(TAG, "[Config] URL 없음, 무시");
                                return;
                            }

                            // SharedPreferences에 저장된 URL과 다르면 재연결
                            String savedUrl = getSharedPreferences("MDM_PREFS", MODE_PRIVATE).getString("server_url", "");
                            if (!newUrl.equals(savedUrl)) {
                                Log.d(TAG, "[Config] URL 변경 감지, 재연결: " + savedUrl + " → " + newUrl);
                                getSharedPreferences("MDM_PREFS", MODE_PRIVATE)
                                        .edit().putString("server_url", newUrl).apply();
                                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                                    if (mSocket != null) { mSocket.disconnect(); mSocket.off(); }
                                    connectToServer();
                                }, 1000);
                            } else {
                                Log.d(TAG, "[Config] URL 동일, 재연결 불필요");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "server-config parse error", e);
                        }
                    }
                }
            });

            // ⭐ APK 자동 업데이트 (관리자가 빌드 & 배포 → 모든 태블릿에 apk-update 전송)
            mSocket.on("apk-update", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length > 0) {
                        try {
                            org.json.JSONObject data = (org.json.JSONObject) args[0];
                            String apkUrl = data.optString("apkUrl", "");
                            String localApkUrl = data.optString("localApkUrl", "");
                            String version = data.optString("version", "");

                            Log.d(TAG, "[APK] 업데이트 수신: local=" + localApkUrl + ", ext=" + apkUrl + ", ver=" + version);

                            // APK 파일 다운로드 후 자동 설치 (로컬 망 1순위 -> 외부망 2순위)
                            new Thread(() -> {
                                try {
                                    java.io.File apkFile = null;
                                    if (!localApkUrl.isEmpty()) {
                                        Log.d(TAG, "[APK] 로컬 망 다운로드 시도: " + localApkUrl);
                                        apkFile = downloadApk(localApkUrl);
                                    }
                                    if (apkFile == null && !apkUrl.isEmpty()) {
                                        Log.d(TAG, "[APK] 외부 망 다운로드 폴백 시도: " + apkUrl);
                                        apkFile = downloadApk(apkUrl);
                                    }
                                    if (apkFile != null) {
                                        Log.d(TAG, "[APK] 다운로드 완료, 자동 설치 시작: " + apkFile.getAbsolutePath());
                                        installApkSilent(apkFile);
                                    } else {
                                        Log.e(TAG, "[APK] 모든 경로 다운로드 실패");
                                    }
                                } catch (Exception e) {
                                    Log.e(TAG, "[APK] 자동 업데이트 실패", e);
                                }
                            }).start();
                        } catch (Exception e) {
                            Log.e(TAG, "apk-update parse error", e);
                        }
                    }
                }
            });

            mSocket.connect();
        } catch (URISyntaxException e) {
            Log.e(TAG, "Socket url parse error", e);
        }
    }

    // 어드민에 태블릿 정보 등록
    private void registerDevice() {
        try {
            JSONObject device = new JSONObject();
            String serial = getDeviceSerial();

            device.put("serial", serial);
            device.put("model", Build.MODEL);
            device.put("state", "online");
            device.put("isDeviceOwner", dpm.isDeviceOwnerApp(getPackageName()));
            device.put("battery", getBatteryLevel());
            device.put("charging", isBatteryCharging());
            device.put("ip", getLocalIpAddress());
            device.put("appVersionCode", 3);
            device.put("appVersionName", "1.2");
            mSocket.emit("register", device);
        } catch (Exception e) {
            Log.e(TAG, "Register error", e);
        }
    }

    // ── 기기 원격 통제 로직 (Device Owner API 적극 활용) ──

    private void lockDevice() {
        if (dpm.isAdminActive(adminComponent)) {
            Log.d(TAG, "Locking screen now...");
            dpm.lockNow();
        } else {
            Log.w(TAG, "Device Admin is not active");
        }
    }

    private void unlockDevice() {
        // Device Owner는 키가드를 강제로 비활성화 가능
        if (dpm.isDeviceOwnerApp(getPackageName())) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                dpm.setKeyguardDisabled(adminComponent, true);
                Log.d(TAG, "Keyguard disabled via Device Owner");
            }
        }
    }

    private void setKioskMode(String packageName) {
        if (dpm.isDeviceOwnerApp(getPackageName())) {
            // 키오스크로 지정할 패키지 등록
            dpm.setLockTaskPackages(adminComponent, new String[]{getPackageName(), packageName});
            
            // 해당 앱 실행 후 LockTask 활성화는 해당 앱 내부에서 startLockTask()로 유도하거나
            // 관리자가 임의의 앱을 강제 런처로 등록할 수도 있음
            Log.d(TAG, "Kiosk package set: " + packageName);
        }
    }

    private void exitKioskMode() {
        if (dpm.isDeviceOwnerApp(getPackageName())) {
            dpm.setLockTaskPackages(adminComponent, new String[]{});
            Log.d(TAG, "Kiosk lock packages cleared");
        }
    }

    private void setVolume(int level) {
        AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        // level: 0 ~ max
        int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int target = (int) ((level / 15.0) * max);
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI);
    }

    private void showNotificationMessage(final String message) {
        // 메인 스레드에서 토스트 띄우기
        android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
        handler.post(new Runnable() {
            @Override
            public void run() {
                Toast toast = Toast.makeText(MdmService.this, "[MDM 알림]\n" + message, Toast.LENGTH_LONG);
                toast.setGravity(android.view.Gravity.CENTER, 0, 0);
                toast.show();
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            if ("ACTION_START_MIRROR".equals(action)) {
                int resultCode = intent.getIntExtra("RESULT_CODE", -1);
                Intent data = intent.getParcelableExtra("DATA");
                if (resultCode != -1 && data != null) {
                    startMirror(resultCode, data);
                }
            } else if ("ACTION_MIRROR_DENIED".equals(action)) {
                emitMirrorError("Permission denied by user");
            }
        }
        return START_STICKY;
    }

    /**
     * 로컬 IP(같은 WiFi)를 통해 서버의 /server-config API를 조회하여 적절한 서버 URL 획득
     * - 로컬 모드: http://[관리PC IP]:3010 직접 연결
     * - 외부 모드: Cloudflare Tunnel URL 경유
     * - 기존 /tunnel-url API를 /server-config로 교체하여 모드 정보까지 함께 수신
     */
    private void fetchTunnelUrlFromLocal() {
        // 1. 로컬 IP(같은 학교 네트워크)의 /server-config API 1순위 빠른 조회 (5ms 반응)
        String[] candidateUrls = {
            "http://" + FALLBACK_LOCAL_IP + ":3010/server-config",
        };
        for (String apiUrl : candidateUrls) {
            try {
                java.net.URL url = new java.net.URL(apiUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(800);  // 로칼 연결 매우 빠름 (0.8초에 탈락)
                conn.setReadTimeout(800);
                int code = conn.getResponseCode();
                if (code == 200) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    reader.close();

                    org.json.JSONObject json = new org.json.JSONObject(sb.toString());
                    String targetUrl = json.optString("url", null);
                    String mode = json.optString("mode", "external");

                    String finalUrl = ("local".equals(mode) && json.has("localUrl")) ? json.optString("localUrl") : targetUrl;
                    if (finalUrl != null && !finalUrl.isEmpty()) {
                        Log.d(TAG, "[Config] 로컬 /server-config 조회를 통한 초고속 URL 획득: " + finalUrl);
                        getSharedPreferences("MDM_PREFS", MODE_PRIVATE).edit().putString("server_url", finalUrl).apply();
                        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                            if (mSocket != null) { mSocket.disconnect(); mSocket.off(); }
                            connectToServer();
                        });
                        return; // 성공 시 종료
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "[Config] 로컬 /server-config 조회 실패: " + e.getMessage());
            }
        }

        // 2. 외부망/인터넷만 되는 환경일 때 GitHub Gist 2순위 폴백 조회
        String gistId = getSharedPreferences("MDM_PREFS", MODE_PRIVATE).getString("gist_id", "be45c5670588da06673ab8bda09d7bb1");
        if (gistId != null && !gistId.isEmpty() && !gistId.contains("GIST_ID")) {
            try {
                java.net.URL url = new java.net.URL("https://api.github.com/gists/" + gistId);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(1200);  // Gist API 타임아웃 1.2초
                conn.setRequestProperty("User-Agent", "School-MDM-Android/1.0");
                if (conn.getResponseCode() == 200) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    reader.close();
                    
                    org.json.JSONObject json = new org.json.JSONObject(sb.toString());
                    org.json.JSONObject files = json.getJSONObject("files");
                    org.json.JSONObject mdmFile = files.getJSONObject("mdm_url.json");
                    org.json.JSONObject contentJson = new org.json.JSONObject(mdmFile.getString("content"));
                    String gistUrl = contentJson.getString("url");
                    
                    if (gistUrl != null && !gistUrl.isEmpty()) {
                        Log.d(TAG, "[Gist] Gist에서 최신 외부 URL 획득 성공: " + gistUrl);
                        getSharedPreferences("MDM_PREFS", MODE_PRIVATE).edit().putString("server_url", gistUrl).apply();
                        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                            if (mSocket != null) { mSocket.disconnect(); mSocket.off(); }
                            connectToServer();
                        });
                        return; // 성공 시 종료
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "[Gist] Gist 조회 실패: " + e.getMessage());
            }
        }

        // 3. 로컬도 실패 시 로컬 IP 직접 소켓 연결 시도
        Log.w(TAG, "[Config] 모든 폴백 실패, 로컬 IP 직접 연결 시도");
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            getSharedPreferences("MDM_PREFS", MODE_PRIVATE)
                    .edit().putString("server_url", "http://" + FALLBACK_LOCAL_IP + ":3010").apply();
            if (mSocket != null) { mSocket.disconnect(); mSocket.off(); }
            connectToServer();
        });
    }

    /**
     * APK 파일을 지정된 URL에서 다운로드하여 임시 파일로 저장
     * @param apkUrl 다운로드할 APK URL
     * @return 다운로드된 APK 파일 객체, 실패 시 null
     */
    private java.io.File downloadApk(String apkUrl) {
        java.io.InputStream input = null;
        java.io.OutputStream output = null;
        java.net.HttpURLConnection connection = null;
        try {
            java.net.URL url = new java.net.URL(apkUrl);
            connection = (java.net.HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            connection.connect();

            if (connection.getResponseCode() != java.net.HttpURLConnection.HTTP_OK) {
                Log.e(TAG, "[APK] 다운로드 실패: HTTP " + connection.getResponseCode());
                return null;
            }

            input = connection.getInputStream();
            // 캐시 디렉토리에 임시 APK 파일 생성
            java.io.File tempFile = new java.io.File(getCacheDir(), "mdm_update.apk");
            output = new java.io.FileOutputStream(tempFile);

            byte[] data = new byte[8192];
            int count;
            while ((count = input.read(data)) != -1) {
                output.write(data, 0, count);
            }
            output.flush();
            Log.d(TAG, "[APK] 다운로드 완료: " + tempFile.getAbsolutePath() + " (" + tempFile.length() + " bytes)");
            return tempFile;
        } catch (Exception e) {
            Log.e(TAG, "[APK] 다운로드 에러", e);
            return null;
        } finally {
            try {
                if (output != null) output.close();
                if (input != null) input.close();
            } catch (java.io.IOException ignored) {}
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (mSocket != null) {
            mSocket.disconnect();
            mSocket.off();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "School MDM Service Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }

    private Notification getNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent,
                PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("School MDM 동작 중")
                .setContentText("학교 단말 제어 서비스가 실행 중입니다.")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void downloadAndProcessFile(final String fileUrl, final String fileName, final boolean createShortcut) {
        Log.d(TAG, "Starting file download: " + fileUrl);
        new Thread(new Runnable() {
            @Override
            public void run() {
                java.io.InputStream input = null;
                java.io.OutputStream output = null;
                java.net.HttpURLConnection connection = null;
                try {
                    java.net.URL url = new java.net.URL(fileUrl);
                    connection = (java.net.HttpURLConnection) url.openConnection();
                    connection.connect();

                    if (connection.getResponseCode() != java.net.HttpURLConnection.HTTP_OK) {
                        Log.e(TAG, "Server returned HTTP " + connection.getResponseCode());
                        return;
                    }

                    input = connection.getInputStream();
                    java.io.File downloadDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadDir.exists()) {
                        downloadDir.mkdirs();
                    }
                    final java.io.File targetFile = new java.io.File(downloadDir, fileName);
                    output = new java.io.FileOutputStream(targetFile);

                    byte data[] = new byte[4096];
                    int count;
                    while ((count = input.read(data)) != -1) {
                        output.write(data, 0, count);
                    }
                    
                    Log.d(TAG, "File downloaded successfully to: " + targetFile.getAbsolutePath());
                    showNotificationMessage("파일 다운로드 완료: " + fileName);

                    // APK 파일인 경우 무음(Silent) 백그라운드 자동 설치 시도
                    if (fileName.endsWith(".apk")) {
                        installApkSilent(targetFile);
                    } else if (createShortcut) {
                        createFileShortcut(targetFile);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Download error", e);
                } finally {
                    try {
                        if (output != null) output.close();
                        if (input != null) input.close();
                    } catch (java.io.IOException ignored) {}
                    if (connection != null) connection.disconnect();
                }
            }
        }).start();
    }

    private void installApkSilent(java.io.File apkFile) {
        try {
            PackageManager pm = getPackageManager();
            android.content.pm.PackageInstaller pi = pm.getPackageInstaller();
            android.content.pm.PackageInstaller.SessionParams params = new android.content.pm.PackageInstaller.SessionParams(
                    android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(getPackageName());

            int sessionId = pi.createSession(params);
            android.content.pm.PackageInstaller.Session session = pi.openSession(sessionId);

            java.io.OutputStream out = session.openWrite("COSU_INSTALL", 0, -1);
            java.io.FileInputStream in = new java.io.FileInputStream(apkFile);
            byte[] buffer = new byte[65536];
            int c;
            while ((c = in.read(buffer)) != -1) {
                out.write(buffer, 0, c);
            }
            session.fsync(out);
            in.close();
            out.close();

            // 설치 결과 수신용 펜딩 인텐트
            Intent intent = new Intent(this, MainActivity.class);
            intent.setAction("com.school.mdm.SESSION_API_PACKAGE_INSTALLED");
            android.app.PendingIntent pendingIntent = android.app.PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? android.app.PendingIntent.FLAG_IMMUTABLE : 0)
            );

            session.commit(pendingIntent.getIntentSender());
            session.close();
            Log.d(TAG, "Silent install session committed successfully: " + sessionId);
        } catch (Exception e) {
            Log.e(TAG, "Silent install failed. Falling back to manual install popup.", e);
            installApk(apkFile); // 무음 설치 불가 기기 또는 권한 에러 발생 시 기존 팝업 수동 설치로 Fallback!
        }
    }

    private void installApk(java.io.File apkFile) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            android.net.Uri apkUri = androidx.core.content.FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    apkFile
            );
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            intent.setDataAndType(android.net.Uri.fromFile(apkFile), "application/vnd.android.package-archive");
        }
        startActivity(intent);
    }

    private void createFileShortcut(java.io.File file) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ShortcutManager shortcutManager = getSystemService(ShortcutManager.class);
            if (shortcutManager != null && shortcutManager.isRequestPinShortcutSupported()) {
                // MainActivity를 거쳐 파일을 열어주어 파일 권한 소실 문제 해결
                Intent intent = new Intent(this, MainActivity.class);
                intent.setAction(Intent.ACTION_VIEW);
                intent.putExtra("filePath", file.getAbsolutePath());
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

                ShortcutInfo shortcutInfo = new ShortcutInfo.Builder(this, file.getName())
                        .setShortLabel(file.getName())
                        .setLongLabel(file.getName())
                        .setIcon(Icon.createWithResource(this, android.R.drawable.ic_menu_save))
                        .setIntent(intent)
                        .build();

                shortcutManager.requestPinShortcut(shortcutInfo, null);
                Log.d(TAG, "Shortcut request sent for: " + file.getName());
            }
        }
    }

    private void sendCurrentLocation() {
        try {
            final LocationManager locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (locationManager == null) {
                emitLocationError("Location manager unavailable");
                return;
            }

            if (androidx.core.app.ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                emitLocationError("Location permission denied on device");
                return;
            }

            // 1. 기존 캐시된 위치 조회
            android.location.Location loc = null;
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                loc = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            }
            if (loc == null && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                loc = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            }

            // 캐시된 위치가 있으면 즉시 전송
            if (loc != null) {
                sendLocationData(loc);
            }

            // 2. 실시간 위치 측정 (Location Updates) 시작
            final android.location.LocationListener listener = new android.location.LocationListener() {
                @Override
                public void onLocationChanged(android.location.Location location) {
                    sendLocationData(location);
                    locationManager.removeUpdates(this);
                }
                @Override public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}
                @Override public void onProviderEnabled(String provider) {}
                @Override public void onProviderDisabled(String provider) {}
            };

            android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
            final android.location.Location finalLoc = loc;
            handler.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                            locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, listener, android.os.Looper.getMainLooper());
                        } else if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener, android.os.Looper.getMainLooper());
                        } else {
                            if (finalLoc == null) {
                                emitLocationError("GPS와 네트워크 위치 서비스가 모두 비활성화되어 있습니다.");
                            }
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Request location updates failed", e);
                        emitLocationError("위치 업데이트 요청 실패: " + e.getMessage());
                    }
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Failed to get location", e);
            emitLocationError(e.getMessage());
        }
    }

    private void sendLocationData(android.location.Location loc) {
        try {
            JSONObject res = new JSONObject();
            res.put("serial", getDeviceSerial());
            res.put("lat", loc.getLatitude());
            res.put("lng", loc.getLongitude());
            mSocket.emit("location-response", res);
            Log.d(TAG, "Location sent: lat=" + loc.getLatitude() + ", lng=" + loc.getLongitude());
        } catch (Exception e) {
            Log.e(TAG, "sendLocationData error", e);
        }
    }

    private void playFindDeviceSound() {
        try {
            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                // 진동/무음 모드에서도 강제 알람이 울릴 수 있도록 알람 볼륨 강제 조정
                int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxVolume, 0);

                // 기본 알람 소리 사용 (없을 시 전화 벨소리로 대체)
                android.net.Uri alert = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM);
                if (alert == null) {
                    alert = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE);
                }

                android.media.MediaPlayer mediaPlayer = new android.media.MediaPlayer();
                mediaPlayer.setDataSource(this, alert);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    mediaPlayer.setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                } else {
                    mediaPlayer.setAudioStreamType(AudioManager.STREAM_ALARM);
                }

                mediaPlayer.setLooping(false);
                mediaPlayer.prepare();
                mediaPlayer.start();

                // 8초 동안 경고음을 시끄럽게 울린 뒤 종료
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        if (mediaPlayer.isPlaying()) {
                            mediaPlayer.stop();
                        }
                        mediaPlayer.release();
                    } catch (Exception ignored) {}
                }, 8000);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to play find sound", e);
        }
    }

    private String getAndroidId() {
        return android.provider.Settings.Secure.getString(
                getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID
        );
    }

    private String getDeviceSerial() {
        String serial = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                serial = Build.getSerial();
            } else {
                serial = Build.SERIAL;
            }
        } catch (Exception e) {
            serial = getAndroidId();
        }
        if (serial == null || serial.isEmpty() || "unknown".equalsIgnoreCase(serial)) {
            serial = getAndroidId();
        }
        return serial;
    }

    private void emitLocationError(String errorMsg) {
        try {
            JSONObject res = new JSONObject();
            res.put("serial", getDeviceSerial());
            res.put("error", errorMsg);
            mSocket.emit("location-response", res);
        } catch (Exception ignored) {}
    }

    private void startMirrorFlow() {
        if (mIsMirroring) return;
        Intent intent = new Intent(this, MirrorActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private void startMirror(int resultCode, Intent data) {
        try {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (manager == null) {
                emitMirrorError("MediaProjection service unavailable");
                return;
            }

            mMediaProjection = manager.getMediaProjection(resultCode, data);
            
            final int width = 640;
            final int height = 360;
            final int dpi = 160;

            mImageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            mVirtualDisplay = mMediaProjection.createVirtualDisplay(
                    "MDM-Mirror",
                    width,
                    height,
                    dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    mImageReader.getSurface(),
                    null,
                    null
            );

            mIsMirroring = true;
            mMirrorHandler = new Handler(Looper.getMainLooper());
            
            mMirrorRunnable = new Runnable() {
                @Override
                public void run() {
                    if (!mIsMirroring) return;
                    captureFrame(width, height);
                    mMirrorHandler.postDelayed(this, 200); // 5 FPS
                }
            };
            mMirrorHandler.post(mMirrorRunnable);
            Log.d(TAG, "Screen mirroring started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start mirroring", e);
            emitMirrorError(e.getMessage());
        }
    }

    private void captureFrame(int width, int height) {
        Image image = null;
        try {
            image = mImageReader.acquireLatestImage();
            if (image == null) return;

            Image.Plane[] planes = image.getPlanes();
            java.nio.ByteBuffer buffer = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            int rowPadding = rowStride - pixelStride * width;

            Bitmap bitmap = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(buffer);

            Bitmap croppedBitmap = Bitmap.createBitmap(bitmap, 0, 0, width, height);

            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            croppedBitmap.compress(Bitmap.CompressFormat.JPEG, 60, out);
            byte[] bytes = out.toByteArray();

            String base64Frame = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);

            JSONObject payload = new JSONObject();
            payload.put("serial", getDeviceSerial());
            payload.put("image", base64Frame);
            mSocket.emit("mirror-frame", payload);

            bitmap.recycle();
            croppedBitmap.recycle();
        } catch (Exception e) {
            Log.e(TAG, "Frame capture error", e);
        } finally {
            if (image != null) {
                image.close();
            }
        }
    }

    private void stopMirror() {
        mIsMirroring = false;
        if (mMirrorHandler != null && mMirrorRunnable != null) {
            mMirrorHandler.removeCallbacks(mMirrorRunnable);
        }
        if (mVirtualDisplay != null) {
            mVirtualDisplay.release();
            mVirtualDisplay = null;
        }
        if (mImageReader != null) {
            mImageReader.close();
            mImageReader = null;
        }
        if (mMediaProjection != null) {
            mMediaProjection.stop();
            mMediaProjection = null;
        }
        Log.d(TAG, "Screen mirroring stopped");
        
        try {
            JSONObject payload = new JSONObject();
            payload.put("serial", getDeviceSerial());
            payload.put("state", "stopped");
            mSocket.emit("mirror-state", payload);
        } catch (Exception ignored) {}
    }

    private void emitMirrorError(String errorMsg) {
        try {
            JSONObject res = new JSONObject();
            res.put("serial", getDeviceSerial());
            res.put("error", errorMsg);
            mSocket.emit("mirror-state", res);
        } catch (Exception ignored) {}
    }

    // 설치된 앱 목록 조회 후 서버에 전송
    private void sendAppList() {
        new Thread(() -> {
            try {
                PackageManager pm = getPackageManager();
                java.util.List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);
                org.json.JSONArray appArray = new org.json.JSONArray();
                for (ApplicationInfo info : apps) {
                    // 사용자 설치 앱만 (시스템 앱 제외)
                    if ((info.flags & ApplicationInfo.FLAG_SYSTEM) == 0) {
                        appArray.put(info.packageName);
                    }
                }
                JSONObject payload = new JSONObject();
                payload.put("serial", getDeviceSerial());
                payload.put("apps", appArray);
                mSocket.emit("app-list-response", payload);
                Log.d(TAG, "[AppList] sent " + appArray.length() + " apps");
            } catch (Exception e) {
                Log.e(TAG, "sendAppList error", e);
            }
        }).start();
    }

    // 다운로드 폴더 전체 삭제 (하위 폴더 포함 재귀 삭제 및 미디어 DB 갱신)
    private void clearDownloadFolder() {
        new Thread(() -> {
            try {
                // Android 11(API 30) 이상에서 모든 파일 접근 권한 체크
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    if (!android.os.Environment.isExternalStorageManager()) {
                        throw new SecurityException("태블릿에 '모든 파일 관리 권한(MANAGE_EXTERNAL_STORAGE)'이 부여되지 않았습니다. 태블릿 설정에서 권한을 허용해 주세요.");
                    }
                }

                java.io.File downloadDir = android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS);
                java.util.List<String> deletedPaths = new java.util.ArrayList<>();
                int deleted = 0;
                if (downloadDir != null && downloadDir.exists()) {
                    java.io.File[] files = downloadDir.listFiles();
                    if (files != null) {
                        for (java.io.File f : files) {
                            deleted += deleteRecursive(f, deletedPaths);
                        }
                    }
                }

                // 삭제된 파일 경로들에 대한 미디어 스토어 갱신 (유령 파일 방지)
                if (!deletedPaths.isEmpty()) {
                    String[] pathsArray = deletedPaths.toArray(new String[0]);
                    android.media.MediaScannerConnection.scanFile(
                            this,
                            pathsArray,
                            null,
                            (path, uri) -> Log.d(TAG, "Scanned deleted path: " + path + " -> uri: " + uri)
                    );
                }

                final int count = deleted;
                try {
                    JSONObject result = new JSONObject();
                    result.put("serial", getDeviceSerial());
                    result.put("success", true);
                    result.put("deleted", count);
                    mSocket.emit("clear-download-done", result);
                } catch (Exception ignored) {}
                Log.d(TAG, "[ClearDownload] deleted " + count + " items (including subdirectories)");
                final int finalCount = count;
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                    android.widget.Toast.makeText(MdmService.this,
                        "다운로드 폴더 정리 완료 (" + finalCount + "개 항목 삭제)", android.widget.Toast.LENGTH_SHORT).show()
                );
            } catch (Exception e) {
                Log.e(TAG, "clearDownloadFolder error", e);
                try {
                    JSONObject result = new JSONObject();
                    result.put("serial", getDeviceSerial());
                    result.put("success", false);
                    result.put("error", e.getMessage());
                    mSocket.emit("clear-download-done", result);
                } catch (Exception ignored) {}
            }
        }).start();
    }

    // 재귀적으로 파일 및 디렉토리 삭제 후 삭제된 경로 수집
    private int deleteRecursive(java.io.File fileOrDirectory, java.util.List<String> deletedPaths) {
        int count = 0;
        if (fileOrDirectory.isDirectory()) {
            java.io.File[] children = fileOrDirectory.listFiles();
            if (children != null) {
                for (java.io.File child : children) {
                    count += deleteRecursive(child, deletedPaths);
                }
            }
        }
        String absolutePath = fileOrDirectory.getAbsolutePath();
        if (fileOrDirectory.delete()) {
            deletedPaths.add(absolutePath);
            count++;
        }
        return count;
    }

    // 앱 원격 제거 (사용자에게 제거 다이얼로그 표시)
    private void uninstallApp(String packageName) {
        try {
            Intent intent = new Intent(Intent.ACTION_DELETE);
            intent.setData(android.net.Uri.parse("package:" + packageName));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            // 제거 UI 뜬 것으로 간주하고 응답
            JSONObject result = new JSONObject();
            result.put("serial", getDeviceSerial());
            result.put("success", true);
            mSocket.emit("uninstall-done", result);
        } catch (Exception e) {
            Log.e(TAG, "uninstallApp error", e);
            try {
                JSONObject result = new JSONObject();
                result.put("serial", getDeviceSerial());
                result.put("success", false);
                result.put("error", e.getMessage());
                mSocket.emit("uninstall-done", result);
            } catch (Exception ignored) {}
        }
    }

    private void sendHeartbeat() {
        if (mSocket == null || !mSocket.connected()) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("serial", getDeviceSerial());
            payload.put("battery", getBatteryLevel());
            payload.put("charging", isBatteryCharging());
            payload.put("ip", getLocalIpAddress());
            mSocket.emit("heartbeat", payload);
            Log.d(TAG, "[Heartbeat] sent battery=" + getBatteryLevel() + "% ip=" + getLocalIpAddress());
        } catch (Exception e) {
            Log.e(TAG, "Heartbeat send error", e);
        }
    }

    private String getLocalIpAddress() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> interfaces =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                java.net.NetworkInterface iface = interfaces.nextElement();
                java.util.Enumeration<java.net.InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress addr = addrs.nextElement();
                    if (!addr.isLoopbackAddress() && addr instanceof java.net.Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return "";
    }

    private int getBatteryLevel() {
        Intent intent = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (intent != null) {
            int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level != -1 && scale != -1) {
                return (int) ((level / (float) scale) * 100);
            }
        }
        return 0;
    }

    private boolean isBatteryCharging() {
        Intent intent = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (intent != null) {
            int status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL;
        }
        return false;
    }
}
