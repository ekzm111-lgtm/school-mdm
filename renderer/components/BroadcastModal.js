import { useState } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function BroadcastModal({ devices, onClose, title = "알림 전송" }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState([]);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    setResults([]);
    const res = [];
    for (const d of devices) {
      if (isMdm) {
        const r = await window.mdm.sendMessage(d.serial, message);
        res.push({ serial: d.serial, model: d.model, ok: r.ok });
      } else {
        await new Promise(r => setTimeout(r, 200));
        res.push({ serial: d.serial, model: d.model, ok: true });
      }
      setResults([...res]);
    }
    setSending(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass animate-fade" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📢 {title}</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="target-info">
            총 <strong>{devices.length}대</strong>의 대상 기기에 알림을 전송합니다.
          </div>

          <div className="form-group">
            <label>알림 메시지</label>
            <textarea
              rows={3}
              placeholder="예: 오늘 수업이 끝났습니다. 기기를 정리해주세요."
              value={message}
              onChange={e => setMessage(e.target.value)}
              style={{ width: '100%', resize: 'none' }}
            />
          </div>

          {results.length > 0 && (
            <div className="results-list">
              {results.map(r => (
                <div key={r.serial} className={`result-item ${r.ok ? 'ok' : 'fail'}`}>
                  <span>{r.ok ? '✅' : '❌'}</span>
                  <span className="r-model">{r.model}</span>
                  <span className="r-serial">{r.serial}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>닫기</button>
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={sending || !message.trim() || devices.length === 0}
          >
            {sending ? `전송 중... (${results.length}/${devices.length})` : '📢 전송'}
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
        .modal { width: 480px; }
        .modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 20px;
          border-bottom: 1px solid var(--border);
        }
        .modal-header h2 { font-size: 16px; font-weight: 700; }
        .close-btn {
          background: none; border: none; color: var(--text-muted);
          cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 6px;
        }
        .close-btn:hover { background: var(--bg-card2); }
        .modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
        .target-info {
          font-size: 13px; color: var(--text-muted);
          padding: 10px 12px;
          background: var(--bg-card2);
          border-radius: 8px;
          border: 1px solid var(--border);
        }
        .target-info strong { color: var(--primary); }
        .form-group { display: flex; flex-direction: column; gap: 6px; }
        .form-group label { font-size: 12px; font-weight: 600; color: var(--text-muted); }
        textarea {
          font-family: var(--font);
          background: var(--bg-card2);
          border: 1px solid var(--border);
          color: var(--text);
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 13px;
          outline: none;
        }
        textarea:focus { border-color: var(--primary); }
        .results-list {
          display: flex; flex-direction: column; gap: 5px;
          max-height: 180px; overflow-y: auto;
        }
        .result-item {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 10px; border-radius: 6px;
          font-size: 12px;
        }
        .result-item.ok { background: rgba(34,197,94,0.08); }
        .result-item.fail { background: rgba(239,68,68,0.08); }
        .r-model { font-weight: 600; color: var(--text); }
        .r-serial { font-family: var(--mono); color: var(--text-muted); font-size: 11px; margin-left: auto; }
        .modal-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 14px 20px;
          border-top: 1px solid var(--border);
        }
      `}</style>
    </div>
  );
}
