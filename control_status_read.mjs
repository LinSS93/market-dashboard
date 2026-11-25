// Storage fields only; live ingestion state stays in its owner process.
export function readControlNewsStorage(db) {
  return {
    sources: db.prepare('SELECT * FROM news_source_status ORDER BY source').all(),
    cninfoCompleteDate: db.prepare('SELECT cursor_value FROM news_source_cursors WHERE source=?').get('cninfo_complete_date')?.cursor_value || null,
    storedArticles: db.prepare('SELECT COUNT(*) AS count FROM news_articles').get().count,
  };
}
