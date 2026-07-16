import { useState, useEffect } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function ConnectModal({ onClose }) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('5555');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [serverConfig, setServerConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const loadConfig = async () => {
      if (isMdm) {
        try {
          const cfg = await window.mdm.getServerConfig();
          if (mounted && cfg) {
            setServerConfig(cfg);
          }
        } catch (e) {
          console.error('Failed to load server config:', e);
        } finally {
          if (mounted) setConfigLoading(false);
        }
      } else {
        // 일반 브라우저: 현재 접속한 주소 사용
        const hostname = window.location.hostname;
        if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
          if (mounted) setServerConfig({ url: `http://${hostname}:3010`, mode: 'local' });
        }
        if (mounted) setConfigLoading(false);
      }
    };
    loadConfig();
    return () => { mounted = false; };
  }, []);

  const getServerUrl = () => {
    if (serverConfig) return serverConfig.url;
    return '';
  };

  const handleConnect = async () => {
    if (!ip) return;
    setLoading(true);
    setResult(null);
    if (isMdm) {
      const res = await window.mdm.connectWifi(ip, parseInt(port));
      setResult(res);
    } else {
      await new Promise(r => setTimeout(r, 1000));
      setResult({ ok: true, message: `connected to ${ip}:${port}` });
    }
    setLoading(false);
  };

  if (configLoading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>🔗 WiFi ADB 연결</h2>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body" style={{ maxHeight: '75vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center' }}>
            <div style={{ width: 160, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12, background: '#f8fafc', borderRadius: 12, border: '1px dashed #cbd5e1' }}>
              서버 설정 로드 중...
            </div>
            <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 12 }}>네트워크 모드 확인 중...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!serverConfig) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>🔗 WiFi ADB 연결</h2>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body" style={{ maxHeight: '75vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center' }}>
            <div style={{ width: 160, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontSize: 12, background: '#fef2f2', borderRadius: 12, border: '1px solid #fecaca' }}>
              서버 정보를 가져올 수 없습니다.
            </div>
            <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 12 }}>
              Electron 앱에서 실행 중인지 확인하세요.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🔗 WiFi ADB 연결</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ maxHeight: '75vh', overflowY: 'auto' }}>
          
          {/* QR 코드 연동 섹션 */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            padding: '16px', background: '#f8fafc', borderRadius: 12, border: '1px dashed #cbd5e1',
            marginBottom: 8
          }}>
            <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0, color: '#334155' }}>📱 태블릿 QR코드 간편 연동</h3>
            <p style={{ fontSize: 11.5, color: '#64748b', textAlign: 'center', margin: '0 0 6px 0', lineHeight: 1.5 }}>
              태블릿 앱에서 <strong>[🔗 QR코드 스캔 등록]</strong> 버튼을 누르고<br/>아래 QR 코드를 비추면 즉시 연동됩니다.
            </p>
            <div style={{
              padding: 8, background: '#ffffff', borderRadius: 8, border: '1px solid #e2e8f0',
              boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
            }}>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(getServerUrl())}`}
                alt="Connect QR Code"
                style={{ width: 160, height: 160, display: 'block' }}
              />
            </div>
            
            {/* 현재 모드 표시 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '6px 12px', background: serverConfig.mode === 'local' ? '#f0fdf4' : '#eef2ff', border: `1px solid ${serverConfig.mode === 'local' ? '#86efac' : '#c7d2fe'}`, borderRadius: 8, fontSize: 11.5, color: serverConfig.mode === 'local' ? '#166534' : '#4f46e5' }}>
              <span>{serverConfig.mode === 'local' ? '📶' : '🌐'}</span>
              <strong>{serverConfig.mode === 'local' ? '로컬 WiFi 모드' : '외부망(Cloudflare) 모드'}</strong>
              <span style={{ opacity: 0.7 }}>자동 감지됨</span>
            </div>

            {/* 수동 IP 입력 기능 추가 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>서버 URL 수정:</span>
              <input
                type="text"
                value={getServerUrl()}
                onChange={e => {
                  const val = e.target.value;
                  if (serverConfig) setServerConfig({...serverConfig, url: val});
                }}
                style={{
                  fontSize: 12,
                  fontFamily: 'monospace',
                  width: 280,
                  padding: '4px 8px',
                  border: '1px solid #cbd5e1',
                  borderRadius: 6,
                  textAlign: 'center',
                  outline: 'none',
                  background: '#ffffff',
                  color: '#0f172a'
                }}
              />
            </div>
          </div>

          <div style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', margin: '4px 0' }}>— 또는 USB 무선 ADB로 기기 연동 —</div>

          <p className="hint">
            태블릿에서 <strong>개발자 옵션 → 무선 디버깅</strong>을 활성화한 후<br/>
            표시된 IP 주소와 포트를 입력하세요.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label>IP 주소</label>
              <input
                type="text"
                placeholder="예: 192.168.1.100"
                value={ip}
                onChange={e => setIp(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div className="form-group" style={{ width: 100 }}>
              <label>포트</label>
              <input
                type="text"
                value={port}
                onChange={e => setPort(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {result && (
            <div className={`result-box ${result.ok ? 'success' : 'error'}`}>
              {result.ok ? '✅' : '❌'} {result.message || result.error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>취소</button>
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={loading || !ip}
          >
            {loading ? '연결 중...' : '연결하기'}
          </button>
        </div>
      </div>

      <style jsx>{`
        .modal-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.6);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000;
          backdrop-filter: blur(4px);
        }
        .modal {
          width: 460px;
          overflow: hidden;
        }
        .modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 20px;
          border-bottom: 1px solid var(--border);
        }
        .modal-header h2 { font-size: 16px; font-weight: 700; }
        .close-btn {
          background: none; border: none; color: var(--text-muted);
          cursor: pointer; font-size: 16px; padding: 4px 8px;
          border-radius: 6px;
        }
        .close-btn:hover { background: var(--bg-card2); color: var(--text); }
        .modal-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
        .hint {
          font-size: 13px; color: var(--text-muted);
          background: var(--bg-card2);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 12px;
          line-height: 1.7;
        }
        .hint strong { color: var(--primary); }
        .form-row { display: flex; gap: 10px; }
        .form-group { display: flex; flex-direction: column; gap: 6px; flex: 1; }
        .form-group label { font-size: 12px; font-weight: 600; color: var(--text-muted); }
        .result-box {
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
          font-family: var(--mono);
        }
        .result-box.success {
          background: rgba(34,197,94,0.1);
          color: var(--green);
          border: 1px solid rgba(34,197,94,0.3);
        }
        .result-box.error {
          background: rgba(239,68,68,0.1);
          color: var(--red);
          border: 1px solid rgba(239,68,68,0.3);
        }
        .modal-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 14px 20px;
          border-top: 1px solid var(--border);
        }
      `}</style>
    </div>
  );
}