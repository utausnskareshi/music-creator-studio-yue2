//! SQLite library (songs, versions, jobs). File: %APPDATA%\MusicCreatorStudioYuE2\library.db

use crate::config::app_data_dir;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub created_at: String,
    pub title: String,
    pub style: String,
    pub lyrics: String,
    /// Text actually sung (hiragana version); empty when identical to `lyrics`.
    #[serde(default)]
    pub lyrics_sung: String,
    pub mode: String,
    pub seed: i64,
    pub abc: String,
    pub duration: f64,
    pub audio_path: String,
    pub folder: String,
    pub params_json: String,
    /// queued | running | done | error | cancelled
    pub status: String,
    pub error: String,
    pub parent_id: Option<String>,
    pub wall_seconds: f64,
    pub peak_vram_gib: f64,
    /// The music (semantic) phase used its whole token budget: the song may stop mid-phrase.
    /// None = unknown (songs made before this was recorded, or not determinable).
    #[serde(default)]
    pub truncated_semantic: Option<bool>,
    /// The ABC planner used its whole token budget (only when YuE2GenerateABC ran). None = unknown / n.a.
    #[serde(default)]
    pub truncated_abc: Option<bool>,
    /// Music budget YuE2GenerateMusic actually used, in seconds (ComfyUI lowers it for a long
    /// prompt). None = unknown (older songs, or the node was served from the cache).
    #[serde(default)]
    pub effective_max_seconds: Option<f64>,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open() -> Result<Self> {
        let dir = app_data_dir();
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("library.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS songs (
               id TEXT PRIMARY KEY,
               created_at TEXT NOT NULL,
               title TEXT NOT NULL DEFAULT '',
               style TEXT NOT NULL DEFAULT '',
               lyrics TEXT NOT NULL DEFAULT '',
               mode TEXT NOT NULL DEFAULT 'full',
               seed INTEGER NOT NULL DEFAULT 0,
               abc TEXT NOT NULL DEFAULT '',
               duration REAL NOT NULL DEFAULT 0,
               audio_path TEXT NOT NULL DEFAULT '',
               folder TEXT NOT NULL DEFAULT '',
               params_json TEXT NOT NULL DEFAULT '{}',
               status TEXT NOT NULL DEFAULT 'queued',
               error TEXT NOT NULL DEFAULT '',
               parent_id TEXT,
               wall_seconds REAL NOT NULL DEFAULT 0,
               peak_vram_gib REAL NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_songs_created ON songs(created_at DESC);",
        )?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    fn open_in_memory_legacy() -> Result<Self> {
        // The first-release schema (no lyrics_sung / truncation columns).
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE songs (
               id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '',
               lyrics TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'full', seed INTEGER NOT NULL DEFAULT 0,
               abc TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, audio_path TEXT NOT NULL DEFAULT '',
               folder TEXT NOT NULL DEFAULT '', params_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
               error TEXT NOT NULL DEFAULT '', parent_id TEXT, wall_seconds REAL NOT NULL DEFAULT 0, peak_vram_gib REAL NOT NULL DEFAULT 0
             );
             INSERT INTO songs (id, created_at, title) VALUES ('old', '2026-09-01T00:00:00+09:00', 'old song');",
        )?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// An empty library with the current schema (the legacy one, migrated).
    #[cfg(test)]
    pub(crate) fn open_in_memory() -> Result<Self> {
        let db = Self::open_in_memory_legacy()?;
        db.delete("old")?;
        Ok(db)
    }

    pub fn insert(&self, s: &Song) -> Result<()> {
        self.conn.execute(
            "INSERT INTO songs (id, created_at, title, style, lyrics, mode, seed, abc, duration, audio_path, folder, params_json, status, error, parent_id, wall_seconds, peak_vram_gib, lyrics_sung, truncated_semantic, truncated_abc, effective_max_seconds)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![s.id, s.created_at, s.title, s.style, s.lyrics, s.mode, s.seed, s.abc, s.duration, s.audio_path, s.folder, s.params_json, s.status, s.error, s.parent_id, s.wall_seconds, s.peak_vram_gib, s.lyrics_sung, s.truncated_semantic, s.truncated_abc, s.effective_max_seconds],
        )?;
        Ok(())
    }

    /// Write every column except the title: the title changes only through insert and set_title, so a
    /// rename made while a job runs is not undone by the job's own writes (it holds an older copy).
    pub fn update(&self, s: &Song) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET style=?2, lyrics=?3, mode=?4, seed=?5, abc=?6, duration=?7, audio_path=?8, folder=?9, params_json=?10, status=?11, error=?12, parent_id=?13, wall_seconds=?14, peak_vram_gib=?15, lyrics_sung=?16, truncated_semantic=?17, truncated_abc=?18, effective_max_seconds=?19 WHERE id=?1",
            params![s.id, s.style, s.lyrics, s.mode, s.seed, s.abc, s.duration, s.audio_path, s.folder, s.params_json, s.status, s.error, s.parent_id, s.wall_seconds, s.peak_vram_gib, s.lyrics_sung, s.truncated_semantic, s.truncated_abc, s.effective_max_seconds],
        )?;
        Ok(())
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.conn.execute("UPDATE songs SET title=?2 WHERE id=?1", params![id, title])?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM songs WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Song>> {
        Ok(self.conn.query_row("SELECT * FROM songs WHERE id=?1", params![id], row_to_song).optional()?)
    }

    pub fn list(&self, limit: usize) -> Result<Vec<Song>> {
        let mut stmt = self.conn.prepare("SELECT * FROM songs ORDER BY created_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit as i64], row_to_song)?;
        // A row that does not decode is left out of the list, but logged (it would otherwise just vanish).
        Ok(rows
            .filter_map(|r| r.map_err(|e| log::warn!("library row skipped: {e}")).ok())
            .collect())
    }

    /// Mark jobs left running by a previous crash as errors.
    pub fn recover(&self) -> Result<()> {
        // A row still 'queued' never made its song folder (jobs.rs make_song_dir runs only after start_song marks it
        // running): its planned path is cleared as jobs.rs mark_ended does. A 'running' row may have made it.
        self.conn.execute(
            "UPDATE songs SET status='error', error='アプリ終了により中断', folder=CASE WHEN status='queued' THEN '' ELSE folder END \
             WHERE status IN ('queued','running')",
            [],
        )?;
        Ok(())
    }
}

/// Additive migrations for columns added after the first release (existing rows keep NULL/defaults).
fn migrate(conn: &Connection) -> Result<()> {
    let cols: Vec<String> = conn.prepare("PRAGMA table_info(songs)")?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
    let has = |c: &str| cols.iter().any(|x| x == c);
    if !has("lyrics_sung") {
        conn.execute("ALTER TABLE songs ADD COLUMN lyrics_sung TEXT NOT NULL DEFAULT ''", [])?;
    }
    if !has("truncated_semantic") {
        conn.execute("ALTER TABLE songs ADD COLUMN truncated_semantic INTEGER NULL", [])?;
    }
    if !has("truncated_abc") {
        conn.execute("ALTER TABLE songs ADD COLUMN truncated_abc INTEGER NULL", [])?;
    }
    if !has("effective_max_seconds") {
        conn.execute("ALTER TABLE songs ADD COLUMN effective_max_seconds REAL NULL", [])?;
    }
    Ok(())
}

fn row_to_song(r: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    Ok(Song {
        id: r.get("id")?,
        created_at: r.get("created_at")?,
        title: r.get("title")?,
        style: r.get("style")?,
        lyrics: r.get("lyrics")?,
        lyrics_sung: r.get::<_, String>("lyrics_sung").unwrap_or_default(),
        mode: r.get("mode")?,
        seed: r.get("seed")?,
        abc: r.get("abc")?,
        duration: r.get("duration")?,
        audio_path: r.get("audio_path")?,
        folder: r.get("folder")?,
        params_json: r.get("params_json")?,
        status: r.get("status")?,
        error: r.get("error")?,
        parent_id: r.get("parent_id")?,
        wall_seconds: r.get("wall_seconds")?,
        peak_vram_gib: r.get("peak_vram_gib")?,
        truncated_semantic: r.get::<_, Option<bool>>("truncated_semantic").unwrap_or(None),
        truncated_abc: r.get::<_, Option<bool>>("truncated_abc").unwrap_or(None),
        effective_max_seconds: r.get::<_, Option<f64>>("effective_max_seconds").unwrap_or(None),
    })
}

/// A song row for tests: only the id and the status matter.
#[cfg(test)]
pub(crate) fn test_song(id: &str, status: &str) -> Song {
    Song {
        id: id.into(),
        created_at: "2026-10-07T10:00:00+09:00".into(),
        title: id.into(),
        style: "pop".into(),
        lyrics: "l".into(),
        lyrics_sung: String::new(),
        mode: "full".into(),
        seed: 7,
        abc: String::new(),
        duration: 0.0,
        audio_path: String::new(),
        folder: String::new(),
        params_json: "{}".into(),
        status: status.into(),
        error: String::new(),
        parent_id: None,
        wall_seconds: 0.0,
        peak_vram_gib: 0.0,
        truncated_semantic: None,
        truncated_abc: None,
        effective_max_seconds: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_marks_only_unfinished_jobs_as_interrupted() {
        let db = Db::open_in_memory().unwrap();
        for status in ["queued", "running", "done", "error", "cancelled"] {
            let mut s = test_song(status, status);
            if status == "error" {
                s.error = "ComfyUI でエラーが発生しました".into();
            }
            db.insert(&s).unwrap();
        }
        db.recover().unwrap();
        let row = |id: &str| {
            let s = db.get(id).unwrap().unwrap();
            (s.status, s.error)
        };
        // Left waiting or running by a crash / forced exit: no job holds them any more (a 'running' row could
        // otherwise be neither deleted nor cancelled in the library).
        for id in ["queued", "running"] {
            assert_eq!(row(id), ("error".into(), "アプリ終了により中断".into()), "{id}");
        }
        // Finished rows keep their outcome and their own error text.
        assert_eq!(row("done"), ("done".into(), String::new()));
        assert_eq!(row("error"), ("error".into(), "ComfyUI でエラーが発生しました".into()));
        assert_eq!(row("cancelled"), ("cancelled".into(), String::new()));
    }

    /// A row left 'queued' never made its song folder (make_song_dir runs only after start_song marks it running):
    /// its planned path is cleared like jobs.rs mark_ended does, so deleting it while that drive is unplugged does
    /// not report a folder that never existed as kept. A 'running' row may have made its folder: it keeps the path.
    #[test]
    fn recover_clears_the_planned_folder_of_queued_rows() {
        let db = Db::open_in_memory().unwrap();
        for status in ["queued", "running", "done", "error"] {
            let mut s = test_song(status, status);
            s.folder = format!(r"D:\songs\{status}");
            db.insert(&s).unwrap();
        }
        db.recover().unwrap();
        let folder = |id: &str| db.get(id).unwrap().unwrap().folder;
        assert_eq!(folder("queued"), "");
        assert_eq!(folder("running"), r"D:\songs\running");
        assert_eq!(folder("done"), r"D:\songs\done");
        assert_eq!(folder("error"), r"D:\songs\error");
    }

    #[test]
    fn legacy_db_migrates_and_keeps_unknown_truncation() {
        let db = Db::open_in_memory_legacy().unwrap();
        let old = db.get("old").unwrap().unwrap();
        assert_eq!(old.title, "old song");
        assert_eq!(old.lyrics_sung, "");
        assert_eq!((old.truncated_semantic, old.truncated_abc, old.effective_max_seconds), (None, None, None));
        // Idempotent.
        migrate(&db.conn).unwrap();

        let mut s = old.clone();
        s.id = "new".into();
        s.truncated_semantic = Some(true);
        db.insert(&s).unwrap();
        let got = db.get("new").unwrap().unwrap();
        assert_eq!((got.truncated_semantic, got.truncated_abc), (Some(true), None));
        s.truncated_semantic = Some(false);
        s.truncated_abc = Some(true);
        s.effective_max_seconds = Some(80.0);
        db.update(&s).unwrap();
        let got = db.get("new").unwrap().unwrap();
        assert_eq!((got.truncated_semantic, got.truncated_abc), (Some(false), Some(true)));
        assert_eq!(got.effective_max_seconds, Some(80.0));
        assert_eq!(db.list(10).unwrap().len(), 2);
    }

    #[test]
    fn update_keeps_a_rename_made_meanwhile() {
        let db = Db::open_in_memory_legacy().unwrap();
        let mut job_copy = db.get("old").unwrap().unwrap();
        // The user renames the song while the job (holding an older copy) runs.
        db.set_title("old", "夏の歌").unwrap();
        job_copy.status = "done".into();
        job_copy.duration = 12.5;
        db.update(&job_copy).unwrap();
        let got = db.get("old").unwrap().unwrap();
        assert_eq!(got.title, "夏の歌");
        assert_eq!((got.status.as_str(), got.duration), ("done", 12.5));
    }

    #[test]
    fn song_json_without_new_fields_decodes() {
        let s: Song = serde_json::from_value(serde_json::json!({
            "id": "a", "createdAt": "x", "title": "t", "style": "s", "lyrics": "l", "mode": "full", "seed": 1, "abc": "",
            "duration": 1.0, "audioPath": "", "folder": "", "paramsJson": "{}", "status": "done", "error": "",
            "parentId": null, "wallSeconds": 0.0, "peakVramGib": 0.0
        }))
        .unwrap();
        assert_eq!((s.truncated_semantic, s.truncated_abc, s.effective_max_seconds), (None, None, None));
    }
}
