import { FactionSummary, PlayerLogCategory, PlayerLogEntry } from './protocol';

const CATEGORY_LABELS: Record<Exclude<PlayerLogCategory, 'all'>, string> = {
  territory: '領土',
  diplomacy: '外交',
  faction: '勢力',
  ap: 'AP',
  system: 'システム',
};

function formatIsoToLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString('ja-JP');
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 行動ログ一覧を読みやすい行テキストへ整形する */
export function formatLogsAsText(
  logs: PlayerLogEntry[],
  factionMap: Map<number, FactionSummary>,
  includeSeason = false
): string {
  return logs
    .map((log) => {
      const cat = CATEGORY_LABELS[log.category] ?? log.category;
      const vis = log.faction_only ? '[勢力限定]' : '';
      const fac = log.faction_id > 0 ? factionMap.get(log.faction_id)?.name : undefined;
      const actor = fac ? `${log.username} (${fac})` : log.username;
      const seasonPrefix =
        includeSeason && 'season_id' in log
          ? `[S${(log as PlayerLogEntry & { season_id: number }).season_id}] `
          : '';
      return `${seasonPrefix}[${formatIsoToLocal(log.created_at)}] [${cat}]${vis} ${actor}: ${log.summary}`;
    })
    .join('\n');
}

/** 行動ログ一覧を UTF-8 BOM 付き CSV へ整形する */
export function formatLogsAsCsv(
  logs: PlayerLogEntry[],
  factionMap: Map<number, FactionSummary>,
  includeSeason = false
): string {
  const headers = includeSeason
    ? ['シーズン', '日時', '種別', '公開範囲', 'プレイヤー', '勢力', '行動内容']
    : ['日時', '種別', '公開範囲', 'プレイヤー', '勢力', '行動内容'];
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const log of logs) {
    const cat = CATEGORY_LABELS[log.category] ?? log.category;
    const vis = log.faction_only ? '勢力限定' : '全体公開';
    const fac =
      log.faction_id > 0
        ? (factionMap.get(log.faction_id)?.name ?? `勢力#${log.faction_id}`)
        : '';
    const row = includeSeason
      ? [
          'season_id' in log ? String((log as PlayerLogEntry & { season_id: number }).season_id) : '',
          formatIsoToLocal(log.created_at),
          cat,
          vis,
          log.username,
          fac,
          log.summary,
        ]
      : [
          formatIsoToLocal(log.created_at),
          cat,
          vis,
          log.username,
          fac,
          log.summary,
        ];
    lines.push(row.map(escapeCsvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** テキストファイルを Blob 経由でダウンロードする */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** テキストをクリップボードへコピーする（フォールバック付き） */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // フォールバックへ
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
