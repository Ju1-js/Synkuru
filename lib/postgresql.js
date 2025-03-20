import sql from "./db.js";

const allowedColumns = ["anilist", "kitsu", "imdb", "thetvdb", "themoviedb"];

(async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS ids (
      anilist INTEGER, 
      kitsu INTEGER,
      imdb INTEGER,
      thetvdb INTEGER,
      themoviedb INTEGER
    )
  `;
})();

export async function getFromDatabase(id, idsource, targetsource) {
  if (
    !allowedColumns.includes(idsource) ||
    !allowedColumns.includes(targetsource)
  ) {
    throw new Error("Invalid column name");
  }
  const queryLiteral = sql`
    SELECT ${sql(targetsource)} 
    FROM ids 
    WHERE ${sql(idsource)} = ${id} 
    LIMIT 1
  `;
  const rows = await queryLiteral;
  if (rows.length > 0) {
    return rows[0][targetsource] ?? null;
  }
  return null;
}

export async function cacheToDatabase(idsource, id, targetsource, targetid) {
  if (
    !allowedColumns.includes(idsource) ||
    !allowedColumns.includes(targetsource)
  ) {
    throw new Error("Invalid column name");
  }
  const existing = await sql`
    SELECT * FROM ids WHERE ${sql(idsource)} = ${id} LIMIT 1
  `;
  if (existing.length > 0) {
    await sql`
      UPDATE ids
      SET ${sql(targetsource)} = ${targetid}
      WHERE ${sql(idsource)} = ${id}
    `;
  } else {
    await sql`
      INSERT INTO ids (anilist, kitsu, imdb, thetvdb, themoviedb)
      VALUES (
        ${idsource === "anilist" ? id : null},
        ${idsource === "kitsu" ? id : null},
        ${idsource === "imdb" ? id : null},
        ${idsource === "thetvdb" ? id : null},
        ${idsource === "themoviedb" ? id : null}
      )
    `;
  }
}

process.on("SIGINT", async () => {
  try {
    await sql.end({ timeout: 5 });
    console.log("Closed the database connection.");
    process.exit();
  } catch (err) {
    console.error("Error closing connection:", err.message);
    process.exit(1);
  }
});
