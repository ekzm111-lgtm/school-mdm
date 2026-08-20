package com.school.mdm;

import android.util.Log;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import android.os.Environment;
import android.provider.Settings;
import android.net.Uri;
import androidx.core.app.ActivityCompat;
import android.Manifest;
import android.content.pm.PackageManager;

import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.result.ActivityResultLauncher;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

public class MainActivity extends AppCompatActivity {
    
    private DevicePolicyManager dpm;
    private ComponentName adminComponent;
    
    private TextView txtStatus;
    private TextView txtGuide;
    private Button btnActivateAdmin;
    private static final int STORAGE_PERMISSION_CODE = 100;

    @Override
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        
        // ── 동적 레이아웃 생성 (XML 디자인이 없어도 동작 가능하도록) ──
        android.widget.LinearLayout layout = new android.widget.LinearLayout(this);
        layout.setOrientation(android.widget.LinearLayout.VERTICAL);
        layout.setPadding(40, 60, 40, 40);
        layout.setBackgroundColor(0xFFF1F5F9); // Light Gray

        TextView title = new TextView(this);
        title.setText("🏫 School MDM Client");
        title.setTextSize(24);
        title.setTextColor(0xFF0F172A);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(android.view.Gravity.CENTER_HORIZONTAL);
        layout.addView(title);

        txtStatus = new TextView(this);
        txtStatus.setTextSize(16);
        txtStatus.setTextColor(0xFF475569);
        txtStatus.setPadding(0, 40, 0, 20);
        layout.addView(txtStatus);

        txtGuide = new TextView(this);
        txtGuide.setTextSize(14);
        txtGuide.setTextColor(0xFFEF4444);
        txtGuide.setPadding(0, 0, 0, 40);
        txtGuide.setLineSpacing(1.2f, 1.2f);
        layout.addView(txtGuide);

        btnActivateAdmin = new Button(this);
        btnActivateAdmin.setText("🛡️ 디바이스 관리자 활성화");
        btnActivateAdmin.setBackgroundColor(0xFF4F46E5); // Indigo
        btnActivateAdmin.setTextColor(0xFFFFFFFF);
        layout.addView(btnActivateAdmin);

        Button btnScanQr = new Button(this);
        btnScanQr.setText("🔗 QR코드 스캔 등록");
        btnScanQr.setBackgroundColor(0xFF10B981); // Emerald
        btnScanQr.setTextColor(0xFFFFFFFF);
        android.widget.LinearLayout.LayoutParams params = new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 20, 0, 0);
        btnScanQr.setLayoutParams(params);
        layout.addView(btnScanQr);

        btnScanQr.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ScanOptions options = new ScanOptions();
                options.setPrompt("PC 화면의 QR 코드를 사각형 안에 비춰주세요.");
                options.setBeepEnabled(true);
                options.setBarcodeImageEnabled(true);
                options.setOrientationLocked(false);
                qrScanLauncher.launch(options);
            }
        });

        setContentView(layout);

        // ── 비즈니스 로직 ──
        dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        adminComponent = new ComponentName(this, MyDeviceAdminReceiver.class);

        btnActivateAdmin.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
                intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent);
                intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "학교 태블릿 제어를 위한 관리자 권한을 활성화합니다.");
                startActivity(intent);
            }
        });

        checkMdmStatus();
        startMdmService();
        checkStoragePermission();
        checkLocationPermission();
        handleIntentShortcut(getIntent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        checkMdmStatus();
    }

    private void checkMdmStatus() {
        boolean isAdmin = dpm.isAdminActive(adminComponent);
        boolean isOwner = dpm.isDeviceOwnerApp(getPackageName());

        StringBuilder status = new StringBuilder();
        status.append("• 디바이스 관리자(Admin): ").append(isAdmin ? "✅ 활성화됨" : "❌ 비활성화됨").append("\n");
        status.append("• 기기 소유자(Device Owner): ").append(isOwner ? "✅ 등록됨" : "❌ 미등록 (개발 테스트 시 무시 가능)").append("\n");

        txtStatus.setText(status.toString());

        if (!isAdmin) {
            btnActivateAdmin.setVisibility(View.VISIBLE);
            txtGuide.setText("⚠️ [디바이스 관리자 활성화 필요]\n" +
                    "원격 명령 처리를 위해 먼저 디바이스 관리자를 활성화해 주세요.");
            txtGuide.setTextColor(0xFFEF4444);
        } else {
            btnActivateAdmin.setVisibility(View.GONE);
            txtGuide.setText("🎉 디바이스 관리자가 연동되었습니다. PC 관리자 프로그램을 켜고 명령을 보낼 수 있습니다.\n" +
                    "(Device Owner 미등록 상태이므로 잠금 해제/키오스크 등의 일부 고급 기능은 제한될 수 있습니다.)");
            txtGuide.setTextColor(0xFF16A34A);
        }
    }

    private void checkStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.addCategory("android.intent.category.DEFAULT");
                    intent.setData(Uri.parse(String.format("package:%s", getPackageName())));
                    startActivity(intent);
                } catch (Exception e) {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    startActivity(intent);
                }
            }
        } else {
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{
                        Manifest.permission.READ_EXTERNAL_STORAGE,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE
                }, STORAGE_PERMISSION_CODE);
            }
        }
    }

    private void checkLocationPermission() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, 200);
        }
    }

    private void startMdmService() {
        Intent intent = new Intent(this, MdmService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private final ActivityResultLauncher<ScanOptions> qrScanLauncher = registerForActivityResult(
            new ScanContract(),
            result -> {
                if (result.getContents() == null) {
                    Toast.makeText(MainActivity.this, "스캔이 취소되었습니다.", Toast.LENGTH_LONG).show();
                } else {
                    String qrData = result.getContents();
                    saveServerUrl(qrData);
                }
            }
    );

    private void saveServerUrl(String url) {
        getSharedPreferences("MDM_PREFS", MODE_PRIVATE)
                .edit()
                .putString("server_url", url)
                .apply();
        
        Toast.makeText(this, "서버 주소 설정 완료: " + url, Toast.LENGTH_LONG).show();
        
        // 서비스 재시작하여 소켓 재접속 유도
        Intent serviceIntent = new Intent(this, MdmService.class);
        stopService(serviceIntent);
        startMdmService();
        
        checkMdmStatus();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntentShortcut(intent);
    }

    private void handleIntentShortcut(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            String filePath = intent.getStringExtra("filePath");
            if (filePath != null && !filePath.isEmpty()) {
                java.io.File file = new java.io.File(filePath);
                if (file.exists()) {
                    openFile(file);
                } else {
                    Toast.makeText(this, "파일이 존재하지 않습니다: " + file.getName(), Toast.LENGTH_SHORT).show();
                }
            }
        }
    }

    private void openFile(java.io.File file) {
        String ext = "";
        String absolutePath = file.getAbsolutePath();
        int lastDot = absolutePath.lastIndexOf('.');
        if (lastDot > 0) {
            ext = absolutePath.substring(lastDot + 1).toLowerCase();
        }
        
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        
        android.net.Uri fileUri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            fileUri = androidx.core.content.FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    file
            );
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            fileUri = android.net.Uri.fromFile(file);
        }

        String type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (type == null) {
            type = "*/*";
        }
        intent.setDataAndType(fileUri, type);

        // 갤럭시 탭의 대표 문서/이미지 앱으로 즉시 직행 바인딩 처리
        try {
            if ("pdf".equals(ext)) {
                if (isPackageInstalled("com.google.android.apps.docs")) {
                    intent.setPackage("com.google.android.apps.docs");
                } else if (isPackageInstalled("com.android.chrome")) {
                    intent.setPackage("com.android.chrome");
                }
            } else if ("png".equals(ext) || "jpg".equals(ext) || "jpeg".equals(ext) || "gif".equals(ext)) {
                if (isPackageInstalled("com.sec.android.gallery3d")) {
                    intent.setPackage("com.sec.android.gallery3d");
                } else if (isPackageInstalled("com.google.android.apps.photos")) {
                    intent.setPackage("com.google.android.apps.photos");
                }
            }
            startActivity(intent);
            finish();
            return;
        } catch (Exception e) {
            Log.e("MDM", "Explicit app package binding failed, falling back", e);
        }

        // Fallback: 일반 암시적 매칭 결과의 첫 번째 기기 뷰어 앱 타겟
        try {
            PackageManager pm = getPackageManager();
            java.util.List<android.content.pm.ResolveInfo> list = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
            if (list != null && !list.isEmpty()) {
                intent.setPackage(list.get(0).activityInfo.packageName);
            }
            startActivity(intent);
            finish();
        } catch (Exception ex) {
            Toast.makeText(this, "파일을 열 수 있는 앱 뷰어가 없습니다.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean isPackageInstalled(String packageName) {
        try {
            getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
