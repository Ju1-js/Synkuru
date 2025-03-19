const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./db/id-cache.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS ids (
    anilist INTEGER PRIMARY KEY,
    kitsu INTEGER,
    imdb INTEGER,
    thetvdb INTEGER,
    themoviedb INTEGER
  )`);
});

// Use 'target' (which corresponds to a column name) instead of 'source'
async function getFromDatabase(id, target) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT anilist FROM ids WHERE ${target} = ?`, [id], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row ? row.anilist : null);
      }
    });
  });
}

async function cacheToDatabase(anilistId, id, target) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ids (anilist, ${target}) VALUES (?, ?)
       ON CONFLICT(anilist) DO UPDATE SET ${target} = excluded.${target}`,
      [anilistId, id],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

process.on("SIGINT", () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log("Closed the database connection.");
    process.exit();
  });
});

module.exports = {
  getFromDatabase,
  cacheToDatabase,
};
