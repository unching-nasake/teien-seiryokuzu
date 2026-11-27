use crate::board::{Board, Cell};
#[cfg(test)]
use crate::board::ASSIMILATION_REQUIRED_TICKS;
use rayon::prelude::*;
use std::collections::HashMap;

/// 毎時00分ターンティックの盤面処理レポート
#[derive(Debug)]
pub struct TickBoardReport {
    /// 状態が変化したセル一覧（クライアント差分通知用）
    pub changed_cells: Vec<(u16, u16, Cell)>,
    /// 勢力ID -> (領土数, 中核ドット数)
    pub faction_stats: HashMap<u16, (u32, u32)>,
    /// 新たに自然中核化へ昇格したドット数
    pub promoted_cores: usize,
    /// 12時間経過で消滅した旧中核履歴数
    pub expired_old_cores: usize,
}

/// 毎時00分の盤面一括処理を rayon で並列実行する（標準設定）
#[cfg(test)]
pub fn run_board_tick(board: &mut Board) -> TickBoardReport {
    run_board_tick_with_rules(board, ASSIMILATION_REQUIRED_TICKS)
}

type RowTickResult = (Vec<(u16, u16, Cell)>, usize, usize);

/// 毎時00分の盤面一括処理を動的ルール設定で実行する
pub fn run_board_tick_with_rules(board: &mut Board, assimilation_required_ticks: u8) -> TickBoardReport {
    let size = board.size;
    // 自然中核化の隣接判定に必要な「中核所有勢力 ID」のみを 2B 配列として抽出（全セル 8B クローンを回避）
    let prev_core_owner: Vec<u16> = board
        .cells
        .par_iter()
        .map(|c| {
            if c.is_land() && c.is_core() {
                c.faction_id
            } else {
                0
            }
        })
        .collect();

    let row_results: Vec<RowTickResult> = board
        .cells
        .par_chunks_mut(size)
        .enumerate()
        .map(|(y, row)| {
            let mut local_changes = Vec::new();
            let mut local_promoted = 0usize;
            let mut local_expired = 0usize;

            for (x, cell) in row.iter_mut().enumerate().take(size) {
                if !cell.is_land() {
                    continue;
                }
                let before = *cell;

                // 1. 旧中核履歴の経過時間更新・消滅判定
                let ttl = cell.old_core_ttl();
                if ttl > 0 {
                    let next_ttl = ttl - 1;
                    cell.set_old_core_ttl(next_ttl);
                    if next_ttl == 0 {
                        cell.old_core_faction = 0;
                        local_expired += 1;
                    }
                }

                // 2. 自然中核化の昇格判定
                if cell.faction_id != 0 && !cell.is_core() {
                    let fid = cell.faction_id;
                    let adjacent_to_core = is_adjacent_to_own_core(&prev_core_owner, size, x, y, fid);
                    if adjacent_to_core {
                        let next_ticks = cell.assimilation_ticks() + 1;
                        if next_ticks >= assimilation_required_ticks {
                            cell.set_core(true);
                            cell.set_assimilation_ticks(0);
                            cell.old_core_faction = 0;
                            cell.set_old_core_ttl(0);
                            local_promoted += 1;
                        } else {
                            cell.set_assimilation_ticks(next_ticks);
                        }
                    } else if cell.assimilation_ticks() != 0 {
                        cell.set_assimilation_ticks(0);
                    }
                }

                if *cell != before {
                    local_changes.push((x as u16, y as u16, *cell));
                }
            }
            (local_changes, local_promoted, local_expired)
        })
        .collect();

    let mut changed_cells = Vec::new();
    let mut promoted_cores = 0usize;
    let mut expired_old_cores = 0usize;

    for (changes, promoted, expired) in row_results {
        promoted_cores += promoted;
        expired_old_cores += expired;
        for &(x, y, _) in &changes {
            board.mark_chunk_dirty(x as usize, y as usize);
        }
        changed_cells.extend(changes);
    }

    // 3. 勢力別の領土数・中核ドット数を並列リダクション集計
    let faction_stats = board
        .cells
        .par_chunks(size * 5)
        .fold(HashMap::<u16, (u32, u32)>::new, |mut acc, chunk| {
            for cell in chunk {
                if cell.is_land() && cell.faction_id != 0 {
                    let entry = acc.entry(cell.faction_id).or_insert((0, 0));
                    entry.0 += 1;
                    if cell.is_core() {
                        entry.1 += 1;
                    }
                }
            }
            acc
        })
        .reduce(HashMap::new, |mut a, b| {
            for (fid, (terr, core)) in b {
                let entry = a.entry(fid).or_insert((0, 0));
                entry.0 += terr;
                entry.1 += core;
            }
            a
        });

    TickBoardReport {
        changed_cells,
        faction_stats,
        promoted_cores,
        expired_old_cores,
    }
}

#[inline]
fn is_adjacent_to_own_core(
    prev_core_owner: &[u16],
    size: usize,
    x: usize,
    y: usize,
    faction_id: u16,
) -> bool {
    if x > 0 && prev_core_owner[y * size + (x - 1)] == faction_id {
        return true;
    }
    if x + 1 < size && prev_core_owner[y * size + (x + 1)] == faction_id {
        return true;
    }
    if y > 0 && prev_core_owner[(y - 1) * size + x] == faction_id {
        return true;
    }
    if y + 1 < size && prev_core_owner[(y + 1) * size + x] == faction_id {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::OLD_CORE_TTL_TICKS;

    #[test]
    fn natural_assimilation_takes_10_consecutive_ticks_and_resets_when_isolated() {
        let mut board = Board::from_terrain(250, &vec![1u8; 250 * 250]);
        let core_idx = board.idx(10, 10);
        let adj_idx = board.idx(11, 10);
        let iso_idx = board.idx(20, 20);

        board.cells[core_idx].faction_id = 1;
        board.cells[core_idx].set_core(true);
        board.cells[adj_idx].faction_id = 1;
        board.cells[iso_idx].faction_id = 1;

        for tick in 1..=9 {
            let r = run_board_tick(&mut board);
            assert_eq!(r.promoted_cores, 0);
            assert!(!board.cells[adj_idx].is_core());
            assert_eq!(board.cells[adj_idx].assimilation_ticks(), tick);
            assert_eq!(board.cells[iso_idx].assimilation_ticks(), 0);
        }

        let r10 = run_board_tick(&mut board);
        assert_eq!(r10.promoted_cores, 1);
        assert!(board.cells[adj_idx].is_core());
        assert_eq!(board.cells[adj_idx].assimilation_ticks(), 0);
        assert_eq!(r10.faction_stats.get(&1), Some(&(3, 2)));

        // 隣接中核マスが奪われると、進行中だった自然中核化カウントは0にリセットされる
        let adj2_idx = board.idx(12, 10);
        board.cells[adj2_idx].faction_id = 1;
        run_board_tick(&mut board);
        assert_eq!(board.cells[adj2_idx].assimilation_ticks(), 1);
        board.cells[adj_idx].faction_id = 2;
        board.cells[adj_idx].set_core(false);
        run_board_tick(&mut board);
        assert_eq!(board.cells[adj2_idx].assimilation_ticks(), 0);
    }

    #[test]
    fn old_core_history_expires_after_10_ticks() {
        let mut board = Board::from_terrain(250, &vec![1u8; 250 * 250]);
        let idx = board.idx(50, 50);
        board.cells[idx].faction_id = 2;
        board.cells[idx].old_core_faction = 1;
        board.cells[idx].set_old_core_ttl(OLD_CORE_TTL_TICKS);

        for _ in 0..9 {
            let r = run_board_tick(&mut board);
            assert_eq!(r.expired_old_cores, 0);
            assert_eq!(board.cells[idx].old_core_faction, 1);
        }

        let r10 = run_board_tick(&mut board);
        assert_eq!(r10.expired_old_cores, 1);
        assert_eq!(board.cells[idx].old_core_faction, 0);
        assert_eq!(board.cells[idx].old_core_ttl(), 0);
    }
}
