#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
garden_sync.py

機能:
1. Garden/Karesansuiの両方の板からdatファイルを同期
2. 同期したdatファイルからGame IDを抽出して game_ids.json を生成

ディレクトリ構成:
- スクリプト: public/garden_sync.py
- データROOT: public/server/data/
    - garden/dat/       (Gardenのdatファイル)
    - karesansui/dat/   (Karesansuiのdatファイル)
    - game_ids.json     (生成されるJSON)
"""

import requests
import os
import re
import time
import json
import sqlite3
import argparse
import sys
from datetime import datetime, timedelta
from collections import defaultdict

# --- 設定 ---
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GardenSync/2.0"
SLEEP_TIME = 0.5
EXCLUDE_PATTERN = "1000000000.dat<>TL"

# ボード設定
BOARDS = [
    {
        "name": "garden",
        "base_url": "https://tulip-garden.net/garden",
        "dir_name": "garden"
    },
    {
        "name": "karesansui",
        "base_url": "https://tulip-garden.net/karesansui",
        "dir_name": "karesansui"
    }
]

# --- パス設定 (初期化時に設定) ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__)) # public/
DATA_ROOT = os.path.join(BASE_DIR, "server", "data")

def setup_paths():
    """ディレクトリの初期化"""
    if not os.path.exists(DATA_ROOT):
        os.makedirs(DATA_ROOT, exist_ok=True)

    for board in BOARDS:
        dat_dir = os.path.join(DATA_ROOT, board["dir_name"], "dat")
        if not os.path.exists(dat_dir):
            os.makedirs(dat_dir, exist_ok=True)

# --- 同期ロジック ---

def download_file(url, path):
    """ファイルをダウンロードして保存"""
    headers = {"User-Agent": USER_AGENT}
    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()

        # ディレクトリ確認
        os.makedirs(os.path.dirname(path), exist_ok=True)

        with open(path, "wb") as f:
            f.write(response.content)
        return True
    except Exception as e:
        print(f"Download Error ({url}): {e}")
        return False

def parse_subject_line(line):
    """subject.txtの行解析"""
    line = line.strip()
    if not line: return None, None
    match = re.match(r"(\d+)\.dat<>.*\((\d+)\)\s*$", line)
    if match:
        return match.group(1), int(match.group(2))
    return None, None

def get_local_res_count(dat_path):
    """ローカルdatファイルのレス数取得"""
    if not os.path.exists(dat_path): return 0
    try:
        with open(dat_path, "rb") as f:
            content = f.read()
            lines = content.split(b"\n")
            return len([line for line in lines if line.strip()])
    except:
        return 0

def sync_board(board_config):
    """指定されたボードを同期"""
    board_name = board_config["name"]
    base_url = board_config["base_url"]
    dir_name = board_config["dir_name"]

    print(f"\n[{board_name}] Sync Start...")

    output_dir = os.path.join(DATA_ROOT, dir_name)
    dat_dir = os.path.join(output_dir, "dat")
    subject_file = os.path.join(output_dir, "subject.txt")

    # 1. subject.txt ダウンロード
    if not download_file(f"{base_url}/subject.txt", subject_file):
        print(f"[{board_name}] Failed to download subject.txt")
        return False

    # 2. subject解析
    subject_threads = {}
    try:
        with open(subject_file, "rb") as f:
            content = f.read().decode("shift_jis", errors="ignore")
        for line in content.split("\n"):
            if EXCLUDE_PATTERN in line: continue
            tid, count = parse_subject_line(line)
            if tid: subject_threads[tid] = count
    except Exception as e:
        print(f"[{board_name}] Failed to parse subject.txt: {e}")
        return False

    # 3. Dat同期
    local_files = {f[:-4] for f in os.listdir(dat_dir) if f.endswith(".dat")}

    dl_count = 0
    up_count = 0

    for tid, remote_count in subject_threads.items():
        dat_path = os.path.join(dat_dir, f"{tid}.dat")
        local_count = get_local_res_count(dat_path)

        url = f"{base_url}/dat/{tid}.dat"

        if tid not in local_files:
            print(f"[{board_name}] New: {tid}.dat")
            if download_file(url, dat_path): dl_count += 1
            time.sleep(SLEEP_TIME)
        elif remote_count > local_count:
            print(f"[{board_name}] Update: {tid}.dat ({local_count}->{remote_count})")
            if download_file(url, dat_path): up_count += 1
            time.sleep(SLEEP_TIME)

    # 4. 削除処理 (コメントアウト: 削除しないように変更)
    # del_count = 0
    # for tid in local_files:
    #     if tid not in subject_threads:
    #         try:
    #             os.remove(os.path.join(dat_dir, f"{tid}.dat"))
    #             print(f"[{board_name}] Deleted: {tid}.dat")
    #             del_count += 1
    #         except: pass

    print(f"[{board_name}] Done. New:{dl_count}, Up:{up_count}")
    return True

# --- Game ID Extraction Logic (Converted from extract_game_ids.py) ---

def extract_from_file_v2(file_path, admin_id=None, refill_cost=30):
    game_to_user = {}
    user_stats = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    secret_triggers = defaultdict(list)

    now = datetime.now()
    cutoff_dt = now - timedelta(days=2)

    try:
        with open(file_path, 'r', encoding='utf-8') as f: content = f.read()
    except:
        try:
            with open(file_path, 'r', encoding='cp932') as f: content = f.read()
        except: return {}, {}, {}

    trigger_pattern = None
    if admin_id:
        trigger_pattern = re.compile(r'<font\s+color\s*=\s*["\']?green["\']?\s*><strong>★ID:' + re.escape(admin_id) + r'に(\d+)コ(?:&#x1F337;|🌷)を送りました。</strong></font>', re.UNICODE)

    lines = content.split('\n')
    for line in lines:
        if not line: continue
        parts = line.strip().split('<>')
        if len(parts) < 3: continue

        name = parts[0]
        date_and_id = parts[2]
        body = parts[3] if len(parts) > 3 else ""

        # Date Parsing
        date_match = re.search(r'(\d{4}/\d{2}/\d{2})', date_and_id)
        time_match = re.search(r'\s(\d{1,2}):\d{2}:\d{2}', date_and_id)
        if not date_match or not time_match: continue

        date_str = date_match.group(1)
        hour = int(time_match.group(1))

        if hour >= 24:
            try:
                d_obj = datetime.strptime(date_str, '%Y/%m/%d')
                d_obj += timedelta(days=hour // 24)
                hour = hour % 24
                date_str = d_obj.strftime('%Y/%m/%d')
            except: continue

        dt_str = f"{date_str} {hour}:00:00"
        try:
            if datetime.strptime(dt_str, '%Y/%m/%d %H:%M:%S') < cutoff_dt: continue
        except: continue

        id_match = re.search(r'ID:([^\s]+)', date_and_id)
        if not id_match: continue
        user_id = id_match.group(1)

        user_stats[user_id][date_str][hour] += 1

        # Game Key Extraction
        # [FIX] game- prefix removed
        gk_pattern = re.compile(r'\b[0-9a-fA-F]{8}\b')
        candidates = gk_pattern.findall(name)
        if body: candidates.extend(gk_pattern.findall(body))

        if candidates:
            game_key = candidates[0]
            if game_key not in game_to_user:
                game_to_user[game_key] = user_id

        # Trigger Detection
        if trigger_pattern:
            match = trigger_pattern.search(body)
            if match:
                cost_value = int(match.group(1))
                if cost_value >= refill_cost:
                    import hashlib
                    msg_hash = hashlib.md5((date_and_id + body).encode('utf-8')).hexdigest()
                    if msg_hash not in secret_triggers[user_id]:
                        secret_triggers[user_id].append(msg_hash)

    # Convert stats to dict
    serializable_stats = {}
    for uid, dates in user_stats.items():
        serializable_stats[uid] = {}
        for d, hours in dates.items():
            serializable_stats[uid][d] = dict(hours)

    return game_to_user, serializable_stats, dict(secret_triggers)

def process_directory(target_dir, cache, admin_id=None, refill_cost=30):
    files = [os.path.join(target_dir, f) for f in os.listdir(target_dir) if f.endswith('.dat') or f.endswith('.dat.txt')]
    dir_game_to_user = {}
    dir_user_stats = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    dir_secret_triggers = defaultdict(list)

    for file_path in files:
        try:
            stat = os.stat(file_path)
            mtime = stat.st_mtime
            size = stat.st_size

            cached_entry = cache.get(file_path)
            # キャッシュ検証
            if (cached_entry and
                cached_entry.get('mtime') == mtime and
                cached_entry.get('size') == size and
                'secret_triggers' in cached_entry['data']):

                fg2u = cached_entry['data']['game_to_user']
                fus = cached_entry['data']['user_stats']
                fst = cached_entry['data']['secret_triggers']
            else:
                fg2u, fus, fst = extract_from_file_v2(file_path, admin_id, refill_cost)
                cache[file_path] = {
                    'mtime': mtime,
                    'size': size,
                    'data': {
                        'game_to_user': fg2u,
                        'user_stats': fus,
                        'secret_triggers': fst
                    }
                }

            # Merge
            for gk, uid in fg2u.items():
                if gk not in dir_game_to_user: dir_game_to_user[gk] = uid
            for uid, dates in fus.items():
                for d, hours in dates.items():
                    for h, count in hours.items():
                        dir_user_stats[uid][d][str(h)] += count
            for uid, triggers in fst.items():
                for t in triggers:
                    if t not in dir_secret_triggers[uid]: dir_secret_triggers[uid].append(t)

        except Exception as e:
            print(f"Error processing {file_path}: {e}")
            continue

    return dir_game_to_user, dir_user_stats, dir_secret_triggers

def run_extraction():
    print("\n[Extraction] Start...")

    game_ids_json = os.path.join(DATA_ROOT, "game_ids.json")
    cache_file = os.path.join(DATA_ROOT, "game_ids_cache.json")
    admin_id_file = os.path.join(DATA_ROOT, "admin-id.txt")

    # Load Admin ID
    admin_id = None
    if os.path.exists(admin_id_file):
        try:
            with open(admin_id_file, 'r', encoding='utf-8') as f:
                admin_id = f.read().strip()
                print(f"[Extraction] Admin ID loaded: {admin_id}")
        except: pass

    # Load Settings (for refill_cost)
    settings_file = os.path.join(DATA_ROOT, "system_settings.json")
    refill_cost = 30
    if os.path.exists(settings_file):
        try:
            with open(settings_file, 'r', encoding='utf-8') as f:
                settings = json.load(f)
                refill_cost = settings.get("apSettings", {}).get("gardenRefillCost", 30)
                print(f"[Extraction] Refill cost loaded: {refill_cost}")
        except: pass

    # Load Cache
    cache = {}
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except: pass

    # Directories to scan
    target_dirs = []
    for board in BOARDS:
        d = os.path.join(DATA_ROOT, board['dir_name'], 'dat')
        if os.path.exists(d): target_dirs.append(d)

    # Load Existing Data
    existing_data = {}
    if os.path.exists(game_ids_json):
        try:
            with open(game_ids_json, 'r', encoding='utf-8') as f:
                existing_data = json.load(f)
        except: pass

    # SCAN
    dir_game_to_user = {}
    dir_user_stats = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    dir_secret_triggers = defaultdict(list)

    for d in target_dirs:
        print(f"[Extraction] Scanning {d}...")
        g2u, us, st = process_directory(d, cache, admin_id, refill_cost)

        for gk, uid in g2u.items(): dir_game_to_user[gk] = uid
        for uid, dates in us.items():
            for dstr, hours in dates.items():
                for h, c in hours.items(): dir_user_stats[uid][dstr][str(h)] += c
        for uid, trigs in st.items():
            for t in trigs:
                if t not in dir_secret_triggers[uid]: dir_secret_triggers[uid].append(t)

    # Resolve Mapping UID <-> GK
    uid_to_gk = {}
    # Existing
    for gk, info in existing_data.items():
        if "id" in info: uid_to_gk[info["id"]] = gk
    # New (Overwrite)
    for gk, uid in dir_game_to_user.items():
        uid_to_gk[uid] = gk

    # Build Final Data
    final_data = existing_data
    updated_gks = set()

    for uid, dates in dir_user_stats.items():
        gk = uid_to_gk.get(uid)
        if not gk: continue

        if gk not in final_data:
            final_data[gk] = {"id": uid, "counts": {}, "secretTriggers": []}

        if gk not in updated_gks:
            final_data[gk]["counts"] = {} # Clear for fresh accumulation
            updated_gks.add(gk)

        for dstr, hours in dates.items():
            if dstr not in final_data[gk]["counts"]: final_data[gk]["counts"][dstr] = {}
            for h, c in hours.items():
                h_str = str(h)
                final_data[gk]["counts"][dstr][h_str] = final_data[gk]["counts"][dstr].get(h_str, 0) + c

    # Merge Triggers
    for uid, triggers in dir_secret_triggers.items():
        for gk, entry in final_data.items():
            if entry.get("id") == uid:
                if "secretTriggers" not in entry: entry["secretTriggers"] = []
                for t in triggers:
                    if t not in entry["secretTriggers"]:
                        entry["secretTriggers"].append(t)

    # Prune Old
    cutoff_date_str = (datetime.now() - timedelta(days=1)).strftime('%Y/%m/%d')
    pruned_keys = []

    for gk, entry in final_data.items():
        if "counts" in entry:
            res_dates = list(entry["counts"].keys())
            for d in res_dates:
                if d < cutoff_date_str: del entry["counts"][d]
            if not entry["counts"]: pruned_keys.append(gk)

    for k in pruned_keys:
        if k in final_data: del final_data[k]

    print(f"[Extraction] Pruned {len(pruned_keys)} inactive keys.")

    # Deduplicate (Keep latest active key for UID)
    uid_to_keys = defaultdict(list)
    for gk, entry in final_data.items():
        uid = entry.get("id")
        if uid: uid_to_keys[uid].append(gk)

    for uid, gks in uid_to_keys.items():
        if len(gks) > 1:
            key_stats = []
            for gk in gks:
                counts = final_data[gk].get("counts", {})
                last_date = max(counts.keys()) if counts else "0000/00/00"
                total = sum(counts[last_date].values()) if counts and last_date else 0
                key_stats.append({"gk": gk, "last": last_date, "cnt": total})

            key_stats.sort(key=lambda x: (x["last"], x["cnt"], x["gk"]), reverse=True)
            winner = key_stats[0]["gk"]
            for loser in key_stats[1:]:
                del final_data[loser["gk"]]
            print(f"[Extraction] Deduplicated UID {uid}: Kept {winner}")

    # Save Data (SQLite & JSON)
    db_path = os.path.join(DATA_ROOT, "game.db")
    try:
        conn = sqlite3.connect(db_path)
        # WALモード設定 (Node.js/better-sqlite3との共存に必須)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")

        cursor = conn.cursor()
        # テーブルがなければ作成 (念のため)
        cursor.execute("CREATE TABLE IF NOT EXISTS game_ids (id TEXT PRIMARY KEY, data TEXT NOT NULL)")

        # バルクインサート
        # final_data: { gk: data_obj }
        insert_data = [(gk, json.dumps(data, ensure_ascii=False)) for gk, data in final_data.items()]

        cursor.execute("BEGIN TRANSACTION")
        cursor.executemany("INSERT OR REPLACE INTO game_ids (id, data) VALUES (?, ?)", insert_data)
        conn.commit()
        conn.close()
        print(f"[Extraction] Saved to SQLite: {len(insert_data)} keys")
    except Exception as e:
        print(f"[Extraction] SQLite Save Error: {e}")

    # (Keep JSON for temporary fallback/debug)
    try:
        tmp_json = game_ids_json + ".tmp"
        with open(tmp_json, 'w', encoding='utf-8') as f:
            json.dump(final_data, f, indent=4, ensure_ascii=False)
        os.replace(tmp_json, game_ids_json)
        print(f"[Extraction] Saved game_ids.json")
    except Exception as e:
        print(f"Failed to save JSON: {e}")

    # Save Cache
    try:
        tmp_cache = cache_file + ".tmp"
        with open(tmp_cache, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp_cache, cache_file)
    except: pass

def main():
    parser = argparse.ArgumentParser(description='Garden Sync & Game ID Extraction')
    parser.add_argument('--local-test', action='store_true', help='(Unused) compatibility flag')
    args = parser.parse_args()

    setup_paths()

    print("=== GardenSync 2.0 Start ===")

    # Sync Boards
    for board in BOARDS:
        try:
            sync_board(board)
        except Exception as e:
            print(f"[{board['name']}] critical sync error: {e}")

    # Extract IDs
    try:
        run_extraction()
    except Exception as e:
        print(f"[Extraction] critical error: {e}")
        import traceback
        traceback.print_exc()

    print("=== All Done ===")

if __name__ == "__main__":
    main()
