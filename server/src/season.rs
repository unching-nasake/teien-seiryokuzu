use chrono::{DateTime, Datelike, Duration, FixedOffset, Timelike, Utc};
use serde::{Deserialize, Serialize};

pub const WEEK_MINUTES: i64 = 7 * 24 * 60;
pub const PREP_DURATION_MINUTES: i64 = 12 * 60;
pub const NATURAL_ACTIVE_DURATION_MINUTES: i64 = 48 * 60;
/// 開催中の定期ティック・AP補充の取りこぼし補完を許可する最大遅延時間（分）
pub const SCHEDULE_CATCHUP_GRACE_MINUTES: i64 = 10;

/// シーズンフェーズ
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeasonPhase {
    /// 準備フェーズ（開幕12時間前 〜 開幕時刻 JST）
    Preparation = 0,
    /// 開催フェーズ（開幕時刻 〜 終了境界 JST）
    Active = 1,
    /// 凍結・結果発表フェーズ（終了境界 〜 次回準備開始 JST）
    Frozen = 2,
}

impl SeasonPhase {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_str_name(s: &str) -> Option<Self> {
        match s {
            "preparation" => Some(Self::Preparation),
            "active" => Some(Self::Active),
            "frozen" => Some(Self::Frozen),
            _ => None,
        }
    }
}

/// JST 基準の週間シーズンスケジュール設定
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeasonSchedule {
    pub start_weekday: u8,
    pub start_hour: u8,
    pub start_minute: u8,
    pub tick_interval_minutes: u32,
    pub max_ticks: u16,
}

impl Default for SeasonSchedule {
    fn default() -> Self {
        Self {
            start_weekday: crate::board::DEFAULT_SEASON_START_WEEKDAY,
            start_hour: crate::board::DEFAULT_SEASON_START_HOUR,
            start_minute: crate::board::DEFAULT_SEASON_START_MINUTE,
            tick_interval_minutes: crate::board::DEFAULT_TICK_INTERVAL_MINUTES,
            max_ticks: crate::board::DEFAULT_MAX_TICKS,
        }
    }
}

impl SeasonSchedule {
    pub fn from_rules(rules: crate::board::GameRulesConfig) -> Self {
        Self {
            start_weekday: rules.season_start_weekday.min(6),
            start_hour: rules.season_start_hour.min(23),
            start_minute: rules.season_start_minute.min(59),
            tick_interval_minutes: rules.tick_interval_minutes.max(1),
            max_ticks: rules.max_ticks.max(1),
        }
    }

    /// 週開始（月曜 00:00 JST）からの開幕時刻（分）
    pub fn start_minute_of_week(self) -> i64 {
        (self.start_weekday.min(6) as i64) * 1440
            + (self.start_hour.min(23) as i64) * 60
            + (self.start_minute.min(59) as i64)
    }

    /// 週開始（月曜 00:00 JST）からの準備フェーズ開始時刻（開幕12時間前、分）
    pub fn prep_start_minute_of_week(self) -> i64 {
        (self.start_minute_of_week() - PREP_DURATION_MINUTES).rem_euclid(WEEK_MINUTES)
    }

    /// 自然スケジュールにおける開催フェーズの総時間（48時間 = 2880分）
    pub fn active_duration_minutes(self) -> i64 {
        NATURAL_ACTIVE_DURATION_MINUTES
    }
}

/// JST (+09:00) の FixedOffset を取得
pub fn jst_offset() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("JST offset")
}

/// 指定 UTC 時刻から直近の開幕時刻（JST）までの経過分数 (0..10080) を返す
pub fn elapsed_since_start_minutes(now_utc: DateTime<Utc>, schedule: SeasonSchedule) -> i64 {
    let jst = now_utc.with_timezone(&jst_offset());
    let wd = jst.weekday().num_days_from_monday() as i64;
    let now_min = wd * 1440 + (jst.hour() as i64) * 60 + (jst.minute() as i64);
    (now_min - schedule.start_minute_of_week()).rem_euclid(WEEK_MINUTES)
}

/// 指定時刻（分精度）が開幕直後の分かどうか判定する
pub fn is_season_start_minute(now_utc: DateTime<Utc>, schedule: SeasonSchedule) -> bool {
    elapsed_since_start_minutes(now_utc, schedule) == 0
}

/// 指定時刻（分精度）が自動開催終了の境界分かどうか判定する
pub fn is_season_end_boundary_minute(now_utc: DateTime<Utc>, schedule: SeasonSchedule) -> bool {
    elapsed_since_start_minutes(now_utc, schedule) == schedule.active_duration_minutes()
}

/// 現在時刻が自然スケジュール上の凍結帯にある場合、直近の自動終了境界時刻（分精度 UTC）を返す
pub fn current_season_end_boundary_at(
    now_utc: DateTime<Utc>,
    schedule: SeasonSchedule,
) -> Option<DateTime<Utc>> {
    let now_floor = now_utc.with_second(0)?.with_nanosecond(0)?;
    let elapsed = elapsed_since_start_minutes(now_floor, schedule);
    let active_dur = schedule.active_duration_minutes();
    if elapsed >= active_dur && elapsed < WEEK_MINUTES - PREP_DURATION_MINUTES {
        Some(now_floor - Duration::minutes(elapsed - active_dur))
    } else {
        None
    }
}

/// 指定時刻から `max_lag_minutes` 分前までの範囲で、最も新しいスケジュール該当時刻（分精度 UTC）を返す
pub fn latest_scheduled_slot_within(
    now_utc: DateTime<Utc>,
    interval_minutes: u32,
    offset_minute: u32,
    schedule: SeasonSchedule,
    max_lag_minutes: i64,
) -> Option<DateTime<Utc>> {
    let now_floor = now_utc.with_second(0)?.with_nanosecond(0)?;
    for lag in 0..=max_lag_minutes.max(0) {
        let cand = now_floor - Duration::minutes(lag);
        if is_ap_refill_minute_with_schedule(cand, interval_minutes, offset_minute, schedule) {
            return Some(cand);
        }
    }
    None
}

/// 指定 UTC 時刻とスケジュールから JST 基準のシーズンフェーズを判定
pub fn compute_phase_jst_with_schedule(
    now_utc: DateTime<Utc>,
    schedule: SeasonSchedule,
) -> SeasonPhase {
    let elapsed = elapsed_since_start_minutes(now_utc, schedule);
    if elapsed < schedule.active_duration_minutes() {
        SeasonPhase::Active
    } else if elapsed >= WEEK_MINUTES - PREP_DURATION_MINUTES {
        SeasonPhase::Preparation
    } else {
        SeasonPhase::Frozen
    }
}

/// 指定 UTC 時刻から JST 基準のシーズンフェーズを判定（標準スケジュール）
#[cfg(test)]
pub fn compute_phase_jst(now_utc: DateTime<Utc>) -> SeasonPhase {
    compute_phase_jst_with_schedule(now_utc, SeasonSchedule::default())
}

/// 指定スケジュールに基づく現在の JST 基準サイクル番号（準備開始時刻を境界とする週番号ID）を算出
pub fn compute_cycle_id(now_utc: DateTime<Utc>, schedule: SeasonSchedule) -> i64 {
    let jst = now_utc.with_timezone(&jst_offset());
    let monday_epoch = chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(jst_offset())
        .unwrap();
    let cycle_epoch = monday_epoch + Duration::minutes(schedule.prep_start_minute_of_week());
    let weeks = (jst - cycle_epoch).num_weeks();
    (weeks + 1).max(1)
}

/// 現在の JST 基準シーズン番号（金曜12:00を境界とする週番号ID）を算出
#[cfg(test)]
pub fn compute_season_id(now_utc: DateTime<Utc>) -> i64 {
    compute_cycle_id(now_utc, SeasonSchedule::default())
}

/// 次の毎時 00:00:00 (UTC/JST 共通) の UNIX タイムスタンプ（秒）
pub fn next_hourly_tick_unix(now_utc: DateTime<Utc>) -> i64 {
    let next = (now_utc + Duration::hours(1))
        .with_minute(0)
        .unwrap()
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap();
    next.timestamp()
}

/// 指定の補充頻度（分）・基準分（0..59）・スケジュールに対して、現在時刻（分精度）が AP 補充タイミングか判定
pub fn is_ap_refill_minute_with_schedule(
    now_utc: DateTime<Utc>,
    interval_minutes: u32,
    offset_minute: u32,
    schedule: SeasonSchedule,
) -> bool {
    let interval = interval_minutes.clamp(1, 1440) as i64;
    let offset = (offset_minute % 60) as i64;
    let elapsed = elapsed_since_start_minutes(now_utc, schedule);
    (elapsed - offset).rem_euclid(interval) == 0
}

/// 指定の補充頻度（分）・基準分（0..59）に対して、現在時刻（分精度）が AP 補充タイミングか判定
#[allow(dead_code)]
pub fn is_ap_refill_minute(now_utc: DateTime<Utc>, interval_minutes: u32, offset_minute: u32) -> bool {
    is_ap_refill_minute_with_schedule(now_utc, interval_minutes, offset_minute, SeasonSchedule::default())
}

/// 次回 AP 補充時刻の UNIX タイムスタンプ（秒）を算出（開幕直後の追加発火スキップ対応）
pub fn next_ap_refill_unix_with_schedule(
    now_utc: DateTime<Utc>,
    interval_minutes: u32,
    offset_minute: u32,
    schedule: SeasonSchedule,
    skip_season_start: bool,
) -> i64 {
    let interval = interval_minutes.clamp(1, 1440) as i64;
    let base_next = now_utc
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap()
        + Duration::minutes(1);
    for step in 0..=(interval * 2) {
        let candidate = base_next + Duration::minutes(step);
        if is_ap_refill_minute_with_schedule(candidate, interval_minutes, offset_minute, schedule)
            && !(skip_season_start && is_season_start_minute(candidate, schedule))
        {
            return candidate.timestamp();
        }
    }
    next_hourly_tick_unix(now_utc)
}

/// 次回 AP 補充時刻の UNIX タイムスタンプ（秒）を算出
#[allow(dead_code)]
pub fn next_ap_refill_unix(now_utc: DateTime<Utc>, interval_minutes: u32, offset_minute: u32) -> i64 {
    next_ap_refill_unix_with_schedule(
        now_utc,
        interval_minutes,
        offset_minute,
        SeasonSchedule::default(),
        false,
    )
}

/// スケジュールに基づく現在の開催ティック番号を算出
pub fn compute_tick_number_with_schedule(
    now_utc: DateTime<Utc>,
    phase: SeasonPhase,
    schedule: SeasonSchedule,
) -> u16 {
    match phase {
        SeasonPhase::Preparation => 0,
        SeasonPhase::Frozen => schedule.max_ticks,
        SeasonPhase::Active => {
            let elapsed = elapsed_since_start_minutes(now_utc, schedule);
            let tick_iv = schedule.tick_interval_minutes.max(1) as i64;
            let active_dur = schedule.active_duration_minutes();
            if elapsed >= active_dur {
                0
            } else {
                (elapsed / tick_iv).min(schedule.max_ticks as i64) as u16
            }
        }
    }
}

/// 現在の開催ティック番号 (0..48) を算出（開催フェーズ外は 0 または 48）
#[allow(dead_code)]
pub fn compute_tick_number(now_utc: DateTime<Utc>, phase: SeasonPhase) -> u16 {
    compute_tick_number_with_schedule(now_utc, phase, SeasonSchedule::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn season_phases_follow_jst_schedule() {
        let jst = jst_offset();
        // 金曜 11:59 -> Frozen
        let fri_morning = jst.with_ymd_and_hms(2026, 11, 20, 11, 59, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst(fri_morning), SeasonPhase::Frozen);

        // 金曜 12:00 -> Preparation
        let fri_noon = jst.with_ymd_and_hms(2026, 11, 20, 12, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst(fri_noon), SeasonPhase::Preparation);

        // 土曜 00:00 -> Active
        let sat_start = jst.with_ymd_and_hms(2026, 11, 21, 0, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst(sat_start), SeasonPhase::Active);

        // 日曜 23:59 -> Active
        let sun_end = jst.with_ymd_and_hms(2026, 11, 22, 23, 59, 59).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst(sun_end), SeasonPhase::Active);

        // 月曜 00:00 -> Frozen
        let mon_start = jst.with_ymd_and_hms(2026, 11, 23, 0, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst(mon_start), SeasonPhase::Frozen);
    }

    #[test]
    fn ap_refill_minute_aligns_with_jst_midnight() {
        let jst = jst_offset();
        let jst_midnight = jst.with_ymd_and_hms(2026, 11, 21, 0, 0, 0).unwrap().with_timezone(&Utc);
        let jst_9am = jst.with_ymd_and_hms(2026, 11, 21, 9, 0, 0).unwrap().with_timezone(&Utc);
        assert!(is_ap_refill_minute(jst_midnight, 1440, 0));
        assert!(!is_ap_refill_minute(jst_9am, 1440, 0));
    }

    #[test]
    fn custom_season_start_schedule_and_refill_skip_start_minute() {
        let jst = jst_offset();
        // 土曜 21:30 JST 開幕（準備は土曜 09:30〜、自然終了は月曜 21:30）
        let sched = SeasonSchedule {
            start_weekday: 5,
            start_hour: 21,
            start_minute: 30,
            tick_interval_minutes: 60,
            max_ticks: 48,
        };

        // 2週目: 土曜 09:29 JST -> Frozen / 09:30 JST -> Preparation でサイクルIDが 1 -> 2 へ進む
        let sat_0929 = jst.with_ymd_and_hms(2026, 11, 28, 9, 29, 0).unwrap().with_timezone(&Utc);
        let sat_0930 = jst.with_ymd_and_hms(2026, 11, 28, 9, 30, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst_with_schedule(sat_0929, sched), SeasonPhase::Frozen);
        assert_eq!(compute_phase_jst_with_schedule(sat_0930, sched), SeasonPhase::Preparation);
        assert!(compute_cycle_id(sat_0930, sched) > compute_cycle_id(sat_0929, sched));

        // 土曜 21:30 JST -> Active（開幕瞬間）
        let sat_2130 = jst.with_ymd_and_hms(2026, 11, 28, 21, 30, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst_with_schedule(sat_2130, sched), SeasonPhase::Active);
        assert!(is_season_start_minute(sat_2130, sched));
        assert_eq!(compute_tick_number_with_schedule(sat_2130, SeasonPhase::Active, sched), 0);

        // 開幕直前 (21:29:50) から次回補充 (30分間隔, offset=0) は開幕瞬間 21:30 をスキップして 22:00 になる
        let sat_2129 = jst.with_ymd_and_hms(2026, 11, 28, 21, 29, 50).unwrap().with_timezone(&Utc);
        let sat_2200 = jst.with_ymd_and_hms(2026, 11, 28, 22, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(
            next_ap_refill_unix_with_schedule(sat_2129, 30, 0, sched, true),
            sat_2200.timestamp()
        );

        // 48時間後の月曜 21:30 JST -> Frozen 終了境界
        let mon_2130 = jst.with_ymd_and_hms(2026, 11, 30, 21, 30, 0).unwrap().with_timezone(&Utc);
        assert_eq!(compute_phase_jst_with_schedule(mon_2130, sched), SeasonPhase::Frozen);
        assert!(is_season_end_boundary_minute(mon_2130, sched));
    }

    #[test]
    fn current_season_end_boundary_and_latest_slot_catchup_work() {
        let jst = jst_offset();
        let default_sched = SeasonSchedule::default();

        // 日曜 23:59 -> Active のため None
        let sun_2359 = jst.with_ymd_and_hms(2026, 11, 22, 23, 59, 0).unwrap().with_timezone(&Utc);
        assert_eq!(current_season_end_boundary_at(sun_2359, default_sched), None);

        // 月曜 00:00 / 00:05 / 木曜 15:00 -> すべて月曜 00:00 JST を返す
        let mon_0000 = jst.with_ymd_and_hms(2026, 11, 23, 0, 0, 0).unwrap().with_timezone(&Utc);
        let mon_0005 = jst.with_ymd_and_hms(2026, 11, 23, 0, 5, 45).unwrap().with_timezone(&Utc);
        let thu_1500 = jst.with_ymd_and_hms(2026, 11, 26, 15, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(current_season_end_boundary_at(mon_0000, default_sched), Some(mon_0000));
        assert_eq!(current_season_end_boundary_at(mon_0005, default_sched), Some(mon_0000));
        assert_eq!(current_season_end_boundary_at(thu_1500, default_sched), Some(mon_0000));

        // 金曜 12:00 -> 準備フェーズのため None
        let fri_1200 = jst.with_ymd_and_hms(2026, 11, 27, 12, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(current_season_end_boundary_at(fri_1200, default_sched), None);

        // カスタム開幕時刻（土曜 21:30 JST -> 月曜 21:30 JST 終了）
        let custom_sched = SeasonSchedule {
            start_weekday: 5,
            start_hour: 21,
            start_minute: 30,
            tick_interval_minutes: 60,
            max_ticks: 48,
        };
        let mon_2130 = jst.with_ymd_and_hms(2026, 11, 30, 21, 30, 0).unwrap().with_timezone(&Utc);
        let tue_0100 = jst.with_ymd_and_hms(2026, 12, 1, 1, 0, 0).unwrap().with_timezone(&Utc);
        assert_eq!(current_season_end_boundary_at(tue_0100, custom_sched), Some(mon_2130));

        // latest_scheduled_slot_within: ジャスト・5分遅延・11分猶予超過・45分間隔
        let sat_0100 = jst.with_ymd_and_hms(2026, 11, 21, 1, 0, 30).unwrap().with_timezone(&Utc);
        let sat_0100_floor = jst.with_ymd_and_hms(2026, 11, 21, 1, 0, 0).unwrap().with_timezone(&Utc);
        let sat_0105 = jst.with_ymd_and_hms(2026, 11, 21, 1, 5, 20).unwrap().with_timezone(&Utc);
        let sat_0111 = jst.with_ymd_and_hms(2026, 11, 21, 1, 11, 0).unwrap().with_timezone(&Utc);
        assert_eq!(
            latest_scheduled_slot_within(sat_0100, 60, 0, default_sched, SCHEDULE_CATCHUP_GRACE_MINUTES),
            Some(sat_0100_floor)
        );
        assert_eq!(
            latest_scheduled_slot_within(sat_0105, 60, 0, default_sched, SCHEDULE_CATCHUP_GRACE_MINUTES),
            Some(sat_0100_floor)
        );
        assert_eq!(
            latest_scheduled_slot_within(sat_0111, 60, 0, default_sched, SCHEDULE_CATCHUP_GRACE_MINUTES),
            None
        );

        let sat_0050 = jst.with_ymd_and_hms(2026, 11, 21, 0, 50, 0).unwrap().with_timezone(&Utc);
        let sat_0045 = jst.with_ymd_and_hms(2026, 11, 21, 0, 45, 0).unwrap().with_timezone(&Utc);
        assert_eq!(
            latest_scheduled_slot_within(sat_0050, 45, 0, default_sched, SCHEDULE_CATCHUP_GRACE_MINUTES),
            Some(sat_0045)
        );
    }
}
