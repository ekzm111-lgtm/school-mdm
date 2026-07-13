import { useState, useRef, useEffect } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function FileDistributeModal({ devices, onClose }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [createShortcut, setCreateShortcut] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedSerials, setSelectedSerials] = useState([]);
  const fileInputRef = useRef(null);

  const onlineDevices = devices.filter(d => d.state === 'online');

  // 최초 마운트 시 1회만 온라인 기기 목록으로 초기 선택 세팅
  useEffect(() => {
    setSelectedSerials(devices.filter(d => d.state === 'online').map(d => d.serial));
  }, []);

  useEffect(() => {
    // 전역적인 브라우저 파일 드롭 기본 동작 방지 및 복사 커서 강제화 (🚫 방지)
    const preventDefault = (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    window.addEventListener('dragenter', preventDefault);
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);

    if (isMdm && window.mdm.onDistributeProgress) {
      window.mdm.onDistributeProgress(({ progress, state }) => {
        setProgress(progress);
        if (state === 'copying') {
          setStatusText(`PC 서버로 파일 복사 중... (${progress}%)`);
        }
      });
    }
    return () => {
      window.removeEventListener('dragenter', preventDefault);
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
      if (isMdm && window.mdm.removeDistributeProgress) {
        window.mdm.removeDistributeProgress();
      }
    };
  }, []);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedFile({
        name: file.name,
        path: file.path || '',
        size: (file.size / 1024 / 1024).toFixed(2) + ' MB'
      });
      if (file.name.endsWith('.apk')) {
        setCreateShortcut(false);
      }
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const file = e.dataTransfer?.files[0];
    if (file) {
      setSelectedFile({
        name: file.name,
        path: file.path || '',
        size: (file.size / 1024 / 1024).toFixed(2) + ' MB'
      });
      if (file.name.endsWith('.apk')) {
        setCreateShortcut(false);
      }
    }
  };

  // 선택 제어 함수들
  const selectAll = () => setSelectedSerials(onlineDevices.map(d => d.serial));
  const selectNone = () => setSelectedSerials([]);
  const selectInvert = () => {
    const allSerials = onlineDevices.map(d => d.serial);
    setSelectedSerials(prev => allSerials.filter(s => !prev.includes(s)));
  };
  const toggleSelect = (serial) => {
    setSelectedSerials(prev =>
      prev.includes(serial) ? prev.filter(s => s !== serial) : [...prev, serial]
    );
  };

  const handleSend = async () => {
    if (!selectedFile || !selectedFile.path) return;
    if (selectedSerials.length === 0) {
      alert("배포할 대상 기기를 최소 1대 이상 선택해 주십시오.");
      return;
    }
    setSending(true);
    setResult(null);
    setProgress(0);
    setStatusText('배포 시작 준비 중...');

    if (isMdm) {
      const res = await window.mdm.distributeFile(selectedFile.path, selectedSerials, { 
        createShortcut,
        serverIp: "nonepithelial-unbased-reece.ngrok-free.dev"
      });
      if (res.ok) {
        setResult({
          success: true,
          msg: `총 ${res.sentCount}대의 기기에 파일 배포 명령을 보냈습니다.\n배포 URL: ${res.fileUrl}\n(2초 후 이 창이 자동으로 닫힙니다.)`
        });
        setTimeout(() => { onClose(); }, 2000);
      } else {
        setResult({
          success: false,
          msg: `파일 전송 중 오류 발생: ${res.error}`
        });
      }
    } else {
      // 데모 모드
      setProgress(10);
      setStatusText('[데모] 전송 준비 중...');
      await new Promise(r => setTimeout(r, 450));
      setProgress(50);
      setStatusText('[데모] 파일 복사 중... (50%)');
      await new Promise(r => setTimeout(r, 450));
      setProgress(100);
      setStatusText('[데모] 전송 완료');
      
      setResult({
        success: true,
        msg: `[데모] 총 ${selectedSerials.length}대의 기기에 파일 배포를 요청했습니다.\n(2초 후 이 창이 자동으로 닫힙니다.)`
      });
      setTimeout(() => { onClose(); }, 2000);
    }
    setSending(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📁 선택 파일 배포</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* 배포 대상 기기 선별 박스 */}
          <div className="target-select-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>
                🎯 배포 대상 지정 ({selectedSerials.length}대 선택됨)
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn-action" onClick={selectAll}>전체 선택</button>
                <button className="btn-action" onClick={selectNone}>선택 해제</button>
                <button className="btn-action" onClick={selectInvert}>선택 반전 🔄</button>
              </div>
            </div>

            <div className="device-list-scroller">
              {onlineDevices.length === 0 ? (
                <div className="no-devices">연결된 온라인 기기가 없습니다.</div>
              ) : (
                onlineDevices.map(d => (
                  <div key={d.serial} className="device-select-row" onClick={() => toggleSelect(d.serial)}>
                    <input
                      type="checkbox"
                      checked={selectedSerials.includes(d.serial)}
                      onChange={() => {}} // onClick에 의해 처리됨
                      style={{ marginRight: 8, cursor: 'pointer' }}
                    />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <span className="dev-name">{d.alias || d.model}</span>
                      <span className="dev-serial">({d.serial})</span>
                    </div>
                    {d.group && (
                      <span className="dev-group">{d.group}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="form-group">
            <label>배포할 로컬 파일 선택</label>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            
            <div 
              onDragEnter={handleDragOver}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current.click()}
              style={{
                border: isDragOver ? '2px dashed #4f46e5' : '2px dashed #cbd5e1',
                background: isDragOver ? '#eef2ff' : '#ffffff',
                padding: '20px 16px',
                borderRadius: 12,
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.16s ease',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6
              }}
            >
              <span style={{ fontSize: 28 }}>📁</span>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>
                파일을 이 영역에 끌어다 놓거나 클릭하여 선택
              </div>
            </div>

            {selectedFile && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12
              }}>
                <span style={{ fontSize: 14 }}>📄</span>
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: '#0f172a' }}>
                  {selectedFile.name} <span style={{ fontWeight: 500, color: '#64748b', fontSize: 10.5 }}>({selectedFile.size})</span>
                </div>
              </div>
            )}
            
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <input
                type="checkbox"
                id="chkShortcut"
                checked={createShortcut}
                onChange={e => setCreateShortcut(e.target.checked)}
                disabled={selectedFile && selectedFile.name.endsWith('.apk')}
                style={{ cursor: 'pointer', width: 14, height: 14 }}
              />
              <label 
                htmlFor="chkShortcut" 
                style={{ 
                  fontSize: 12, fontWeight: 600, color: selectedFile?.name.endsWith('.apk') ? '#94a3b8' : '#475569', 
                  cursor: selectedFile?.name.endsWith('.apk') ? 'not-allowed' : 'pointer', userSelect: 'none' 
                }}
              >
                태블릿 홈 화면에 파일 바로가기 생성 (APK 파일 제외)
              </label>
            </div>
          </div>

          {sending && (
            <div style={{
              background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0',
              display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#4f46e5' }}>
                <span>{statusText}</span>
                <span>{progress}%</span>
              </div>
              <div style={{ width: '100%', height: 8, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  width: `${progress}%`, height: '100%',
                  background: 'linear-gradient(90deg, #4f46e5, #818cf8)',
                  borderRadius: 99, transition: 'width 0.1s ease-out'
                }} />
              </div>
            </div>
          )}

          {result && (
            <div className={`result-box ${result.success ? 'success' : 'error'}`}>
              {result.msg}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>닫기</button>
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={sending || !selectedFile || selectedSerials.length === 0}
          >
            {sending ? '📤 전송 중...' : '🚀 선택 기기 배포'}
          </button>
        </div>
      </div>

      <style jsx>{`
        .modal-overlay {
          position: fixed; inset: 0;
          background: rgba(15, 23, 42, 0.7);
          display: flex; align-items: center; justify-content: center;
          z-index: 1500;
          backdrop-filter: blur(4px);
        }
        .modal { width: 520px; background: #ffffff; border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; }
        .modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid #e2e8f0;
        }
        .modal-header h2 { font-size: 15px; font-weight: 700; color: #0f172a; margin: 0; }
        .close-btn {
          background: none; border: none; color: #64748b;
          cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 6px;
        }
        .close-btn:hover { background: #f1f5f9; }
        .modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
        
        .target-select-section {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 10px 12px;
        }
        .btn-action {
          background: #ffffff; border: 1px solid #cbd5e1; color: #475569;
          font-size: 11px; font-weight: 600; padding: 3px 6px; border-radius: 4px;
          cursor: pointer; transition: all 0.1s;
        }
        .btn-action:hover { background: #f1f5f9; border-color: #94a3b8; }
        
        .device-list-scroller {
          max-height: 120px;
          overflow-y: auto;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          margin-top: 4px;
        }
        .no-devices { font-size: 12px; color: #94a3b8; text-align: center; padding: 16px; }
        
        .device-select-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 10px; border-bottom: 1px solid #f1f5f9;
          cursor: pointer; font-size: 12px; transition: background 0.1s;
        }
        .device-select-row:last-child { border-bottom: none; }
        .device-select-row:hover { background: #f8fafc; }
        
        .dev-name { font-weight: 700; color: #1e293b; }
        .dev-serial { font-size: 11px; color: #64748b; margin-left: 4px; font-family: monospace; }
        .dev-group {
          font-size: 10.5px; font-weight: 600; background: #e0f2fe; color: #0369a1;
          padding: 2px 6px; border-radius: 4px;
        }

        .form-group { display: flex; flex-direction: column; gap: 6px; }
        .form-group label { font-size: 12px; font-weight: 600; color: #475569; }
        
        .result-box {
          padding: 10px;
          border-radius: 6px;
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-line;
        }
        .result-box.success { background: #dcfce7; border: 1px solid #86efac; color: #15803d; }
        .result-box.error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
        
        .modal-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 12px 20px;
          border-top: 1px solid #e2e8f0;
          background: #f8fafc;
        }
        .btn {
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          border: none;
        }
        .btn-ghost { background: #e2e8f0; color: #475569; }
        .btn-ghost:hover { background: #cbd5e1; }
        .btn-primary { background: #4f46e5; color: #ffffff; }
        .btn-primary:hover { background: #4338ca; }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
