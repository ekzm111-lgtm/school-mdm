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
  const fileInputRef = useRef(null);

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
      // Electron 환경에서 파일의 path 속성을 획득할 수 있습니다.
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

  const handleSend = async () => {
    if (!selectedFile || !selectedFile.path) return;
    setSending(true);
    setResult(null);
    setProgress(0);
    setStatusText('배포 시작 준비 중...');

    const onlineSerials = devices.filter(d => d.state === 'online').map(d => d.serial);
    
    if (isMdm) {
      const res = await window.mdm.distributeFile(selectedFile.path, onlineSerials, { 
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
      // 데모 모드 작동 방식 (게이지 시뮬레이션)
      setProgress(10);
      setStatusText('[데모] 전송 준비 중...');
      await new Promise(r => setTimeout(r, 450));
      setProgress(45);
      setStatusText('[데모] 파일 복사 중... (45%)');
      await new Promise(r => setTimeout(r, 450));
      setProgress(80);
      setStatusText('[데모] 파일 복사 중... (80%)');
      await new Promise(r => setTimeout(r, 450));
      setProgress(100);
      setStatusText('[데모] 복사 및 전송 완료');
      
      setResult({
        success: true,
        msg: `[데모] 총 ${onlineSerials.length}대의 기기에 파일 배포를 요청했습니다.\n(2초 후 이 창이 자동으로 닫힙니다.)`
      });
      setTimeout(() => { onClose(); }, 2000);
    }
    setSending(false);
  };

  const onlineDevicesCount = devices.filter(d => d.state === 'online').length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📁 여러 기기에 일괄 파일 배포</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="target-info">
            대상: 총 <strong>{onlineDevicesCount}대</strong>의 온라인 기기
          </div>

          <div className="form-group">
            <label>배포할 로컬 파일 선택</label>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            
            {/* 드래그 앤 드롭 드롭존 영역 */}
            <div 
              onDragEnter={handleDragOver}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current.click()}
              style={{
                border: isDragOver ? '2px dashed #4f46e5' : '2px dashed #cbd5e1',
                background: isDragOver ? '#eef2ff' : '#ffffff',
                padding: '24px 20px',
                borderRadius: 12,
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.16s ease',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                boxShadow: isDragOver ? '0 0 0 3px rgba(79,70,229,0.1)' : 'none'
              }}
              onMouseEnter={e => { if(!isDragOver) e.currentTarget.style.borderColor = '#4f46e5'; }}
              onMouseLeave={e => { if(!isDragOver) e.currentTarget.style.borderColor = '#cbd5e1'; }}
            >
              <span style={{ fontSize: 32 }}>📁</span>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>
                파일을 이 영역에 마우스로 끌어다 놓거나 클릭하여 선택
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                (PDF, 이미지, 비디오, APK 등 모든 교육용 파일 지원)
              </div>
            </div>

            {/* 선택된 파일 요약 정보 */}
            {selectedFile && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12.5
              }}>
                <span style={{ fontSize: 15 }}>📄</span>
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: '#0f172a' }}>
                  {selectedFile.name} <span style={{ fontWeight: 500, color: '#64748b', fontSize: 11 }}>({selectedFile.size})</span>
                </div>
              </div>
            )}
            
            {/* 바로가기 생성 옵션 체크박스 추가 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <input
                type="checkbox"
                id="chkShortcut"
                checked={createShortcut}
                onChange={e => setCreateShortcut(e.target.checked)}
                disabled={selectedFile && selectedFile.name.endsWith('.apk')}
                style={{ cursor: 'pointer', width: 15, height: 15 }}
              />
              <label 
                htmlFor="chkShortcut" 
                style={{ 
                  fontSize: 12.5, fontWeight: 600, color: selectedFile?.name.endsWith('.apk') ? '#94a3b8' : '#475569', 
                  cursor: selectedFile?.name.endsWith('.apk') ? 'not-allowed' : 'pointer', userSelect: 'none' 
                }}
              >
                태블릿 홈 화면에 파일 바로가기 생성 (APK 파일은 제외)
              </label>
            </div>
          </div>

          {/* 실시간 전송 게이지 UI 추가 */}
          {sending && (
            <div style={{
              background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0',
              display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4
            }} className="animate-fade">
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
            disabled={sending || !selectedFile || onlineDevicesCount === 0}
          >
            {sending ? '📤 파일 배포 중...' : '📁 일괄 배포'}
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
        .modal { width: 500px; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.25); overflow: hidden; }
        .modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 20px;
          border-bottom: 1px solid #e2e8f0;
        }
        .modal-header h2 { font-size: 16px; font-weight: 700; color: #0f172a; }
        .close-btn {
          background: none; border: none; color: #64748b;
          cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 6px;
        }
        .close-btn:hover { background: #f1f5f9; }
        .modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
        .target-info {
          font-size: 13px; color: #64748b;
          padding: 10px 12px;
          background: #f8fafc;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
        }
        .target-info strong { color: #4f46e5; }
        .form-group { display: flex; flex-direction: column; gap: 8px; }
        .form-group label { font-size: 12px; font-weight: 600; color: #64748b; }
        .file-info-box {
          flex: 1;
          display: flex;
          align-items: center;
          border: 1px solid #e2e8f0;
          background: #f8fafc;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          color: #0f172a;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .result-box {
          padding: 12px;
          border-radius: 8px;
          font-size: 12.5px;
          line-height: 1.5;
          white-space: pre-line;
        }
        .result-box.success {
          background: #dcfce7;
          border: 1px solid #86efac;
          color: #16a34a;
        }
        .result-box.error {
          background: #fee2e2;
          border: 1px solid #fca5a5;
          color: #dc2626;
        }
        .modal-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 14px 20px;
          border-top: 1px solid #e2e8f0;
        }
        .btn {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: none;
        }
        .btn-ghost { background: #f1f5f9; color: #475569; }
        .btn-ghost:hover { background: #e2e8f0; }
        .btn-primary { background: #4f46e5; color: #ffffff; }
        .btn-primary:hover { background: #4338ca; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
