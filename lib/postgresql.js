import sql from "./db.js";
(async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS ids (
      anilist INTEGER PRIMARY KEY,
      kitsu INTEGER,
      imdb INTEGER,
      thetvdb INTEGER,
      themoviedb INTEGER
    )
  `;
})();

export async function getFromDatabase(id, target) {
  const rows = await sql`
    SELECT anilist FROM ids WHERE ${sql(target)} = ${id}
  `;
  return rows.length > 0 ? rows[0].anilist : null;
}

export async function cacheToDatabase(anilistId, id, target) {
  await sql`
    INSERT INTO ids (anilist, ${sql(target)})
    VALUES (${anilistId}, ${id})
    ON CONFLICT (anilist)
    DO UPDATE SET ${sql(target)} = EXCLUDED.${sql(target)}
  `;
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
