package com.school.mdm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

public class InstallReceiver extends BroadcastReceiver {
    private static final String TAG = "InstallReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

        Log.d(TAG, "[SilentInstall] 수신된 설치 상태: status=" + status + ", message=" + message);

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // ⭐ 팝업 요청이 오더라도 화면에 팝업을 띄우지 않고 디바이스 관리자 권한으로 자동 승인/실행!
            Intent userAction = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (userAction != null) {
                userAction.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(userAction);
                    Log.d(TAG, "[SilentInstall] PENDING_USER_ACTION 자동 승인 실행 완료");
                } catch (Exception e) {
                    Log.e(TAG, "[SilentInstall] PENDING_USER_ACTION 실행 에러", e);
                }
            }
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            Log.d(TAG, "[SilentInstall] 🎉 무음 백그라운드 패키지 설치 완전 성공!");
            // 설치 완료 후 MdmService 재시작
            Intent serviceIntent = new Intent(context, MdmService.class);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        } else {
            Log.e(TAG, "[SilentInstall] 무음 설치 실패: status=" + status + ", message=" + message);
        }
    }
}
