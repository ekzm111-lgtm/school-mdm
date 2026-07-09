import { useState, useEffect } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function MirrorModal({ device, onClose }) {
  const [frame, setFrame] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!device) return;
    if (!isMdm) {
      setError('실시간 화면 모니터링은 무설치 Portable.exe 프로그램 환경에서만 지원됩니다.');
      setLoading(false);
      return;
    }

    let frameCount = 0;
    
    // FPS 계산기
    const fpsTimer = setInterval(() => {
      setFps(frameCount);
      frameCount = 0;
    }, 1000);

    const startStreaming = async () => {
      try {
        setError('');
        setLoading(true);

        // 1. 미러링 개시 명령 전송
        await window.mdm.startMirror(device.serial);

        // 2. 스트림 리스너 등록
        window.mdm.onMirrorFrame((data) => {
          if (data.serial === device.serial) {
            setFrame(data.image);
            setLoading(false);
            frameCount++;
          }
        });
        
        window.mdm.onMirrorState((data) => {
          if (data.serial === device.serial) {
            if (data.error) {
              setError(data.error);
              setLoading(false);
            } else if (data.state === 'stopped') {
              setError('기기에서 미러링 전송이 정지되었습니다.');
            }
          }
        });
      } catch (err) {
        setError('미러링 초기화 중 오류가 발생했습니다.');
        setLoading(false);
      }
    };

    startStreaming();

    // 정리(Clean up)
    return () => {
      clearInterval(fpsTimer);
      window.mdm.stopMirror(device.serial);
      window.mdm.removeMirrorFrame();
      window.mdm.removeMirrorState();
    };
  }, [device]);

  if (!device) return null;

  return (
    <div className="mirror-overlay" onClick={onClose}>
      <div className="mirror-modal animate-fade" onClick={e => e.stopPropagation()}>
        <div className="mirror-header">
          <div>
            <h3 style={{ margin: 0 }}>🖥️ 실시간 무선 화면 모니터링</h3>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
              기기: {device.alias || device.model} ({device.serial})
            </span>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="mirror-body">
          {loading && (
            <div className="status-container">
              <div className="spinner"></div>
              <p>태블릿 화면 권한 승인 대기 중...</p>
              <span className="tip">※ 태블릿 화면에 나타난 '화면 녹화/전송 시작' 권한 팝업을 허용해 주십시오.</span>
            </div>
          )}

          {error && (
            <div className="status-container error">
              <span style={{ fontSize: 32 }}>⚠️</span>
              <p>{error}</p>
              <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginTop: 8, color: '#f8fafc', background: '#1e293b' }}>창 닫기</button>
            </div>
          )}

          {!loading && !error && frame && (
            <div className="frame-container">
              <img src={`data:image/jpeg;base64,${frame}`} alt="mirroring screen" className="mirror-image" />
              <div className="fps-indicator">🟢 실시간 수신 중 • {fps} FPS</div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .mirror-overlay {
          position: fixed; inset: 0;
          background: rgba(15, 23, 42, 0.75);
          display: flex; align-items: center; justify-content: center;
          z-index: 2000;
          backdrop-filter: blur(6px);
        }
        .mirror-modal {
          width: 720px;
          background: #0f172a;
          border-radius: 16px;
          border: 1px solid #334155;
          box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .mirror-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid #1e293b;
          color: #f8fafc;
        }
        .close-btn {
          background: none; border: none; color: #94a3b8;
          cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 6px;
          transition: all 0.12s;
        }
        .close-btn:hover { background: #1e293b; color: #f8fafc; }
        
        .mirror-body {
          height: 480px;
          background: #020617;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        
        .status-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          color: #94a3b8;
          font-size: 13.5px;
          padding: 20px;
          text-align: center;
        }
        .status-container.error { color: #f87171; }
        .tip { font-size: 11px; color: #64748b; }
        
        .frame-container {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .mirror-image {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          border-radius: 4px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.8);
        }
        
        .fps-indicator {
          position: absolute;
          bottom: 12px;
          right: 12px;
          background: rgba(15, 23, 42, 0.8);
          color: #34d399;
          font-size: 11px;
          font-weight: 700;
          font-family: var(--mono);
          padding: 4px 8px;
          border-radius: 4px;
          border: 1px solid #1e293b;
        }
        
        .spinner {
          width: 28px;
          height: 28px;
          border: 3px solid rgba(79, 70, 229, 0.2);
          border-top-color: #4f46e5;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
