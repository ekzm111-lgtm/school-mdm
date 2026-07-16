package com.school.mdm;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.util.Log;
import androidx.appcompat.app.AppCompatActivity;

public class MirrorActivity extends AppCompatActivity {
    private static final String TAG = "MirrorActivity";
    private static final int REQUEST_CODE = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // 빈 투명 뷰 적용
        setContentView(new android.view.View(this));

        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager != null) {
            Intent intent = manager.createScreenCaptureIntent();
            startActivityForResult(intent, REQUEST_CODE);
        } else {
            Log.e(TAG, "MediaProjectionManager unavailable");
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CODE) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                // MdmService에 획득한 권한 데이터(Intent) 전달
                Intent serviceIntent = new Intent(this, MdmService.class);
                serviceIntent.setAction("ACTION_START_MIRROR");
                serviceIntent.putExtra("RESULT_CODE", resultCode);
                serviceIntent.putExtra("DATA", data);
                startService(serviceIntent);
            } else {
                Log.w(TAG, "Screen capture permission denied");
                // 서비스에 거절 상태 전파
                Intent serviceIntent = new Intent(this, MdmService.class);
                serviceIntent.setAction("ACTION_MIRROR_DENIED");
                startService(serviceIntent);
            }
        }
        finish();
    }
}
