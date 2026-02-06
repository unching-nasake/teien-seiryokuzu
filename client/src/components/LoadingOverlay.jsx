
const LoadingOverlay = ({ progress, total, message }) => {
  const percentage = total > 0 ? Math.min(100, Math.max(0, (progress / total) * 100)) : 0;

  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="loading-spinner"></div>
        <h2 className="loading-title">ワールド読み込み中...</h2>
        <div className="loading-bar-container">
          <div
            className="loading-bar-fill"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div className="loading-stats">
          {message} ({Math.round(percentage)}%)
        </div>
      </div>
    </div>
  );
};

export default LoadingOverlay;
