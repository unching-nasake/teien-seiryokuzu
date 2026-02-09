import { useEffect, useRef, useState } from 'react';
import GameMap, { getTilePoints } from './GameMap';
import Leaderboard from './Leaderboard';

function TimelapseViewer({ onClose, factions, showFactionNames: initialShowFactionNames = true, workerPool }) {
  const [historyList, setHistoryList] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTiles, setCurrentTiles] = useState({});
  const [snapshotFactions, setSnapshotFactions] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [namedCells, setNamedCells] = useState({});
  const timerRef = useRef(null);

  // View Options
  const [showFactionNames, setShowFactionNames] = useState(initialShowFactionNames);
  const [allianceDisplayMode, setAllianceDisplayMode] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(true);
  const [leaderboardItems, setLeaderboardItems] = useState([]);

  // 履歴リスト取得
  useEffect(() => {
    setIsLoading(true);
    fetch('/api/map/history', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.history) {
          setHistoryList(data.history);
          setCurrentIndex(data.history.length - 1); // 最新を表示
        }
      })
      .catch(err => {
        console.error(err);
      });

    // ネームドマス取得
    fetch('/api/named-cells', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          setNamedCells(data);
        }
        setIsLoading(false);
      })
      .catch(err => {
        console.error(err);
        setIsLoading(false);
      });
  }, []);

  // マップデータロード
  useEffect(() => {
    if (historyList.length === 0) return;

    const filename = historyList[currentIndex];
    setIsLoading(true);

    // キャッシュ機構を入れたいが、サーバー負荷と相談。とりあえず毎回Fetch
    fetch(`/api/map/history/${filename}`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.tiles) {
          setCurrentTiles(data.tiles);
        }
        if (data.factions) {
          setSnapshotFactions(data.factions);
        } else {
          setSnapshotFactions(null); // 古いスナップショット用
        }
        setIsLoading(false);
      })
      .catch(err => {
        console.error(err);
        setIsLoading(false);
      });
  }, [currentIndex, historyList]);

  // 再生ロジック
  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          if (prev >= historyList.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 500); // 0.5秒間隔
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, historyList.length]);


  // リーダーボード計算 (snapshotFactions or Tiles)
  useEffect(() => {
     // 1. 勢力データソースの決定
     // タイムラプス時はスナップショット内の勢力情報を最優先する
     const sourceFactions = snapshotFactions || factions.factions || factions;

     // 2. カウント/ポイント集計
     const scores = {};
     const mapSize = 500; // デフォルト 500

     // タイルから集集計 (ポイント対応)
     Object.entries(currentTiles).forEach(([key, t]) => {
         const fid = t.faction || t.factionId;
         if (fid) {
             const [x, y] = key.split('_').map(Number);
             const points = getTilePoints(x, y, mapSize, namedCells);
             scores[fid] = (scores[fid] || 0) + points;
         }
     });

     const usePoints = true; // 常にポイントベースにする

     // 3. アイテム整形
     // sourceFactionsにある勢力のみを対象とする
     const items = Object.keys(sourceFactions)
         .map(fid => {
             const f = sourceFactions[fid];
             if (!f || (!scores[fid] && !snapshotFactions)) return null; // 勢力データがない、かつ最新タイルにもいない場合は除外

             return {
                 id: fid,
                 name: f.name || "不明な勢力",
                 color: f.color || "#cccccc",
                 count: scores[fid] || 0,
                 desc: usePoints ? 'pts' : 'tiles'
             };
         })
         .filter(item => item !== null && (item.count > 0 || snapshotFactions)); // スナップショット時は0ポイントでも表示

     // 4. ソート (降順)
     items.sort((a, b) => b.count - a.count);

     // 5. ランク付与
     let currentRank = 1;
     items.forEach((item, index) => {
         if (index > 0 && item.count < items[index - 1].count) {
             currentRank = index + 1;
         }
         item.rank = currentRank;
     });

     setLeaderboardItems(items);

  }, [snapshotFactions, currentTiles, factions]);

  // 日時フォーマット (filename: map_YYYYMMDD_HHmm.json)
  const formatTime = (filename) => {
    if (!filename) return '';
    // map_20260112_2330.json
    const match = filename.match(/map_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
    if (match) {
      return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
    }
    // 古い形式 (map_20260112_23.json -> HHのみ) の互換性
    const matchOld = filename.match(/map_(\d{4})(\d{2})(\d{2})_(\d{2})/);
    if (matchOld) {
        return `${matchOld[1]}/${matchOld[2]}/${matchOld[3]} ${matchOld[4]}:00`;
    }
    return filename;
  };

  return (
    <div className="modal-overlay">
      <div className="timelapse-container">
        <div className="timelapse-header">
          <h3>タイムラプス再生</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="timelapse-map-wrapper">
             {/* GameMapを再利用。操作不可にする */}
              <GameMap
                 tileData={null} // タイムラプスは旧式の tiles={currentTiles} を使用
                 tiles={currentTiles}
                 factions={snapshotFactions || factions}
                 selectedTiles={[]}
                 onTileClick={() => {}} // No-op
                 playerFactionId={null}
                 readOnly={true}
                 showTooltip={false} // タイムラプスではツールチップ（黒いバー）を出さない
                 showFactionNames={showFactionNames}
                 showAllianceNames={showFactionNames}
                 allianceDisplayMode={allianceDisplayMode}
                 limitZoomOut={false}
                 workerPool={workerPool}
                 namedCells={namedCells}
                 showNamedTileNames={showFactionNames} // 名前表示ONの時だけ星名も出す
               />

             {/* リーダーボード表示 */}
             {showLeaderboard && (
               <div className="timelapse-leaderboard-wrapper">
                   <Leaderboard items={leaderboardItems} activeFactionId={null} />
               </div>
             )}

             {/* {isLoading && <div className="loading-overlay">Loading...</div>} */}
        </div>

        <div className="timelapse-controls">
          <div className="time-display">{formatTime(historyList[currentIndex])}</div>

          {/* 表示オプション */}
          <div className="timelapse-options" style={{ display: 'flex', gap: '8px', marginBottom: '8px', justifyContent: 'center' }}>
              <button
                  className={`btn ${showFactionNames ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowFactionNames(!showFactionNames)}
                  style={{ fontSize: '0.8rem', padding: '4px 8px' }}
              >
                  {showFactionNames ? '名前表示 ON' : '名前表示 OFF'}
              </button>
               <button
                  className={`btn ${allianceDisplayMode ? 'btn-purple' : 'btn-secondary'}`}
                  onClick={() => setAllianceDisplayMode(!allianceDisplayMode)}
                  style={{ fontSize: '0.8rem', padding: '4px 8px' }}
              >
                  {allianceDisplayMode ? '同盟モード' : '通常モード'}
              </button>
              <button
                  className={`btn ${showLeaderboard ? 'btn-blue' : 'btn-secondary'}`}
                  onClick={() => setShowLeaderboard(!showLeaderboard)}
                  style={{ fontSize: '0.8rem', padding: '4px 8px' }}
              >
                  {showLeaderboard ? 'ランキング ON' : 'ランキング OFF'}
              </button>
          </div>

          <input
            type="range"
            min="0"
            max={historyList.length - 1}
            value={currentIndex}
            onChange={(e) => setCurrentIndex(Number(e.target.value))}
            className="timeline-slider"
          />

           <div className="control-buttons">
            <button
                className={`btn ${isPlaying ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => setIsPlaying(!isPlaying)}
                style={{ minWidth: '100px' }}
            >
              {isPlaying ? '一時停止' : '再生'}
            </button>
            <button className="btn btn-blue" onClick={() => setCurrentIndex(0)}>最初から</button>
            <button className="btn btn-warning" onClick={() => setCurrentIndex(historyList.length - 1)}>最新へ</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TimelapseViewer;
